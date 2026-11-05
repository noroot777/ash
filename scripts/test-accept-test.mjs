import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repo = fileURLToPath(new URL("..", import.meta.url));
// Windows 上执行器照旧按链交给 npm 串行跑（见 scripts/test-runner.mjs 的 runSequentially）：
// 并行池子、历史排队、共用台子、进程收场这些契约那边没有，对应用例只在其它平台跑；串行那份
// 契约单独有用例，其它平台用 ASH_TEST_RUNNER=serial 在本机也核一遍。
const parallel = process.platform !== "win32";
const parallelOnly = parallel ? {} : { skip: "Windows 走串行 npm，没有并行池子" };
const SERIAL = { ASH_TEST_RUNNER: "serial" };

// 夹具长成真实仓库的形状：根包声明 workspaces，后端那一步的链住在 server 子包、前端那一步
// 住在 web 子包，链里照真实写法嵌 `npm run` —— 执行器要把它们展开成叶子直接跑。
function fixture(context, { backend = "node backend.mjs && npm run test:more", web = "node regression.mjs", webExtra = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ash accept-test "));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ["scripts", "server", "web"]) mkdirSync(join(root, dir));
  for (const name of ["accept-test.mjs", "test-runner.mjs", "npm.mjs"]) {
    cpSync(join(repo, "scripts", name), join(root, "scripts", name));
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ private: true, workspaces: ["server", "web"] }));
  writeFileSync(join(root, "server", "package.json"), JSON.stringify({
    name: "fixture-server",
    private: true,
    scripts: { "test:accept": backend, "test:more": "node more.mjs" },
  }));
  writeFileSync(join(root, "web", "package.json"), JSON.stringify({
    name: "fixture-web",
    private: true,
    scripts: { test: web },
    ...webExtra,
  }));
  // 每条叶子留一份「我跑过了」的痕迹：在哪个目录、以哪条脚本的名义、看见了哪些要剥掉的变量。
  const step = (name, exitVar, stdout) => `
    import { appendFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    appendFileSync(join(${JSON.stringify(root)}, "order.txt"), ${JSON.stringify(`${name}
`)});
    writeFileSync(join(${JSON.stringify(root)}, ${JSON.stringify(`${name}.json`)}),
      JSON.stringify({ cwd: process.cwd(), event: process.env.npm_lifecycle_event, stage: process.env.FIXTURE_STAGE ?? null,
        environment: Object.keys(process.env).filter((key) => /^ASH_(?:DB|RUNS_DIR)$/i.test(key)) }));
    console.log(${JSON.stringify(stdout)});
    console.error(${JSON.stringify(`${stdout}_STDERR`)});
    // FIXTURE_ORPHAN_<名字>：起一个 detached 的后台进程（自成一组、跟父进程断开），把 pid 记下来。
    if (process.env[${JSON.stringify(`FIXTURE_ORPHAN_${name.toUpperCase()}`)}]) {
      const { spawn } = await import("node:child_process");
      const orphan = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { detached: true, stdio: "ignore" });
      orphan.unref();
      writeFileSync(join(${JSON.stringify(root)}, ${JSON.stringify(`${name}.orphan`)}), String(orphan.pid));
    }
    // FIXTURE_WAIT_<名字>：先登记「我起来了」，再等那个文件出现，10 秒等不到就红。
    const waitFor = process.env[${JSON.stringify(`FIXTURE_WAIT_${name.toUpperCase()}`)}];
    if (waitFor) {
      const { existsSync } = await import("node:fs");
      writeFileSync(join(${JSON.stringify(root)}, ${JSON.stringify(`${name}.started`)}), String(process.pid));
      const deadline = Date.now() + 10_000;
      while (!existsSync(join(${JSON.stringify(root)}, waitFor))) {
        if (Date.now() > deadline) process.exit(9);
        await new Promise((wait) => setTimeout(wait, 50));
      }
    }
    process.exit(Number(process.env[${JSON.stringify(exitVar)}] ?? 0));
  `;
  writeFileSync(join(root, "server", "backend.mjs"), step("backend", "ACCEPT_TEST_BACKEND_EXIT", "BACKEND_STDOUT"));
  writeFileSync(join(root, "server", "more.mjs"), step("more", "ACCEPT_TEST_MORE_EXIT", "MORE_STDOUT"));
  writeFileSync(join(root, "web", "regression.mjs"), step("web", "ACCEPT_TEST_EXIT", "REGRESSION_STDOUT"));
  return root;
}

const order = (root) => readFileSync(join(root, "order.txt"), "utf8").trim().split("\n");

function run(root, env = {}) {
  return spawnSync(process.execPath, [join(root, "scripts", "accept-test.mjs")], {
    cwd: tmpdir(),
    encoding: "utf8",
    // 用时记录落在临时目录下：指到夹具里，既不读宿主那份、也不把夹具的叶子写进去。Windows 的
    // os.tmpdir() 认 TEMP/TMP，其它平台认 TMPDIR。
    env: { ...process.env, TMPDIR: root, TEMP: root, TMP: root, ...env },
    timeout: 60_000,
  });
}

const seen = (root, name) => JSON.parse(readFileSync(join(root, `${name}.json`), "utf8"));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

test("从外部目录调用也在脚本所属项目跑完整回归，叶子的输出整段透传", (context) => {
  const root = fixture(context);
  const result = run(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const ran = seen(root, "web");
  assert.equal(ran.cwd, realpathSync(join(root, "web")));
  assert.equal(ran.event, "test");
  // 叶子的 stdout/stderr 落进同一份日志、按原有先后整段打出来，并行时不会互相穿插；串行时
  // 直接继承两路输出。
  if (parallel) assert.match(result.stdout, /REGRESSION_STDOUT\nREGRESSION_STDOUT_STDERR/);
  else assert.match(result.stdout + result.stderr, /REGRESSION_STDOUT_STDERR/);
  assert.match(result.stdout, /前端全量回归通过/);
  // 验收不许顺手装依赖：装过一次就会把验收变成「第一次跑特别慢、还可能改 lock 文件」。
  assert.equal(existsSync(join(root, "node_modules")), false);
});

test("链里嵌的 npm run 展开成叶子，各在自己的包目录、以自己的脚本名跑", (context) => {
  const root = fixture(context);
  const result = run(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual([seen(root, "backend").event, seen(root, "more").event], ["test:accept", "test:more"]);
  assert.equal(seen(root, "more").cwd, realpathSync(join(root, "server")));
  assert.match(result.stdout, /后端核心回归通过/);
  assert.match(result.stdout, /验收前置检查全部通过/);
});

test("跨包的 npm -w 也展开，跟 npm 一样按包名或相对本包目录的路径认", (context) => {
  for (const ref of ["fixture-server", "../server"]) {
    const root = fixture(context, { web: `node regression.mjs && npm -w ${ref} run test:more` });
    const result = run(root);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(seen(root, "more").cwd, realpathSync(join(root, "server")), ref);
  }
  // 子包里的 `-w server` 在 npm 眼里是 web/server，不存在 —— 执行器不能替它圆成根下那个。
  const root = fixture(context, { web: "node regression.mjs && npm -w server run test:more" });
  const result = run(root);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /验收前置检查全部通过/);
});

test("叶子是并行跑的：两步各一条，互相等到对方起来才退", parallelOnly, (context) => {
  const root = fixture(context, { backend: "node backend.mjs" });
  const result = run(root, { ASH_TEST_JOBS: "2", FIXTURE_WAIT_BACKEND: "web.started", FIXTURE_WAIT_WEB: "backend.started" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("排队按上一轮的记录：上次红的先跑，其余用时长的先跑", parallelOnly, (context) => {
  const root = fixture(context);
  const record = (entries) => writeFileSync(join(root, "ash-test-runner-history.json"), JSON.stringify(entries));
  record({ "server: node backend.mjs": { seconds: 1, failed: false }, "server: node more.mjs": { seconds: 5, failed: false },
    "web: node regression.mjs": { seconds: 9, failed: false } });
  assert.equal(run(root, { ASH_TEST_JOBS: "1" }).status, 0);
  assert.deepEqual(order(root), ["web", "more", "backend"]);
  // 这一轮把真实用时写回去了；再把 backend 记成上次红过，它就排到最前。
  const history = JSON.parse(readFileSync(join(root, "ash-test-runner-history.json"), "utf8"));
  assert.equal(history["server: node backend.mjs"].failed, false);
  record({ ...history, "server: node backend.mjs": { seconds: 0.1, failed: true } });
  rmSync(join(root, "order.txt"));
  assert.equal(run(root, { ASH_TEST_JOBS: "1" }).status, 0);
  assert.equal(order(root)[0], "backend");
});

test("任何一条失败时退出码照样透传，报出是哪一步哪一条，且不报「全部通过」", (context) => {
  const root = fixture(context);
  const result = run(root, { ACCEPT_TEST_EXIT: "5" });
  assert.equal(result.status, 5, result.stdout + result.stderr);
  assert.match(result.stdout, parallel ? /前端全量回归未通过（web: node regression\.mjs）/ : /前端全量回归未通过/);
  assert.doesNotMatch(result.stdout, /验收前置检查全部通过/);
});

test("一条红就收掉在跑的其余叶子，不等它们跑完", parallelOnly, (context) => {
  const root = fixture(context, { backend: "node backend.mjs" });
  // web 那条一直等一个永远不会出现的文件（最多 10 秒）；后端那条等它起来就红。
  const startedAt = Date.now();
  const result = run(root, { ASH_TEST_JOBS: "2", FIXTURE_WAIT_WEB: "never", FIXTURE_WAIT_BACKEND: "web.started", ACCEPT_TEST_BACKEND_EXIT: "7" });
  assert.equal(result.status, 7, result.stdout + result.stderr);
  assert.ok(Date.now() - startedAt < 9_000, "红了之后还在等别的叶子跑完");
  assert.match(result.stdout, /后端核心回归未通过/);
  assert.doesNotMatch(result.stdout, /前端全量回归通过/);
  const pid = Number(readFileSync(join(root, "web.started"), "utf8"));
  assert.throws(() => process.kill(pid, 0), "被收掉的叶子进程不该还活着");
});

test("脚本文件缺失时拒绝放行", (context) => {
  const root = fixture(context, { backend: "node missing-backend.mjs" });
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /后端核心回归未通过/);
});

test("链里引用了不存在的脚本时拒绝放行", (context) => {
  const result = run(fixture(context, { backend: "node backend.mjs && npm run test:nope" }));
  assert.notEqual(result.status, 0);
  // 串行时这句由 npm 自己报（Missing script），只认它没放行。
  if (parallel) assert.match(result.stdout, /无法展开测试清单：server 没有脚本 test:nope/);
  assert.doesNotMatch(result.stdout, /验收前置检查全部通过/);
});

test("旧推送开关和空 stdin 不会绕过验收测试", (context) => {
  const root = fixture(context);
  const result = run(root, { SKIP_WEB_TEST: "1", ACCEPT_TEST_EXIT: "3" });
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.equal(existsSync(join(root, "web.json")), true);
});

test("验收子进程不继承宿主数据库与运行目录，包括大小写变体", (context) => {
  const root = fixture(context);
  const result = run(root, {
    ASH_DB: join(root, "host.db"), ASH_RUNS_DIR: join(root, "host-runs"),
    ash_db: join(root, "lower.db"), ash_runs_dir: join(root, "lower-runs"),
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  // 每条叶子都要干净：只检查其中一条的话，别的可以带着宿主库跑而没人发现。
  for (const name of ["backend", "more", "web"]) assert.deepEqual(seen(root, name).environment, [], name);
});

test("包声明的共用台子只交给本包的叶子，跑完收掉", parallelOnly, (context) => {
  const root = fixture(context, { webExtra: { testStage: "stage.mjs" } });
  writeFileSync(join(root, "web", "stage.mjs"), `
    import { writeFileSync } from "node:fs";
    export async function startSharedStage() {
      return { env: { FIXTURE_STAGE: "shared" }, stop: async () => writeFileSync(${JSON.stringify(join(root, "stopped"))}, "") };
    }
  `);
  const result = run(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(seen(root, "web").stage, "shared");
  assert.equal(seen(root, "backend").stage, null);
  assert.equal(existsSync(join(root, "stopped")), true);
});

test("叶子退出后它 detached 出去的后台进程也收掉，红绿都一样", parallelOnly, (context) => {
  // 后台进程的父进程（叶子）先退了，它被过继出去、又自成一组：按进程组和父子关系都认不出来。
  const passed = fixture(context, { backend: "node backend.mjs" });
  assert.equal(run(passed, { FIXTURE_ORPHAN_BACKEND: "1" }).status, 0);
  assert.equal(alive(Number(readFileSync(join(passed, "backend.orphan"), "utf8"))), false, "绿的叶子留下的后台进程还活着");

  const failed = fixture(context, { backend: "node backend.mjs" });
  const result = run(failed, {
    ASH_TEST_JOBS: "2", FIXTURE_ORPHAN_BACKEND: "1", FIXTURE_WAIT_WEB: "never", FIXTURE_WAIT_BACKEND: "web.started", ACCEPT_TEST_BACKEND_EXIT: "7",
  });
  assert.equal(result.status, 7, result.stdout + result.stderr);
  assert.equal(alive(Number(readFileSync(join(failed, "backend.orphan"), "utf8"))), false, "红的那条自己留下的后台进程还活着");
  assert.equal(alive(Number(readFileSync(join(failed, "web.started"), "utf8"))), false, "被收掉的叶子还活着");
});

test("共用台子起不来时报红，已经在跑的叶子照样收掉", parallelOnly, (context) => {
  const root = fixture(context, { backend: "node backend.mjs", webExtra: { testStage: "stage.mjs" } });
  // 等后端那条真的起来了再失败：执行器出错时它正在跑，必须被收掉而不是留在后台。
  writeFileSync(join(root, "web", "stage.mjs"), `
    import { existsSync } from "node:fs";
    export async function startSharedStage() {
      while (!existsSync(${JSON.stringify(join(root, "backend.started"))})) await new Promise((wait) => setTimeout(wait, 50));
      throw new Error("injected-stage-failure");
    }
  `);
  const startedAt = Date.now();
  const result = run(root, { ASH_TEST_JOBS: "2", FIXTURE_WAIT_BACKEND: "never" });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(alive(Number(readFileSync(join(root, "backend.started"), "utf8"))), false, "正在跑的后端叶子没被收掉");
  assert.ok(Date.now() - startedAt < 9_000, "台子起不来之后还在等别的叶子跑完");
  assert.match(result.stdout, /共用台子起不来：injected-stage-failure/);
  assert.match(result.stdout, /前端全量回归未通过/);
  assert.doesNotMatch(result.stdout, /验收前置检查全部通过/);
});

// 串行契约：Windows 的默认走法，其它平台显式切过去核对同一份行为。
test("串行：两步按链依次跑完，各自报通过", (context) => {
  const root = fixture(context);
  const result = run(root, SERIAL);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(order(root), ["backend", "more", "web"]);
  assert.equal(seen(root, "more").event, "test:more");
  assert.match(result.stdout, /后端核心回归通过/);
  assert.match(result.stdout, /验收前置检查全部通过/);
});

test("串行：第一步红就透传退出码，后一步不跑", (context) => {
  const root = fixture(context);
  const result = run(root, { ...SERIAL, ACCEPT_TEST_BACKEND_EXIT: "7" });
  assert.equal(result.status, 7, result.stdout + result.stderr);
  assert.match(result.stdout, /后端核心回归未通过/);
  assert.equal(existsSync(join(root, "web.json")), false, "前一步红了后一步还在跑");
  assert.doesNotMatch(result.stdout, /验收前置检查全部通过/);
});

test("串行：叶子同样不继承宿主数据库与运行目录", (context) => {
  const root = fixture(context);
  const result = run(root, { ...SERIAL, ASH_DB: join(root, "host.db"), ash_runs_dir: join(root, "lower-runs") });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  for (const name of ["backend", "more", "web"]) assert.deepEqual(seen(root, name).environment, [], name);
});

test("依赖缺失导致测试无法启动时拒绝放行", (context) => {
  const result = run(fixture(context, { web: "node missing-regression.mjs" }));
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /前端全量回归未通过/);
});

test("PATH 里找不到 node 时拒绝放行", (context) => {
  const result = run(fixture(context), { PATH: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /未通过/);
  assert.doesNotMatch(result.stdout, /验收前置检查全部通过/);
});

test("推送钩子已移除，验收命令指向独立入口", () => {
  assert.equal(existsSync(join(repo, ".githooks", "pre-push")), false);
  assert.equal(existsSync(join(repo, "scripts", "web-test-gate.mjs")), false);
  const { scripts } = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  assert.equal(scripts["test:accept"], "node scripts/accept-test.mjs");
});
