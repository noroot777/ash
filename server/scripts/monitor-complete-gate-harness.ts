// `test-monitor-complete-gate.ts` 那套用例共用的台子：一个挂好真路由的 API、几个
// 「这一刻库里是什么样」的读法，外加两种只能预先铺好的现场（断在半路的 `complete_task`
// 调用记录、排在托盘里没送到的哨兵事件）。
//
// 为什么单独成文件：那份用例连这套台子一起是 706 行，超过单文件 700 行的约定（全局约定）。
// 拆法跟 `monitor-checkpoint-harness.ts` / `monitor-checkpoint-edges.ts` 一致 —— 台子一份，
// 各节按职责分文件，由主脚本按顺序驱动。各节**必须共用同一份台子**：复制一份出去，改了
// 形状只有一边跟着改，另一边悄悄测的是个过期现场。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
// 台子自己要用的那几个（`export … from` 不建立本地绑定，所以这一行不能省）。
import {
  db, monitors, monitorsModule, now, root, scheduledMessages, sessions, tasks, uniq,
} from "./monitors-fixture.js";
// 各节直接从台子上取,免得同一份夹具在两个文件里各写一份进口清单(改一处漏一处)。
export {
  db, inTurnCaller, insertMonitorRow, makeTask, monitors, now, pendingOf, reviewInFlight, runs,
  schema, scheduledMessages, sleep, startMonitor, stopMonitor, tasks, teardown, until,
} from "./monitors-fixture.js";
export const { serialize } = monitorsModule;
export const { clearAutoCheckpoint, restoreResumePrompt, takeResumePrompt, writeResumePrompt } =
  await import("../src/task-resume-prompt.js");
export const { monitorWakeCheckpoint } = await import("../src/monitor-session.js");
export { uniq } from "./monitors-fixture.js";
export const { redeliverResultHandoffs } = await import("../src/monitor-reattach.js");
export const { monitorsBlockingComplete } = await import("../src/task-complete-monitors.js");
export const { deliverResultHandoff } = await import("../src/monitor-events.js");
/** 底层 libsql 客户端：F1 的结构锁要数「闸到底发了几条语句」，只能从这一层看。 */
export const { dbClient } = await import("../src/db/index.js");

/** 哨兵整行（新列也在里面：交接凭证、放弃凭证）。 */
export const monitorRow = async (monitorId: string) =>
  (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0)!;

const { mountTaskRunRoutes } = await import("../src/task-run-routes.js");
const { sessionTranscriptPath } = await import("../src/transcript.js");
export const { settleTaskStatus } = await import("../src/settle-status.js");
export const { beginTerminalLanding, terminalLandingInFlight } = await import("../src/task-complete.js");
export const { setTaskStatus } = await import("../src/status.js");
export const { replayUndeliveredMcpCalls } = await import("../src/mcp-handoff.js");
const { RUNS_DIR } = await import("../src/paths.js");

const api = new Hono();
mountTaskRunRoutes(api);

export const complete = (taskId: string) => api.request(`/tasks/${taskId}/complete`, {
  method: "POST", headers: { "content-type": "application/json" }, body: "{}",
});
/**
 * 真人/agent 自己挂检查点走的那条**生产路由**。
 *
 * 用它而不是直接写库：这一列的归属判据（占用代次）只有在**所有** writer 都维护时才成立，而
 * 第 3 轮审查走穿的正是这条路由自己直写两列、不动代次（`F2_HTTP_PAUSE_GENERATION_BYPASS`）。
 */
export const pause = (taskId: string, resumePrompt: string, headers: Record<string, string> = {}) =>
  api.request(`/tasks/${taskId}/pause`, {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ resumePrompt }),
  });
export const taskRow = async (taskId: string) =>
  (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
export const confirmedAt = async (taskId: string): Promise<string | null> =>
  (await taskRow(taskId)).completeConfirmedAt ?? null;
export const monitorStatus = async (monitorId: string): Promise<string> =>
  (await db.select({ s: monitors.status }).from(monitors).where(eq(monitors.id, monitorId))).at(0)!.s;

/** 一条带回合起点的执行会话 —— 「本回合」这个时间窗就是从它身上读的。 */
export async function sessionWithTurn(
  taskId: string, turnStartedAt: string,
  opts: { id?: string; agentType?: string; startedAt?: string; turn?: boolean } = {},
): Promise<string> {
  const id = opts.id ?? `sess-${taskId}`;
  await db.insert(sessions).values({
    id, taskId, role: "single", agentType: opts.agentType ?? "claude", executor: "claude",
    cwd: root, startedAt: opts.startedAt ?? turnStartedAt,
    turnStartedAt: opts.turn === false ? null : turnStartedAt,
  });
  return id;
}
export const transcriptOf = (sessionId: string, taskId: string): string => {
  try { return readFileSync(sessionTranscriptPath(taskId, sessionId), "utf8"); }
  catch { return ""; }
};
/**
 * 主动撤掉一条哨兵时**进程那一侧**的样子（`ended_by='actor'`）。
 *
 * 只用在「这一回合撤过哪几个」那几节上 —— 那件事的判据就是这一列。**「结果我不要了」不在
 * 这里**：那是另一笔凭证（`results_abandoned_at`），而且只有真的 `stopMonitor` 写得出来，
 * 所以凡是要走那条出路的用例一律调真接口（第 2 轮审查 R2-3：预写终态字段证明不了出路通）。
 */
export const dropByActor = (monitorId: string, reason: string, endedAt = now()) =>
  db.update(monitors).set({ status: "stopped", endedAt, endedReason: reason, endedBy: "actor" })
    .where(eq(monitors.id, monitorId));
/** 一条哨兵推来的事件，还排在待发送托盘里。 */
export const queueMonitorEvent = async (taskId: string, monitorId: string, text: string): Promise<string> => {
  const id = uniq("msg");
  await db.insert(scheduledMessages).values({
    id, taskId, text, origin: `monitor:${monitorId}`, mode: "queued",
    sendAt: now(), status: "pending", createdAt: now(),
  });
  return id;
};

/**
 * 「`complete_task` 交到一半通道断了」那一笔**真实格式**的调用记录（codex 的 item 流）。
 *
 * 补录就是从这份文件里把它捞回来的，所以两节用例共用这一份 —— 各写一份的话，改了格式只
 * 会有一节跟着改，另一节悄悄测的是个过期形状。
 */
export function writeLostCompleteCall(taskId: string, sessId: string, turnStart: string): void {
  const stream = JSON.stringify({
    type: "item.completed",
    item: {
      id: "item_1", type: "mcp_tool_call", server: "ash", tool: "complete_task",
      arguments: { taskId }, result: null,
      error: { message: "tool call error: tool call failed for `ash/complete_task`\n\nCaused by:\n    Transport closed" },
      status: "failed",
    },
  });
  mkdirSync(join(RUNS_DIR, taskId), { recursive: true });
  writeFileSync(
    join(RUNS_DIR, taskId, `${sessId}-${turnStart.replace(/[^0-9A-Za-z]/g, "")}.agent-out.jsonl`),
    stream,
  );
}
