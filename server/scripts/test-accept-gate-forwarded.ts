// 「runner 把落点转发走了」这一组端到端反例 —— 第 10 轮审查 F1/F2 的那两条，照它原样复现。
//
// 为什么单独一个文件：它跟 test-accept-gate-missing.ts 的用例形状不同（那边是真 npm 在**它
// 自己解释出来的那份 manifest** 上缺脚本；这边是 PATH 上有个同名包装器，把 npm 整个指到别的
// 目录去），而那个文件已经 650 行，离 700 行的上限只剩一点。
//
// 这两条反例钉住的是**现在的那条不变量**：起跑前的纯读 + 日志形状**永远**不足以说出「那条
// 命令一行都没跑到、不要为这件事改任何代码」。它们都是旧判据下的假阳性：
//
//   A（审查 F1）：包装器把 npm 指到 child，child 的脚本真跑了、真报了断言失败，而项目自己的
//     输出被 `>` 引到别的文件里 —— 于是旧判据的三件事全都成立（起跑前读根 manifest「没有」、
//     npm 自己报了同名 `Missing script`、日志里只剩 npm 自己的报错），一条真红被交成免修令。
//   B（审查 F2）：同一个包装器，而这次**是任务把 child 那份定义删了**。根 manifest 上一直没有
//     这个名字，于是「目标分支上也没有、开工基线上也没有」都成立 → 旧判据给 not-mine → 免修，
//     而正确的出路恰恰是把那个定义改回来。
//
// 所以这两条的断言分两段：先钉**前提**（旧判据的几件事确实都成立、项目代码确实跑过），再钉
// **产品**（failure 照实、归因只到 unknown、交回去的字里没有免修令）。前提断言不成立就是夹具
// 没搭对，照实改夹具 —— 别为了让它绿去放宽判据。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { acceptGateRuns, projects, sessions, tasks } from "../src/db/schema.js";
import { acceptTask } from "../src/task-accept.js";
import { gateFailurePrompt } from "../src/accept-gate-messages.js";
import { foreignOutputIn, runnerRanOrLookedElsewhere } from "../src/accept-gate-miss.js";
import { releaseTurn } from "../src/turn-lock.js";

type GateRow = typeof acceptGateRuns.$inferSelect;

type Ctx = {
  makeRepo: (name: string) => string;
  seedProject: (name: string, repo: string, gateCommand: string | null) => Promise<string>;
  seedTask: (projectId: string, repo: string, taskId: string, file: string) => Promise<string>;
  settled: (taskId: string) => Promise<void>;
  runsOf: (taskId: string) => Promise<GateRow[]> | { then: (f: (rows: GateRow[]) => unknown) => unknown };
  createdAt: string;
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

/** 这台机器上真正的 npm。包装器要 exec 它，不然自己转发给自己会无限递归。 */
const realNpm = () => execFileSync("sh", ["-lc", "command -v npm"], { encoding: "utf8" }).trim();

/** 写一个文件并让 node 自己校验一遍语法 —— 生成的脚本语法错了，看上去跟「门禁改了环境」一样。 */
function writeChecked(path: string, lines: string[]): void {
  writeFileSync(path, `${lines.join("\n")}\n`);
  execFileSync(process.execPath, ["--check", path]);
}

export async function testGateForwardedRunner(ctx: Ctx): Promise<void> {
  const npm = realNpm();
  const repo = ctx.makeRepo("gate-forwarded-runner");
  const ran = join(repo, "really-ran.log");
  mkdirSync(join(repo, "bin"), { recursive: true });
  mkdirSync(join(repo, "child"), { recursive: true });
  mkdirSync(join(repo, "bare"), { recursive: true });
  // 透明转发：自己什么都不打印，只把 npm 的落点挪到 child。审查反例原样 —— 它不伪造任何诊断。
  writeFileSync(join(repo, "bin", "npm"), `#!/bin/sh\nexec ${JSON.stringify(npm)} --prefix child "$@"\n`, { mode: 0o755 });
  // 被测程序：真跑、真报断言失败。跑没跑过由**快照之外**的这份文件作证（快照本身跑完会删）。
  writeChecked(join(repo, "fail.cjs"), [
    `require("node:fs").appendFileSync(${JSON.stringify(ran)}, "ran\\n");`,
    'console.log("ACCEPTANCE STARTED");',
    'try { require("node:assert").equal(1, 2, "ASSERTION FAILED"); }',
    "catch (failure) { console.log(String(failure)); process.exitCode = 1; }",
  ]);
  // npm 跑脚本时会把 cwd 换到 `--prefix` 指的那个包目录（实测），所以这两个路径都从 child 往上
  // 走一级 —— 写成 `fail.cjs` 会落在 child/ 里找、直接 MODULE_NOT_FOUND。
  const childScript = `node ../fail.cjs 2>&1; ${npm} --prefix ../bare run test:accept`;
  writeFileSync(join(repo, "bare", "package.json"), `${JSON.stringify({ name: "bare", private: true, scripts: { build: "echo bare" } }, null, 2)}\n`);
  writeFileSync(join(repo, "child", "package.json"), `${JSON.stringify({ name: "child", private: true, scripts: { "test:accept": childScript } }, null, 2)}\n`);
  // 根 manifest 上**从来没有**这个名字：起跑前那一层读的就是它。
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({ name: "forwarded-fixture", private: true, scripts: { build: "echo build" } }, null, 2)}\n`);
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "wrapper npm forwards to child; child really runs and fails");

  // 命令里的前置赋值把包装器放在 PATH 最前面，stdout 引到别处 —— 起跑前那一层照旧只看得见
  // `npm run test:accept`，于是它去读根 manifest。
  //
  // PATH 必须写成**字面量**（审查那条反例也是字面量）：带 `$PWD` 这种展开时，起跑前那一层
  // 会按「读不准的 shell 语义」交白卷，于是①压根不成立，反例也就不成立了。
  const command = `PATH=./bin:${dirname(npm)}:${dirname(process.execPath)}:/usr/bin:/bin`
    + " npm run test:accept > acceptance.out";
  const projectId = await ctx.seedProject("gate-forwarded-runner", repo, command);
  const taskId = "gateforwarded1";
  const wsPath = await ctx.seedTask(projectId, repo, taskId, "forwarded.txt");
  // 红了之后 ash 会把日志交回这个任务，而交接要有个会话可叫 —— 没有它，每条用例后面都会多
  // 出一行 continueWhenIdle 失败的噪音（判据跟交接本身无关，但噪音会盖住真的失败）。
  await db.insert(sessions).values({
    id: "gate-forwarded-session", taskId, role: "single", agentType: "claude", executor: "claude",
    cwd: repo, startedAt: ctx.createdAt, turnStartedAt: ctx.createdAt, endedAt: ctx.createdAt, activeMs: 0,
  });
  // 归因只认任务**自己记下的**开工起点（审查四 F2）：共享夹具的 seedTask 不写它，这里补上。
  await db.update(tasks).set({ worktreeStartCommit: git(wsPath, "rev-parse", "HEAD") }).where(eq(tasks.id, taskId));
  const latest = async () => (await ctx.runsOf(taskId) as GateRow[]).at(0)!;
  const again = async () => {
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, taskId));
    releaseTurn(taskId);
    await acceptTask(taskId);
    await ctx.settled(taskId);
    return latest();
  };
  const promptOf = (run: GateRow) => gateFailurePrompt({
    command: run.command, summary: "未通过", logPath: run.logPath, tail: "",
    cwd: run.cwd, sourceCwd: repo, failure: run.failure as "exit_code", diagnosis: run.diagnosis,
  });

  // ── 反例 A：项目代码真跑了、真红了，而旧判据的三件事全都成立 ──
  const forwarded = await again();
  const log = readFileSync(forwarded.logPath, "utf8");
  assert.ok(existsSync(ran), "前提：被测程序真的跑起来了（快照之外那份记录在）");
  assert.match(readFileSync(ran, "utf8"), /ran/, "前提：它至少跑了一遍");
  assert.equal(/ACCEPTANCE STARTED|ASSERTION FAILED/.test(log), false, "前提：项目自己的输出被引走了，日志里看不见");
  assert.match(log, /Missing script: "test:accept"/, "前提②：npm 自己报了同名缺失");
  assert.equal(foreignOutputIn(log, "npm"), false, "前提③：日志里剩下的全是 npm 自己的行");
  assert.equal(runnerRanOrLookedElsewhere(log, "npm"), false, "前提②′：npm 这次没交代它跑过什么或读的是别处");
  assert.deepEqual(JSON.parse(forwarded.entryProbe ?? "null"),
    { ask: "test:accept", file: "package.json", resolved: false, by: "被测快照 package.json 的 scripts" },
    "前提①：起跑前读的是根 manifest，那上面确实没有");
  // 产品：旧判据在这儿会说「一行都没跑到、不是断言失败、不要改代码」—— 三句全是错的。
  assert.equal(forwarded.failure, "exit_code", "真跑了、真红了，failure 必须照实（审查十 F1）");
  assert.notEqual(forwarded.missAttribution, "not-mine", "绝不许判成「不是这次改动的事」（审查十 F2）");
  assert.equal(forwarded.missAttribution, "unknown", "起跑前核到它不在，但责任只到未知");
  assert.match(forwarded.diagnosis ?? "", /证明不了它一行都没跑到/, "结论必须自己说破这一层证明不了");
  assert.match(forwarded.diagnosis ?? "", /PATH 上可能有个同名的包装器/, "并且点出落点可能被挪走这件事");
  assert.equal(/它要测的东西一行都没跑到/.test(forwarded.diagnosis ?? ""), false, "不许把「没启动」当事实说");
  const forwardedPrompt = promptOf(forwarded);
  assert.equal(forwardedPrompt.includes("不要为这件事改任何代码"), false, "交回去的字里绝不许有免修令");
  assert.match(forwardedPrompt, /定位到底是哪一条红的/, "照旧让它去定位、去修");

  // ── 反例 B：同一个包装器，而这次是**任务把 child 那份定义删了** ──
  // 根 manifest 上一直没有这个名字，所以按根目录去核会得出「目标分支上也没有、基线上也没有」。
  // 旧判据据此发免修令，而正确的出路恰恰是把 child 那个定义改回来。
  writeFileSync(join(wsPath, "child", "package.json"), `${JSON.stringify({ name: "child", private: true, scripts: { build: "echo child build" } }, null, 2)}\n`);
  git(wsPath, "add", "-A");
  git(wsPath, "commit", "-m", "this task deletes the child acceptance script");
  const deleted = await again();
  const deletedLog = readFileSync(deleted.logPath, "utf8");
  assert.match(deletedLog, /Missing script: "test:accept"/, "前提：npm 在 child 那份上报了同名缺失");
  assert.equal(foreignOutputIn(deletedLog, "npm"), false, "前提：日志里剩下的全是 npm 自己的行");
  assert.notEqual(deleted.missAttribution, "not-mine", "任务把定义删了，绝不许判成「不是这次改动的事」（审查十 F2）");
  assert.equal(deleted.failure, "exit_code", "也不许摆成「没启动」那一档");
  const deletedPrompt = promptOf(deleted);
  assert.equal(deletedPrompt.includes("不要为这件事改任何代码"), false, "更不许发免修令 —— 该做的正是把它改回来");
  assert.match(deletedPrompt, /跟本次改动无关/, "要无关就得它自己拿依据，不是模板替它断言");

  console.log("accept gate forwarded-runner: 包装器挪落点后真跑真红 / 任务删掉被转发那份定义 全部通过");
}
