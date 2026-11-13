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
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desc, eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-accept-gate-prepare-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.on("exit", () => { try { rmSync(root, { recursive: true, force: true }); } catch {} });
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
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: name, version: "1.0.0", private: true, dependencies: { dep: "1.0.0" } }));
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "seed");
  mkdirSync(join(repo, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "dep", "package.json"), JSON.stringify({ name: "dep", version: "1.0.0", main: "index.js" }));
  writeFileSync(join(repo, "node_modules", "dep", "index.js"), 'module.exports = "MAIN";\n');
  return repo;
}

// 准备命令：起跑时快照里必须还没有依赖目录（有就说明借进来了），然后现装一份说 SNAPSHOT 的 dep。
const installCommand = (order: string) => [
  `test ! -e node_modules || { echo 快照里已经有依赖目录 >&2; exit 9; }`,
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
    const stage = await seed("pass", `echo command >> ${order} && node -e "process.stdout.write(require('dep'))" > ${saw}`, installCommand(order));
    const first = await acceptTask(stage.taskId);
    assert.equal(first.accepted, false, "设了门禁，第一按不合并");
    const run = await settled(stage.taskId);
    const log = readFileSync(run.logPath, "utf8");
    assert.equal(run.status, "passed", log);
    assert.equal(run.prepareCommand, installCommand(order), "这一次用的准备命令要落进记录");
    assert.equal(readFileSync(order, "utf8"), "prepare\ncommand\n", "先准备、后前置命令，各一次");
    assert.equal(readFileSync(saw, "utf8"), "SNAPSHOT", "测试解析到的是准备命令装进快照的那份依赖，不是主检出那份");
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

  // 4. 没配准备命令：老路，记录与日志里都没有准备那一段。
  {
    const stage = await seed("plain", "true", null);
    // 主检出不装依赖：这一条只验「老路没被改动」，不去碰借用那一套自己的证明。
    rmSync(join(stage.repo, "node_modules"), { recursive: true, force: true });
    await acceptTask(stage.taskId);
    const run = await settled(stage.taskId);
    assert.equal(run.status, "passed", readFileSync(run.logPath, "utf8"));
    assert.equal(run.prepareCommand, null);
    assert.equal(readFileSync(run.logPath, "utf8").includes("准备命令"), false);
    assert.equal((await acceptGateState(stage.taskId)).prepare, null);
  }

  console.log("✅ 门禁准备命令：准备 → 前置命令 → 回收；准备失败 / 测试红 / 通过分得清；没配的走老路");
} finally {
  await releaseTmpDb();
}
