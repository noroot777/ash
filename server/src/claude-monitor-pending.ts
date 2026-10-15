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
import { orphanRows, writeIfTaskAlive } from "./claude-monitor-write.js";
import { db } from "./db/index.js";
import { monitorPendingCalls, monitors, sessions } from "./db/schema.js";

/**
 * 一条语句最多带多少行（或多少个 id）。
 *
 * sqlite 的绑定变量有上限（本机 node:sqlite 是 250000，别的平台构建出来的不一定一样），
 * 而这张表的行数虽然天然有界，界在「每个 run 文件至多一条长期悬着的」——历史很长的任务
 * 总 run 数没有硬上限。顶爆的后果不是一行写不进去，而是**整轮 discard + 留账，下一轮重读
 * 又攒出同样大的一批**，永远过不去（第 12 轮审查 N6）。分批写的代价只是多几条语句。
 */
const BATCH = 200;

const batches = <T>(items: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += BATCH) out.push(items.slice(i, i + BATCH));
  return out;
};

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
  //
  // **「同一个 tool_use_id」要连来源会话一起问。** 这张表按 (task, ash 会话, tool_use) 分区，
  // 而投影行记的是 **CLI** 会话，两个命名空间不一样，所以先用 `sessions` 把它们对上。只按
  // tool_use_id 判的话，甲会话里已经成行的那条，会把乙会话里还悬着的同号调用一起销掉——
  // 入参的唯一出处就这么没了，乙那张卡再也出不来（第 13 轮审查 N1）。
  // **空归属不是通配符。** 两边都没有归属时按「都不知道」对上（键里都是空串），但「我这条
  // 有来源、库里那条没有」说明不了它们是同一条 —— 那时不许销账（第 14 轮审查 N2 实测：一条
  // 无归属的旧投影把另一条会话里还悬着的同号调用销了,那条调用唯一的恢复依据就此消失,它那
  // 张卡再也出不来）。代价只是这一行会被反复读回来(留着不会让显示出错,见上),比毁掉恢复
  // 依据便宜得多:宁可留着未决责任,也不拿一条证明不了的证据销账。
  const cliOf = new Map((await db
    .select({ id: sessions.id, cliSessionId: sessions.cliSessionId })
    .from(sessions)
    .where(eq(sessions.taskId, taskId)))
    .map((row) => [row.id, row.cliSessionId] as const));
  const settled = new Set((await db
    .select({ toolUseId: monitors.toolUseId, cliSessionId: monitors.cliSessionId })
    .from(monitors)
    .where(and(eq(monitors.taskId, taskId), eq(monitors.kind, "claude"))))
    .filter((row): row is { toolUseId: string; cliSessionId: string | null } => !!row.toolUseId)
    .map((row) => `${row.cliSessionId ?? ""}\u0000${row.toolUseId}`));
  const isSettled = (row: { sessionKey: string; toolUseId: string }): boolean =>
    settled.has(`${cliOf.get(row.sessionKey) ?? ""}\u0000${row.toolUseId}`);
  // 删除也按会话分区：跨会话删等于把乙那条一起带走。
  const stale = new Map<string, string[]>();
  for (const row of rows) {
    if (!isSettled(row)) continue;
    stale.set(row.sessionKey, [...(stale.get(row.sessionKey) ?? []), row.toolUseId]);
  }
  for (const [sessionKey, ids] of stale) {
    for (const batch of batches(ids)) {
      await db.delete(monitorPendingCalls).where(and(
        eq(monitorPendingCalls.taskId, taskId),
        eq(monitorPendingCalls.sessionKey, sessionKey),
        inArray(monitorPendingCalls.toolUseId, batch),
      ));
    }
  }
  for (const row of rows) {
    if (isSettled(row)) continue;
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
 * 它（文件被重写、位置回退）时没有任何字段需要更新。它靠的是 `(task_id, session_key,
 * tool_use_id)` 这个唯一键 —— **两条建库路径都得有**（见 db/schema-monitors.ts）。
 */
export async function syncPendingCalls(
  taskId: string, pending: readonly PendingCall[], cleared: readonly ClearedCall[],
): Promise<void> {
  const bySession = new Map<string, string[]>();
  for (const item of cleared) {
    bySession.set(item.sessionKey, [...(bySession.get(item.sessionKey) ?? []), item.toolUseId]);
  }
  for (const [sessionKey, ids] of bySession) {
    for (const batch of batches(ids)) {
      await db.delete(monitorPendingCalls).where(and(
        eq(monitorPendingCalls.taskId, taskId),
        eq(monitorPendingCalls.sessionKey, sessionKey),
        inArray(monitorPendingCalls.toolUseId, batch),
      ));
    }
  }
  for (const batch of batches(pending)) {
    // 落库资格跟插入同批（见 claude-monitor-write.ts）：门闸只在进入这个函数时问过一次。
    await writeIfTaskAlive(
      db.insert(monitorPendingCalls)
        .values(batch.map((item) => ({
          taskId, sessionKey: item.sessionKey, toolUseId: item.toolUseId,
          command: item.call.command, description: item.call.description,
          at: item.at, sourceRun: item.sourceRun,
        })))
        .onConflictDoNothing(),
      db.delete(monitorPendingCalls).where(orphanRows(monitorPendingCalls, taskId)),
    );
  }
}
