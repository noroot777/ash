// 悬着的 Monitor 调用（读到了 `tool_use`、还没配上 `task_started`）的**落盘与恢复**。
//
// 为什么非落盘不可：那一行是**入参的唯一出处**（命令、说明），而身份要等下一行才有。上一版
// 把这段状态只放内存，靠「读取位置绝不越过一条还悬着的调用」来保证那一行可以重放 —— 代价是
// 位置会被**永远不会完结的调用**钉死：
//
//   - 启动被拒 / 校验失败：有 `is_error` 回执，但**没有** `task_started`
//   - 进程在那一行之后被杀：连回执都没有
//
// 于是每一轮都从那一行重读同一个窗口，末尾的 Monitor 永远读不到（第 11 轮审查实测：12 轮
// 固定输入，`blast` 一次都没出现；第 8～10 轮是同一类的前几个实例）。
//
// 落盘之后分工干净：
//   - **位置**只管单调往前（`claude-monitor-backfill.ts` 的 `checkpointCursors`）
//   - **悬着的调用**由这张表独立恢复，不受内存上限和读取窗口影响
//   - 「`task_started` 配不上任何调用 ⇒ 那个工具不是 Monitor」这条推理照旧成立，因为悬着的
//     调用一定在（内存里或这张表里），不再依赖「位置没越过它」
import { and, eq, inArray } from "drizzle-orm";
import type { MonitorCall } from "./claude-monitors.js";
import { db } from "./db/index.js";
import { monitorPendingCalls, monitors } from "./db/schema.js";

export type PendingCall = {
  /** 读到它的那条 ash 会话 id（`pending` 按会话分区）。 */
  sessionKey: string;
  toolUseId: string;
  call: MonitorCall;
  /** 那条 assistant 事件的时刻 = 起点区间的下界。 */
  at: string | null;
  sourceRun: string | null;
};

/** 已经完结、该从表里销掉的调用（配上了 `task_started`，或确证起不来）。 */
export type ClearedCall = { sessionKey: string; toolUseId: string };

/** 按会话分桶（`scanSession` 新建会话桶时取它）。 */
export async function loadPendingCalls(taskId: string): Promise<Map<string, PendingCall[]>> {
  const rows = await db.select().from(monitorPendingCalls)
    .where(eq(monitorPendingCalls.taskId, taskId));
  const out = new Map<string, PendingCall[]>();
  if (!rows.length) return out;
  // **自愈**：已经成行的那些（库里有同一个 `tool_use_id` 的 Monitor）早就配上了，只是当初
  // 那一笔删除没落地（提交成功、紧接着写失败）。留着不会让显示出错，但会一直被读回来 ——
  // 就地清掉，免得越积越多。
  const settled = new Set((await db
    .select({ toolUseId: monitors.toolUseId })
    .from(monitors)
    .where(and(eq(monitors.taskId, taskId), eq(monitors.kind, "claude"))))
    .map((row) => row.toolUseId)
    .filter((value): value is string => !!value));
  const stale = rows.filter((row) => settled.has(row.toolUseId)).map((row) => row.toolUseId);
  if (stale.length) {
    await db.delete(monitorPendingCalls).where(and(
      eq(monitorPendingCalls.taskId, taskId),
      inArray(monitorPendingCalls.toolUseId, stale),
    ));
  }
  for (const row of rows) {
    if (settled.has(row.toolUseId)) continue;
    const bucket = out.get(row.sessionKey) ?? [];
    bucket.push({
      sessionKey: row.sessionKey, toolUseId: row.toolUseId,
      call: { command: row.command, description: row.description },
      at: row.at, sourceRun: row.sourceRun,
    });
    out.set(row.sessionKey, bucket);
  }
  return out;
}

/**
 * 把这一轮的未决状态落下来：完结的删掉、还悬着的补上。
 *
 * **只在确认提交之后调用**（见 `TaskScan.committedThrough`）：没提交的那几条路会回退读取
 * 位置、把那些行重新读一遍，这时落盘只会留下一份马上又会被重建的拷贝。
 *
 * 写入用 `onConflictDoNothing`：同一个 `tool_use_id` 的内容来自同一行不变的日志，重复读到
 * 它（文件被重写、位置回退）时没有任何字段需要更新。
 */
export async function syncPendingCalls(
  taskId: string, pending: readonly PendingCall[], cleared: readonly ClearedCall[],
): Promise<void> {
  const bySession = new Map<string, string[]>();
  for (const item of cleared) {
    bySession.set(item.sessionKey, [...(bySession.get(item.sessionKey) ?? []), item.toolUseId]);
  }
  for (const [sessionKey, ids] of bySession) {
    await db.delete(monitorPendingCalls).where(and(
      eq(monitorPendingCalls.taskId, taskId),
      eq(monitorPendingCalls.sessionKey, sessionKey),
      inArray(monitorPendingCalls.toolUseId, ids),
    ));
  }
  if (!pending.length) return;
  await db.insert(monitorPendingCalls)
    .values(pending.map((item) => ({
      taskId, sessionKey: item.sessionKey, toolUseId: item.toolUseId,
      command: item.call.command, description: item.call.description,
      at: item.at, sourceRun: item.sourceRun,
    })))
    .onConflictDoNothing();
}
