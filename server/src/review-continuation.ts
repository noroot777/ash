import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "./db/index.js";
import { monitors, regressionEvidence, scheduledMessages, tasks } from "./db/schema.js";
import type { ConclusionTransaction } from "./regression-conclusion-commit.js";
import type { WaitOrigin } from "./db/schema-task-wait.js";
import { dirname } from "node:path";
import { freeReviewEvidenceDir } from "./free-review-files.js";
import { isTurnClaimed, type TurnSource } from "./runs.js";
import { activeReviewEvidence, assertReviewAuthority, reviewDeliveryAuthority, reviewIdentityMatches, ReviewSuperseded,
  reviewTargetIdentity, type ReviewDelivery } from "./review-ownership.js";
import { recordReviewWait, reviewWaitAuthorized, reviewWaitAtTurnStart, snapshotReviewWait } from "./review-wait.js";
import { autoCheckpointOwner, questionWaitMatches, questionWaitOrigin, reviewWaitOrigin,
  startTaskWaitTurn } from "./task-wait-ownership.js";
import { rememberGuardedStart, clearGuardedStart } from "./guarded-turn-start.js";
import type { ReviewStartReceipt } from "./review-start-withdrawal.js";
import { now } from "./util.js";

export { activeReviewEvidence } from "./review-ownership.js";

type TaskRow = typeof tasks.$inferSelect;
type EvidenceRow = typeof regressionEvidence.$inferSelect;

export async function reviewContinuationPending(transaction: ConclusionTransaction, owner: TaskRow, state?: EvidenceRow,
  hasConclusion = false, ignoreActive = false): Promise<boolean> {
  if (!ignoreActive && (["running", "queued"].includes(owner.status) || isTurnClaimed(owner.id))) return true;
  if (!state || state.settlement) return false;
  if (!await reviewWaitAuthorized(transaction, state)) return false;
  if (state.continuation?.phase === "uncertain") return true;
  const ownsWait = (origin: WaitOrigin | undefined) =>
    origin?.kind === "review" && origin.directory === state.directory && origin.generation === state.generation;
  const question = owner.question && questionWaitMatches(owner) && ownsWait(owner.waitOwnership?.question?.origin);
  // `resumePromptAuto` = 这一格是**系统替任务自己写的**(task-complete.ts 的 landCheckpoint:
  // 名下还有没了结的哨兵,这一轮只能按暂停收尾)。它常常写在审查窗口里,而归属推断
  // (task-wait-ownership.ts 的 writerOrigin)会把它记到审查头上,所以 `origin` 这一问单独
  // 不够用。
  //
  // 但「是不是系统代写的」**答不了**「是不是执行者的」—— 那道闸对回合身份一视同仁,审查旁路
  // 回合自己也会被代写这么一格。早先拿 auto 当执行者的同义词,于是审查还在等后台构建、系统
  // 也已经把这一轮改成检查点暂停,结算却读成「没有人在等」,round 以 status:"error"、
  // conclusion:null 提前结账(自由审查实测复现)。
  //
  // 判据改成**哪个回合写的**(reviewOwnsAutoCheckpoint:写它的回合 role 是 reviewer、而且绑的
  // 正是这一轮):执行者遗留的那一格照旧不挡审查交卷,审查自己还没交卷的等待照旧挡得住。
  // 非 auto 的那种本来就没这层歧义(真人/agent 自己挂的),只看归属。expireTaskWait 同源。
  //
  // 第三态 `unknown`(升级前的存量行,或者补记时不在回合里)在这一侧**不能**按「不是审查的」
  // 算:那正是「还不知道」被读成「确定不是」。但也不能一律当成审查的 —— 执行者遗留的那一格
  // 同样可能没记 writer,那样就退回 D6 之前「交卷被别人的等待挡住」。所以 unknown 这一档去问
  // 一个**跟字段无关的运行时事实**:这一轮审查自己挂的哨兵还在跑吗(monitors 的
  // source_review_run/round 就是为这个记的)。还在跑 = 确有人在等,别结;没有 = 没人等它,
  // 按老规矩结算。第 2 轮自由审查 F3 的现场正是「旧等待 + 这一轮的哨兵仍 running」。
  const autoOwner = owner.resumePromptAuto
    ? autoCheckpointOwner(owner.waitOwnership?.checkpoint, state) : "review";
  const checkpointMine = autoOwner === "review"
    || (autoOwner === "unknown" && await roundStillWatching(transaction, owner.id, state));
  const checkpoint = owner.resumePrompt && checkpointMine
    && owner.waitOwnership?.checkpoint?.generation === owner.resumePromptGeneration
    && ownsWait(owner.waitOwnership.checkpoint.origin);
  // 「owner 还挂着东西在等」只能挡住**还没交卷**的那一轮。
  //
  // 早先这里还有一条 `|| state.continuation.phase === "waiting"` 的后门,于是:执行者挂哨兵、
  // pause_task 收尾,预约审查随即起跑;审查写完报告、落了 conclusion、正常退出 —— 结算这一拍
  // 读到「owner 挂着检查点 + 相位 waiting」(那个相位正是执行者那次 pause 由 recordReviewWait
  // 翻回去的),判成「审查在等续跑」,preserveReviewWait 之后直接 return。round 从此挂在
  // reviewing:验收 409、自动复审不开、修复交接不发,只有重启时的 reconcileFreeReviews 能救。
  // (本任务自己的第 1 轮审查就卡在这上面,现场见 docs/incidents.md「审查交卷后 round 挂死」。)
  //
  // 判据回到这个文件本来就写着的那一句(free-workflow.ts 审查旁路分支):**reviewer 已交卷
  // 就必须结算**。执行者的等待不归这一轮审查管 —— 消费它的是实现会话的续跑,不会有任何人
  // 回来替这一轮审查落账。交卷之前的等待照旧挡住(下一行的 hasConclusion),审查自己以提问/
  // 检查点收尾、还没给结论的那种场景一个字都没变。
  if ((question || checkpoint) && !hasConclusion) return true;
  const pending = await transaction.select().from(scheduledMessages)
    .where(and(eq(scheduledMessages.taskId, owner.id), eq(scheduledMessages.status, "pending")));
  return pending.some((message) => message.origin === `review-answer:${state?.generation}`
    || (!message.origin && message.mode === "queued" && (owner.verifyRound || owner.reviewOf
      ? message.sessionRole !== "reviewer"
      : message.sessionRole === "reviewer" && state?.directory === freeReviewEvidenceDir(owner.id, message.reviewRun ?? "", message.reviewRound ?? 0))));
}

/**
 * **这一轮审查自己挂的哨兵还在跑吗** —— 归属字段缺失时的替代事实。
 *
 * `monitors.source_review_run/round` 是哨兵创建时就落库的身份(见 schema-monitors.ts),
 * 跟 `wait_ownership.writer` 是两套独立记录,所以存量等待缺 writer 时它照样答得上来。
 * 旧哨兵行可能没记轮次,那就退到「同一次 run 的任何一轮」—— 宁可多挡一会儿。
 */
async function roundStillWatching(transaction: ConclusionTransaction, taskId: string,
  state: EvidenceRow): Promise<boolean> {
  const live = await transaction.select().from(monitors).where(and(
    eq(monitors.taskId, taskId), eq(monitors.status, "running"), eq(monitors.kind, "ash"),
    isNotNull(monitors.sourceReviewRun),
  ));
  const runDir = (run: string) => dirname(freeReviewEvidenceDir(taskId, run, 1));
  return live.some((row) => row.sourceReviewRound === null
    ? runDir(row.sourceReviewRun!) === dirname(state.directory)
    : freeReviewEvidenceDir(taskId, row.sourceReviewRun!, row.sourceReviewRound) === state.directory);
}

export async function preserveReviewWait(owner: TaskRow): Promise<void> {
  await db.transaction(async (transaction) => {
    const current = (await transaction.select().from(tasks).where(eq(tasks.id, owner.id)))[0];
    if (!current || !reviewIdentityMatches(current, reviewTargetIdentity(owner)) || (!current.question && !current.resumePrompt)) return;
    await recordReviewWait(transaction, current);
  }, { behavior: "immediate" });
}

export async function assertReviewTurnStart(taskId: string, turnToken: string, directionToken: string,
  delivery?: ReviewDelivery, reviewTurn = false): Promise<void> {
  if (!delivery && !reviewTurn) return;
  const generation = delivery?.generation;
  if (delivery && !generation) throw new ReviewSuperseded();
  await db.transaction(async (transaction) => {
    const task = (await transaction.select().from(tasks).where(eq(tasks.id, taskId)))[0];
    const evidence = generation ? (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.generation, generation)))[0]
      : task && await activeReviewEvidence(transaction, task);
    if (!task || !evidence || task.archived
      || task.activeTurnToken !== turnToken || task.activeDirectionToken !== directionToken) throw new ReviewSuperseded();
    if (delivery?.kind === "repair") await reviewDeliveryAuthority(transaction, delivery, taskId);
    if (delivery?.kind !== "repair") {
      const active = await activeReviewEvidence(transaction, task);
      if (active?.directory !== evidence.directory || evidence.settlement) throw new ReviewSuperseded();
      await assertReviewAuthority(transaction, { directory: evidence.directory, generation: evidence.generation, target: evidence.targetIdentity }, true);
      if (!task.waitOwnership?.start) await transaction.update(regressionEvidence)
        .set({ continuation: { ...evidence.continuation, phase: "running", start: undefined } })
        .where(eq(regressionEvidence.directory, evidence.directory));
    }
    if (task.waitOwnership?.start) await transaction.update(tasks).set({ waitOwnership: { ...task.waitOwnership,
      start: { ...task.waitOwnership.start, phase: "launching" } } }).where(eq(tasks.id, taskId));
  }, { behavior: "immediate" });
}

export async function queueReviewAnswer(transaction: ConclusionTransaction, task: TaskRow,
  message: typeof scheduledMessages.$inferInsert): Promise<boolean> {
  const origin = await questionWaitOrigin(transaction, task);
  if (origin.kind === "ordinary") return false;
  if (origin.kind === "unknown") throw new ReviewSuperseded();
  const state = await activeReviewEvidence(transaction, task);
  if (!state) throw new ReviewSuperseded();
  if (state.settlement || state.directory !== origin.directory || state.generation !== origin.generation) throw new ReviewSuperseded();
  await assertReviewAuthority(transaction, { directory: state.directory, generation: state.generation, target: state.targetIdentity }, true);
  await transaction.insert(scheduledMessages).values({ ...message, origin: `review-answer:${state.generation}` });
  await transaction.update(regressionEvidence).set({ continuation: { ...state.continuation, phase: "delivery", messageId: message.id } })
    .where(eq(regressionEvidence.directory, state.directory));
  return true;
}

export async function beginReviewContinuation(transaction: ConclusionTransaction, task: TaskRow, source: TurnSource,
  turnToken: string, directionToken: string, delivery?: ReviewDelivery): Promise<ReviewStartReceipt | undefined> {
  if (task.waitOwnership?.start?.phase === "uncertain") throw new Error("原审查输入是否执行尚不确定，已暂停自动重发；请核对执行记录后重新派审。");
  const deliveredState = delivery ? await reviewDeliveryAuthority(transaction, delivery, task.id) : undefined;
  const state = await activeReviewEvidence(transaction, task, source);
  if (delivery && delivery.kind !== "repair" && (!state || state.directory !== deliveredState?.directory)) throw new ReviewSuperseded();
  const identity = { turnToken, directionToken, directionEpoch: task.directionEpoch + 1 };
  if (!state || delivery?.kind === "repair") {
    await snapshotReviewWait(transaction, task, identity, { kind: "ordinary" });
    if (deliveredState && delivery?.kind === "repair") {
      if (deliveredState.finalization?.repair?.messageId === delivery.messageId) {
        await transaction.update(regressionEvidence).set({ finalization: { ...deliveredState.finalization,
          repair: { ...deliveredState.finalization.repair, identity } } })
          .where(eq(regressionEvidence.directory, deliveredState.directory));
      }
      const receipt: ReviewStartReceipt = { directory: deliveredState.directory, generation: deliveredState.generation,
        identity, repair: true, delivery,
        ...(deliveredState.finalization?.repair?.messageId === delivery.messageId ? { acceptedRepair: true } : {}) };
      await rememberGuardedStart(transaction, task, receipt, delivery.messageId);
      return receipt;
    }
    return;
  }
  const current = (await transaction.select().from(tasks).where(eq(tasks.id, task.id)))[0];
  await assertReviewAuthority(transaction, { directory: state.directory, generation: state.generation, target: state.targetIdentity }, true);
  if (!current || !reviewIdentityMatches(current, reviewTargetIdentity(task))
    || state.settlement || (state.taskId === task.id && !reviewIdentityMatches(current, state.targetIdentity))) throw new ReviewSuperseded();
  await startTaskWaitTurn(transaction, task, identity, reviewWaitOrigin(state));
  await transaction.update(regressionEvidence).set({
    ...(state.taskId === task.id ? { targetIdentity: { turnToken, directionToken, directionEpoch: task.directionEpoch + 1 } } : {}),
    continuation: { phase: delivery?.kind === "answer" ? "delivery" : delivery?.kind === "checkpoint" ? "waiting" : "running",
      start: { ownerTaskId: task.id, identity }, wait: reviewWaitAtTurnStart(task, turnToken, directionToken),
      ...(state.continuation?.messageId ? { messageId: state.continuation.messageId } : {}) },
  }).where(eq(regressionEvidence.directory, state.directory));
  const receipt = { directory: state.directory, generation: state.generation, identity, delivery };
  await rememberGuardedStart(transaction, task, receipt);
  return receipt;
}

export async function commitReviewTurnDelivery(taskId: string, receipt: ReviewStartReceipt | undefined,
  process?: { pid: number; unitToken?: string | null },
  persistRunner?: (transaction: ConclusionTransaction) => Promise<void>): Promise<void> {
  if (!receipt) return;
  await db.transaction(async (transaction) => {
    const task = (await transaction.select().from(tasks).where(eq(tasks.id, taskId)))[0];
    const start = task?.waitOwnership?.start;
    const state = (await transaction.select().from(regressionEvidence).where(eq(regressionEvidence.directory, receipt.directory)))[0];
    if (!task || !start || !state || state.generation !== receipt.generation
      || start.directory !== receipt.directory || start.generation !== receipt.generation
      || JSON.stringify(start.identity) !== JSON.stringify(receipt.identity) || !reviewIdentityMatches(task, receipt.identity)) throw new ReviewSuperseded();
    await persistRunner?.(transaction);
    if (receipt.delivery?.kind === "checkpoint") {
      await transaction.update(tasks).set({ resumePrompt: null, updatedAt: now() })
        .where(and(eq(tasks.id, taskId), eq(tasks.resumePrompt, receipt.delivery.text),
          eq(tasks.resumePromptGeneration, receipt.delivery.promptGeneration)));
    } else if (receipt.delivery) {
      const message = (await transaction.select().from(scheduledMessages)
        .where(eq(scheduledMessages.id, receipt.delivery.messageId)))[0];
      if (message?.taskId === taskId) await (await import("./pending-messages.js")).markSent(message, transaction);
    }
    if (!receipt.repair && !state.settlement) await transaction.update(regressionEvidence)
      .set({ continuation: { ...state.continuation, phase: "running", start: undefined } })
      .where(eq(regressionEvidence.directory, receipt.directory));
    await clearGuardedStart(transaction, task);
    const current = (await transaction.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
    await transaction.update(tasks).set({ waitOwnership: { ...current.waitOwnership,
      deliveredReview: { directory: receipt.directory, generation: receipt.generation, identity: receipt.identity,
        input: receipt.delivery, pid: process?.pid, unitToken: process?.unitToken, confirmedAt: now() } } })
      .where(eq(tasks.id, taskId));
  }, { behavior: "immediate" });
}
