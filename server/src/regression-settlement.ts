import type { ReviewConclusion } from "@ash/shared";
import { and, eq, isNotNull, or } from "drizzle-orm";
import { db } from "./db/index.js";
import { freeReviewRounds, regressionEvidence, tasks } from "./db/schema.js";
import type { RegressionFinalization, RegressionSettlement } from "./db/schema-regression-evidence.js";
import { checkRegressionConclusion, evidenceState } from "./regression-evidence-lifecycle.js";
import { RegressionConclusionRejected } from "./regression-conclusion-errors.js";
import { appendTaskTimeline, alertLine } from "./task-timeline.js";
import { isTurnClaimed, turnIdentity } from "./runs.js";
import type { ConclusionTransaction } from "./regression-conclusion-commit.js";
import { reviewRoundDir } from "./review-evidence.js";
import { reconcileRegressionFinalizations } from "./regression-finalization.js";
import { reviewContinuationPending } from "./review-continuation.js";
import { directionEpochUnchangedSince } from "./task-direction-epoch.js";
import { activeReviewScope, reviewIdentityMatches } from "./review-ownership.js";
import type { ReviewTargetIdentity } from "./db/schema-regression-evidence.js";
import { retireHistoricalReview } from "./review-retirement.js";
import { clearReviewWait, reviewWaitForExit } from "./review-wait.js";
import { announceResumePrompt } from "./task-resume-prompt.js";
import { now } from "./util.js";
import { expireClosedTaskWait } from "./task-wait-ownership.js";
import { reconcileReviewStarts } from "./review-start-withdrawal.js";

export type CheckedSettlement = {
  conclusion: ReviewConclusion;
  outcome: RegressionSettlement["outcome"];
  generation: string;
  recoveryOwnerTaskId?: string;
  target: ReviewTargetIdentity | null;
  /** 原样带到下半场：「活回合」那一问由调用方回答（见 `regressionSettlementConclusion` 的同名入参）。 */
  ignoreActive?: boolean;
  /** 原样带到下半场的**落笔条件**：上下两个事务各核一次（见 `SettlementFence`）。 */
  fence?: SettlementFence;
};

/**
 * **这一笔结算的落笔条件** —— 「我判断的时候这条任务停在第几个方向世代」。
 *
 * 只有**从外面判断「已经没有任何东西能把这一轮跑完」**的那条路(自由工作流的孤儿收尾)需要它。
 * 正常结算跑在回合锁里面,写的就是刚刚结束的那一轮,不存在「写的时候情况已经变了」。
 *
 * 孤儿收尾从读到写之间隔着好几次 await,另一份恢复完全可以在这中间把任务书送进会话、把审查者
 * 拉起来(第 3 轮审查 F1)。每个回合起跑(含审查旁路回合)都在自己那笔事务里把
 * `tasks.direction_epoch` +1(`turnDirectionStart`),所以「这中间起过回合」与「带着这个世代写得
 * 成」互斥。
 *
 * **两个事务都要核**:结算是两段式的 —— 上半场
 * (`regressionSettlementConclusion`)就已经把 `settlement={outcome,pending:true}` 和
 * `continuation.phase=exited` 落进证据行,下半场(`completeRegressionSettlement`)才写 round/run。
 * 只守下半场的话,迟到者照样在上半场把结算状态写成失败:那条正在输出的审查随后上报结论会被
 * 「本轮已进入结算,不能更改结论」拒掉,正常退出也沿用这份失败 settlement —— 最终那道闸撤回的
 * 只是 round/run,撤不回前一个事务(第 4 轮审查 F1 实测)。所以条件由调用方声明一次,**结算层
 * 在每一次持久写之前自己核**。
 */
export type SettlementFence = {
  taskId: string;
  directionEpoch: number;
  /**
   * **「这一轮此刻没有任何派发责任」** —— 孤儿收尾的另一半前提,也要在落笔那一刻自己成立。
   *
   * 为什么 `directionEpoch` 一位不够:它答的是「这中间有没有又起过**回合**」,而一次合法的接手
   * 压根不起回合 —— 公开 reviewing 的那一笔带着持久责任落库(`preparingReviewDispatch`),重跑
   * 也只是在同一段同步代码里换代次、重新登记。两者都不增长 epoch,于是「读完没人负责、下笔前
   * 有人接手了」这条路照样提交得了,把一个**活着的准备**打成 failed/error(第 2 轮审查问题 2
   * 复现 B:零故障注入,两次普通查询的返回顺序就够了)。
   *
   * 条件写成「**不存在**一行带着在途意图」而不是「存在一行且意图为空」:轮次行可能还没建
   * (对账那条路会在落笔前补建),而「行不在」本身并不意味着有人负责。
   */
  review?: { runId: string; round: number };
};

/** 落笔条件到此刻还成立吗。没有条件(正常结算)恒真。 */
async function fenceHeld(transaction: ConclusionTransaction, fence: SettlementFence | undefined): Promise<boolean> {
  if (!fence) return true;
  if (!(await transaction.select({ id: tasks.id }).from(tasks)
    .where(and(eq(tasks.id, fence.taskId), directionEpochUnchangedSince(fence.directionEpoch)))).length) return false;
  if (!fence.review) return true;
  return !(await transaction.select({ id: freeReviewRounds.id }).from(freeReviewRounds)
    .where(and(
      eq(freeReviewRounds.runId, fence.review.runId),
      eq(freeReviewRounds.round, fence.review.round),
      isNotNull(freeReviewRounds.dispatch),
    ))).length;
}

export async function regressionSettlementConclusion(taskId: string, directory: string, input: {
  outcome?: RegressionSettlement["outcome"];
  round: number;
  ownerTaskId?: string;
  freeRoundId?: string;
  acceptedMerge?: boolean;
  /**
   * 「owner 还有回合在跑」这一问由调用方自己回答过了,这里不再按 `tasks.status` 拦一次。
   *
   * 自由工作流的审查是**同一个任务上的旁路回合**:结算这一拍 owner 常常就是 running,所以
   * 那条分支从来都是自己带着 `ignoreActive=true` 判完才进来的(free-workflow.ts 审查旁路
   * 分支)。恢复路径(outcome 省略)下面那道闸要是再按 status 拦一次,就会把「执行者正在跑
   * 实现回合、这一轮审查早已交卷死透」的任务永远挡在结算之外 —— round 挂 reviewing,验收
   * 409(D6)。
   */
  ignoreActive?: boolean;
  /** 见 `SettlementFence`：孤儿收尾那一路的落笔条件，这一笔和下半场各核一次。 */
  fence?: SettlementFence;
}): Promise<CheckedSettlement | null> {
  await evidenceState(taskId, directory);
  const stored = await db.transaction(async (transaction) => {
    // **先问落笔条件,再读、再写**:这一笔要写的 `settlement` / `continuation` 就是后续结算的
    // 依据,迟到者在这里写下的失败,下半场那道闸撤不回去(见 `SettlementFence`)。上面那句
    // `evidenceState` 不在闸内:它只在证据行压根不存在时补一行空壳(这条路上它一定已经存在,
    // 是 `launchReviewRound` 开头落的),不影响任何结算判定。
    if (!await fenceHeld(transaction, input.fence)) return null;
    const state = (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, directory)))[0]!;
    const owner = (await transaction.select().from(tasks).where(eq(tasks.id, input.ownerTaskId ?? taskId)))[0];
    if (input.outcome === "done" && owner && !state.settlement
      && await reviewContinuationPending(transaction, owner, state, !!input.freeRoundId, true)) return null;
    if (state.taskId !== taskId) throw new Error("审查证据所属任务不匹配");
    const target = (await transaction.select().from(tasks).where(eq(tasks.id, taskId)))[0];
    const row = input.freeRoundId
      ? (await transaction.select({ conclusion: freeReviewRounds.conclusion }).from(freeReviewRounds)
        .where(eq(freeReviewRounds.id, input.freeRoundId)))[0]
      : (await transaction.select({ conclusion: tasks.stage }).from(tasks).where(eq(tasks.id, taskId)))[0];
    const currentConclusion = (input.freeRoundId || target && reviewIdentityMatches(target, state.targetIdentity))
      && (row?.conclusion === "verified" || row?.conclusion === "verify_failed") ? row.conclusion : null;
    if (input.outcome === undefined && (!owner || await reviewContinuationPending(transaction, owner, state,
      !!input.freeRoundId && currentConclusion !== null, input.ignoreActive))) return null;
    let settlement: RegressionSettlement = state.settlement ?? {
      outcome: input.outcome ?? "failed", conclusion: currentConclusion, round: input.round, ownerTaskId: input.ownerTaskId ?? taskId,
      ...(input.freeRoundId ? { freeRoundId: input.freeRoundId } : {}), pending: true, target: state.targetIdentity,
    };
    if (settlement.round !== input.round || settlement.ownerTaskId !== (input.ownerTaskId ?? taskId)
      || settlement.freeRoundId !== input.freeRoundId) throw new Error("审查结算身份不匹配");
    if (settlement.pending && settlement.outcome === "done" && input.outcome && input.outcome !== "done") {
      settlement = { ...settlement, outcome: input.outcome };
    }
    const wait = await reviewWaitForExit(transaction, owner, state);
    await transaction.update(regressionEvidence).set({ settlement, continuation: { ...state.continuation, phase: "exited", start: undefined, wait } })
      .where(eq(regressionEvidence.directory, directory));
    return { conclusion: settlement.conclusion, outcome: settlement.outcome, generation: state.generation,
      target: settlement.target ?? null, unknown: !state.settlement && input.outcome === undefined };
  }, { behavior: "immediate" });
  if (!stored) return null;
  const { conclusion, outcome } = stored;
  const checked: CheckedSettlement = { conclusion, outcome, generation: stored.generation, target: stored.target,
    ...(input.outcome === undefined ? { recoveryOwnerTaskId: input.ownerTaskId ?? taskId } : {}),
    ...(input.ignoreActive ? { ignoreActive: true } : {}),
    ...(input.fence ? { fence: input.fence } : {}),
  };
  if (stored.unknown) await appendTaskTimeline(taskId, alertLine("审查缺少持久保存的真实退出结果，不能因已有通过结论推定正常结束；本轮按异常结束处理。"));
  if (outcome !== "done" || !checked.target) return checked;
  try {
    await checkRegressionConclusion(taskId, directory, conclusion ?? "", undefined, true);
    return checked;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof RegressionConclusionRejected) {
      await appendTaskTimeline(taskId, alertLine(`通过结论的依据已失效：${message}`));
      return { ...checked, conclusion: "verify_failed" };
    }
    await appendTaskTimeline(taskId, alertLine(`验证依据暂不可核验，保留结论及审查轮次，恢复后可重试：${message}`));
    return null;
  }
}

export async function completeRegressionSettlement(directory: string, checked: CheckedSettlement,
  write: (transaction: ConclusionTransaction) => Promise<boolean> = async () => true,
  /** 函数形态 = 收尾计划要看 `write` 在事务里读到的状态才定得下来，在 `write` 成功之后求值。 */
  finalization?: RegressionFinalization | (() => RegressionFinalization)): Promise<boolean> {
  let changedOwner: string | undefined;
  const completed = await db.transaction(async (transaction) => {
    const state = (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, directory)))[0];
    if (checked.recoveryOwnerTaskId) {
      const owner = (await transaction.select().from(tasks).where(eq(tasks.id, checked.recoveryOwnerTaskId)))[0];
      // `checked.ignoreActive`:上半场判过「活回合」了,这里不许按 owner 的 status 再拦一次 ——
      // 否则自由工作流那条自愈走完上半场就停在「settlement 挂着 pending」上,round 照旧 reviewing。
      if (!owner || await reviewContinuationPending(transaction, owner, state, false, checked.ignoreActive)) return false;
    }
    if (!state?.settlement?.pending || state.generation !== checked.generation || state.settlement.outcome !== checked.outcome) return false;
    // 上半场声明的落笔条件在这里**再核一遍**:两段之间还隔着结论复核、时间线这些 await,
    // 而这一笔写的是 round/run 的终态(见 `SettlementFence`)。
    if (!await fenceHeld(transaction, checked.fence)) {
      console.error(`[ash] 审查结算撤回 ${directory}：判断之后这条任务又起过回合`);
      return false;
    }
    // 同上：存量 revoked=1 的旧轮次，没交依据就不许把通过结论落定（新轮次 revoked 恒为 0，这一支不触发）。
    if (checked.target && checked.outcome === "done" && checked.conclusion === "verified" && state.revoked && !state.acceptedBasis) return false;
    const owner = (await transaction.select().from(tasks).where(eq(tasks.id, state.settlement.ownerTaskId)))[0];
    const ownsRound = owner && (await activeReviewScope(transaction, owner))?.directory === directory;
    const wait = ownsRound ? await reviewWaitForExit(transaction, owner, state) : undefined;
    if (!await write(transaction)) return false;
    if (owner && await clearReviewWait(transaction, owner, state)) changedOwner = owner.id;
    const waitingTurn = owner?.waitOwnership?.turn;
    const ownsLegacyTurn = owner && (waitingTurn ? waitingTurn.origin.kind !== "ordinary"
      && waitingTurn.origin.directory === directory && reviewIdentityMatches(owner, waitingTurn.identity)
      : !wait?.owner || reviewIdentityMatches(owner, wait.owner));
    if (owner?.reviewOf && ownsRound && ["paused", "queued"].includes(owner.status) && ownsLegacyTurn) {
      await transaction.update(tasks).set({ status: state.settlement.outcome, updatedAt: now() }).where(eq(tasks.id, owner.id));
      changedOwner = owner.id;
    }
    await transaction.update(regressionEvidence).set({ settlement: { ...state.settlement, pending: false },
      ...(finalization ? { finalization: typeof finalization === "function" ? finalization() : finalization } : {}),
    })
      .where(eq(regressionEvidence.directory, directory));
    return true;
  }, { behavior: "immediate" });
  if (completed && changedOwner) await announceResumePrompt(changedOwner);
  return completed;
}

export async function recordInterruptedRegressionReview(task: typeof tasks.$inferSelect): Promise<boolean> {
  if (task.waitOwnership?.start && await (await import("./review-start-retry.js"))
    .restoreUndeliveredReviewStart(task.id, task.waitOwnership.start)) return true;
  const taskId = task.reviewOf ?? task.id, round = task.reviewOf ? task.reviewRound : task.verifyRound;
  if (!round) return false;
  const directory = reviewRoundDir(taskId, round);
  const state = await evidenceState(taskId, directory);
  if (!state.settlement) await regressionSettlementConclusion(taskId, directory, { round, ownerTaskId: task.id, outcome: "failed" });
  return false;
}

export async function reconcileRegressionSettlements(ownerTaskId?: string): Promise<void> {
  await reconcileReviewStarts(ownerTaskId);
  await (await import("./free-review-reconcile.js")).reconcileFreeReviews(ownerTaskId)
    .catch((error) => console.error("[ash] 自由审查发现待重试:", error));
  const candidates = await db.select().from(tasks).where(or(isNotNull(tasks.verifyRound), isNotNull(tasks.reviewOf)));
  for (const task of candidates) {
    if (ownerTaskId && task.id !== ownerTaskId) continue;
    if (["running", "queued"].includes(task.status) || isTurnClaimed(task.id)) continue;
    const taskId = task.reviewOf ?? task.id, round = task.reviewOf ? task.reviewRound : task.verifyRound;
    if (!round) continue;
    const state = (await db.select().from(regressionEvidence).where(eq(regressionEvidence.directory, reviewRoundDir(taskId, round))))[0];
    if (await retireHistoricalReview(task)) continue;
    if (state?.settlement || (!task.verifyRound && !state)) continue;
    if (await db.transaction((transaction) => reviewContinuationPending(transaction, task, state), { behavior: "immediate" })) continue;
    const { handleTaskSettlement } = await import("./review.js");
    await handleTaskSettlement(task.id, "failed", false, null).catch((error) => console.error(`[ash] 审查恢复待重试 ${task.id}:`, error));
  }
  const states = await db.select().from(regressionEvidence).where(isNotNull(regressionEvidence.settlement));
  for (const state of states) {
    const settlement = state.settlement;
    if (!settlement?.pending || (ownerTaskId && settlement.ownerTaskId !== ownerTaskId)) continue;
    const owner = (await db.select().from(tasks).where(eq(tasks.id, settlement.ownerTaskId)))[0];
    if (!owner) continue;
    if (settlement.freeRoundId) {
      // 自由工作流的审查是**同一个任务上的旁路回合**,所以这里不能问「owner 忙不忙」:执行者
      // 被哨兵结果叫醒去跑实现回合时它一直 running,而这一轮审查早就交卷死透了 —— 按状态跳过
      // 等于让挂着 pending 的结算永远补不上(D6,判据同 reconcileFreeReviews)。
      const held = turnIdentity(owner.id);
      if (held ? held.role === "reviewer" : owner.status === "running" || owner.status === "queued") continue;
      await (await import("./free-workflow.js")).handleFreeWorkflowSettlement(owner.id, "failed", false, null, "reviewer")
        .catch((error) => console.error(`[ash] 自由审查恢复待重试 ${owner.id}:`, error));
      continue;
    }
    if (owner.status === "running" || owner.status === "queued" || isTurnClaimed(owner.id)) continue;
    if (owner.reviewOf ? owner.reviewOf !== state.taskId || owner.reviewRound !== settlement.round
      : owner.id !== state.taskId || owner.verifyRound !== settlement.round) continue;
    const { handleTaskSettlement } = await import("./review.js");
    await handleTaskSettlement(owner.id, settlement.outcome, false, null)
      .catch((error) => console.error(`[ash] 审查结算待重试 ${owner.id}:`, error));
  }
  await reconcileRegressionFinalizations(ownerTaskId);
  const waiting = await db.select().from(tasks).where(ownerTaskId ? eq(tasks.id, ownerTaskId)
    : or(isNotNull(tasks.question), isNotNull(tasks.resumePrompt)));
  for (const owner of waiting) {
    const changed = await db.transaction(async (transaction) => {
      const current = (await transaction.select().from(tasks).where(eq(tasks.id, owner.id)))[0];
      return !!current && await expireClosedTaskWait(transaction, current);
    }, { behavior: "immediate" });
    if (changed) await announceResumePrompt(owner.id);
  }
}

let retrying = false;
export function startRegressionSettlementRecovery(): void {
  const timer = setInterval(async () => {
    if (retrying) return;
    retrying = true;
    try { await reconcileRegressionSettlements(); }
    catch (error) { console.error("[ash] 审查结算重试失败:", error); }
    finally { retrying = false; }
  }, 30_000);
  timer.unref();
}
