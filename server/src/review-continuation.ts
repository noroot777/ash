import { and, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { regressionEvidence, scheduledMessages, tasks } from "./db/schema.js";
import type { ConclusionTransaction } from "./regression-conclusion-commit.js";
import type { WaitOrigin } from "./db/schema-task-wait.js";
import { dirname } from "node:path";
import { freeReviewEvidenceDir } from "./free-review-files.js";
import { unsettledMonitorResponsibility } from "./monitor-responsibility.js";
import { isTurnClaimed, type TurnSource } from "./runs.js";
import { activeReviewEvidence, assertReviewAuthority, reviewDeliveryAuthority, reviewIdentityMatches, ReviewSuperseded,
  reviewTargetIdentity, type ReviewDelivery } from "./review-ownership.js";
import { recordReviewWait, reviewWaitAuthorized, reviewWaitAtTurnStart, snapshotReviewWait } from "./review-wait.js";
import { autoCheckpointOwner, questionWaitMatches, questionWaitOrigin, reviewWaitOrigin,
  startTaskWaitTurn } from "./task-wait-ownership.js";
import { resumePromptHeldBy, resumePromptTakePatch } from "./task-resume-prompt.js";
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
  // **这一轮的续跑交接已经立下、还没落地**:`beginReviewContinuation` 把它同时写进证据行的
  // `continuation.start` 和任务的 `wait_ownership.start`,只有三条路能销它 ——
  // `commitReviewTurnDelivery`(输入确实交到 CLI 手上了)、`restoreUndeliveredReviewStart`
  // (没送到,原答复留着下次再投)、`withdrawReviewStart`(自己写 settlement 收尾)。三条路
  // 都会把这一轮的账结清或原样留好,所以在它落地之前,这一轮**不是**无人认领的死账。
  //
  // 这一问跟「有没有回合在跑」是两件事,所以 `ignoreActive` 不许把它一起忽略掉:交接凭证是
  // 库里的持久事实,回合锁只活在内存里。两者分家的现场是答复续跑的那一瞬 —— 交接事务里,
  // 答复消息从 pending 翻成 sent 和交接凭证落库是同一笔,而「挂着一条待投递的答复」正是
  // 下面那条 pending 判据唯一的依据。凭证不算数的话,这一拍就谁都不认领:对账器按
  // 「reviewer 回合不在、owner 跑的是实现回合」把 round 记成 failed / conclusion:null,
  // 用户的答复连带整轮审查一起作废,而撤回路径(reconcileReviewStarts)因为回合锁被别人占着
  // 根本没机会跑 —— 它那一侧 `isTurnClaimed` 就跳过了。
  //
  // 身份核一遍再算:凭证的方向身份已经被新方向顶掉时,它既不可能再被确认、也不会被撤回
  // (restore/withdraw 两边都按身份核),拿这种过期凭证挡住结算就成了永久挂死 —— 那正是
  // 「交卷后 round 挂在 reviewing」那一类伤害。过期的一律不挡,按原判据继续往下走。
  if (continuationLeaseHeld(owner, state)) return true;
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
  // 一个**跟字段无关的运行时事实**:这一轮审查名下还欠着哨兵结果吗(monitors 的
  // source_review_run/round 就是为这个记的)。还欠着 = 确有人在等,别结;不欠了 = 没人等它,
  // 按老规矩结算。第 2 轮自由审查 F3 的现场正是「旧等待 + 这一轮的哨兵仍 running」。
  const autoOwner = owner.resumePromptAuto
    ? autoCheckpointOwner(owner.waitOwnership?.checkpoint, state) : "review";
  const checkpointMine = autoOwner === "review"
    || (autoOwner === "unknown" && await roundOwesResult(transaction, owner.id, state));
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
  // 回来替这一轮审查落账。交卷之前的等待照旧挡住(下面两档各自那一问),审查自己以提问/
  // 检查点收尾、还没给结论的那种场景一个字都没变。
  //
  // 但**提问**与检查点在这一点上不是一回事,`hasConclusion` 只该管后者:
  //
  //  · 检查点(含系统代写那一格)是「这一轮还想接着做」,交卷之后它说的话已经不改变任何结论,
  //    D6 明说的取舍就是让它让路 —— 上面那段讲的全是这一类。
  //  · 提问是一笔**还没完成的人工交接**:答复回来要续跑的正是这一轮(`/answer` →
  //    `review-answer:*` → 交接凭证 → 同一轮续跑)。这一轮要是先结掉,`queueReviewAnswer` 下一步
  //    就按 `state.settlement` 抛 ReviewSuperseded —— 用户照着界面上的问题写完答复,换来一句
  //    「原目标方向已失效」,问题悬着、答复丢掉、整轮审查记成 failed/conclusion:null。
  //
  // 同一条链的下半截(本函数最后那条 `review-answer:*` 判据)本来就不看交卷:答复一旦入队,
  // 交卷与否都挡得住。只有「问了、还没答」这一小段漏着,两头对不上。
  //
  // 另一头的旁证:preset / legacy 两条路的交卷退出(review-settlement.ts 的 `waitingForReview`)
  // 一直是写死 `hasConclusion=false` 调进来的 —— 也就是说「提问挡住结算」在那两条路上从来成立,
  // 只有自由工作流这一条按 round 的结论把它一起关掉了。这里把提问那一档拉回一致。
  //
  // 「别人遗留的旧 question」不靠这一位拦:`ownsWait(question.origin)` 已经答过了 —— 归属
  // 只在**写它的那一回合就是这一轮审查**时才记成 review(task-wait-ownership.ts 的
  // `writerOrigin`:先认回合身份,认不出来记 unknown,而 unknown 不满足 `ownsWait`)。
  if (question) return true;
  if (checkpoint && !hasConclusion) return true;
  // **一格等待都没留下、而这一轮自己的哨兵结果还排在托盘里**:同一类伤害的另一个入口(第 3 轮
  // 自由审查 F2 的旁证)。上面那三格全靠 `wait_ownership` 记着「有人在等」,可回合是会直接死的
  // (崩溃/被杀,landCheckpoint 那一笔没落成),此时等待格为空,而结果仍确凿地欠着。下面那条
  // pending 检查只认 `review-answer:*` 和无 origin 的排队消息 —— 来源身份完全正确的
  // `monitor:<id>` 消息在它眼里不存在,于是这一轮照旧落 error、那条结果照旧被作废。
  //
  // **只在还没交卷时拦**:交卷之后那一轮必须结算(D6 / docs/incidents.md「审查交卷后 round 挂
  // 死」),哪怕结果还排着也一样 —— 结论已经写定,那条结果不再影响任何判断,作废它是 D6 明说
  // 的取舍。所以这里跟上一行同一道 `!hasConclusion` 闸,绝不把保护扩到交卷之后。
  if (!hasConclusion && await roundOwesResult(transaction, owner.id, state)) return true;
  const pending = await transaction.select().from(scheduledMessages)
    .where(and(eq(scheduledMessages.taskId, owner.id), eq(scheduledMessages.status, "pending")));
  return pending.some((message) => message.origin === `review-answer:${state?.generation}`
    || (!message.origin && message.mode === "queued" && (owner.verifyRound || owner.reviewOf
      ? message.sessionRole !== "reviewer"
      : message.sessionRole === "reviewer" && state?.directory === freeReviewEvidenceDir(owner.id, message.reviewRun ?? "", message.reviewRound ?? 0))));
}

/**
 * **续跑交接凭证还握在这一轮手里吗** —— 只认当前方向身份的那一份。
 *
 * 两处记录同生同死(`beginReviewContinuation` 一笔写下、销毁的三条路各自一笔清掉),所以任一
 * 处还在就算握着;分开读是为了覆盖 `assertReviewTurnStart` 那条按 `wait_ownership.start`
 * 在不在来决定要不要清 `continuation.start` 的分支。
 */
function continuationLeaseHeld(owner: TaskRow, state: EvidenceRow): boolean {
  const start = owner.waitOwnership?.start;
  if (start && start.directory === state.directory && start.generation === state.generation
    && reviewIdentityMatches(owner, start.identity)) return true;
  const handoff = state.continuation?.start;
  return !!handoff && handoff.ownerTaskId === owner.id && reviewIdentityMatches(owner, handoff.identity);
}

/**
 * **这一轮审查名下还有没了结的哨兵责任吗** —— 归属字段缺失时的替代事实。
 *
 * `monitors.source_review_run/round` 是哨兵创建时就落库的身份(见 schema-monitors.ts),
 * 跟 `wait_ownership.writer` 是两套独立记录,所以存量等待缺 writer 时它照样答得上来。
 * 旧哨兵行可能没记轮次,那就退到「同一次 run 的任何一轮」—— 宁可多挡一会儿。
 *
 * **问的是「责任」不是「进程」**(第 3 轮自由审查 F2)。上一版只查 `status="running"`,于是:
 * 哨兵的命令自己跑完了(exited)、结果已经排进待发送托盘、审查者一个字都没看到 —— 这一问答
 * 「没有」,round 以 `status:"error"`、`conclusion:null` 提前结账,那条 pending 随即被
 * `cancelPendingMonitorEvents` 作废(实测:WRITER_PENDING origin="monitor:m" →
 * PENDING_AFTER_RECOVERY status="canceled")。**进程结束推不出等待结束**:结果从产出到
 * 真正递到手上,中间整段都还是「有人在等」。所以改用完成闸那份同样的三类集合
 * (`unsettledMonitorResponsibility`:在跑 / 已排队未消费 / 结局已定待交接),一条语句读齐,
 * 且跟本次结算读任务行、证据行同一个事务快照。
 *
 * 轮次归属两边任一命中都算:哨兵行自己记的那对,和**那条待发送消息入队时抄下来的**那对
 * (`scheduled_messages.review_run/round`)。后者是为哨兵行已经被删掉的情形留的 —— 行没了
 * 责任还在。
 */
async function roundOwesResult(transaction: ConclusionTransaction, taskId: string,
  state: EvidenceRow): Promise<boolean> {
  const owed = await unsettledMonitorResponsibility(transaction, taskId);
  const runDir = (run: string) => dirname(freeReviewEvidenceDir(taskId, run, 1));
  const thisRound = (run: string | null, round: number | null) => run !== null && (round === null
    ? runDir(run) === dirname(state.directory)
    : freeReviewEvidenceDir(taskId, run, round) === state.directory);
  return owed.some((row) => thisRound(row.reviewRun, row.reviewRound)
    || thisRound(row.messageReviewRun, row.messageReviewRound));
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
  persistRunner?: (transaction: ConclusionTransaction) => Promise<void>,
  /** 输入进了哪条会话:「继续本轮审查」认会话只认这一份归属(free-review-retry-identity.ts)。 */
  sessionId?: string): Promise<void> {
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
      // 这三列只许由 `task-resume-prompt.ts` 导出的 patch/条件助手写:自己拼 `.set` 会漏掉代次,
      // 而「文字」压根证明不了「还是同一次占用」(那边 `resumePromptHeldBy` 的说明)。
      // `test-monitor-complete-gate` 的 F1-A 按语句扫 `server/src` 全树钉这一条,所以这里没有
      // 「改断言」那条路 —— 只能换成助手。
      await transaction.update(tasks).set(resumePromptTakePatch())
        .where(and(eq(tasks.id, taskId), ...resumePromptHeldBy({ text: receipt.delivery.text,
          generation: receipt.delivery.promptGeneration })));
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
      // 协议回执此刻还没落定:显式记成 unknown,跟凭据同一笔落下 —— 之后回执那一笔写不进库,
      // 留下的也是「说不清」而不是缺席(review-input-verdict.ts)。
      deliveredReview: { directory: receipt.directory, generation: receipt.generation, identity: receipt.identity,
        input: receipt.delivery, pid: process?.pid, unitToken: process?.unitToken, confirmedAt: now(),
        acceptance: "unknown", ...(sessionId ? { sessionId } : {}) } } })
      .where(eq(tasks.id, taskId));
  }, { behavior: "immediate" });
}
