// 熔断修复期间 ask_question 的格式闸**绑在哪**：绑在「熔断那条修复交接实际送进去的那个方向」上。
//
// 上一版按「任务最近一轮审查结掉了、且那一轮熔断了」判，那是拿最近一条历史记录冒充「现在正在
// 处理哪一份修复」，两个方向都错（第 1 轮审查 R3 实测）：
//   · 用户裁定「这条意见不用改了」、再让执行者干别的，那条历史还在，普通澄清题照样被逼成二到四选一；
//   · 用户点名修一条**历史轮**（手动修复按 `opts.round` 取轮），交接里带着熔断指令，闸却只看最新
//     那一轮，于是指令说「交给用户选」、闸却不管格式。
//
// 所以开关是**投递事实**：熔断交接开跑的那一刻（`continueTask` 起跑、方向身份刚装上），把那个方向
// token 记到那一轮上（`free_review_rounds.breaker_direction`）；提问时只认「当前方向 = 记下的方向」。
// 用户发新消息、中途改派、裁定之后另起一轮，方向都会换掉，闸自然落下，不用另外清。
//
// 代价是**同一份修复跨回合续下去时闸也落下**（等哨兵结果被叫醒是新回合、新方向）。这是有意的：
// 二选一的那个决定落在收到指令的那一轮里，之后再提问已经说不清是不是那道选择题；闸落下的后果只是
// 一道题不被强制改写，反过来误拦的后果是用户的正常对话被卡住。
import { and, eq, inArray } from "drizzle-orm";
import { db } from "./db/index.js";
import { freeReviewRounds, freeReviewRuns, regressionEvidence } from "./db/schema.js";
import { freeReviewEvidenceDir } from "./free-review-files.js";
import type { ReviewDelivery } from "./review-ownership.js";
import { roundRecurrence } from "./review-recurrence.js";

/** 这一回合交进去的是哪一轮的修复交接：自动修复从投递收据反查，手动修复由调用方点名。 */
export type RepairSource = {
  reviewDelivery?: ReviewDelivery;
  recurrenceRound?: { runId: string; round: number };
};

async function repairRound(taskId: string, source: RepairSource): Promise<{ runId: string; round: number } | null> {
  if (source.recurrenceRound) return source.recurrenceRound;
  const delivery = source.reviewDelivery;
  if (delivery?.kind !== "repair") return null;
  const state = (await db.select({ taskId: regressionEvidence.taskId, directory: regressionEvidence.directory })
    .from(regressionEvidence).where(eq(regressionEvidence.generation, delivery.generation))).at(0);
  if (!state || state.taskId !== taskId) return null;
  const runs = await db.select({ id: freeReviewRuns.id }).from(freeReviewRuns).where(eq(freeReviewRuns.taskId, taskId));
  if (!runs.length) return null;
  const rounds = await db.select({ runId: freeReviewRounds.runId, round: freeReviewRounds.round }).from(freeReviewRounds)
    .where(inArray(freeReviewRounds.runId, runs.map((run) => run.id)));
  return rounds.find((row) => freeReviewEvidenceDir(taskId, row.runId, row.round) === state.directory) ?? null;
}

/**
 * 回合起跑、方向身份刚装上时调：这一回合交进去的是熔断那一轮的修复交接，就把方向记到那一轮上。
 * 判据与交接里附不附指令是同一个（`roundRecurrence`），两边读的是同一份落库承接。失败不拦起跑。
 */
export async function armRecurrenceBreaker(taskId: string, directionToken: string, source: RepairSource): Promise<void> {
  try {
    const target = await repairRound(taskId, source);
    if (!target || !await roundRecurrence(taskId, target.runId, target.round)) return;
    await db.update(freeReviewRounds).set({ breakerDirection: directionToken })
      .where(and(eq(freeReviewRounds.runId, target.runId), eq(freeReviewRounds.round, target.round)));
  } catch (error) {
    console.error(`[ash] 熔断修复的方向没记上 task=${taskId}:`, error);
  }
}

/** 当前方向是不是某一轮熔断修复交接送进去的那个方向。读失败按「不是」（闸是附加的，不许卡住提问）。 */
export async function recurrenceBreakerArmed(taskId: string, directionToken: string | null): Promise<boolean> {
  if (!directionToken) return false;
  try {
    const rows = await db.select({ id: freeReviewRounds.id }).from(freeReviewRounds)
      .innerJoin(freeReviewRuns, eq(freeReviewRuns.id, freeReviewRounds.runId))
      .where(and(eq(freeReviewRuns.taskId, taskId), eq(freeReviewRounds.breakerDirection, directionToken)));
    return rows.length > 0;
  } catch {
    return false;
  }
}
