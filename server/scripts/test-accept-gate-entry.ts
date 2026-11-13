// 「命令点名的入口不在被测的这棵树里」的端到端回归（判据在 server/src/accept-gate-entry.ts）。
//
// 钉住两档，处置相反：
//  · 核得准（入口是一个具体文件）：**不起跑**，这一行落成 entry_missing，卡片上是一句确定的话，
//    附它在目标分支上有没有；刷新（重新从库里读）后照样在。
//  · 核不准（npm 脚本）：照常起跑；红了把起跑前看到的那件事和原始输出并排摆，不下结论。
//
// 由 test-accept-gate.ts 在同一个进程里调用，共用它的临时库和夹具。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { acceptGateRuns, projects, sessions, tasks } from "../src/db/schema.js";
import { acceptTask } from "../src/task-accept.js";
import { acceptGateState } from "../src/accept-gate.js";
import { sessionTranscriptPath } from "../src/transcript.js";
import { releaseHeldTurn } from "../src/turn-lock.js";

type GateRow = typeof acceptGateRuns.$inferSelect;

type Ctx = {
  makeRepo: (name: string) => string;
  seedProject: (name: string, repo: string, gateCommand: string | null) => Promise<string>;
  seedTask: (projectId: string, repo: string, taskId: string, file: string) => Promise<string>;
  taskRow: (taskId: string) => Promise<{ stage: string | null }>;
  settled: (taskId: string) => Promise<void>;
  runsOf: (taskId: string) => PromiseLike<GateRow[]>;
  createdAt: string;
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

export async function testGateEntry(ctx: Ctx): Promise<void> {
  const repo = ctx.makeRepo("gate-entry");
  const projectId = await ctx.seedProject("gate-entry", repo, "./only-on-target.sh");
  const taskId = "gateentry0001";
  const wsPath = await ctx.seedTask(projectId, repo, taskId, "entry.txt");
  // 任务开工**之后**，目标分支才加进这个入口脚本 —— 跑的是任务那份更早的快照。
  writeFileSync(join(repo, "only-on-target.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "add gate entry script on target only");
  const before = git(repo, "rev-parse", "main");
  const session = "gate-entry-session";
  await db.insert(sessions).values({
    id: session, taskId, role: "single", agentType: "claude", executor: "claude",
    cwd: repo, startedAt: ctx.createdAt, turnStartedAt: ctx.createdAt, endedAt: ctx.createdAt, activeMs: 0,
  });
  const latest = async () => (await ctx.runsOf(taskId)).at(0)!;
  const timeline = () => readFileSync(sessionTranscriptPath(taskId, session), "utf8");

  // ① 核得准、不在、目标分支上有：不起跑，一句确定的话。
  const first = await acceptTask(taskId);
  assert.equal(first.accepted, false, "入口不在树里，这一按不许合并");
  await ctx.settled(taskId);
  const blocked = await latest();
  assert.equal(blocked.status, "failed");
  assert.equal(blocked.failure, "entry_missing", "核得准的那一档落成「没起跑」");
  assert.equal(blocked.exitCode, null, "没起跑就没有退出码");
  assert.equal(blocked.pid, null, "进程一个都不许起");
  assert.equal(git(repo, "rev-parse", "main"), before, "目标分支一动不动");
  assert.equal((await ctx.taskRow(taskId)).stage, "verified");
  const sentence = "被测的这棵树里没有 ./only-on-target.sh，命令没有起跑。目标分支 main 上有它。";
  // 「刷新后仍看得到」：卡片读的是这一份，每次都从库里那一行现算。
  const card = (await acceptGateState(taskId)).latest!;
  assert.equal(card.entryNote, sentence, "卡片上是一句确定的话，带目标分支上的情形");
  assert.equal(card.failure, "entry_missing");
  assert.equal(JSON.parse(blocked.entryProbe ?? "null")?.target?.has, true, "目标分支上的情形起跑前一次定下、跟着这一行落盘");
  assert.match(readFileSync(blocked.logPath, "utf8"), new RegExp(sentence.slice(0, 20)), "日志里也写着这句");
  if (!first.accepted) assert.ok(first.error?.includes(sentence), "MCP/HTTP 回执里也给出这句，不只甩原始报错");
  for (let i = 0; i < 200 && !/门禁交接/.test(timeline()); i++) await sleep(25);
  assert.ok(timeline().includes(sentence), "这句话进时间线");
  assert.match(timeline(), /门禁交接：已叫醒该任务去看这条命令的入口为什么不在被测的树里/, "照常交回给任务");

  const again = async (command: string) => {
    await db.update(projects).set({ acceptGateCommand: command }).where(eq(projects.id, projectId));
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, taskId));
    releaseHeldTurn(taskId);
    await acceptTask(taskId);
    await ctx.settled(taskId);
    return { row: await latest(), view: (await acceptGateState(taskId)).latest! };
  };

  // ② 目标分支上也没有：照样不起跑，后半句如实说「也没有」。重定向不改变入口。
  const nowhere = await again("./scripts/nowhere.sh 2>/dev/null");
  assert.equal(nowhere.row.failure, "entry_missing");
  assert.equal(nowhere.view.entryNote, "被测的这棵树里没有 ./scripts/nowhere.sh，命令没有起跑。目标分支 main 上也没有。");

  // ③ 入口在树里、真跑了、真红了：一个字都不许多说。
  writeFileSync(join(wsPath, "kb.sh"), "#!/bin/sh\necho 真断言失败 >&2\nexit 4\n", { mode: 0o755 });
  git(wsPath, "add", "-A");
  git(wsPath, "commit", "-m", "task adds its own gate script");
  const real = await again("./kb.sh test full");
  assert.equal(real.row.failure, "exit_code");
  assert.equal(real.row.exitCode, 4);
  assert.equal(real.view.entryNote, null, "入口在树里，就没有入口那句话");

  // ④ 核不准（npm 脚本）：照常起跑，红了只并排摆起跑前看到的那件事。
  assert.doesNotThrow(() => execFileSync("sh", ["-lc", "command -v npm"], { stdio: "ignore" }),
    "这一条用真实 npm（门禁用登录 shell 起命令），登录 shell 里得有 npm");
  writeFileSync(join(wsPath, "package.json"), `${JSON.stringify({ name: "gate-entry", private: true, scripts: { build: "echo b" } })}\n`);
  git(wsPath, "add", "-A");
  git(wsPath, "commit", "-m", "manifest without the acceptance script");
  const script = await again("npm run test:accept");
  assert.notEqual(script.row.pid, null, "核不准就照常起跑");
  assert.equal(script.row.failure, "exit_code", "红法照实留在真实那一档");
  assert.equal(script.view.entryNote,
    "起跑前看到：被测快照 package.json 的 scripts 里没有 test:accept（这一项核不准，npm 可能按配置去别处找）。");
  assert.match(script.view.logTail, /Missing script/, "原始报错就摆在旁边");

  console.log("accept gate entry: 入口文件不在树里=不起跑+确定的一句话（目标分支有/没有）/ 入口在树里照常红 / npm 脚本核不准照常跑、只并排摆事实 全部通过");
}
