import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repo = fileURLToPath(new URL("..", import.meta.url));

// 验收入口是**按步骤列表**跑的（`scripts/accept-test.mjs` 的 STEPS），所以夹具也得长成
// 真实仓库的形状：根包声明 workspaces，后端那一步的命令住在 server 子包里。夹具只给
// `test:web` 的那一版，后端那步会直接「找不到 workspace」—— 本该成功的用例全红，
// 而红的理由跟被测行为毫无关系。
function fixture(context, { backend = "node backend.mjs", web = "node regression.mjs" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ash accept-test "));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "server"));
  for (const name of ["accept-test.mjs", "npm.mjs"]) {
    cpSync(join(repo, "scripts", name), join(root, "scripts", name));
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({
    private: true,
    workspaces: ["server"],
    scripts: { "test:web": web },
  }));
  writeFileSync(join(root, "server", "package.json"), JSON.stringify({
    name: "fixture-server",
    private: true,
    scripts: { "test:accept": backend },
  }));
  // 两步各自留下一份「我跑过了」的痕迹，外加一个**递增的序号**：只看两份文件都在，
  // 证明不了它们是按顺序跑的（STEPS 的意义一半在顺序：第一步红了就不该有第二步）。
  const step = (name, exitVar, stdout) => `
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const order = join(${JSON.stringify(root)}, "order.json");
    const seen = existsSync(order) ? JSON.parse(readFileSync(order, "utf8")) : [];
    seen.push(${JSON.stringify(name)});
    writeFileSync(order, JSON.stringify(seen));
    writeFileSync(join(${JSON.stringify(root)}, ${JSON.stringify(`${name}.json`)}),
      JSON.stringify({ cwd: process.cwd(), event: process.env.npm_lifecycle_event,
        environment: Object.keys(process.env).filter((key) => /^ASH_(?:DB|RUNS_DIR)$/i.test(key)) }));
    console.log(${JSON.stringify(stdout)});
    console.error(${JSON.stringify(`${stdout}_STDERR`)});
    process.exit(Number(process.env[${JSON.stringify(exitVar)}] ?? 0));
  `;
  writeFileSync(join(root, "server", "backend.mjs"), step("backend", "ACCEPT_TEST_BACKEND_EXIT", "BACKEND_STDOUT"));
  writeFileSync(join(root, "regression.mjs"), step("web", "ACCEPT_TEST_EXIT", "REGRESSION_STDOUT"));
  return root;
}

function run(root, env = {}) {
  return spawnSync(process.execPath, [join(root, "scripts", "accept-test.mjs")], {
    cwd: tmpdir(),
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
}

const order = (root) => JSON.parse(readFileSync(join(root, "order.json"), "utf8"));

test("从外部目录调用也在脚本所属项目跑完整回归，并透传日志", (context) => {
  const root = fixture(context);
  const result = run(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const ran = JSON.parse(readFileSync(join(root, "web.json"), "utf8"));
  assert.equal(ran.event, "test:web");
  assert.equal(readFileSync(join(ran.cwd, "web.json"), "utf8"), readFileSync(join(root, "web.json"), "utf8"));
  assert.match(result.stdout, /REGRESSION_STDOUT/);
  assert.match(result.stderr, /REGRESSION_STDOUT_STDERR/);
  assert.match(result.stdout, /前端全量回归通过/);
  // 验收不许顺手装依赖：`npm -w server run` 只按根包的 workspaces 定位目录，装过一次
  // 就会把验收变成「第一次跑特别慢、还可能改 lock 文件」。
  assert.equal(existsSync(join(root, "node_modules")), false);
});

test("后端核心回归是第一步，前端回归排在它之后，两步都通过才放行", (context) => {
  const root = fixture(context);
  const result = run(root);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(order(root), ["backend", "web"]);
  const ran = JSON.parse(readFileSync(join(root, "backend.json"), "utf8"));
  assert.equal(ran.event, "test:accept");
  assert.match(result.stdout, /BACKEND_STDOUT/);
  assert.match(result.stdout, /后端核心回归通过/);
  assert.match(result.stdout, /验收前置检查全部通过/);
});

test("第二步失败时退出码照样透传，且不报「全部通过」", (context) => {
  const root = fixture(context);
  const result = run(root, { ACCEPT_TEST_EXIT: "5" });
  assert.equal(result.status, 5, result.stdout + result.stderr);
  assert.match(result.stdout, /后端核心回归通过/);
  assert.match(result.stdout, /前端全量回归未通过/);
  assert.doesNotMatch(result.stdout, /验收前置检查全部通过/);
});

test("第一步失败就不再跑第二步", (context) => {
  const root = fixture(context);
  const result = run(root, { ACCEPT_TEST_BACKEND_EXIT: "7" });
  assert.equal(result.status, 7, result.stdout + result.stderr);
  assert.deepEqual(order(root), ["backend"]);
  assert.equal(existsSync(join(root, "web.json")), false);
  assert.match(result.stdout, /后端核心回归未通过/);
  assert.doesNotMatch(result.stdout, /后端核心回归通过/);
  assert.doesNotMatch(result.stdout, /前端全量回归/);
});

test("第一步无法启动（脚本缺失）时拒绝放行", (context) => {
  const root = fixture(context, { backend: "node missing-backend.mjs" });
  const result = run(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /后端核心回归未通过/);
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
  // 两步都要干净：只检查其中一步的话，另一步可以带着宿主库跑而没人发现。
  for (const name of ["backend", "web"]) {
    assert.deepEqual(JSON.parse(readFileSync(join(root, `${name}.json`), "utf8")).environment, []);
  }
});

test("依赖缺失导致测试无法启动时拒绝放行", (context) => {
  const result = run(fixture(context, { web: "node missing-regression.mjs" }));
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /前端全量回归未通过/);
});

test("npm 不可用时返回失败", (context) => {
  const result = run(fixture(context), { PATH: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /后端核心回归未通过/);
});

test("推送钩子已移除，验收命令指向独立入口", () => {
  assert.equal(existsSync(join(repo, ".githooks", "pre-push")), false);
  assert.equal(existsSync(join(repo, "scripts", "web-test-gate.mjs")), false);
  const { scripts } = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  assert.equal(scripts["test:accept"], "node scripts/accept-test.mjs");
});
