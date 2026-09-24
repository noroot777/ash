// 执行者**驳回**一轮审查结论，以及用户对这条驳回的裁定。
//
// 为什么要有这条支线：审查者给的 verify_failed 不是事实，是一份判断。执行者被打回去
// 修的时候，可能看出报告读错了代码、或者那条意见属于「知道、但这次有意不改」。原来
// 的链只给它一条路——照改。于是要么它违心改坏一版能跑的代码，要么它在会话里辩解几句
// 然后照改，而**辩解不会留在任何结构化状态里**：用户下次打开任务只看得见「未通过，
// 等待处理」，不知道执行者其实不认这条意见。
//
// 所以驳回必须是**一等状态**（落在那一轮审查上），不是聊天里的一段话：
// ① 它让链**停下来等人**——不自动复审、不自动修复，因为双方各执一词时，多跑一轮
//    审查只会得到同一份报告；
// ② 它让用户看得见，并且有三条明确的出路：让双方辩一轮、采纳执行者、维持审查意见；
// ③ **裁定权只在用户手上**。审查者在辩论收尾时给的 verdict 只是它自己的立场，绝不
//    自动改写结论——让被驳回的那一方替用户签字，等于把裁定这件事取消掉。
//
// 「驳回成立」时**不把 run 改成 passed**：那是伪造审查者的结论。报告与证据原样留着，
// 只多一条「用户裁定：采纳执行者」——与验证站那颗「人工强制通过」同一个规矩。
//
// ── 第三条出路：转独立任务（`deferred`，2026-09-24 加） ──
// 上面两条判据（不成立 / 知情有意为之）漏掉了一整类意见：**技术上成立、依据可复现、
// 也不是有意为之，但它不属于本任务**——最典型的形态是**上一轮修复自己引入的衍生问题**。
// 执行者碰上它时手里只有两条路：照改（于是修复再引入新问题，下一轮再被打回，这条链
// 没有终止条件），或者谎称「依据不可复现」（审查者每次都附了可复现构造，一拆就穿）。
// 实测后果：一条任务连着被打回 10 轮，第 1 轮就修好了原始症状，后 9 轮全在修上一轮的
// 修复，分支从 +191/-7 涨到 +1045/-67。
//
// 所以给它一条**同样是一等状态**的出路：执行者在同一次 `dispute_review` 里多写一段
// `deferReason`（逐条写明哪几条越界、为什么），用户裁定同意后建一个 **backlog、不起跑**
// 的派生任务把那几条带走。四条规矩与上面两条完全一致，一条都不放松：
// ① 裁定权只在用户手上——执行者只能**提出**，`disputeFreeReview` 这一路永远不建任务；
// ② 不改写审查结论——转走 ≠ 这一轮 passed，报告和证据原样留着；
// ③ 不能变成逃避修复的捷径——没写 `deferReason` 就拒绝这个裁定（判据是**边界**不是
//    **工作量**，措辞见 free-review-prompts.ts 的 disputeOption）；
// ④ 提出之后停下来等人——与驳回共用同一条停顿，撤自动复审预约的规矩也共用。
import type { FreeReviewDisputeResolution, Task } from "@ash/shared";
import { and, eq, isNull } from "drizzle-orm";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { freeReviewRounds, freeReviewRuns, tasks } from "./db/schema.js";
import { latestWorkspaceRun } from "./free-review-round.js";
import {
  consumeFreeReviewReservation,
  readFreeReviewReservation,
} from "./free-review-reservations.js";
import { handoffBlockReason } from "./handoff-guard.js";
import { turnRole } from "./runs.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { now } from "./util.js";

type TaskRow = typeof tasks.$inferSelect;
export type ReviewRunRow = typeof freeReviewRuns.$inferSelect;
export type ReviewRoundRow = typeof freeReviewRounds.$inferSelect;

/** 驳回理由的长度上限：够写满一页逐条反驳，又不至于把一整份 diff 灌进数据库。 */
export const MAX_DISPUTE_REASON_LEN = 20_000;

function trimmed(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().slice(0, MAX_DISPUTE_REASON_LEN) : "";
}

export function disputeReasonOf(raw: unknown): string {
  const text = trimmed(raw);
  if (!text) throw new Error("驳回必须写明理由：逐条说清报告里哪一条不成立、依据是什么");
  return text;
}

/**
 * 两段理由的联合入参校验：`reason`（哪几条不成立）与 `deferReason`（哪几条成立但越界）
 * **至少要有一段**。只提转出时不强求 `reason` —— 强求的话执行者就只能在「哪一条不成立」
 * 那一栏里编一句它自己都不认的话，而那正是这条出路要消灭的东西。
 */
export function disputeInputOf(raw: { reason?: unknown; deferReason?: unknown }): {
  reason: string;
  deferReason: string | null;
} {
  const deferReason = trimmed(raw.deferReason);
  const reason = trimmed(raw.reason);
  if (!reason && !deferReason) {
    throw new Error(
      "驳回必须写明理由：逐条说清报告里哪一条不成立、依据是什么；" +
      "若你认可这些意见、只是认为它们超出本任务边界，就把逐条依据写进 deferReason",
    );
  }
  return { reason, deferReason: deferReason || null };
}

/** 「这一轮挂着一条驳回」——两段理由任意一段非空即算（只提转出的那次 reason 为空）。 */
export function hasDispute(round: ReviewRoundRow | null | undefined): boolean {
  return !!(round?.disputeReason || round?.disputeDeferReason);
}

async function freeTask(taskId: string): Promise<TaskRow> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) throw new Error("任务不存在");
  if (task.mode !== "single" || task.parentId || task.reviewOf || task.workflowMode !== "free") {
    throw new Error("当前任务不是自由工作流普通任务");
  }
  return task;
}

/** 这一轮（run 的当前轮）的行；run 已结束时它就是最后出结论的那一轮。 */
export async function currentRoundOf(run: ReviewRunRow): Promise<ReviewRoundRow | null> {
  return (await db.select().from(freeReviewRounds)
    .where(and(eq(freeReviewRounds.runId, run.id), eq(freeReviewRounds.round, run.currentRound)))).at(0) ?? null;
}

/**
 * 「现在有没有一条等着用户裁定的驳回」——驳回已写下、用户还没裁定。
 * 界面上的几颗按钮、辩论入口、修复入口全读它，一处定义。
 */
export async function openDisputeOf(taskId: string): Promise<{ run: ReviewRunRow; round: ReviewRoundRow } | null> {
  const run = await latestWorkspaceRun(taskId);
  if (!run || run.status !== "stopped") return null;
  const round = await currentRoundOf(run);
  if (!hasDispute(round) || round?.disputeResolution) return null;
  return { run, round: round! };
}

/**
 * 「这一轮意见已经被用户裁定成『不在本任务里修』了」——采纳执行者（`withdrawn`）或者
 * 转成了独立任务（`deferred`）之后的那一轮。
 *
 * 修复入口必须认它：确认框上写的是「执行者不再按它修改」，裁定完却还能把同一份报告
 * 重新发回去修，等于让用户自己把刚做的裁定按没了（第 1 轮审查实测）。前端藏按钮，
 * 后端照样挡——只藏按钮就是把规矩交给界面守。`deferred` 同理，而且更硬：那几条已经
 * 有一个独立任务在承接了，在本任务里再修一遍就是两处各改一版。
 */
export async function waivedDisputeOf(taskId: string): Promise<{ run: ReviewRunRow; round: ReviewRoundRow } | null> {
  const run = await latestWorkspaceRun(taskId);
  if (!run || run.status !== "stopped") return null;
  const round = await currentRoundOf(run);
  const resolution = round?.disputeResolution;
  return resolution === "withdrawn" || resolution === "deferred" ? { run, round: round! } : null;
}

/**
 * 执行者驳回最近一轮的未通过结论（MCP `dispute_review`）。
 *
 * 必须出自**执行者自己的回合**：审查旁路回合（role=reviewer）调它就是审查者替执行者
 * 驳回自己的结论，一律拒。判据取回合的运行时身份（同 report_stage 的理由，见 runs.ts）。
 *
 * `deferReason` 只是**一份提案**：这一路一个任务都不会建（规矩①）。真正建任务在
 * free-review-defer.ts，且只能从用户裁定那条路进去。
 */
export async function disputeFreeReview(
  taskId: string,
  reason: string,
  deferReason: string | null = null,
): Promise<{ runId: string; round: number }> {
  const task = await freeTask(taskId);
  if (task.archived) throw new Error("归档任务不能驳回审查意见");
  const handedOff = handoffBlockReason(task.handoff);
  if (handedOff) throw new Error(handedOff);
  if (task.stage === "accepted" || task.stage === "merged") {
    throw new Error("任务已进入验收结果，审查意见不再需要驳回");
  }
  const role = turnRole(taskId);
  if (role === "reviewer") throw new Error("审查回合不能驳回自己的结论；驳回只能由执行回合发起");
  if (!role) throw new Error("当前没有正在进行的执行回合，驳回已拒收（迟到或误投的调用不落账）");
  const run = await latestWorkspaceRun(taskId);
  if (!run || run.status !== "stopped") throw new Error("最近一轮审查没有停在未通过状态，没有可驳回的意见");
  const round = await currentRoundOf(run);
  if (!round || round.conclusion !== "verify_failed") throw new Error("最近一轮审查没有未通过结论，无需驳回");
  if (hasDispute(round)) throw new Error("这一轮意见已经驳回过了；还有话要说就等用户开辩论，别重复驳回");

  const at = now();
  // CAS：只有把两段理由从空写成非空的那一次算数。并发重试（MCP 的重连重试、用户手点
  // 两下）到这里都只会落一条驳回，而不是后写的盖掉先写的。两列一起判——只判一列的话，
  // 「只提转出」和「只提不成立」这两次并发调用会各自看到对方那列是空，双双写进去。
  const written = await db.update(freeReviewRounds)
    .set({ disputeReason: reason || null, disputeDeferReason: deferReason, disputeAt: at })
    .where(and(
      eq(freeReviewRounds.id, round.id),
      isNull(freeReviewRounds.disputeReason),
      isNull(freeReviewRounds.disputeDeferReason),
    ))
    .returning({ id: freeReviewRounds.id });
  if (!written.length) throw new Error("这一轮意见已经驳回过了；还有话要说就等用户开辩论，别重复驳回");

  // 自动复审预约必须撤掉：执行者没有按意见改代码，续上的那一轮只会对着同一份代码
  // 再写一遍同一份报告，还会把「等你裁定」这个停顿冲掉。**只撤自动续轮那条**
  // （runId 非空）；用户自己手存的预约是他明确的意思，一个字都不动。
  const reservation = await readFreeReviewReservation(taskId);
  const canceledAuto = reservation?.armed && reservation.runId
    ? await consumeFreeReviewReservation(taskId, reservation)
    : null;

  const what = deferReason
    ? reason
      ? "驳回了部分意见，并提出另几条虽然成立、但超出本任务边界，建议转独立任务"
      : "认可这一轮意见，但提出它们超出本任务边界，建议转独立任务"
    : "驳回了这一轮审查意见";
  await appendTaskTimeline(taskId,
    `执行者${what}（第 ${run.currentRound} 轮 · ${run.reviewerName}）：${summarize(reason || deferReason || "")}` +
    `${canceledAuto ? "；自动复审已取消" : ""}。` +
    "现在由你裁定：可以让双方辩一轮，也可以直接采纳执行者的说法、维持审查意见让它照改" +
    `${deferReason ? "，或者把越界的那几条转成一个独立任务" : ""}。`);
  bus.publish({ type: "task.review", taskId });
  return { runId: run.id, round: run.currentRound };
}

/** 时间线里只放一句话的摘要，全文留在审查记录里（时间线不是正文的第二个家）。 */
function summarize(reason: string): string {
  const line = reason.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

/**
 * 「按意见修复」= 维持审查意见（幂等，没有待裁定的驳回时空转）。
 *
 * 两个入口都经这一处：用户可以点「维持并修复」，也可以直接点那颗老的「按意见修复」。
 * 不在第二个入口上记裁定的话，驳回会一直挂着「等你裁定」——而用户其实已经用行动
 * 裁定过了，界面却还在催他做一件已经做完的事。
 */
export async function upholdOpenDispute(taskId: string): Promise<boolean> {
  const open = await openDisputeOf(taskId);
  if (!open) return false;
  await db.update(freeReviewRounds)
    .set({ disputeResolution: "upheld", disputeResolvedAt: now() })
    .where(eq(freeReviewRounds.id, open.round.id));
  await appendTaskTimeline(taskId,
    `按第 ${open.run.currentRound} 轮审查意见发起修复，即维持审查意见（执行者的驳回未被采纳）。`);
  bus.publish({ type: "task.review", taskId });
  return true;
}

export const DISPUTE_RESOLUTION_LABELS: Record<FreeReviewDisputeResolution, string> = {
  upheld: "维持审查意见",
  withdrawn: "采纳执行者说法",
  deferred: "转为独立任务",
};

export function disputeResolutionOf(raw: unknown): FreeReviewDisputeResolution {
  if (raw === "upheld" || raw === "withdrawn" || raw === "deferred") return raw;
  throw new Error(
    "裁定只能是 upheld（维持审查意见）、withdrawn（采纳执行者说法）或 deferred（转为独立任务）",
  );
}

/**
 * 用户裁定一条驳回。`upheld` 会顺带把「按意见修复」发起来（那正是这个裁定的意思）；
 * 修复起不来不回滚裁定 —— 裁定是用户的决定，投递失败是另一件事，如实写进时间线即可。
 *
 * `deferred` 走另一条路（free-review-defer.ts）：它的「顺带」是**建一个任务**，而建
 * 失败了这个裁定就什么也没剩下——没有第二个入口能把那个任务补建出来。所以它必须能
 * 回滚，不能照抄 upheld 的「失败也落账」。
 */
export async function resolveFreeReviewDispute(
  taskId: string,
  resolution: FreeReviewDisputeResolution,
): Promise<{ resolution: FreeReviewDisputeResolution; repairError: string | null; deferredTask: Task | null }> {
  const task = await freeTask(taskId);
  if (task.archived) throw new Error("归档任务不能裁定审查驳回");
  const handedOff = handoffBlockReason(task.handoff);
  if (handedOff) throw new Error(handedOff);
  const open = await openDisputeOf(taskId);
  if (!open) throw new Error("现在没有等待裁定的驳回");
  const { activeDebateOf } = await import("./free-review-debate.js");
  if (await activeDebateOf(taskId)) throw new Error("辩论正在进行，等它结束再裁定");

  if (resolution === "deferred") {
    const { deferOpenDispute } = await import("./free-review-defer.js");
    const deferredTask = await deferOpenDispute(task, open);
    return { resolution, repairError: null, deferredTask };
  }

  const at = now();
  await db.update(freeReviewRounds)
    .set({ disputeResolution: resolution, disputeResolvedAt: at })
    .where(eq(freeReviewRounds.id, open.round.id));
  await appendTaskTimeline(taskId, resolution === "withdrawn"
    ? `你裁定采纳执行者的说法：第 ${open.run.currentRound} 轮的未通过意见不再要求修复（报告与证据原样保留，审查结论本身不改写）。`
    : `你裁定维持第 ${open.run.currentRound} 轮审查意见：执行者需要照报告修复。`);
  bus.publish({ type: "task.review", taskId });

  let repairError: string | null = null;
  if (resolution === "upheld") {
    try {
      const { startManualFreeReviewRepair } = await import("./free-workflow.js");
      await startManualFreeReviewRepair(taskId, { holdTurn: true });
    } catch (error) {
      repairError = error instanceof Error ? error.message : String(error);
      await appendTaskTimeline(taskId,
        `已裁定维持审查意见，但这次没能自动发起修复：${repairError}；可在审查面板里手动点「按意见修复」。`);
      bus.publish({ type: "task.review", taskId });
    }
  }
  return { resolution, repairError, deferredTask: null };
}
