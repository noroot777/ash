// 门禁「准备命令」的回归：快照里先跑准备命令把依赖现装出来，rc=0 才起验收前置命令，跑完随快照回收。
//
// 钉住的几条（对应 accept-gate-launch.ts 的 GATE_BOOTSTRAP 与 accept-gate-source.ts 的 GateSource.prepared）：
//  · 配了准备命令，快照里**不放任何借来的依赖**：主检出装着依赖、任务工作区没装（worktree 的常态，
//    也正是借用那条路要「证明隔离」的形状），准备命令起跑时快照里不该有 node_modules，测试读到的
//    是准备命令装出来的那一份，不是主检出那一份。
//  · 顺序是「准备 → 前置命令」，准备没过前置命令一行都不跑，结论是 prepare_failed（不是测试红）；
//    准备过了、测试红了仍是 exit_code；三种结果在门禁状态里分得清。
//  · 快照（连同准备命令装出来的依赖）随门禁收尾回收。
//  · 没配准备命令的项目原样走老路：记录里没有准备命令、日志里没有那一段。
//  · 快照住在 ash 与项目目录树之外（accept-gate-isolated.ts）：运行目录和主检出的祖先目录里装着的包，
//    快照里漏装了就是找不到；快照位置往上一旦能找到依赖目录就拒跑。
//  · 执行环境同一条不变量：ash 继承来的 PATH 上别人家的 `node_modules/.bin`、NODE_PATH、NODE_OPTIONS 里
//    的外来预加载、ash 自己那份 npm 包上下文，准备命令和前置命令（含 `npm run`）都看不见；老路不变。
//  · 阶段只由退出档说：日志写不进去不打断阶段推进，启动器自己出错记成「分不清」；退出档写不进去时
//    也按「分不清」收（被打断、不交修），不猜成准备没过或测试红。
//  · 门禁卡状态里的准备命令是保存着的那一条，不随前置命令撤掉而投影成空；跨机接力搬得动准备那一档。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { desc, eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-accept-gate-prepare-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
// 独立快照根放在 root 之外：root 本身要扮演「祖先目录里装着依赖」的 ash 检出。
const isolated = mkdtempSync(join(tmpdir(), "ash-accept-gate-isolated-"));
process.env.ASH_GATE_ISOLATED_DIR = isolated;
// 另一个项目的依赖树，经 ash 继承来的环境指过来（ash 被 npm 起时就是这个形状，第 2 轮审查实测）。
const foreign = join(mkdtempSync(join(tmpdir(), "ash-accept-gate-foreign-")), "other", "node_modules");
const preloaded = join(isolated, "preloaded.txt");
mkdirSync(join(foreign, ".bin"), { recursive: true });
mkdirSync(join(foreign, "envghost"), { recursive: true });
writeFileSync(join(foreign, ".bin", "ghosttool"), "#!/bin/sh\nexit 0\n");
chmodSync(join(foreign, ".bin", "ghosttool"), 0o755);
writeFileSync(join(foreign, "envghost", "index.js"), "module.exports = 1;\n");
// 只记在独立快照里起的 node：测试进程自己别处起的 node 进程不算。
writeFileSync(join(foreign, "preload.cjs"),
  `if (process.cwd().startsWith(${JSON.stringify(isolated)})) require("fs").appendFileSync(${JSON.stringify(preloaded)}, process.cwd() + "\\n");\n`);
process.on("exit", () => { for (const dir of [root, isolated, join(foreign, "..", "..")]) try { rmSync(dir, { recursive: true, force: true }); } catch {} });
assert.ok(process.env.ASH_ALLOW_REAL_AGENT !== "1", "门禁失败那一条会叫醒任务；拦截器一失效，测试就会拿用户的真额度跑 agent");

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** 一个装着依赖的「主检出」：node_modules 被忽略、不进提交，里面那份 dep 说的是 MAIN。 */
function makeRepo(name: string): string {
  const repo = join(root, name);
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.name", "Ash Gate Test");
  git(repo, "config", "user.email", "gate@example.test");
  writeFileSync(join(repo, ".gitignore"), ".worktrees/\nnode_modules/\n");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: name, version: "1.0.0", private: true, dependencies: { dep: "1.0.0" },
    scripts: { ghost: "ghosttool" } }));
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "seed");
  mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "dep", "package.json"), JSON.stringify({ name: "dep", version: "1.0.0", main: "index.js" }));
  writeFileSync(join(repo, "node_modules", "dep", "index.js"), 'module.exports = "MAIN";\n');
  return repo;
}

// 环境里看不看得见外来依赖：PATH 上的工具、NODE_PATH 上的包、ash 那份 npm 包上下文。
const sealed = `! command -v ghosttool >/dev/null && ! node -e "require.resolve('envghost')" 2>/dev/null`
  + ` && test -z "$npm_package_json$INIT_CWD$NODE_PATH"`;
// 准备命令：起跑时快照里必须还没有依赖目录（有就说明借进来了），然后现装一份说 SNAPSHOT 的 dep。
const installCommand = (order: string) => [
  `test ! -e node_modules || { echo 快照里已经有依赖目录 >&2; exit 9; }`,
  `{ ${sealed} || { echo 准备命令看得见外来依赖 >&2; exit 8; }; }`,
  `mkdir -p node_modules/dep`,
  `printf '{"name":"dep","version":"1.0.0","main":"index.js"}' > node_modules/dep/package.json`,
  `echo 'module.exports = "SNAPSHOT";' > node_modules/dep/index.js`,
  `echo prepare >> ${order}`,
].join(" && ");

try {
  const { prepareWorktree } = await import("../src/git.js");
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { acceptGateRuns, projects, tasks } = await import("../src/db/schema.js");
  const { acceptTask } = await import("../src/task-accept.js");
  const { acceptGateState, whenAcceptGateSettled } = await import("../src/accept-gate.js");
  const { gateView } = await import("../src/accept-gate-state.js");
  const { gateFailureInputFor } = await import("../src/accept-gate-messages.js");
  const { gateScopeNotice } = await import("../src/accept-gate-confinement.js");
  const { readGateLaunch } = await import("../src/accept-gate-launch.js");
  const { summarizeAcceptGate } = await import("@ash/shared/accept-gate");
  const { GATE_BOOTSTRAP } = await import("../src/accept-gate-launch.js");
  const { GATE_ENV_ISOLATION, isolatedGateEnv } = await import("../src/accept-gate-isolated.js");
  const { collectGateRuns, validateGatePayload } = await import("../src/handoff-accept-gate.js");
  const { PATH_DELIMITER } = await import("../src/platform.js");
  const { gateExitOutcome, readGateExit, unrecordedGateExit } = await import("../src/accept-gate-exit.js");
  const { userShellLaunch } = await import("../src/platform.js");
  const { createGateSnapshot, readGateSource } = await import("../src/accept-gate-source.js");
  // root 扮演 ash 检出：运行目录与项目仓库都在它下面，它的 node_modules 里装着快照没装的 ghost。
  mkdirSync(join(root, "node_modules", "ghost"), { recursive: true });
  writeFileSync(join(root, "node_modules", "ghost", "index.js"), 'module.exports = "GHOST";\n');
  process.env.PATH = `${join(foreign, ".bin")}${PATH_DELIMITER}${process.env.PATH}`;
  process.env.NODE_PATH = foreign;
  process.env.NODE_OPTIONS = `--require ${join(foreign, "preload.cjs")}`;
  process.env.npm_package_json = join(root, "package.json");
  process.env.INIT_CWD = root;
  await ensureSchema();

  const createdAt = new Date().toISOString();
  const runsOf = (taskId: string) => db.select().from(acceptGateRuns).where(eq(acceptGateRuns.taskId, taskId))
    .orderBy(desc(acceptGateRuns.startedAt), desc(acceptGateRuns.id));
  const taskRow = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
  async function settled(taskId: string) {
    for (let i = 0; i < 800; i++) {
      const latest = (await runsOf(taskId)).at(0);
      if (latest && latest.status !== "running") { await whenAcceptGateSettled(latest.id); return (await runsOf(taskId)).at(0)!; }
      await sleep(25);
    }
    throw new Error("门禁没有在 20 秒内结束");
  }
  async function seed(name: string, gate: string, prepare: string | null) {
    const repo = makeRepo(name);
    const projectId = `prep-project-${name}`;
    await db.insert(projects).values({ id: projectId, name, repoPath: repo, acceptGateCommand: gate, acceptGatePrepare: prepare, createdAt });
    const taskId = `prep${name.replace(/[^a-z0-9]/g, "")}`.padEnd(12, "0").slice(0, 12);
    const ws = await prepareWorktree(repo, taskId, "main");
    writeFileSync(join(ws.path, `${name}.txt`), `${name}\n`);
    git(ws.path, "add", "-A");
    git(ws.path, "commit", "-m", `task ${name}`);
    assert.equal(existsSync(join(ws.path, "node_modules")), false, "前提：任务工作区自己没装依赖");
    await db.insert(tasks).values({
      id: taskId, projectId, title: name, body: "", mode: "single", status: "done", stage: "verified",
      labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "claude",
      useWorktree: true, worktreeBase: "main", mergeTargetBranch: "main", workflowMode: "free",
      autoTitle: false, createdAt, updatedAt: createdAt,
    });
    return { repo, projectId, taskId, ws: ws.path, before: git(repo, "rev-parse", "main") };
  }
  /** 快照回收：结算时就删，macOS 兼容监督那一档保留到任务了结（accept-gate-reclaim.ts）。 */
  const retainedUntilConcluded = (logPath: string) => !!gateScopeNotice(readGateLaunch(logPath)?.confinementId);

  // 1. 准备 → 前置命令 → 通过 → 自动合并 → 快照回收；全程读不到主检出那份依赖。
  {
    const order = join(root, "pass-order.txt");
    const saw = join(root, "pass-saw.txt");
    const stage = await seed("pass", `echo command >> ${order} && node -e "process.stdout.write(require('dep'))" > ${saw}`
      + ` && ! node -e "require.resolve('ghost')" 2>/dev/null && ${sealed} && ! npm run --silent ghost >/dev/null 2>&1`, installCommand(order));
    const first = await acceptTask(stage.taskId);
    assert.equal(first.accepted, false, "设了门禁，第一按不合并");
    const run = await settled(stage.taskId);
    const log = readFileSync(run.logPath, "utf8");
    assert.equal(run.status, "passed", log);
    assert.equal(run.prepareCommand, installCommand(order), "这一次用的准备命令要落进记录");
    assert.equal(readFileSync(order, "utf8"), "prepare\ncommand\n", "先准备、后前置命令，各一次");
    assert.equal(readFileSync(saw, "utf8"), "SNAPSHOT", "测试解析到的是准备命令装进快照的那份依赖，不是主检出那份");
    assert.ok(run.cwd.startsWith(isolated) && !run.cwd.startsWith(root), `快照要住在 ash 与项目目录树之外（实际 ${run.cwd}）`);
    assert.equal(existsSync(preloaded), false, "NODE_OPTIONS 里的外来预加载不许跟进快照");
    assert.match(log, /准备命令通过，开跑验收前置命令/, "日志里分得出两段");
    assert.equal((await taskRow(stage.taskId)).stage, "accepted", "绿了自动把验收做完");
    assert.notEqual(git(stage.repo, "rev-parse", "main"), stage.before);
    assert.equal(existsSync(run.cwd), false, "快照（连同准备命令装出来的依赖）随门禁回收");
    assert.equal(existsSync(`${run.cwd}.inputs.json`), false);
  }

  // 2. 准备没过：前置命令一行都不跑，结论是 prepare_failed，不是测试红；不合并、目标分支不动。
  {
    const marker = join(root, "fail-command-ran.txt");
    const stage = await seed("prepfail", `touch ${marker}`, "echo 依赖装不上 >&2; exit 4");
    await acceptTask(stage.taskId);
    const run = await settled(stage.taskId);
    assert.equal(run.status, "failed");
    assert.equal(run.failure, "prepare_failed");
    assert.equal(run.exitCode, 4, "退出码是准备命令的");
    assert.equal(existsSync(marker), false, "准备没过，前置命令不许起");
    assert.match(readFileSync(run.logPath, "utf8"), /依赖装不上/);
    assert.equal(git(stage.repo, "rev-parse", "main"), stage.before, "目标分支一个字节都不许动");
    assert.notEqual((await taskRow(stage.taskId)).stage, "accepted");
    assert.equal(existsSync(run.cwd), retainedUntilConcluded(run.logPath), "快照照常随收尾回收");
    const view = gateView(run);
    assert.match(summarizeAcceptGate(view), /准备命令 `echo 依赖装不上 >&2; exit 4` 失败（rc=4），测试没有开跑/);
    assert.match(gateFailureInputFor(view, stage.ws), /&& echo 依赖装不上 >&2; exit 4\n/, "交回去复现的是准备命令");
    const state = await acceptGateState(stage.taskId);
    assert.equal(state.prepare, "echo 依赖装不上 >&2; exit 4");
    assert.equal(state.latest?.failure, "prepare_failed");
    assert.equal(state.latest?.stale, false);
    // 准备命令换了，那一次就不再替现在这一套作证。
    await db.update(projects).set({ acceptGatePrepare: "true" }).where(eq(projects.id, stage.projectId));
    assert.equal((await acceptGateState(stage.taskId)).latest?.stale, true, "换了准备命令，旧结论不作数");
    // 撤掉前置命令、留着准备命令：状态里仍是保存着的那一条，卡片才能据它把留空的那一格清掉。
    await db.update(projects).set({ acceptGateCommand: null }).where(eq(projects.id, stage.projectId));
    const withdrawn = await acceptGateState(stage.taskId);
    assert.equal(withdrawn.command, null);
    assert.equal(withdrawn.prepare, "true", "准备命令不随前置命令撤掉而投影成空");
    // 跨机接力：准备那一档的记录搬得出去、也读得进来。
    const exported = await collectGateRuns(stage.taskId);
    assert.equal(exported[0]?.prepareCommand, "echo 依赖装不上 >&2; exit 4");
    const manifest = (runs: unknown[]) => ({ task: {}, acceptGateRuns: runs }) as unknown as Parameters<typeof validateGatePayload>[0];
    validateGatePayload(manifest(exported));
    validateGatePayload(manifest([{ ...exported[0], id: "launcherfail", status: "interrupted", failure: "launcher_failed", exitCode: null }]));
    assert.throws(() => validateGatePayload(manifest([{ ...exported[0], prepareCommand: 4 }])), /prepareCommand 非法/);
  }

  // 3. 准备过了、测试红了：仍是 exit_code，退出码是前置命令的。
  {
    const order = join(root, "red-order.txt");
    const stage = await seed("red", `echo command >> ${order}; exit 5`, installCommand(order));
    await acceptTask(stage.taskId);
    const run = await settled(stage.taskId);
    assert.equal(run.status, "failed");
    assert.equal(run.failure, "exit_code", "准备过了之后的红就是测试红");
    assert.equal(run.exitCode, 5);
    assert.equal(readFileSync(order, "utf8"), "prepare\ncommand\n");
    assert.equal(existsSync(run.cwd), retainedUntilConcluded(run.logPath));
  }

  // 4. 快照位置往上能找到依赖目录就拒跑（不靠「这台机器上大概没有」）。
  {
    const repo = makeRepo("ancestor");
    const target = join(root, "runs", "ancestor-task", "accept-gate-probe.source");
    await assert.rejects(createGateSnapshot(repo, target, await readGateSource(repo, target, true)),
      /往上能找到依赖目录 .*node_modules/, "快照放在装着依赖的目录树下面就不许跑");
    assert.equal(existsSync(target), false);
    assert.ok((await readGateSource(repo, target, true)).ambient.startsWith(`${GATE_ENV_ISOLATION}:`), "环境隔离口径记进凭据");
  }

  // 4b. 环境隔离逐项：外来依赖一律去掉，快照自己的、与依赖无关的照留。
  {
    const snapshot = join(isolated, "unit", "accept-gate-x.source");
    const npmBins = join(tmpdir(), "global", "lib", "node_modules", "npm", "node_modules", "@npmcli", "run-script", "lib", "node-gyp-bin");
    const env = isolatedGateEnv({
      PATH: [join(foreign, ".bin"), npmBins, join(snapshot, "node_modules", ".bin"), "/usr/bin"].join(PATH_DELIMITER),
      NODE_PATH: "/anywhere", NODE_OPTIONS: `--max-old-space-size=4096 --require=${join(foreign, "preload.cjs")}`,
      npm_package_json: "/ash/package.json", npm_lifecycle_event: "start", INIT_CWD: "/ash", npm_config_local_prefix: "/ash",
      npm_config_registry: "https://registry.example", HOME: "/home/someone", OWN: join(snapshot, "node_modules", "x"),
    }, snapshot);
    assert.deepEqual(env, { PATH: [join(snapshot, "node_modules", ".bin"), "/usr/bin"].join(PATH_DELIMITER),
      npm_config_registry: "https://registry.example", HOME: "/home/someone", OWN: join(snapshot, "node_modules", "x") });
  }

  // 5. 阶段只由退出档说：日志写不进去照常推进；启动器自己出错、或退出档写不进去，一律「分不清」。
  {
    const stageDir = mkdtempSync(join(isolated, "bootstrap-"));
    writeFileSync(join(stageDir, "go"), "go");
    writeFileSync(join(stageDir, "occupied"), "a file, so nothing can be written beneath it");
    const unwritable = join(stageDir, "occupied", "x");
    const launch = async (name: string, prepare: string, command: string,
      opts: { exitWritable?: boolean; logBroken?: boolean; guardFile?: string } = {}) => {
      const logPath = join(opts.exitWritable ? stageDir : unwritable, `${name}.log`);
      const marker = join(stageDir, `${name}-command-ran`);
      const config = { ...userShellLaunch(`touch ${marker}; ${command}`), prepare: userShellLaunch(prepare), cwd: stageDir, restoreEnv: {},
        go: join(stageDir, "go"), abort: join(stageDir, "abort"), exit: `${logPath}.exit.json`, prepared: "\n[ash] 准备命令通过\n",
        ...(opts.guardFile ? { macGuard: "/usr/bin/true", macGuardFile: opts.guardFile } : {}) };
      // 只读打开的日志 fd：往上写就是真实的 EBADF，跟磁盘满时 writeSync 抛错走同一条路。
      const log = opts.logBroken ? openSync(join(stageDir, "occupied"), "r") : "ignore";
      const child = spawn(process.execPath, ["-e", GATE_BOOTSTRAP, Buffer.from(JSON.stringify(config)).toString("base64")],
        { stdio: ["ignore", log, log] });
      if (typeof log === "number") closeSync(log);
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done, fail) => {
        child.once("error", fail);
        child.once("exit", (code, signal) => done({ code, signal }));
      });
      const recorded = readGateExit(logPath, child.pid!);
      assert.equal(!!recorded, !!opts.exitWritable, `${name}：退出档写没写下来要符合这一条的前提`);
      return { outcome: gateExitOutcome(recorded ?? unrecordedGateExit(exit, true)), commandRan: existsSync(marker) };
    };
    const unknown = { status: "interrupted", exitCode: null, failure: "launcher_failed" };
    const pick = ({ status, exitCode, failure }: { status: string; exitCode: number | null; failure: string | null }) => ({ status, exitCode, failure });
    // 日志写不进去：准备过了照样起前置命令，结论按真实那一段。
    const broken = await launch("broken-log", "true", "exit 0", { exitWritable: true, logBroken: true });
    assert.deepEqual([pick(broken.outcome), broken.commandRan], [{ status: "passed", exitCode: 0, failure: null }, true],
      "日志写不进去只少几行字，不许打断阶段推进、也不许冒充测试红");
    const brokenPrep = await launch("broken-log-prep", "exit 4", "exit 0", { exitWritable: true, logBroken: true });
    assert.deepEqual([pick(brokenPrep.outcome), brokenPrep.commandRan], [{ status: "failed", exitCode: 4, failure: "prepare_failed" }, false]);
    // 启动器自己出错：记成「分不清」，不是某一段的退出码。
    const crashed = await launch("launcher-error", "true", "exit 0", { exitWritable: true, guardFile: join(unwritable, "guard.pid") });
    assert.deepEqual([pick(crashed.outcome), crashed.commandRan], [unknown, false]);
    // 退出档写不进去：不论停在哪一段、退出码是多少，都不猜。
    for (const [name, prepare, command, ran] of [["prep-red", "exit 4", "exit 0", false], ["cmd-red", "true", "exit 5", true],
      ["cmd-green", "true", "exit 0", true]] as const) {
      const result = await launch(name, prepare, command);
      assert.deepEqual([pick(result.outcome), result.commandRan], [unknown, ran], `${name}：没有退出档就分不清，不判红、不交修`);
    }
    // 没配准备命令时不动：老路原样按退出码说话；被信号打死、起不来也照旧。
    assert.equal(gateExitOutcome(unrecordedGateExit({ code: 3, signal: null }, false)).failure, "exit_code");
    assert.equal(gateExitOutcome(unrecordedGateExit({ code: null, signal: "SIGTERM" }, true)).failure, "canceled");
    assert.equal(gateExitOutcome(unrecordedGateExit({ code: null, signal: null }, true)).failure, "spawn_failed");
  }

  // 6. 没配准备命令：老路，记录与日志里都没有准备那一段。
  {
    // 祖先目录里的依赖只为前面几条准备命令的用例摆着；老路自有它对祖先依赖的登记与证明，这一条不去碰。
    rmSync(join(root, "node_modules"), { recursive: true, force: true });
    // 老路的环境原样继承（这一条只钉「没被改动」，不替它下对错的结论）。
    const stage = await seed("plain", "command -v ghosttool >/dev/null", null);
    // 主检出不装依赖：这一条只验「老路没被改动」，不去碰借用那一套自己的证明。
    rmSync(join(stage.repo, "node_modules"), { recursive: true, force: true });
    await acceptTask(stage.taskId);
    const run = await settled(stage.taskId);
    assert.equal(run.status, "passed", readFileSync(run.logPath, "utf8"));
    assert.equal(run.prepareCommand, null);
    assert.equal(readFileSync(run.logPath, "utf8").includes("准备命令"), false);
    assert.equal((await acceptGateState(stage.taskId)).prepare, null);
  }

  console.log("✅ 门禁准备命令：准备 → 前置命令 → 回收；准备失败 / 测试红 / 通过分得清；快照不在依赖树下、环境里也没有外来依赖；阶段证据不足就如实说分不清；没配的走老路");
} finally {
  await releaseTmpDb();
}
