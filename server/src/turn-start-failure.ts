// continueTask 的 catch 兜底:一轮没跑成(spawn 前抛错 / 流中途炸)时的失败交代与状态
// 恢复。从 orchestrator.ts 按职责拆出(那边顶到 700 行上限);依赖方向单向:这里不回头
// import orchestrator。
//
// 做四件事,顺序有讲究:
// 1. 基线降级的事先说(它在这一轮更早时已落库,说在失败交代之前才对得上发生顺序);
// 2. 失败交代(handle 还没赋值 = 连 spawn 都没到,原话按「未送达」抄给用户,判据与
//    措辞见 turn-failure.ts);
// 3. 按基线对账(必须在 afterSettlement 之前 —— turn-baseline.ts 的约定;不对账的话
//    下一轮 recordTurnBaseline 直接覆盖,验收事实快照永久丢失,审查实测);
// 4. 状态恢复:续聊回合出岔子不该把任务打差(同 settleTaskStatus 的约定),「清旁路
//    身份 + 回到原状态」包进队列认领临界区对推进原子可见(分开写的窗口会让推进漏记
//    交接);恢复 paused 不是检查点落位,quietAdvance 防静止成员被续跑。
import { eq } from "drizzle-orm";
import type { AgentType, SessionRole, TaskStatus } from "@ash/shared";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { setTaskStatus } from "./status.js";
import type { StopSettle } from "./runs.js";
import { reconcileTurnBaseline } from "./turn-baseline.js";
import { reportTurnFailure } from "./turn-failure.js";
import { announceBaseFallback } from "./base-fallback-notice.js";
import type { Workspace } from "./git.js";
import { afterSettlement } from "./settle-status.js";
import { now } from "./util.js";
import { interruptCliGoal } from "./task-cli-state.js";
import { forgetGuardedStart, recordReviewStartNotLaunched } from "./guarded-turn-start.js";
import { withdrawReviewStart, type ReviewStartReceipt } from "./review-start-withdrawal.js";
import { restoreUndeliveredReviewStart } from "./review-start-retry.js";

export async function recoverFailedTurnStart(input: {
  startReceipt?: ReviewStartReceipt;
  taskId: string;
  message: string;
  sessionRole: SessionRole;
  agentType: AgentType;
  /** 已经 spawn 出进程了吗(没有 = 原话一个字没送出去,要按未送达交代)。 */
  spawned: boolean;
  goalStarted?: boolean;
  goalStartFrom?: TaskStatus | null;
  /** 后端代写的续跑(system)不把输入当用户原话交代。 */
  systemTurn: boolean;
  undeliveredText: string;
  resumeSessionId?: string;
  stopped: StopSettle | null;
  baseFallback: Workspace["baseFallback"];
  baseFallbackTold: boolean;
}): Promise<void> {
  const { taskId, sessionRole, agentType } = input;
  if (!input.baseFallbackTold) {
    await announceBaseFallback(taskId, input.baseFallback, {
      sessionId: input.resumeSessionId, agentType, role: sessionRole,
    });
  }
  await reportTurnFailure({
    taskId, message: input.message, role: sessionRole, agentType,
    undelivered: input.spawned || input.systemTurn ? undefined : input.undeliveredText,
    target: { sessionId: input.resumeSessionId, agentType, role: sessionRole },
  });
  await reconcileTurnBaseline(taskId, false).catch(() => undefined);
  if (!input.spawned && input.startReceipt) {
    const current = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0];
    if (current?.nativeTurn) {
      await recordReviewStartNotLaunched(taskId, input.startReceipt);
      if (await restoreUndeliveredReviewStart(taskId, input.startReceipt, true)) return;
    }
    await withdrawReviewStart(taskId, input.startReceipt, null);
    return;
  }
  const row = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  const goalHeld = row && await interruptCliGoal(row, agentType, input.goalStarted ?? false);
  const restored = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  const back = (restored?.followUpFrom as TaskStatus | null | undefined) ?? (!goalHeld ? input.goalStartFrom : null);
  // 原生命令标记跟 followUpFrom 一样**只在本回合内有效**:CLI 还没起来就抛错时,正常
  // 那条清理路(settleTaskStatus)根本没跑过 —— 不在这儿清掉,标记就漏给下一轮,下一轮
  // 的真实结算会被整段跳过(当成「那是次压缩」)。
  const nativeTurn = !!row?.nativeTurn;
  const status = input.stopped ?? back ?? (goalHeld ? "paused" : "failed");
  const { serializeQueueClaims } = await import("./queue-seat.js");
  await serializeQueueClaims(async () => {
    if (back || nativeTurn) {
      await db
        .update(tasks)
        .set({ ...(back ? { followUpFrom: null } : {}), ...(nativeTurn ? { nativeTurn: false } : {}), updatedAt: now() })
        .where(eq(tasks.id, taskId));
    }
    await setTaskStatus(taskId, status, !input.stopped && back === "paused" ? { quietAdvance: true } : undefined);
  });
  await forgetGuardedStart(taskId, input.startReceipt);
  // 压缩连启动都没启动,更谈不上有结论 —— 跟正常结算同一口径(single-run.ts):整段
  // 跳过结算钩子。交给它的话,正在跑的那轮就地验证会被当成「验完了」收掉(清 verifyRound、
  // 涨 verifyRounds,却给不出 verified/verify_failed),白耗用户一轮验证配额。
  if (!nativeTurn) await afterSettlement(taskId, status, false, false, sessionRole, true, !input.stopped);
}
