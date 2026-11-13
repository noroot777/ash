// 「重跑上一回合」：上一回合非正常结束、但任务**仍停在终态**时的重试入口。
//
// 为什么不能只靠 `/tasks/:id/retry`：那条要求 `status === "failed"`。可续聊回合崩了是不改
// 任务状态的（`single-run.ts` 的 followUpFrom 分支只写一句「续聊回合异常结束(退出码 N),
// 任务状态保持「已完成」不变」），自由工作流的自动修复回合、审查回合同理。于是「一句话
// 没跑成」的任务停在 done，整个界面没有任何一个能重来的按钮 —— 用户只能自己重打一遍。
//
// 语义是**重跑上一回合**，不是「重跑整个任务」，按上一回合是谁跑的分两条路：
// - 普通回合（role=single、非旁路）→ 把上一句话重投给**同一条会话**（下称 turn 档）。
//   不用 RESUME_PROMPT 续跑，是因为回合可能死在 CLI 起来之前（503 no available account
//   就是），那时 CLI 侧压根没收到过这句话，只说「继续」等于把指令弄丢了。代价是 agent
//   有可能看见同一句话两遍 —— 宁可重一遍，也不能丢。
// - 自由工作流的审查回合（role=reviewer）→ 把**崩掉的那一轮审查**重新拉起来（review
//   档，见 free-review-round.ts 的 reopenFailedFreeReview）。用户在界面上看到的就是那条
//   审查会话，重试语义只能是「同一位审查者接着把这一轮跑完」；这里另拼一套普通回合，
//   跑的是实现 agent，等于把审查按钮接到了别人身上（第 2 轮审查 finding 1）。
//
// 「同一条会话」是这条路的**硬要求**，不是锦上添花：`resumeOrRunTask` 按任务自身的
// agentType 挑实现会话，@召唤别的执行器续聊、就地验证的验证者，跑的都不是那一条。所以
// 重投一律按崩掉那条会话自己记下的 profile（`sessions.executor_id` + 那一轮生效的
// 模型/思考强度）路由，并用 `resumeSessionId` 钉死续哪一行。profile 是可编辑可删的，所以
// 还要核一遍那条会话记下的**环境指纹**（`sessions.executor_fingerprint`）：对不上就 409，
// 不拿一套新环境冒充「原样重放」。
//
// 三个「看起来像崩了、其实不是」的形状必须挡在门外，判据都在库里，不靠猜：
// ① 手动停止/暂停 → CLI 吃 SIGTERM 后按 signal 写非零退出码，跟崩溃一模一样，认
//    `sessions.stopped_as`（finding 2）；
// ② 旁路回合（就地验证、`/compact` 这类原生命令）→ 认 `sessions.side_turn`，它们各有
//    自己的重来入口，重投会顶着同一个轮号另跑一段普通回合（finding 6）；
// ③ 就地验证轮还挂着（`verifyRound` 非空 = 那一轮没 concludeRound）→ 同上。
//
// 反过来，「崩了」的判据两档不同：重投档只有退出码可认；审查档认的是**那一轮有没有给出
// 结论**（审查链自己的 error/failed），因为 CLI 报错后照样 exit 0，退出码会漏判。
//
// 审查档的**对象**也不按「最新会话」认：前端带着那一轮审查的身份来（`review`，判据与理由见
// free-review-retry-identity.ts），这一档就只问审查链自己 —— 中间插进来一条不结束审查的旁路
// 回合（`/compact`），不该把还在等用户的那一轮的入口挤掉。只带 sessionId 的老请求照旧按
// 最新会话分档。
import { open, stat } from "node:fs/promises";
import type { AgentType, ConvSeg } from "@ash/shared";
import { parseSessionOutput } from "@ash/shared/session-output";
import { parseAttachmentText } from "@ash/shared/attachments";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { isAcceptingTask } from "./acceptance-lock.js";
import { noted, type RejectedAction } from "./user-action-rejection.js";
import { db } from "./db/index.js";
import { groups, sessions, tasks } from "./db/schema.js";
import { profileDrift } from "./executors/index.js";
import {
  freeReviewRetryBlocker, latestRun, reopenFailedFreeReview, reviewAwaitsInputDecision, reviewRetrySessionId, roundOf,
} from "./free-review-round.js";
import { reviewRetryIdentityMismatch, type ReviewRetryIdentity } from "./free-review-retry-identity.js";
import { turnEndedAbnormally } from "@ash/shared/turn-outcome";
import { turnOutcome } from "./session-turns.js";
import type { TurnOutcome } from "./session-turns.js";
import { handoffBlockReason } from "./handoff-guard.js";
import { continueTask } from "./orchestrator.js";
import { queueBlockedText, queueBlockerDetails, type QueueBlocker } from "./queues.js";
import { claimQueueSeat, queueClaimError, type QueueSeat } from "./queue-seat.js";
import { claimOwnTurn, releaseTurn } from "./runs.js";
import { RESUME_PROMPT } from "./run-prompts.js";
import { resumeOrRunTask } from "./task-resume.js";
import { preparePendingCheckpointStart } from "./pending-checkpoint-recovery.js";
import { appendTaskTimeline, alertLine } from "./task-timeline.js";
import { readableRunPath, sessionTranscriptPath } from "./transcript.js";
import { actorOf, ownerIdOf } from "./auth/context.js";

// 分档往回读会话正文，理由同 `task-follow-up.ts`：正文是一路追加的 Markdown，可能几 MB，
// 而要找的那一段就在末尾附近；agent 一条回复动辄几十 KB，固定尾巴长度不够用。
const TAIL_STEPS = [64 * 1024, 1024 * 1024, 32 * 1024 * 1024];

async function readTail(path: string, bytes: number): Promise<{ text: string; whole: boolean }> {
  const info = await stat(path);
  const handle = await open(path, "r");
  try {
    const length = Math.min(info.size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    const text = buffer.toString("utf8");
    const whole = length >= info.size;
    // 从中间切进去时第一行多半是半截字（还可能劈开一个 UTF-8 字符），丢掉；要的是**最后**
    // 一段，它离切口最远，永远完整。
    return { text: whole ? text : text.slice(text.indexOf("\n") + 1), whole };
  } finally {
    await handle.close();
  }
}

type NonAgentSeg = Exclude<ConvSeg, { kind: "agent" }>;

// 一段会话正文里**最后一个非 agent 段**：它就是「上一回合的输入」。是 user 段才可能重投；
// 是 system 段（系统续跑提示）说明上一回合本来就是续跑，重投没有意义。
//
// 后端旁注（level:"notice"：结算说明、会话轮换那句）不是输入，必须跳过 —— 它们恒在回合
// 收尾时落盘，也就是恒在最后一个真人回合之后。不跳的话每一个「没交卷」的失败回合末尾都
// 挂着一条旁注，`lastInputOf` 拿到 system 就判成「上一轮本来就是续跑」，于是「重跑上一
// 回合」再也重投不了用户那句话，静默退回 resume。
export function lastInputOf(out: string): NonAgentSeg | null {
  return [...parseSessionOutput(out)]
    .reverse()
    .find((seg): seg is NonAgentSeg => seg.kind !== "agent" && !(seg.kind === "system" && seg.level === "notice"))
    ?? null;
}

async function lastInputSeg(path: string): Promise<NonAgentSeg | null> {
  for (const step of TAIL_STEPS) {
    const { text, whole } = await readTail(path, step);
    const hit = lastInputOf(text);
    if (hit || whole) return hit;
  }
  return null;
}

type UserSeg = Extract<NonAgentSeg, { kind: "user" }>;

/** 重投档要原样重投的那句话。 */
export type ResendInput = { text: string; paths: string[]; bySystem: boolean; monitorWake: UserSeg["monitorWake"] };

// 上一回合的输入能不能原样重投:是 user 段、且去掉附件标记后还剩点东西。不能就落续跑档。
export function resendInputOf(seg: NonAgentSeg | null): ResendInput | null {
  if (seg?.kind !== "user") return null;
  const { body, paths } = parseAttachmentText(seg.text);
  const text = body.trim();
  if (!text && !paths.length) return null;
  return { text, paths, bySystem: !!seg.bySystem, monitorWake: seg.monitorWake };
}

export type RetryTurnTask = {
  archived: boolean;
  mode: string;
  status: string;
  verifyRound: number | null;
  question?: string | null;
  resumePrompt?: string | null;
  workflowMode?: string | null;
  handoff?: string | null;
};

export type RetryTurnSession = {
  id: string;
  role: string;
  turnStartedAt: string | null;
  startedAt: string;
  exitStatus: number | null;
  stoppedAs?: string | null;
  sideTurn?: boolean;
};

/** 判据的全部输入：任务、最新会话，加上三样只有查库才知道的事实。 */
export type RetryTurnFacts = {
  task: RetryTurnTask;
  /** 重跑落在哪条会话上。审查档(按审查身份来的)是最近那条审查会话,可能一条都没有。 */
  latest: RetryTurnSession | null;
  /** 分档。省略 = 按 `latest` 的身份分(只带 sessionId 的老请求)。 */
  kind?: RetryTurnKind;
  wantedSessionId?: string;
  /**
   * 普通回合里,上一回合的输入能不能原样重投(`resendInputOf`)。能 = 重投档,不能 = 续跑档。
   * 省略按不能算:续跑档是要过队列那道闸的那一档,不知道的时候往严里判。
   */
  resendable?: boolean;
  /** 同队列里挡着它执行的成员(`queueBlockerDetails`)。只有续跑档会被它挡。 */
  blockedBy?: QueueBlocker[];
  /** 所在分组被暂停（`scheduler.ts` 同样拒绝拉起暂停组的成员）。 */
  groupPaused?: boolean;
  /**
   * 上一回合那条 profile 后来被删了（missing）／被改过（changed）。
   * 判据是会话行里存的**环境指纹**，不是主键（见 `executors/index.ts` 的 profileDrift）。
   */
  profileDrift?: "missing" | "changed" | null;
  /** 审查档专用：这条审查链能不能重跑（`freeReviewRetryBlocker` 的结论）。 */
  reviewBlocker?: string | null;
  /**
   * 上一回合**自己**的权威结局（`session_turns.outcome`）。
   *
   * 退出码答不了「ash 判这一轮成没成」：被回合级停滞看门狗终止的那一轮,我们判它失败、区间
   * 记 failed,而被终止的进程多半以 **exit 0** 收流 —— 页面明写「本次续聊因上游连不上被自动
   * 终止」,重试却 409「上一回合不是异常结束」(审查 F2,已实测)。null = 不知道（回合还开着、
   * 存量行、收口没写成）,按老行为退回退出码判。
   */
  turnOutcome?: TurnOutcome | null;
};

/** 重试落在哪条路上，由**上一回合自己的身份**决定。 */
export type RetryTurnKind = "turn" | "review";

export function retryTurnKindOf(latest: RetryTurnSession): RetryTurnKind {
  return latest.role === "reviewer" ? "review" : "turn";
}

/**
 * 重跑落在哪一档。普通回合再按上一回合的输入分两档:
 * - resend:把上一句话重投给同一条会话 —— 终态任务上的续聊回合,`followUpFrom` 护着原终态;
 * - resume:没有可重投的原话,`system:"retry"` 续跑 —— 这才是任务的执行回合。
 * review 是旁路回合。三档里只有 resume 占队列执行位,队列那道闸也只挡它。
 */
export type RetryTurnTier = "review" | "resend" | "resume";

export function retryTurnTierOf(kind: RetryTurnKind, resendable: boolean | undefined): RetryTurnTier {
  return kind === "review" ? "review" : resendable ? "resend" : "resume";
}

/** 留痕里的操作名,跟用户按的那颗按钮同名(user-action-rejection.ts 的判据)。 */
export function retryTurnActionOf(kind: RetryTurnKind): RejectedAction {
  return kind === "review" ? "继续本轮审查" : "重试这一回合";
}

// 会话行**跨回合复用**：恢复一条旧 CLI 会话只更新 `turnStartedAt`，`startedAt` 停在它第一
// 次被创建的时刻。所以「最新会话」只能按最近一次回合排，按 `startedAt` 排会把「先建后用」
// 的会话永远判成旧的（口径同 `task-question.ts` 的 askingAgentFor）。
export function latestSessionOf<T extends RetryTurnSession>(rows: T[]): T | null {
  const turnAt = (row: RetryTurnSession) => row.turnStartedAt ?? row.startedAt;
  return [...rows].sort((left, right) => turnAt(left).localeCompare(turnAt(right))).at(-1) ?? null;
}

// 能不能重跑。纯函数：路由只负责取数据、占回合锁，判据全在这里，好钉测试。
// 返回 null = 放行；否则是要原样回给前端的那句拒绝理由。
export function retryTurnRejection(facts: RetryTurnFacts): { error: string; detail?: Record<string, unknown> } | null {
  const { task, latest } = facts;
  const kind = facts.kind ?? (latest ? retryTurnKindOf(latest) : "turn");
  if (task.archived) return { error: "任务已归档，先取消归档再重试", detail: { archived: true } };
  {
    const blocked = handoffBlockReason(task.handoff);
    if (blocked) return { error: blocked, detail: { handoff: true } };
  }
  // 只做单飞任务：duet 有自己的 gate 语义、团队调度台是常驻会话，两边的「上一回合」
  // 都不是这里这套 user/agent 交替的形状，硬套只会把它们的状态机搅乱。
  if (task.mode !== "single") return { error: "只有单飞任务支持重跑上一回合", detail: { mode: task.mode } };
  if (!latest && kind !== "review") return { error: "任务还没跑过，没有可重跑的回合" };
  // 前端按钮挂在某一条会话的尾栏上；带上 sessionId 就是在说「我要重跑的是**我看到的
  // 那一条**」。它不是最新会话就说明中间又跑过一轮，页面是旧的 —— 拒绝而不是照跑。
  if (facts.wantedSessionId && facts.wantedSessionId !== latest?.id) {
    return { error: "页面上的会话不是最新一次，刷新后再试", detail: { sessionId: latest?.id } };
  }
  if (task.status === "running" || task.status === "queued") {
    return { error: "任务正在运行或排队，结束后再重试", detail: { status: task.status } };
  }
  // 遗留的提问 / 检查点续跑指令必须先处理：它们各自有入口（答复、继续），而且这两个
  // 字段在结算与对账里都被当成「这条链在等答复」的正常态，带着它们重投会让等待中的那
  // 条链收不了尾（口径同 startFreeReview）。
  if (task.question) return { error: "任务正在等你答复，先回答再决定要不要重跑", detail: { question: true } };
  if (task.resumePrompt) return { error: "任务挂着待续跑指令，先让它继续，不必重跑上一回合", detail: { resumePrompt: true } };
  // 验证轮的轮次号还挂着 = 那一轮就地验证没出结论。它是旁路回合，重投等于顶着同一个轮号
  // 另跑一段普通回合（判据同 `/verify` 与 `task-accept-guard.ts`）。
  if (task.verifyRound !== null) {
    return { error: `第 ${task.verifyRound} 轮就地验证还没出结论，等它结束再重试`, detail: { verifyRound: task.verifyRound } };
  }
  // **主动停止/暂停也会留下非零退出码**（多数 CLI 吃 SIGTERM 后按 signal 写 exitStatus=1）。
  // 那不是崩溃，重投等于把用户刚亲手停下的那句话再跑一遍；界面上这种状态给的是「运行」。
  if (latest?.stoppedAs) {
    return { error: "上一回合是你手动停止的，不是异常结束；要继续请用运行", detail: { stoppedAs: latest.stoppedAs } };
  }
  // 退出码只在**重投档**上当「崩没崩」的判据。审查档另有权威判据，而且更准：那一轮到底
  // 有没有给出结论（`free_review_rounds.status='error'` + run `failed`，见
  // freeReviewRetryBlocker）。两者会分家 —— CLI 打完「API Error: Connection lost
  // mid-response」照样 exit 0（2026-09-11 实测：reviewer 会话 exit 0、审查链却停在 failed，
  // 时间线上明写「未能正常给出结论，已停止自动链」，界面却一个重跑入口都没有）。
  // 「算不算异常结束」整份住在 `@ash/shared/turn-outcome`:三个信号的优先级(真人停止 >
  // 这一轮自己的权威结局 > 退出码)写在那里,**前端那颗按钮读同一份** —— 两边各写一份 if
  // 就是在等下一次漂开,审查 F2 要修的恰恰是同一句判据在两端各错一次(都只看退出码)。
  // 审查档不吃这一条:它另有更准的判据(上面那段注释)。
  if (kind !== "review" && latest
    && !turnEndedAbnormally({ ...latest, turnOutcome: facts.turnOutcome })) {
    return {
      error: "上一回合不是异常结束，不需要重跑",
      detail: { exitStatus: latest.exitStatus, turnOutcome: facts.turnOutcome ?? null },
    };
  }
  if (facts.groupPaused) return { error: "所在分组已暂停，先恢复分组再重试", detail: { groupPaused: true } };
  // 同 /run：续跑档是任务的执行回合，同队有人在执行、或前面还有没让位的，就不该抢跑 ——
  // 少了这道闸，队里任务上的重试按钮就成了插队入口。另两档不是执行：审查档是旁路回合（派审
  // 本来就不查队列），重投档是终态任务的续聊（手打同一句话发出去也不受队列限制，见
  // task-reply.ts），队列按 followUpFrom 把它们看成原终态，既不因此停住、也不因此多拉一个
  // 成员。挡这两档，串行队列只要还在往下跑，队里已完成成员上断掉的那一回合就续不了。
  // 这里只是快速失败；续跑档真正的互斥是下面路由里的 claimQueueSeat。
  if (retryTurnTierOf(kind, facts.resendable) === "resume" && facts.blockedBy?.length) {
    return { error: queueBlockedText(facts.blockedBy), detail: { blockedBy: facts.blockedBy.map((b) => b.id) } };
  }
  // 「原样再跑一遍上一回合」的**保真前提**：那条 profile 还是当时那套执行环境。profile 是
  // 可编辑可删的（改 target 就换了台机器、改供应商就换了套账号），只存主键说不清这件事 ——
  // 于是「重投同一句话」会拿着旧 CLI 会话 id 去连一台从没跑过它的机器（第 1 轮审查
  // finding 2）。变了就 409，由用户明确决定要不要按新配置另起一回合（对话框 @ 它重发）。
  // 审查档同吃这一条：它重跑用的 `free_review_runs.executor_id` 引的是同一条可变 profile。
  if (facts.profileDrift === "missing") {
    return { error: "上一回合用的执行器已被删除，重跑不再是原样重放；请在对话框里 @ 一个执行器重新发一遍", detail: { profileDrift: "missing" } };
  }
  if (facts.profileDrift === "changed") {
    return { error: "上一回合用的执行器配置已被改过，重跑不再是原样重放；请在对话框里 @ 它重新发一遍", detail: { profileDrift: "changed" } };
  }
  if (kind === "review") {
    if (task.workflowMode !== "free") {
      return { error: "上一回合是审查旁路会话，重跑它请走审查那条路", detail: { role: "reviewer" } };
    }
    if (facts.reviewBlocker) return { error: facts.reviewBlocker, detail: { role: "reviewer" } };
    return null;
  }
  if (!latest) return { error: "任务还没跑过，没有可重跑的回合" };
  // 剩下的只放行普通实现回合：lead/voiceA/voiceB 这些身份连「上一回合」的形状都不同。
  if (latest.role !== "single") {
    return { error: "上一回合是旁路会话，这里重跑不了", detail: { role: latest.role } };
  }
  // 旁路回合（就地验证、`/compact` 这类 CLI 原生命令）用的是任务当前的默认配置重投，
  // 跑的根本不是那一轮的验证者；它们各有自己的重来入口。
  if (latest.sideTurn) {
    return { error: "上一回合是验证/命令旁路回合，请从它自己的入口重来", detail: { sideTurn: true } };
  }
  if (task.status !== "done") {
    return { error: "只有停在「已完成」的任务才谈得上重跑上一回合", detail: { status: task.status } };
  }
  return null;
}

type TaskRow = typeof tasks.$inferSelect;
type SessionRow = typeof sessions.$inferSelect;

export type RetryTurnRequest = { sessionId?: string; review?: ReviewRetryIdentity };

/** 一次性把判据要的东西全查出来。任务不存在返回 null。导出给回归脚本走真库核对。 */
export async function readRetryTurnFacts(
  taskId: string,
  request: RetryTurnRequest = {},
): Promise<{
  task: TaskRow; latest: SessionRow | null; kind: RetryTurnKind; resend: ResendInput | null; facts: RetryTurnFacts;
} | null> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return null;
  const rows = await db.select().from(sessions).where(eq(sessions.taskId, taskId));
  const overall = latestSessionOf(rows);
  const kind: RetryTurnKind = request.review ? "review" : overall ? retryTurnKindOf(overall) : "turn";
  let latest = overall;
  const group = task.groupId
    ? (await db.select({ paused: groups.paused }).from(groups).where(eq(groups.id, task.groupId))).at(0)
    : undefined;
  // 审查链的判据只在真的走审查档时才查（多两条 SQL 换不来任何东西）。
  let reviewBlocker: string | null = null;
  if (kind === "review" && task.workflowMode === "free") {
    const run = await latestRun(taskId);
    const round = run ? await roundOf(run) : null;
    reviewBlocker = freeReviewRetryBlocker(run, round, await reviewAwaitsInputDecision(task, run, round))
      ?? (request.review ? await reviewRetryIdentityMismatch(taskId, run!, request.review) : null);
    // 审查档的落点(停止记录、执行器指纹、续哪条上下文都读它)只认**这一轮输入实际进过的那条
    // 会话**,不认「最近的 reviewer」—— 那可能是上一条链的(free-review-retry-identity.ts)。
    // 这一轮还没有就是 null:从头交代任务书。只带 sessionId 的老请求因此也只能续到这一条,
    // 页面上那条不是它就 409 刷新。
    const bound = run ? reviewRetrySessionId(task, run) : null;
    latest = rows.find((row) => row.id === bound) ?? null;
  }
  // 重投还是续跑,要读会话正文最后一段输入才知道;判据(队列那道闸)和路由走哪档读的是同一份。
  const resend = kind === "turn" && latest
    ? resendInputOf(await lastInputSeg(readableRunPath(sessionTranscriptPath(taskId, latest.id))).catch(() => null))
    : null;
  return {
    task,
    latest: latest ?? null,
    kind,
    resend,
    facts: {
      task,
      latest: latest ?? null,
      kind,
      wantedSessionId: request.review ? undefined : request.sessionId,
      resendable: !!resend,
      blockedBy: retryTurnTierOf(kind, !!resend) === "resume" ? await queueBlockerDetails(taskId) : [],
      groupPaused: !!group?.paused,
      // 老会话行没记指纹（null）时返回 null = 无从核对，按老行为放行。
      profileDrift: latest ? await profileDrift(latest.executorId, latest.executorFingerprint) : null,
      reviewBlocker,
      turnOutcome: latest ? await turnOutcome(latest.id, latest.turnStartedAt ?? latest.startedAt) : null,
    },
  };
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function mountTaskRetryTurnRoutes(api: Hono): void {
  api.post("/tasks/:id/retry-turn", async (c) => {
    const taskId = c.req.param("id");
    const body = await c.req.json<RetryTurnRequest>().catch(() => ({} as RetryTurnRequest));
    const checkpointBlocked = await preparePendingCheckpointStart(taskId);
    // 挡回就留痕(`noted`,判据见那边):这颗按钮按下去没反应时,用户刷新页面后要能看出
    // 「点过、没成、因为什么」。下面每条 409 同理,**除了**一眼能从界面读到的那种
    // (任务已删、上一回合不存在 → 那本来就不显示这颗按钮)。
    // 这一刻还没读会话,按请求认按钮:页面上的「继续本轮审查」带着审查身份来。
    if (checkpointBlocked) {
      return c.json(await noted(taskId, retryTurnActionOf(body.review ? "review" : "turn"), { error: checkpointBlocked, checkpoint: true }), 409);
    }
    const first = await readRetryTurnFacts(taskId, body);
    if (!first) return c.json({ error: "not found" }, 404);
    const kind = first.kind;
    const action = retryTurnActionOf(kind);
    const rejection = retryTurnRejection(first.facts);
    if (rejection) return c.json(await noted(taskId, action, { error: rejection.error, ...rejection.detail }), 409);
    // 同 /run、/retry：原子占位，并发只有一个能 202。占位身份跟着分支走 —— 审查重跑此刻
    // 还没有审查回合，冒充 reviewer 会让迟到的结论上报被当成本回合的（见
    // reportFreeReviewConclusion 的 turnRole 校验）。
    // 占到的那把锁的**身份**一路带到交接与释放:这中间全是 await(权威重查、队列认领),
    // 人工放开可以把锁拔走、另一轮合法占上,按任务 id 还锁撤掉的就是后来者那把互斥
    // (本轮审查 F1,见 turn-lock.ts `endOwnTurn`)。
    const turn = claimOwnTurn(taskId, kind === "review" ? "dispatch" : "single");
    if (!turn) {
      return c.json(await noted(taskId, action, { error: "任务回合正在进行，结束后再重试", status: first.task.status }), 409);
    }
    // 占位之后的每一条出路都必须交接或释放这把锁：漏一条就是「500 一次、之后永远 409，
    // 只能重启服务」。所以 handed 只在**真正把 turnHeld 交给下游**的那一刻才置位。
    let handed = false;
    // 队列执行占位(重投/resume 档才占,见下;审查档是旁路回合,不是任务执行)。
    let seat: QueueSeat | null = null;
    try {
      // 占位后镜像检查验收锁，否则下游撞上验收锁静默 return，202 就成了谎报。
      if (isAcceptingTask(taskId)) {
        return c.json(await noted(taskId, action, { error: "任务正在验收（含发布尾段），结束后再重试", status: first.task.status }), 409);
      }
      // ── 占位后权威重查（口径同 review.ts）──
      // 上面那一遍是在**没有任何互斥**的情况下读的：从读完到 claimOwnTurn 之间隔着好几个
      // await，归档、取消、入队、验收随便哪个都能在这中间落库，而占位只挡得住「另一个
      // 回合」，挡不住这些不占 turn 的写操作。实测 20/20：并发归档 + 重试双双成功，任务
      // 落在 archived=true 且 running（第 2 轮审查 finding 3）。所以判据整套重跑一遍，
      // 拒绝走 finally 释放。
      const fresh = await readRetryTurnFacts(taskId, body);
      const again = fresh ? retryTurnRejection(fresh.facts) : { error: "任务已被删除", detail: undefined };
      if (!fresh || again) {
        const body = { error: again?.error ?? "任务已被删除", ...(again?.detail ?? {}) };
        // 任务真被删了就没地方留痕了(那条记录读不出来),其余照记。
        return c.json(fresh ? await noted(taskId, action, body) : body, 409);
      }
      const { task } = fresh!;
      // 分支在占位前后必须是同一个：占位身份是按它选的，变了就等于按错的身份占了锁。
      if (fresh!.kind !== kind) {
        return c.json(await noted(taskId, action, { error: "上一回合在这中间变了，刷新后再试", sessionId: fresh!.latest?.id }), 409);
      }

      // 交接必须**有人接住错误**：`void continueTask(...)` 在下游接管这把锁之前抛错（它
      // 开头还有一次 DB 读）时，锁会永远留在我们名下 —— 之后这个任务的每一次运行都 409，
      // 只能重启服务，而 202 已经发出去了，用户以为跑起来了（finding 4）。
      const handoff = (work: Promise<boolean | void>, what: string): void => {
        handed = true;
        void work.then(
          async (delivered) => {
            // continueTask 返回 false = 一个字都没送出去，且它自己已经把锁还了。
            if (delivered === false) await appendTaskTimeline(taskId, alertLine(`${what}未能启动：回合被其它执行抢占，请再试一次。`));
          },
          async (error) => {
            // 只有下游接管之前抛错才会到这（接管之后它自己 try/finally 兜底），锁还是
            // 我们占的那把，必须还回去。
            releaseTurn(taskId, turn);
            await appendTaskTimeline(taskId, alertLine(`${what}启动失败：${errorText(error)}；可以再试一次。`));
          },
        ).finally(() => {
          // 队列占位的收尾:真跑起来了是 no-op(结算覆盖状态);一个字都没跑成就按守卫
          // 回滚,别让任务卡在 queued(判据在 seat.release() 里)。
          if (seat) void seat.release();
        });
      };

      if (kind === "review") {
        // 我们占着 turn 调用（holdTurn 交给这里做）：审查投递在 continueWhenIdle 里排队，
        // finally 释放这把锁之后才真正开跑，和派审同一条路。
        // resumed = 这一次是「从中断处接着做」还是「重发整份任务书从头再来」，由崩掉那一
        // 回合留下的痕迹决定（见 reviewTurnResumable）。同一颗按钮两种结果，得如实回给前端。
        // dispatched=false = 同代次已经有一份在途派发在负责,这一次没有另起投递(时间线里
        // 也写了一句)。如实报出来,别让 202 冒充「我给你安排好了」(第 3 轮审查 F2)。
        try {
          // 续哪条会话由它自己按同一份归属定(就是上面判停止/指纹的那一条),这里不另传。
          const { resumed, dispatched } = await reopenFailedFreeReview(taskId);
          return c.json({ started: true, mode: "review", resumed, dispatched }, 202);
        } catch (error) {
          return c.json(await noted(taskId, action, { error: errorText(error) }), 409);
        }
      }

      // 走到这里是重投/续跑档,判据已经保证有那条会话。
      const latest = fresh!.latest!;
      // 崩掉的那一回合可能跑在**被召唤来的**执行器上（@codex 续聊），也可能任务的配置在
      // 这之后被改过。会话行记着那一轮真正生效的 profile 主键与模型/思考强度，按它整套
      // 重放；`agents.name` 反查是错的 —— 名字非唯一、可改，重名时会选中另一位（finding 5）。
      // 老会话行没有这三列（null）：只能退回按类型走默认 profile，与旧行为一致。
      // 重跑也是真人回合:共享项目里重跑别人的任务,烧的是**我**的 key(§八)。
      const acting = ownerIdOf(actorOf(c));
      const route = latest.executorId
        ? {
          agent: latest.agentType as AgentType,
          executorId: latest.executorId,
          model: latest.turnModel,
          reasoningEffort: latest.turnReasoningEffort,
        }
        : latest.agentType === task.agentType
          ? {}
          : { agent: latest.agentType as AgentType, model: null, reasoningEffort: null };
      // 重投还是续跑按占位后那一遍读到的定(判据放行的就是这一档)。
      const resend = fresh!.resend;
      if (resend) {
        handoff(continueTask(taskId, resend.text, {
          ...route,
          actingUserId: acting,
          attachments: resend.paths,
          // 后端代写的那句（审查打回等）重投时仍标 by:"system"：作者没变，重来一次不该
          // 把机器的话记成我说的。
          byBackend: resend.bySystem,
          monitorWake: resend.monitorWake,
          resumeSessionId: latest.id,
          turnHeld: turn,
          // 判据是在这里读的，CLI 却要到几个 await 之后才真正起来（执行器解析、worktree
          // 准备）：起跑前再核一遍冻结事实，不然「暂停分组已经 200 返回」和「重试把 CLI
          // 拉起来」会同时成立（第 1 轮审查 finding 1）。
          freezeGuard: true,
        }), action);
        return c.json({ started: true, mode: "resend" }, 202);
      }
      // 上一回合是系统续跑（会话里最后一段不是 user）：没有可重投的原话，改用续跑提示。
      // 会话行记着 profile 时仍旧钉死那一条会话；老行退回 `resumeOrRunTask`（它按任务的
      // agentType 挑会话，跟界面头部那颗「运行」同一条路）。
      //
      // 这一档是**任务的执行回合**(system:"retry" → followUpFrom=null),必须先认领队列
      // 执行占位(queue-seat.ts):从这里到 CLI 真正拉起之间隔着解析执行器、准备 worktree
      // 等一串 await,任务状态却一直停在 done —— 消息补投扫描在这个窗口里按 DB 状态判定
      // 「整队空闲」,会放行同队另一个失败成员的执行型回复,两个任务一起跑(第 7 轮审查:
      // 普通 HTTP 并发 10/10 复现)。claimQueueSeat 与扫描、/run、/fire、/retry、队列推进
      // 共用同一条认领链,占到位后这段窗口对任何入口都可见。上面的重投档不占:它重放的是
      // 续聊回合(followUpFrom 护住原终态),队列对续聊本就豁免,占位反而会让一次聊天重跑
      // 把整条队列挡住;审查档同理(旁路回合,不是任务执行)。
      const claim = await claimQueueSeat(taskId);
      if (!claim.ok) {
        return c.json(await noted(taskId, action, { error: queueClaimError(claim), blockedBy: claim.blockers }), 409);
      }
      seat = claim.seat;
      handoff(
        latest.executorId
          ? continueTask(taskId, RESUME_PROMPT, { ...route, actingUserId: acting, system: "retry", resumeSessionId: latest.id, turnHeld: turn, freezeGuard: true })
          : resumeOrRunTask(taskId, { reason: "retry", turnHeld: turn, actingUserId: acting }),
        action,
      );
      return c.json({ started: true, mode: "resume" }, 202);
    } finally {
      if (!handed) {
        releaseTurn(taskId, turn);
        // 占了队列位却没交接出去(权威重查 409、认领后又被拒):按守卫回滚,别卡在 queued。
        if (seat) void seat.release();
      }
    }
  });
}
