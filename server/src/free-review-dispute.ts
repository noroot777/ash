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
// 也不是有意为之，但它偏离了本任务要做的那件事**。判据是用户 2026-09-24 的原话
// 「如果偏离了主任务的内容的话就开启一个新的任务」，三种形态并列：**内容无关**（落点在
// 与任务目标无关的模块）、**基线既有**（缺陷在开工起点那一版上就存在）、**衍生问题**
// （上一轮修复自己带出来的）。三条都得写给执行者，少一条它就会把「不是我上一轮改出来的」
// 读成「属于本任务」——那正是 2026-10-14 真实翻车的那一步，经过见 free-review-prompts.ts
// 的 disputeOption 注释。
// 执行者碰上它时手里只有两条路：照改（于是一路改到任务边界之外，下一轮再被打回，这条链
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
import type { FreeReviewDisputeResolution, FreeReviewDisputeTarget, Task } from "@ash/shared";
import { MAX_PLAIN_SUMMARY_LEN, PLAIN_SUMMARY_GUIDE } from "@ash/shared/free-workflow";
import { and, desc, eq, inArray, isNull, not, sql } from "drizzle-orm";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { freeReviewRounds, freeReviewRuns, tasks } from "./db/schema.js";
import { latestWorkspaceRun } from "./free-review-round.js";
import {
  consumeFreeReviewReservation,
  forgetHeldTrigger,
  readFreeReviewReservation,
} from "./free-review-reservations.js";
import { withRulingGate } from "./free-review-ruling-gate.js";
import { handoffBlockReason } from "./handoff-guard.js";
import { turnRole } from "./runs.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { now } from "./util.js";

type TaskRow = typeof tasks.$inferSelect;
export type ReviewRunRow = typeof freeReviewRuns.$inferSelect;
export type ReviewRoundRow = typeof freeReviewRounds.$inferSelect;

/** 驳回理由的长度上限：够写满一页逐条反驳，又不至于把一整份 diff 灌进数据库。 */
export const MAX_DISPUTE_REASON_LEN = 20_000;

/** 裁定要点的长度上限：够写清「这条按辩论里那个方案做」，但它是一段批注，不是第二份报告。 */
export const MAX_DISPUTE_RESOLUTION_NOTE_LEN = 4_000;

function trimmed(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().slice(0, MAX_DISPUTE_REASON_LEN) : "";
}

export function disputeReasonOf(raw: unknown): string {
  const text = trimmed(raw);
  if (!text) throw new Error("驳回必须写明理由：逐条说清报告里哪一条不成立、依据是什么");
  return text;
}

/**
 * 「写给用户的那一句话」的入参校验 —— 驳回和辩论发言共用（`free-review-debate.ts` 从这里
 * 取，两处各写一份校验就会漂成两套规范）。
 *
 * **必填**，而不是「有就用、没有就算了」：可选的那一版等于没有——执行者手里的默认稿
 * 一直是写给审查者看的辩护书（真实样本 1000~3500 字、满篇路径行号），缺了这一句用户
 * 就只能对着那堵墙拍板。漏传的代价只是 agent 读到这条报错再补一次调用，它读得到；
 * 用户读不懂的代价是每次裁定都在猜。
 *
 * 换行压成空格：它要摆在界面首屏当一行结论，顺手也堵掉「在摘要栏里塞一份小报告」。
 */
export function plainSummaryOf(raw: unknown, field: string, what: string): string {
  const text = typeof raw === "string"
    ? raw.replace(/\s+/g, " ").trim().slice(0, MAX_PLAIN_SUMMARY_LEN)
    : "";
  if (!text) throw new Error(`${field} 必填：${what}\n${PLAIN_SUMMARY_GUIDE}`);
  return text;
}

/**
 * 三段入参的联合校验。
 *
 * `summary` 必填（理由见 `plainSummaryOf`）；`reason`（哪几条不成立）与 `deferReason`
 * （哪几条成立但越界）**至少要有一段**。只提转出时不强求 `reason` —— 强求的话执行者就
 * 只能在「哪一条不成立」那一栏里编一句它自己都不认的话，而那正是这条出路要消灭的东西。
 */
export function disputeInputOf(raw: { summary?: unknown; reason?: unknown; deferReason?: unknown }): {
  summary: string;
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
  const summary = plainSummaryOf(
    raw.summary, "summary", "用户要靠这一句决定「让你接着改 / 这一轮不用改 / 转成独立任务」，所以它必须是人话",
  );
  return { summary, reason, deferReason: deferReason || null };
}

/** 「这一轮挂着一条驳回」——两段理由任意一段非空即算（只提转出的那次 reason 为空）。 */
export function hasDispute(round: ReviewRoundRow | null | undefined): boolean {
  return !!(round?.disputeReason || round?.disputeDeferReason);
}

/**
 * 同一个判据的 SQL 版：查询与 CAS 都用它，不各写一份 `IS NOT NULL`。两边口径一偏（老数据
 * 或接力载荷里理由是空串），裁定闸按 SQL 认定「有驳回、等裁定」挡住预约，界面按
 * `hasDispute` 认定「没驳回」不给卡——用户看得见「等裁定」，却找不到能裁的那一条。
 */
const disputeWritten = sql`(coalesce(${freeReviewRounds.disputeReason}, '') <> '' or coalesce(${freeReviewRounds.disputeDeferReason}, '') <> '')`;

/**
 * 「等着用户裁定」的那组条件（不含任务过滤）：驳回已写下、没裁定、没被用户新派的审查取代、
 * 是工作区审查。按任务查（`unresolvedDisputes`）和跨任务查（`openDisputeTargets`）共用这一份，
 * 两处各写一遍的话，飞书推出去的卡和审查面板上的卡迟早不是同一批。
 */
const awaitingRuling = and(
  eq(freeReviewRuns.targetKind, "workspace"),
  disputeWritten,
  isNull(freeReviewRounds.disputeResolution),
  isNull(freeReviewRounds.disputeSupersededAt),
);

// 排序键与界面上那张卡的 `dispute.at` 同一个兜底（free-workflow-state.ts）：接力载荷允许
// 驳回时间为空，两边各按各的排，显示的那条和「默认那条」就会是两条。
const disputeTime = sql<string>`coalesce(${freeReviewRounds.disputeAt}, ${freeReviewRounds.endedAt}, ${freeReviewRounds.startedAt})`;

/**
 * 用户点的那条驳回已经不在等裁定了：别处已经裁过（另一个标签页、飞书卡片），或者被新一轮
 * 审查取代。单独一个类型，是为了让入口能回一个结构化的 `stale`，调用方不必去比对文案才知道
 * 「这条已经在别处处理了」。
 */
export class DisputeStaleError extends Error {}

/**
 * 「执行者到底说了什么」——发给辩论双方的那一份完整材料。
 *
 * 必须**三段都带**，而且必须是一个函数：辩论提示原来直接取 `round.disputeReason!`，
 * 碰上「只提转出」那种形态（`reason` 为空、话全在 `deferReason` 里）就把 null 发了出去，
 * 双方看到的是字面量「null」—— 审查者对着一条空驳回答辩，执行者再读一遍自己的空话。
 * 这条形态在线上真实发生过（见 web fixture `debate-lane.data.json` 那场）。
 */
export function disputeBriefOf(round: ReviewRoundRow): string {
  return [
    round.disputeSummary ? `〔一句话〕${round.disputeSummary}` : "",
    round.disputeReason ? `〔它认为不成立的那几条〕\n${round.disputeReason}` : "",
    round.disputeDeferReason ? `〔它认可、但认为该另开一个任务去改的那几条〕\n${round.disputeDeferReason}` : "",
  ].filter(Boolean).join("\n\n");
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
 * 这个任务上所有「驳回已写下、用户还没裁定、也没被用户新派的审查取代」的轮次，最近的在前。
 *
 * 判据是**任务级**的，不是「最近一条审查链的当前轮」：后者只是界面上最显眼的那一条，
 * 一条更新的审查链（哪怕只开了个头就停了）就能把旧驳回遮住，于是裁定闸放行、裁定入口
 * 也找不到它——欠着的那个裁定就这么静默没了（第 1 轮审查问题 2）。合并结果审查是验收后的
 * 独立只读链，不参与。
 */
export async function unresolvedDisputes(taskId: string): Promise<{ run: ReviewRunRow; round: ReviewRoundRow }[]> {
  return db.select({ run: freeReviewRuns, round: freeReviewRounds }).from(freeReviewRounds)
    .innerJoin(freeReviewRuns, eq(freeReviewRuns.id, freeReviewRounds.runId))
    .where(and(eq(freeReviewRuns.taskId, taskId), awaitingRuling))
    .orderBy(desc(disputeTime));
}

/** 一条等裁定的驳回在别的表面（飞书）上的身份与摘要：`{runId, round}` 就是裁定接口的 target。 */
export type OpenDisputeTarget = {
  taskId: string;
  runId: string;
  round: number;
  /** 排序与展示用的驳回时间（兜底同 `unresolvedDisputes`）。 */
  disputeAt: string;
  /** 写给用户的一句话；加这一列之前的老驳回为 null。 */
  summary: string | null;
  /** 执行者提了「转独立任务」那一段 = 卡片上才该有那个出口。 */
  hasDefer: boolean;
};

/**
 * **跨任务**列出所有等裁定的驳回，最近的在前 —— 给启动时全量对账用（按任务一条条查要先知道
 * 有哪些任务）。条件与 `unresolvedDisputes` 同一组，所以按 taskId 过滤后两边是同一批。
 *
 * 只按驳回本身判，不看任务归档 / 接力：那两种裁定时会被 `resolveFreeReviewDispute` 如实拒，
 * 推不推卡由调用方决定。
 */
export async function openDisputeTargets(): Promise<OpenDisputeTarget[]> {
  const rows = await db.select({
    taskId: freeReviewRuns.taskId,
    runId: freeReviewRuns.id,
    round: freeReviewRounds.round,
    disputeAt: disputeTime,
    summary: freeReviewRounds.disputeSummary,
    deferReason: freeReviewRounds.disputeDeferReason,
  }).from(freeReviewRounds)
    .innerJoin(freeReviewRuns, eq(freeReviewRuns.id, freeReviewRounds.runId))
    .where(awaitingRuling)
    .orderBy(desc(disputeTime));
  return rows.map(({ deferReason, ...row }) => ({ ...row, hasDefer: !!deferReason }));
}

/**
 * 「现在有没有一条等着用户裁定的驳回」（判据见 `unresolvedDisputes`），裁定闸读它。
 * 它只回答「有没有」：要对**某一条**动手（裁定、辩论）走 `targetedOpenDispute`，别拿这里
 * 排第一的那条当用户点的那条。
 */
export async function openDisputeOf(taskId: string): Promise<{ run: ReviewRunRow; round: ReviewRoundRow } | null> {
  return (await unresolvedDisputes(taskId)).at(0) ?? null;
}

/** 一次用户动作指向的那条驳回：哪条审查链的第几轮。 */
export type DisputeTarget = FreeReviewDisputeTarget;

/** 请求体里的 `target`；没带是 null，带了却不完整就拒（半个目标比没有目标更容易指错）。 */
export function disputeTargetOf(raw: unknown): DisputeTarget | null {
  if (raw == null) return null;
  const { runId, round } = (typeof raw === "object" ? raw : {}) as { runId?: unknown; round?: unknown };
  if (typeof runId !== "string" || !runId || typeof round !== "number" || !Number.isInteger(round) || round < 1) {
    throw new Error("驳回目标无效：要带上那条驳回所在的审查链 id 和轮次");
  }
  return { runId, round };
}

/**
 * 用户这次动作要处理的**那一条**未裁定驳回。一次动作的目标在这里定死，之后的裁定、修复
 * 校验、修复提示、辩论都只认它，下游**不许再按任务去挑「当前那条」**。
 *
 * 为什么不能直接用 `openDisputeOf`：未裁定驳回是任务级的，可以同时挂着好几条（升级前的
 * 老数据就有），「最近那条」只是排序的结果，不是用户点的那张卡。第 2 轮审查实测：对旧
 * 第 1 轮点「让它接着改」，修复却按更新的第 2 轮报告发出，另一条旧驳回也被顺手记成维持。
 *
 * 带了目标：必须仍在未裁定之列，否则如实拒（多半是别处已经裁过或被新一轮审查取代）。
 * 没带目标（老客户端、脚本）：只在恰好一条时放行，有好几条就拒，不替用户挑。
 */
export async function targetedOpenDispute(
  taskId: string,
  target: DisputeTarget | null,
  none = "现在没有等待裁定的驳回",
): Promise<{ run: ReviewRunRow; round: ReviewRoundRow }> {
  const open = await unresolvedDisputes(taskId);
  // 点的是具体那一条、而任务上已经一条都不剩：同样是「那条已在别处处理」，按 stale 报。
  if (!open.length) throw target ? new DisputeStaleError(none) : new Error(none);
  if (!target) {
    if (open.length > 1) throw new Error(`现在有 ${open.length} 条驳回在等裁定，请在审查面板里对具体那一条操作`);
    return open[0]!;
  }
  const hit = open.find(({ run, round }) => run.id === target.runId && round.round === target.round);
  if (!hit) throw new DisputeStaleError(`第 ${target.round} 轮那条驳回已经不在等裁定了（已被裁定，或被新一轮审查取代），刷新后再看`);
  return hit;
}

/**
 * 用户在驳回还没裁定时**自己**又开了一轮工作区审查（派新链 / 重跑一条失败的链）：把挂着的
 * 驳回记成「被取代」，并在时间线上说清。
 *
 * 为什么不是拒掉这次派审：「驳回了就重新派一轮看看」是用户的常用操作（线上 30 多条驳回
 * 都是这么收场的），那是他明确的决定，硬挡只会逼他先随手点一档裁定来解锁。为什么不是
 * 静默放过：那样驳回只是被更新的链遮住，任务级仍然欠着一个没人看得见的裁定。所以记一笔
 * 「取代」——不是裁定，不冒充用户签了哪一档，报告和驳回原样留着。
 *
 * 只给**用户发起**的开审调用；按预约开审的那一路在裁定闸后面，碰不到未裁定的驳回。
 */
export async function supersedeOpenDisputes(taskId: string, how: string): Promise<void> {
  const open = await unresolvedDisputes(taskId);
  if (!open.length) return;
  await db.update(freeReviewRounds).set({ disputeSupersededAt: now() })
    .where(and(inArray(freeReviewRounds.id, open.map(({ round }) => round.id)), isNull(freeReviewRounds.disputeResolution)));
  const rounds = [...new Set(open.map(({ round }) => `第 ${round.round} 轮`))].join("、");
  await appendTaskTimeline(taskId,
    `执行者对${rounds}意见的驳回还没裁定，你${how}：这条驳回不再等裁定（驳回与报告原样留在审查记录里，没有替你选任何一档裁定）。`);
  bus.publish({ type: "task.review", taskId });
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
  input: { summary: string; reason: string; deferReason: string | null },
): Promise<{ runId: string; round: number }> {
  // 与按预约开审互斥（理由见 free-review-ruling-gate.ts）：从「最近一轮停在未通过」这道判据
  // 到驳回落库、撤自动续轮，整段不许和预约消费交错。
  return withRulingGate(taskId, () => disputeFreeReviewHeld(taskId, input));
}

async function disputeFreeReviewHeld(
  taskId: string,
  input: { summary: string; reason: string; deferReason: string | null },
): Promise<{ runId: string; round: number }> {
  const { summary, reason, deferReason } = input;
  const task = await freeTask(taskId);
  if (task.archived) throw new Error("归档任务不能驳回审查意见");
  const handedOff = handoffBlockReason(task.handoff);
  if (handedOff) throw new Error(handedOff);
  if (task.stage === "accepted" || task.stage === "merged") {
    throw new Error("任务已进入验收结果，审查意见不再需要驳回");
  }
  const role = turnRole(taskId);
  if (role === "reviewer") throw new Error("审查回合不能驳回自己的结论；驳回只能由执行回合发起");
  // dispatch 是派审 / 重跑 / 修复投递那几步的占位身份，不是执行回合：此刻送达的驳回只能是
  // 上一轮迟到的调用，而它占着的那一段正要开一轮新审查。
  if (role === "dispatch") throw new Error("审查正在派发，当前没有正在进行的执行回合，驳回已拒收");
  if (!role) throw new Error("当前没有正在进行的执行回合，驳回已拒收（迟到或误投的调用不落账）");
  const run = await latestWorkspaceRun(taskId);
  if (!run || run.status !== "stopped") throw new Error("最近一轮审查没有停在未通过状态，没有可驳回的意见");
  const round = await currentRoundOf(run);
  if (!round || round.conclusion !== "verify_failed") throw new Error("最近一轮审查没有未通过结论，无需驳回");
  if (hasDispute(round)) throw new Error("这一轮意见已经驳回过了；还有话要说就等用户开辩论，别重复驳回");

  // 驳回这一刻的代码也是一个锚点：工具要求「部分成立先改掉成立的、再只驳剩下的」，所以
  // 此刻的工作区必然已经不同于审查那一版。用户维持意见后，修复对应的就是这一版
  // （判据见 shared 的 `reviewAnchorMatches`）。取不到就留 null，退回只认审查那一版。
  const { workspaceStateOf } = await import("./free-workflow-state.js");
  const disputedFingerprint = (await workspaceStateOf(task, { verify: true })).fingerprint;
  const at = now();
  // CAS：只有把两段理由从空写成非空的那一次算数。并发重试（MCP 的重连重试、用户手点
  // 两下）到这里都只会落一条驳回，而不是后写的盖掉先写的。两列一起判——只判一列的话，
  // 「只提转出」和「只提不成立」这两次并发调用会各自看到对方那列是空，双双写进去。
  const written = await db.update(freeReviewRounds)
    .set({
      disputeSummary: summary, disputeReason: reason || null, disputeDeferReason: deferReason, disputeAt: at,
      disputedFingerprint,
    })
    .where(and(
      eq(freeReviewRounds.id, round.id),
      not(disputeWritten),
    ))
    .returning({ id: freeReviewRounds.id });
  if (!written.length) throw new Error("这一轮意见已经驳回过了；还有话要说就等用户开辩论，别重复驳回");

  // 自动复审预约必须撤掉：执行者没有按意见改代码，续上的那一轮只会对着同一份代码
  // 再写一遍同一份报告，还会把「等你裁定」这个停顿冲掉。**只撤自动续轮那条**
  // （按预约自己记的来源判）；用户自己手存的预约是他明确的意思，一个字都不动——它留在槽里，
  // 由消费点的裁定闸挡到裁定落地（见 startReservedFreeReview）。
  const reservation = await readFreeReviewReservation(taskId);
  const canceledAuto = reservation?.armed && reservation.source === "follow_up"
    ? await consumeFreeReviewReservation(taskId, reservation)
    : null;

  await appendTaskTimeline(taskId, disputeTimelineNote({
    round: run.currentRound,
    reviewerName: run.reviewerName,
    summary,
    hasReason: !!reason,
    hasDefer: !!deferReason,
    canceledAuto: !!canceledAuto,
  }));
  bus.publish({ type: "task.review", taskId });
  return { runId: run.id, round: run.currentRound };
}

/**
 * 「执行者不认这一轮意见，等你裁定」那条时间线旁注。
 *
 * 它是用户最常先看到的那一眼——会话里就能读到，不必先打开审查面板——所以只说三件事：
 * **谁不认谁、它一句话说了什么、你能怎么选**。
 *
 * 第二行用 `summary` 而不是正文前 60 字：原来截出来的是「本轮认可的部分已先修复、验证
 * 并提交 ceed925（fix: separa…」，占着最值钱的一行却一个字都没说到争点上（用户 2026-10-20
 * 「一大篇文字都看不懂」里的一半就是这条旁注）。
 *
 * 「现在由你裁定：」这个前缀不能改字：前端靠它在时间线里认出这一行并挂上「去裁定」按钮
 * （`web/src/task-detail/systemNoticeModel.ts` 的 `pendingDisputeEvent`）。
 *
 * 抽成纯函数是为了能被回归钉住：这条链里「措辞」本身就是功能，而测试环境里任务没有会话，
 * `appendTaskTimeline` 根本不落盘，断不到。
 */
export function disputeTimelineNote(input: {
  round: number;
  reviewerName: string;
  summary: string;
  hasReason: boolean;
  hasDefer: boolean;
  canceledAuto: boolean;
}): string {
  const what = input.hasDefer
    ? input.hasReason
      ? "不认这一轮的部分意见，另几条认可、但说该另开一个任务去改"
      : "认可这一轮意见，但说该另开一个任务去改，不在这个任务里改"
    : "不认这一轮审查意见";
  const choices = ["让它接着改", "这一轮不用改了"];
  if (input.hasDefer) choices.push("把那几条转成独立任务");
  return `执行者${what}（第 ${input.round} 轮 · ${input.reviewerName}）。\n`
    + `它的说法：${input.summary}\n`
    + `现在由你裁定：${choices.join(" / ")}；拿不准就先让双方辩一轮。`
    + (input.canceledAuto ? "（自动复审已取消，等你拍板。）" : "");
}

/**
 * 这一档裁定不会顺带起执行回合（采纳执行者 / 转独立任务）：被裁定闸扣住的预约就地兑现
 * （理由见 free-review-ruling-release.ts）。开审失败不回滚裁定——裁定是用户的决定，开审
 * 起不来是另一件事，预约由 startReservedFreeReview 放回槽里并写进时间线。
 */
async function releaseHeldReservation(taskId: string): Promise<void> {
  try {
    const { releaseReservationAfterRuling } = await import("./free-review-ruling-release.js");
    await releaseReservationAfterRuling(taskId);
  } catch (error) {
    console.error(`[ash] 裁定后兑现预约审查失败 task=${taskId}:`, error);
  }
}

/** 时间线里只放一句话的摘要，全文留在审查记录里（时间线不是正文的第二个家）。 */
function summarize(reason: string): string {
  const line = reason.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}

/**
 * 「按意见修复」= 维持**这一轮**的审查意见（幂等，这一轮没有待裁定的驳回时空转）。
 *
 * 用户可以点「让它接着改」（裁定那一路自己记账），也可以直接点那颗老的「按意见修复」。
 * 后者不在这里记裁定的话，驳回会一直挂着「等你裁定」——而用户其实已经用行动裁定过了，
 * 界面却还在催他做一件已经做完的事。
 */
export async function upholdDisputeOn(taskId: string, round: ReviewRoundRow): Promise<boolean> {
  // 只裁**要修的这一轮**自己身上的驳回。按任务去找「下一条未裁定」的话，别的轮次上的
  // 驳回会被这一下顺手记成维持——用户根本没看过那一条（第 2 轮审查实测）。
  // 维持意见 = 预约改由那一轮修复的正常结束来触发，之前被闸按住的那次同一笔事务里作废
  // （理由见 forgetHeldTrigger ②）。
  const ruled = await db.transaction(async (transaction) => {
    const rows = await transaction.update(freeReviewRounds)
      .set({ disputeResolution: "upheld", disputeResolvedAt: now() })
      .where(and(
        eq(freeReviewRounds.id, round.id),
        disputeWritten,
        isNull(freeReviewRounds.disputeResolution),
        isNull(freeReviewRounds.disputeSupersededAt),
      ))
      .returning({ id: freeReviewRounds.id });
    if (rows.length) await forgetHeldTrigger(taskId, transaction);
    return rows;
  }, { behavior: "immediate" });
  if (!ruled.length) return false;
  await appendTaskTimeline(taskId,
    `按第 ${round.round} 轮审查意见发起修复，即维持审查意见（执行者的驳回未被采纳）。`);
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
 * 裁定时用户写给执行者的要点（选填）。
 *
 * 为什么裁定要带一栏自由文本：三档裁定各自表达的是一整条驳回的去留，而辩论辩出来的
 * 结论常常落在三档之间——「第 1、3 条已修好，第 2 条我认但按后来达成的方案做」。没有
 * 这一栏时，用户只能点完 `upheld` 再手打一条续聊补充，那段话不进任何结构化状态：
 * 刷新看不见、接力不跟着走，而且它到得比修复提示晚，执行者多半已经照原报告动手了。
 */
export function disputeResolutionNoteOf(raw: unknown): string | null {
  const text = typeof raw === "string" ? raw.trim().slice(0, MAX_DISPUTE_RESOLUTION_NOTE_LEN) : "";
  return text || null;
}

/**
 * 用户裁定一条驳回。`upheld` 会顺带把「按意见修复」发起来（那正是这个裁定的意思）；
 * 修复起不来不回滚裁定 —— 裁定是用户的决定，投递失败是另一件事，如实写进时间线即可。
 *
 * `deferred` 走另一条路（free-review-defer.ts）：它的「顺带」是**建一个任务**，而建
 * 失败了这个裁定就什么也没剩下——没有第二个入口能把那个任务补建出来。所以它必须能
 * 回滚，不能照抄 upheld 的「失败也落账」。
 *
 * `note` 是用户写给执行者的要点（选填，理由见 disputeResolutionNoteOf）。它跟着裁定
 * 一起落库、一起进时间线；`upheld` 时还会整段拼进修复提示，**并在那里声明它压过报告**。
 */
export async function resolveFreeReviewDispute(
  taskId: string,
  resolution: FreeReviewDisputeResolution,
  note: string | null = null,
  target: DisputeTarget | null = null,
): Promise<{ resolution: FreeReviewDisputeResolution; repairError: string | null; deferredTask: Task | null }> {
  const task = await freeTask(taskId);
  if (task.archived) throw new Error("归档任务不能裁定审查驳回");
  const handedOff = handoffBlockReason(task.handoff);
  if (handedOff) throw new Error(handedOff);
  const open = await targetedOpenDispute(taskId, target);
  const { activeDebateOf } = await import("./free-review-debate.js");
  if (await activeDebateOf(taskId)) throw new Error("辩论正在进行，等它结束再裁定");

  if (resolution === "deferred") {
    const { deferOpenDispute } = await import("./free-review-defer.js");
    const deferredTask = await deferOpenDispute(task, open, note);
    await releaseHeldReservation(taskId);
    return { resolution, repairError: null, deferredTask };
  }

  const at = now();
  // CAS：只有把裁定从空写成非空的那一次算数。上面那道「还在待裁定之列」与这里之间隔着
  // 好几个 await，两个表面（web 与飞书卡片）同时点时两边都过得了那道检查；只按 id 写的话
  // 后写的会盖掉先写的 —— 先到的 upheld 已经起了修复，后到的 withdrawn 再把记录改成
  // 「不用改了」。输掉的那一路如实报「已经裁定过了」，与 deferred 那条路（free-review-defer.ts）
  // 同一个口径。
  // upheld 时被闸按住的那次触发与裁定同一笔事务作废（理由见 forgetHeldTrigger ②）。
  const ruled = await db.transaction(async (transaction) => {
    const rows = await transaction.update(freeReviewRounds)
      .set({ disputeResolution: resolution, disputeResolvedAt: at, disputeResolutionNote: note })
      .where(and(
        eq(freeReviewRounds.id, open.round.id),
        disputeWritten,
        isNull(freeReviewRounds.disputeResolution),
        isNull(freeReviewRounds.disputeSupersededAt),
      ))
      .returning({ id: freeReviewRounds.id });
    if (rows.length && resolution === "upheld") await forgetHeldTrigger(taskId, transaction);
    return rows;
  }, { behavior: "immediate" });
  if (!ruled.length) throw new DisputeStaleError("这一轮驳回已经被裁定过了");
  await appendTaskTimeline(taskId, (resolution === "withdrawn"
    ? `你裁定第 ${open.round.round} 轮的未通过意见不用改了（采纳执行者的说法，报告与证据原样保留，审查结论本身不改写）。`
    // 写了要点时不能只说「照报告修复」：用户写要点，多半正是因为要改的不是报告那版。
    : `你裁定让执行者接着改第 ${open.round.round} 轮的意见（维持审查意见，未采纳驳回）：` +
      `${note ? "按你写的要点和报告修复" : "照报告修复"}。`)
    // 时间线只放摘要，全文留在那一轮的审查记录里（时间线不是正文的第二个家）。
    + (note ? `你写下的裁定要点：${summarize(note)}` : ""));
  bus.publish({ type: "task.review", taskId });
  if (resolution === "withdrawn") await releaseHeldReservation(taskId);

  let repairError: string | null = null;
  if (resolution === "upheld") {
    try {
      const { startManualFreeReviewRepair } = await import("./free-review-manual-repair.js");
      // 目标原样交下去：修复只按用户刚裁定的这一轮来（校验、报告、要点都取它）。
      await startManualFreeReviewRepair(taskId, {
        holdTurn: true, target: { runId: open.run.id, round: open.round.round },
      });
    } catch (error) {
      repairError = error instanceof Error ? error.message : String(error);
      // 报错里已经指了出路（再派一轮审查）时，就别再叫用户去点「按意见修复」——那颗按钮过的
      // 是同一道校验，只会再被拦一次。
      await appendTaskTimeline(taskId, `已裁定维持审查意见，但这次没能自动发起修复：${repairError}` +
        (repairError.includes("再派一轮审查") ? "。" : "；可在审查面板里手动点「按意见修复」。"));
      bus.publish({ type: "task.review", taskId });
    }
  }
  return { resolution, repairError, deferredTask: null };
}
