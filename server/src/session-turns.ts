import { db } from "./db/index.js";
import { sessionTurns } from "./db/schema.js";
import { id } from "./util.js";
// 回合区间的**写入端**。读取端在 `task-artifact-scope.ts`（产物归属），表的语义写在
// `db/schema.ts` 的 `sessionTurns` 上，这里不复述。
//
// 为什么单独一个文件而不是直接在各执行路径里 insert：single / duet / team 三条路各自
// 收尾（`single-run.ts`、`duet/turn.ts`、`team/session-consumer.ts`），同一件事落三份
// 就会漂移——其中一条忘了写，那类任务的产物归属就静默退回「按 session 寿命」，而那是
// 看不出来的（面板只是多列几个别人的东西）。
/**
 * 记下「这一回合从 X 跑到 Y，干活的目录是 Z」。
 *
 * **绝不抛**：这一行只影响产物面板的归属精度，而调用它的地方正在做回合结算——那条路上
 * 任何意外都会变成「任务状态结算不下去」。写不进去就降级回老行为（按 session 寿命认），
 * 代价是面板可能多列几个同目录别的任务的东西，不是数据错乱。
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
  try {
    await db.insert(sessionTurns).values({
      id: id(),
      sessionId: input.sessionId,
      taskId: input.taskId,
      cwd: input.cwd ?? null,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
    });
  } catch (error) {
    console.warn(`[ash] 回合区间没落盘（产物归属降级为按会话寿命认）: ${String(error)}`);
  }
}
