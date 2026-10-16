import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "./db/index.js";
import { sessionTurns, sessions } from "./db/schema.js";
import { id } from "./util.js";
// 回合区间的**写入端**。读取端在 `task-artifact-windows.ts`（产物归属按时间认人），表的语义写在
// `db/schema.ts` 的 `sessionTurns` 上，这里不复述。
//
// 为什么单独一个文件而不是直接在各执行路径里 insert：single / duet / team 三条路各自
// 收尾（`single-run.ts`、`duet/turn.ts`、`team/session-consumer.ts`），同一件事落三份
// 就会漂移——其中一条忘了写，那类任务的产物归属就静默退回「按 session 寿命认」，而那是
// 看不出来的（面板只是多列几个别人的东西）。
//
// 一个回合的生命周期是**两步**，别只做一半：
//   ① `openTurn` —— 开始那一刻，往表里落一行「开了，还没收口」。
//   ② `recordTurnSpan` —— 收尾那一刻，按同一身份把 `ended_at` 补上。
// 只做第二步（原来的样子）就等于「写失败 = 什么都没发生」：后来成功的一轮一落账，读端
// 再也看不出中间少过东西,那一轮做出来的图被静默滤掉（第 4 轮审查必须修 1）。
//
// 起跑入口有**八处**（task-run 的 fresh run、orchestrator 的新建与复用、team/session 的
// 新建与复用、team/session-consumer 的 beginTurn、duet/turn 的新建与复用），所以那几个
// 字段从下面两个 helper 取,不要在调用处手写——漏一处就少计一个回合,而少计正好能抵掉
// 另一轮的真缺口（第 4 轮审查必须修 1 的根因就是漏了 task-run 那一处）。

/** 新建会话行时的回合字段：这是它的第 1 个回合,没有升级前的未知历史。 */
export const freshTurnFields = (at: string) => ({
  turnStartedAt: at,
  turnsStarted: 1,
  turnsBase: 0,
});

/**
 * 复用同一行会话、又开一个回合时要刷的字段。
 *
 * `endedAt: null` 也在这里：会话重新开跑就不再是「已收尾」,漏掉它的那一处会让读端把这条
 * 会话当成结束了的（区间按老的收尾时刻截断）。
 */
export const resumedTurnFields = (at: string) => ({
  turnStartedAt: at,
  turnsStarted: sql`COALESCE(${sessions.turnsStarted}, 0) + 1`,
  endedAt: null as string | null,
});

/**
 * 回合**开始**：落一行「从 X 开始、还没收口」。
 *
 * **绝不抛**，理由同 `recordTurnSpan`：这一行只影响产物面板的归属精度,而调用它的地方正在
 * 起跑。写不进去就退回老行为（只有收尾那一行,或者什么都没有）。
 *
 * 幂等：同一 (session_id, started_at) 再调一次什么都不做（接回、重试会重放同一个回合起点）。
 */
export async function openTurn(input: {
  sessionId: string;
  taskId: string;
  cwd: string | null | undefined;
  startedAt: string | null | undefined;
}): Promise<void> {
  if (!input.startedAt) return;
  try {
    await db.insert(sessionTurns).values({
      id: id(),
      sessionId: input.sessionId,
      taskId: input.taskId,
      cwd: input.cwd ?? null,
      startedAt: input.startedAt,
      endedAt: null,
    }).onConflictDoNothing();
  } catch (error) {
    console.warn(`[ash] 回合开始没落盘（产物归属降级为按会话寿命认）: ${String(error)}`);
  }
}

/**
 * 记下「这一回合从 X 跑到 Y，干活的目录是 Z」。
 *
 * **绝不抛**：这一行只影响产物面板的归属精度，而调用它的地方正在做回合结算——那条路上
 * 任何意外都会变成「任务状态结算不下去」。写不进去就降级回老行为（按 session 寿命认），
 * 代价是面板可能多列几个同目录别的任务的东西，不是数据错乱。
 *
 * **按身份收口,不是追加**：有开始行就补它的 `ended_at`；没有（开始那下没写成、或者是本
 * 函数早于 `openTurn` 的老路径）才插一条完整的。已经收过口的**不覆盖**——团队那边旧调度台
 * 也可能来收一次（`closeLead`），认第一次才叫幂等,否则同一回合的收尾时刻会被改晚。
 */
export async function recordTurnSpan(input: {
  sessionId: string;
  taskId: string;
  cwd: string | null | undefined;
  startedAt: string | null | undefined;
  endedAt: string;
}): Promise<void> {
  // 起点取不到就没有区间可言（宁可不记，也不要记一条起点是「现在」的假区间：那会把
  // 这一回合真正写出来的东西全判到区间之外）。
  if (!input.startedAt) return;
  const startedAt = input.startedAt;
  try {
    const existing = await db.select({ endedAt: sessionTurns.endedAt })
      .from(sessionTurns)
      .where(and(eq(sessionTurns.sessionId, input.sessionId), eq(sessionTurns.startedAt, startedAt)));
    if (!existing.length) {
      await db.insert(sessionTurns).values({
        id: id(),
        sessionId: input.sessionId,
        taskId: input.taskId,
        cwd: input.cwd ?? null,
        startedAt,
        endedAt: input.endedAt,
      }).onConflictDoNothing();
      return;
    }
    if (existing.some((row) => row.endedAt)) return; // 已经收过口：重放,不动
    await db.update(sessionTurns)
      .set({ endedAt: input.endedAt, cwd: input.cwd ?? null })
      .where(and(
        eq(sessionTurns.sessionId, input.sessionId),
        eq(sessionTurns.startedAt, startedAt),
        isNull(sessionTurns.endedAt),
      ));
  } catch (error) {
    console.warn(`[ash] 回合区间没落盘（产物归属降级为按会话寿命认）: ${String(error)}`);
  }
}
