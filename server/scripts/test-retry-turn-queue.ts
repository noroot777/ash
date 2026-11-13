// 「重试这一回合 / 继续本轮审查」与串行队列:队列那道闸只挡续跑档(真正的任务执行)。
//
// 现场(2026-11-13):串行队列第 0 位是一条已完成的自由任务,它的第 1 轮审查因上游 503 断了;
// 排在第 4 位的成员正在执行。点「继续本轮审查」得到 409「队列前面还有未完成的任务」——它前面
// 没有任务,挡路的排在后面;而「再审一轮」、手打同一句话发出去都不受队列限制。
//
//  Q1 审查档:同队有人在执行 → 202,审查回合照常跑;队列按原终态看它,不停住、不多拉成员;
//  Q2 重投档:同上;重投期间挡路的成员完成,队列照常往下拉下一个(没被这条续聊卡住);
//  Q3 续跑档:同队有人在执行 → 仍然 409,带 blockedBy,那句话点名挡路任务的标题;留痕记「重试这一回合」;
//  Q4 /run 被同队成员挡回:那句话点名挡路任务的标题;
//  Q5 审查档被别的原因挡回:留痕的操作名是「继续本轮审查」。
//
// 执行器是装在 PATH 上的假 claude:收到输入就记一行、一直挂着,直到用例放行那个任务。
// 跑:npm -w server run test:retry-turn-queue
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { IS_WINDOWS } from "../src/platform.js";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-retry-turn-queue-"));
const inputLog = join(root, "inputs.jsonl");
const releaseDir = join(root, "release");
mkdirSync(releaseDir, { recursive: true });
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
// 设了 ASH_RUNS_DIR 就有测试隔离闸;这里跑的是下面这个假 claude,显式放行。
process.env.ASH_ALLOW_REAL_AGENT = "1";
process.env.ASH_TEST_INPUT_LOG = inputLog;
process.env.ASH_TEST_RELEASE_DIR = releaseDir;
delete process.env.ASH_LAX_DONE;

const bin = join(root, "bin");
mkdirSync(bin, { recursive: true });
writeFileSync(join(bin, "fake-claude.js"), `const fs = require("fs");
const path = require("path");
const task = String(process.env.ASH_TASK_ID);
const resident = process.argv.includes("--input-format");
let buf = "";
let started = false;
function start(input) {
  fs.appendFileSync(process.env.ASH_TEST_INPUT_LOG, JSON.stringify({ task, input }) + "\\n");
  if (started) return;
  started = true;
  process.stdout.write(JSON.stringify({ type: "system", session_id: "retry-queue-" + task }) + "\\n");
  const timer = setInterval(() => {
    if (!fs.existsSync(path.join(process.env.ASH_TEST_RELEASE_DIR, task))) return;
    clearInterval(timer);
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id: "retry-queue-" + task }) + "\\n");
    process.exit(0);
  }, 20);
}
process.stdin.on("data", (d) => {
  buf += d;
  if (!resident) return;
  for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.includes('"control_request"')) continue;
    if (line.trim()) start(line);
  }
});
process.stdin.on("end", () => {
  if (resident) return;
  if (!buf || !process.env.ASH_TURN_TOKEN) return process.exit(1);
  start(buf);
});
`);
writeFileSync(
  join(bin, IS_WINDOWS ? "claude.cmd" : "claude"),
  IS_WINDOWS ? `@node "%~dp0fake-claude.js" %*\r\n` : `#!/bin/sh\nexec node "$(dirname "$0")/fake-claude.js" "$@"\n`,
  { mode: 0o755 },
);
process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;

const [{ db, ensureSchema }, schema, runRoutes, runs, { setTaskStatus }, { queueStatus }, transcript, store,
  { freeWorkflowState }, { freeReviewEvidenceDir }, { evidenceState }] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/task-run-routes.js"),
  import("../src/runs.js"),
  import("../src/status.js"),
  import("../src/scheduler.js"),
  import("../src/transcript.js"),
  import("../src/task-store.js"),
  import("../src/free-workflow-state.js"),
  import("../src/free-review-files.js"),
  import("../src/regression-evidence-lifecycle.js"),
]);
const { agents, freeReviewRounds, freeReviewRuns, groups, projects, queueItems, reviewerProfiles, sessions, taskNotices, tasks } = schema;

const api = new Hono();
runRoutes.mountTaskRunRoutes(api);
const post = (path: string, body: unknown = {}) => api.request(path, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

const at = new Date().toISOString();
const started: string[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (what: string, cond: () => boolean | Promise<boolean>, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) if (await cond()) return;
  assert.fail(`等不到:${what}`);
};
const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
const inputsOf = (taskId: string): string[] => existsSync(inputLog)
  ? readFileSync(inputLog, "utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { task: string; input: string })
    .filter((entry) => entry.task === taskId).map((entry) => entry.input)
  : [];
const sessionCount = async (taskId: string) => (await db.select().from(sessions).where(eq(sessions.taskId, taskId))).length;
const release = (taskId: string) => writeFileSync(join(releaseDir, taskId), "go");
const noticeActions = async (taskId: string) =>
  (await db.select({ action: taskNotices.action }).from(taskNotices).where(eq(taskNotices.taskId, taskId))).map((n) => n.action);

/**
 * 一条串行队列 [done 成员, 正在执行的成员, 还没开工的成员]。正在执行那条只是库里的状态 ——
 * 队列判据读的就是它;它一个进程都没有,用例想让它完成时直接 setTaskStatus。
 */
async function seedQueue(prefix: string, done: { workflowMode?: "free" }) {
  const ids = { done: `${prefix}-done`, running: `${prefix}-running`, next: `${prefix}-next` };
  const base = { projectId: "p", groupId: "g", mode: "single", agentType: "claude", executorId: null,
    autoTitle: false, useWorktree: false, createdAt: at, updatedAt: at } as const;
  await store.createTasks([
    { ...base, id: ids.done, title: `${prefix} 已完成的那条`, body: "已完成", status: "done", workflowMode: done.workflowMode ?? "preset" },
    { ...base, id: ids.running, title: `${prefix} 正在执行的那条`, body: "执行中", status: "running" },
    { ...base, id: ids.next, title: `${prefix} 排在最后的那条`, body: "轮到再说", status: "backlog" },
  ]);
  await db.insert(queueItems).values([ids.done, ids.running, ids.next]
    .map((taskId, position) => ({ queueId: `${prefix}-queue`, taskId, position, createdAt: at })));
  return ids;
}

/** 一条崩掉的普通回合:会话 exit 1,正文最后一段输入是 `lastInput`(null = 没有正文)。 */
async function crashedTurn(taskId: string, lastInput: { t: "user" | "system"; text: string } | null) {
  const sessionId = `${taskId}-session`;
  await db.insert(sessions).values({ id: sessionId, taskId, role: "single", agentType: "claude", executor: "claude",
    cwd: root, startedAt: at, turnStartedAt: at, endedAt: at, exitStatus: 1 });
  if (lastInput) {
    const path = transcript.sessionTranscriptPath(taskId, sessionId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, [
      `\x1e${JSON.stringify({ t: "user", agent: "claude", text: "开工", at })}`,
      "agent 干完了第一件事",
      `\x1e${JSON.stringify({ ...lastInput, agent: "claude", at })}`,
      "agent 刚开口就崩了",
    ].join("\n") + "\n");
  }
  return sessionId;
}

/** 一轮断掉的审查:链 failed、当前轮 error,页面上拿到的「继续本轮审查」身份照状态接口原样取。 */
async function failedReview(taskId: string) {
  const runId = `${taskId}-run`;
  await db.insert(freeReviewRuns).values({ id: runId, taskId, reviewerId: "reviewer", reviewerName: "reviewer",
    agentType: "claude", executorId: "ex", checkMode: "logic", retryLimit: 1, currentRound: 1, status: "failed",
    createdAt: at, updatedAt: at, finishedAt: at });
  await evidenceState(taskId, freeReviewEvidenceDir(taskId, runId, 1), await row(taskId));
  await db.insert(freeReviewRounds).values({ id: `${runId}-round`, runId, round: 1, status: "error", startedAt: at, endedAt: at });
  await db.insert(sessions).values({ id: `${taskId}-reviewer`, taskId, role: "reviewer", agentType: "claude",
    executor: "claude", cwd: root, startedAt: at, turnStartedAt: at, endedAt: at, exitStatus: 1 });
  const latest = (await freeWorkflowState(taskId)).reviews[0]!;
  const retry = latest.rounds.find((round) => round.round === latest.currentRound)?.retry;
  assert.ok(retry, "台子前提:状态接口给出了「继续本轮审查」的身份");
  return { runId, review: { runId: latest.id, round: latest.currentRound, generation: retry.generation } };
}

/** 那条已完成成员的回合在跑期间,队列始终按原终态看它,别的成员一个都没被拉起来。 */
async function assertQueueUntouched(ids: { done: string; running: string; next: string }) {
  const done = await row(ids.done);
  assert.equal(done.status, "running", "那条已完成成员的回合真的跑起来了");
  assert.equal(queueStatus(done), "done", "队列按 followUpFrom 把这一回合看成原终态");
  assert.equal((await row(ids.running)).status, "running", "挡路的那条照旧在执行");
  assert.equal((await row(ids.next)).status, "backlog", "队列没有因此多拉起一个成员");
  assert.equal(await sessionCount(ids.next), 0);
  assert.deepEqual(inputsOf(ids.next), []);
}

try {
  await ensureSchema();
  await db.insert(projects).values({ id: "p", name: "retry turn queue", repoPath: root, createdAt: at });
  await db.insert(groups).values({ id: "g", projectId: "p", name: "串行组", mode: "serial", paused: false, createdAt: at });
  await db.insert(agents).values({ id: "ex", name: "test", type: "claude", model: "test", isDefault: true });
  await db.insert(reviewerProfiles).values({ id: "reviewer", name: "reviewer", agentType: "claude", executorId: "ex",
    createdAt: at, updatedAt: at });

  // ── Q1 审查档 ──────────────────────────────────────────────────────────────
  {
    const ids = await seedQueue("q1", { workflowMode: "free" });
    const { runId, review } = await failedReview(ids.done);
    const res = await post(`/tasks/${ids.done}/retry-turn`, { review });
    const body = await res.json() as { mode?: string; error?: string };
    assert.equal(res.status, 202, `同队有人在执行时「继续本轮审查」应放行,实际 ${res.status}:${body.error ?? ""}`);
    assert.equal(body.mode, "review");
    started.push(ids.done);
    await until("审查回合跑起来", () => inputsOf(ids.done).length > 0);
    await until("审查回合落 running", async () => (await row(ids.done)).status === "running");
    await assertQueueUntouched(ids);
    const reviewRun = (await db.select().from(freeReviewRuns).where(eq(freeReviewRuns.id, runId))).at(0)!;
    assert.equal(reviewRun.status, "reviewing", "跑的是那一轮审查");
    release(ids.done);
    await until("审查回合结束", async () => (await row(ids.done)).status === "done" && !runs.turnIdentity(ids.done));
    await sleep(300);
    assert.equal((await row(ids.next)).status, "backlog", "审查回合收尾时也不多拉成员");
    assert.equal(await sessionCount(ids.next), 0);
    console.log("✓ Q1 审查档:同队有人在执行也放行,队列按原终态看它,不多拉成员");
  }

  // ── Q2 重投档 ──────────────────────────────────────────────────────────────
  {
    const ids = await seedQueue("q2", {});
    const sessionId = await crashedTurn(ids.done, { t: "user", text: "把标题也改一下" });
    const res = await post(`/tasks/${ids.done}/retry-turn`, { sessionId });
    const body = await res.json() as { mode?: string; error?: string };
    assert.equal(res.status, 202, `同队有人在执行时重投上一句话应放行,实际 ${res.status}:${body.error ?? ""}`);
    assert.equal(body.mode, "resend");
    started.push(ids.done);
    await until("重投的那句话进了执行器", () => inputsOf(ids.done).some((input) => input.includes("把标题也改一下")));
    await until("重投回合落 running", async () => (await row(ids.done)).status === "running");
    await assertQueueUntouched(ids);
    // 重投期间挡路的那条完成:队列照常往下拉,没被这条续聊卡住。
    await setTaskStatus(ids.running, "done");
    started.push(ids.next);
    await until("队列拉起下一个成员", () => inputsOf(ids.next).length > 0);
    assert.equal((await row(ids.next)).status, "running");
    release(ids.done);
    await until("重投回合结束,回到原终态", async () => (await row(ids.done)).status === "done" && !runs.turnIdentity(ids.done));
    release(ids.next);
    await until("下一个成员跑完", async () => !runs.turnIdentity(ids.next) && (await row(ids.next)).status !== "running");
    console.log("✓ Q2 重投档:同队有人在执行也放行,不停住队列、不多拉成员");
  }

  // ── Q3 续跑档 ──────────────────────────────────────────────────────────────
  {
    const ids = await seedQueue("q3", {});
    await crashedTurn(ids.done, { t: "system", text: "继续（从中断处）" });
    const res = await post(`/tasks/${ids.done}/retry-turn`, { sessionId: `${ids.done}-session` });
    const body = await res.json() as { error?: string; blockedBy?: string[] };
    assert.equal(res.status, 409, "续跑档是任务执行,同队有人在执行就得挡");
    assert.deepEqual(body.blockedBy, [ids.running], "409 带出挡路的成员");
    assert.match(body.error ?? "", /「q3 正在执行的那条」正在运行/, "那句话点名挡路的是哪条");
    assert.doesNotMatch(body.error ?? "", /队列前面/, "挡路的排在后面,不许说「队列前面」");
    assert.equal((await row(ids.done)).status, "done", "被挡回的那条不开新回合");
    assert.equal(await sessionCount(ids.done), 1);
    assert.deepEqual(await noticeActions(ids.done), ["重试这一回合"], "留痕跟按钮同名");
    console.log("✓ Q3 续跑档:同队有人在执行仍 409,点名挡路任务,留痕记「重试这一回合」");

    // ── Q4 /run 被同队成员挡回 ──
    const run = await post(`/tasks/${ids.next}/run`);
    const runBody = await run.json() as { error?: string; blockedBy?: string[] };
    assert.equal(run.status, 409);
    assert.ok(runBody.blockedBy?.includes(ids.running));
    assert.match(runBody.error ?? "", /「q3 正在执行的那条」/, "/run 的那句话同样点名挡路任务");
    console.log("✓ Q4 /run 被挡回:那句话点名挡路任务");
  }

  // ── Q5 审查档被别的原因挡回 ────────────────────────────────────────────────
  {
    const ids = await seedQueue("q5", { workflowMode: "free" });
    const { review } = await failedReview(ids.done);
    await db.update(groups).set({ paused: true }).where(eq(groups.id, "g"));
    const res = await post(`/tasks/${ids.done}/retry-turn`, { review });
    assert.equal(res.status, 409);
    assert.match((await res.json() as { error: string }).error, /分组已暂停/);
    assert.deepEqual(await noticeActions(ids.done), ["继续本轮审查"], "审查档留痕跟按钮同名");
    await db.update(groups).set({ paused: false }).where(eq(groups.id, "g"));
    console.log("✓ Q5 审查档被挡回:留痕记「继续本轮审查」");
  }
} finally {
  for (const taskId of started) release(taskId);
  await until("在跑的回合都退干净", () => started.every((taskId) => !runs.turnIdentity(taskId)), 15_000).catch((error) => {
    console.error(error);
  });
  // 收尾的结算与时间线还要再写几次库,给它们留一点时间,别让拆台的噪声盖住真问题。
  await sleep(300);
  await releaseTmpDb();
}
