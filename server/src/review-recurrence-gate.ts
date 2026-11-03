// 熔断修复期间 ask_question 的格式闸**绑在哪**：绑在「熔断那份修复还在继续」这件事上。
//
// 按历史状态判两个方向都错（第 1 轮审查 R3）：用户裁定「不用改了」、再让执行者干别的，那条历史
// 还在，普通澄清题照样被逼成选择题；用户点名修一条历史轮，闸却只看最新一轮。只按回合的方向 token
// 判又漏了另一头（第 2 轮审查 F2）：熔断修复暂停到检查点、被续跑叫醒，那是**同一份修复**，token
// 却换了，闸跟着落下。
//
// 所以记的是方向**世代**（`tasks.direction_epoch`：每次回合起跑、每次改派都 +1，见
// task-direction-epoch.ts），在每次起跑时（`continueTask`，方向身份刚装上）按来源三选一：
//   · 送进去的是**熔断那一轮的修复交接**（自动修复从投递收据反查，手动修复由调用方点名）
//     → 把这一轮的世代记到那一轮上：闸开；
//   · **系统续跑**（检查点续跑、哨兵唤醒、重试，即 `system` / `monitorWake`）且上一个世代正是闸开
//     的那个 → 世代跟着前进：闸继续开；
//   · 其余一切 —— 用户发新消息、答复提问（用户已经拍过板）、裁定后让它接着干、下一轮审查起跑 ——
//     什么都不写：世代已经前进，记下的那个对不上，闸自然落下。回合中途的改派同理（改派推世代）。
// 不需要任何「清除」入口：只有上面两种起跑会把世代续上，漏掉一个入口的后果是闸落下（少拦一道题），
// 而不是闸卡着不走（误拦用户的正常对话）。
import { and, eq, inArray } from "drizzle-orm";
import { db } from "./db/index.js";
import { freeReviewRounds, freeReviewRuns, regressionEvidence, tasks } from "./db/schema.js";
import { freeReviewEvidenceDir } from "./free-review-files.js";
import type { ReviewDelivery } from "./review-ownership.js";
import { roundRecurrence } from "./review-recurrence.js";

/** 这一回合的来源（`ContinueTaskOptions` 里与此相关的那几项）。 */
export type RepairSource = {
  reviewDelivery?: ReviewDelivery;
  recurrenceRound?: { runId: string; round: number };
  system?: string;
  monitorWake?: unknown;
};

const taskRounds = (taskId: string) => db.select({ runId: freeReviewRounds.runId, round: freeReviewRounds.round })
  .from(freeReviewRounds).innerJoin(freeReviewRuns, eq(freeReviewRuns.id, freeReviewRounds.runId))
  .where(eq(freeReviewRuns.taskId, taskId));

async function repairRound(taskId: string, source: RepairSource): Promise<{ runId: string; round: number } | null> {
  if (source.recurrenceRound) return source.recurrenceRound;
  const delivery = source.reviewDelivery;
  if (delivery?.kind !== "repair") return null;
  const state = (await db.select({ taskId: regressionEvidence.taskId, directory: regressionEvidence.directory })
    .from(regressionEvidence).where(eq(regressionEvidence.generation, delivery.generation))).at(0);
  if (!state || state.taskId !== taskId) return null;
  return (await taskRounds(taskId)).find((row) => freeReviewEvidenceDir(taskId, row.runId, row.round) === state.directory) ?? null;
}

/**
 * 回合起跑、方向身份（连同世代）刚装上时调：按来源决定熔断闸要不要续到这一个世代（文件头三选一）。
 * 判据与交接里附不附指令是同一个（`roundRecurrence`），两边读的是同一份落库承接。失败不拦起跑。
 */
export async function carryRecurrenceBreaker(taskId: string, source: RepairSource): Promise<void> {
  try {
    const epoch = (await db.select({ epoch: tasks.directionEpoch }).from(tasks).where(eq(tasks.id, taskId))).at(0)?.epoch;
    if (epoch == null) return;
    const target = await repairRound(taskId, source);
    if (target) {
      if (!await roundRecurrence(taskId, target.runId, target.round)) return;
      await db.update(freeReviewRounds).set({ breakerEpoch: epoch })
        .where(and(eq(freeReviewRounds.runId, target.runId), eq(freeReviewRounds.round, target.round)));
      return;
    }
    if (!source.system && !source.monitorWake) return;
    const live = await db.select({ id: freeReviewRounds.id }).from(freeReviewRounds)
      .innerJoin(freeReviewRuns, eq(freeReviewRuns.id, freeReviewRounds.runId))
      .where(and(eq(freeReviewRuns.taskId, taskId), eq(freeReviewRounds.breakerEpoch, epoch - 1)));
    if (live.length) {
      await db.update(freeReviewRounds).set({ breakerEpoch: epoch }).where(inArray(freeReviewRounds.id, live.map((row) => row.id)));
    }
  } catch (error) {
    console.error(`[ash] 熔断修复的方向世代没续上 task=${taskId}:`, error);
  }
}

/** 这个世代是不是还在某一轮的熔断修复里。读失败按「不是」（闸是附加的，不许卡住提问）。 */
export async function recurrenceBreakerArmed(taskId: string, epoch: number): Promise<boolean> {
  try {
    const rows = await db.select({ id: freeReviewRounds.id }).from(freeReviewRounds)
      .innerJoin(freeReviewRuns, eq(freeReviewRuns.id, freeReviewRounds.runId))
      .where(and(eq(freeReviewRuns.taskId, taskId), eq(freeReviewRounds.breakerEpoch, epoch)));
    return rows.length > 0;
  } catch {
    return false;
  }
}
