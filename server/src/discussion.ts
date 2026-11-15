// 讨论：回复框里 `@` 一个（或两个）执行器、选「讨论」——它们和这条任务的执行器各说各的、再来回几段，
// 说完由这条任务的执行器在主会话里照常回一段合稿。不再是一种单独的任务，就是普通任务上的一场对话。
//
// 底子是审查意见辩论那一套（talk/segments.ts）：每一段是一个**旁路回合**（任务状态、验收阶段、审查链
// 原样不动），发言用 `debate_reply` 交卷、带一句写给用户的摘要，推进只在结算里做，落在同一张表里
// （kind=discussion）。谁在第几段说、什么算谈拢，按 @ash/shared/discussion 那几条规则算。
//
// 一场讨论的一生：
//   发起 → 第 1 段 …… 第 N 段（每段一个旁路回合）→ 谈拢了 / 说满了轮数 → synthesizing：
//   这条任务的执行器续它自己的会话写合稿（也是旁路回合，回复就落在主会话里）→ finished。
//   中途任何一段被停下、崩了、没交卷 → failed，断在哪、为什么写进 ended_note，刷新后照样在；可以再发起一场。
// 合稿之后**没有闸口**：原来讨论模式末尾「等你拍板」那一步不要了，不满意照常回话，或者再讨论一次。
//
// 讨论期间（running / synthesizing）这条任务的回合归它：用户发的话照「任务在跑」排队（task-reply.ts、
// pending-delivery-facts.ts），派审、辩论、裁定都等它说完——它们插进两段之间，就会被当成讨论的一段结算。
import type { AgentType, DiscussionParticipant, DiscussionRounds, TaskDiscussion } from "@ash/shared";
import { AGENT_TYPES } from "@ash/shared";
import {
  discussionAgreed, discussionRoundsLabel, discussionRoundsOf, discussionTotalSegments, isBlindSeq,
  MAX_DISCUSSION_GUESTS, speakerAt, speakingOrder,
} from "@ash/shared/discussion";
import { asc, and, eq } from "drizzle-orm";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { freeReviewDebates, freeReviewRuns, tasks } from "./db/schema.js";
import { discussionSegmentPrompt, discussionSynthesisPrompt, type SpokenSegment } from "./discussion-prompts.js";
import { plainSummaryOf } from "./free-review-dispute.js";
import { releaseFreeWorkflowAction, tryAcquireFreeWorkflowAction } from "./free-workflow-lock.js";
import { handoffBlockReason } from "./handoff-guard.js";
import { claimOwnTurn, continueWhenIdle, releaseTurn, turnRole } from "./runs.js";
import {
  activeTalkOf, commitSegment, failTalk, hangingTalks, openSegment, segmentEnding, speakingTurnOf,
  statementOf, talkOrphaned, talkTurnsOf, type TalkRow, type TalkTurnRow,
} from "./talk/segments.js";
import { alertLine, appendTaskTimeline, receiptLine } from "./task-timeline.js";
import { id, now } from "./util.js";

type TaskRow = typeof tasks.$inferSelect;
const KIND = "discussion" as const;
/** 还归这场讨论管的两档：还在说、在写合稿。 */
const LIVE = ["running", "synthesizing"] as const;

/** 这条任务上此刻有没有一场讨论占着回合（还在说，或在写合稿）。 */
export async function discussionHolds(taskId: string): Promise<boolean> {
  return !!(await activeTalkOf(taskId, KIND, LIVE));
}

function participantsOf(talk: TalkRow): DiscussionParticipant[] {
  try {
    const parsed = JSON.parse(talk.participants ?? "[]") as DiscussionParticipant[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function roundsOf(talk: TalkRow): DiscussionRounds {
  return talk.untilAgreed ? "agreed" : (discussionRoundsOf(talk.exchanges) ?? 1);
}

function totalOf(talk: TalkRow): number {
  return discussionTotalSegments(roundsOf(talk), participantsOf(talk).length);
}

const pair = (order: readonly DiscussionParticipant[]) => {
  const host = order.find((item) => item.host);
  return [host, ...order.filter((item) => !item.host)].filter(Boolean).map((item) => item!.agentType).join(" 和 ");
};

/** 能不能在这条任务上开讨论：不能就说为什么（发送键上照这句灰着）。 */
export function discussionBlocker(task: TaskRow): string | null {
  if (task.mode !== "single" || task.parentId || task.reviewOf) return "只有普通任务能开讨论";
  if (task.workflowMode !== "free") return "这条任务是旧的预设工作流，开不了讨论";
  if (task.archived) return "归档任务不能开讨论";
  const handedOff = handoffBlockReason(task.handoff);
  if (handedOff) return handedOff;
  if (task.status === "running" || task.status === "queued") return "任务正在跑，这一轮结束后再开讨论";
  if (task.question || task.resumePrompt) return "任务正等着答复或续跑，处理完再开讨论";
  return null;
}

type GuestInput = { agentType?: unknown; executorId?: unknown; model?: unknown; reasoningEffort?: unknown };

function guestsOf(raw: unknown, host: AgentType): DiscussionParticipant[] {
  const list = Array.isArray(raw) ? raw as GuestInput[] : [];
  if (!list.length) throw new Error("先叫一个人来讨论");
  if (list.length > MAX_DISCUSSION_GUESTS) throw new Error(`最多再叫 ${MAX_DISCUSSION_GUESTS} 个人`);
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
  const guests = list.map((item): DiscussionParticipant => {
    const agentType = item.agentType as AgentType;
    if (!AGENT_TYPES.includes(agentType)) throw new Error(`认不出这个执行器：${String(item.agentType)}`);
    // 同一种执行器在一条任务里只有一条会话：叫它来讨论，说话的就是这条任务的执行器自己。
    if (agentType === host) throw new Error(`${agentType} 就是这条任务自己的执行器，叫别人来讨论`);
    return { agentType, executorId: text(item.executorId), model: text(item.model), reasoningEffort: text(item.reasoningEffort), host: false };
  });
  if (new Set(guests.map((item) => item.agentType)).size !== guests.length) throw new Error("同一个执行器叫了两次");
  return guests;
}

/** 别人在 `speaker` 上一段之后说的（第一轮恒为空：各写各的）。 */
function spokenSince(turns: readonly TalkTurnRow[], speaker: string, before: number): SpokenSegment[] {
  const done = turns.filter((turn) => turn.status === "done" && turn.statement && turn.seq < before);
  const last = done.filter((turn) => turn.side === speaker).at(-1)?.seq ?? 0;
  return done.filter((turn) => turn.seq > last && turn.side !== speaker)
    .map((turn) => ({ seq: turn.seq, speaker: turn.side, statement: turn.statement! }));
}

/** 第 seq 段交给谁说、交给它什么话。第一轮（各写各的）一律不带别人的发言。 */
export async function segmentPromptFor(taskId: string, talk: TalkRow, turn: TalkTurnRow): Promise<{ speaker: DiscussionParticipant; prompt: string }> {
  const order = participantsOf(talk);
  const speaker = order.find((item) => item.agentType === turn.side)!;
  const prompt = discussionSegmentPrompt({
    taskId, topic: talk.topic ?? "", order, rounds: roundsOf(talk), seq: turn.seq, total: totalOf(talk), speaker,
    previous: isBlindSeq(turn.seq, order.length) ? [] : spokenSince(await talkTurnsOf(talk.id), speaker.agentType, turn.seq),
  });
  return { speaker, prompt };
}

/**
 * 这一段的回合怎么起：一律是旁路回合（任务状态、验收阶段、审查链原样不动）。主执行器续任务自己的会话
 * （不带 agent，就是这条任务的常设配置）；被叫来的人照它被叫时的那一套（同「问一句」的 @），续它自己那条。
 */
export function segmentTurnOptions(speaker: DiscussionParticipant, blind: boolean, attachments: readonly string[]) {
  return {
    system: "run" as const,
    sideTurn: true,
    // 第一轮各方都还没见过用户发起时附的图和文件。
    ...(blind && attachments.length ? { attachments: [...attachments] } : {}),
    ...(speaker.host ? {} : {
      agent: speaker.agentType,
      executorId: speaker.executorId,
      model: speaker.model,
      reasoningEffort: speaker.reasoningEffort,
    }),
  };
}

/** 起一段：按这一段该谁说挑执行器与会话。 */
async function launchSegment(task: TaskRow, talk: TalkRow, turn: TalkTurnRow, attachments: string[]): Promise<void> {
  const { speaker, prompt } = await segmentPromptFor(task.id, talk, turn);
  await appendTaskTimeline(task.id, receiptLine(`讨论第 ${turn.seq}/${totalOf(talk)} 段：轮到 ${speaker.agentType}。`));
  bus.publish({ type: "task.review", taskId: task.id });
  continueWhenIdle(task.id, prompt, segmentTurnOptions(speaker, isBlindSeq(turn.seq, participantsOf(talk).length), attachments),
    (error) => failDiscussion(talk, turn, `${speaker.agentType} 第 ${turn.seq} 段没能起跑（${error}）`));
}

async function failDiscussion(talk: TalkRow, turn: TalkTurnRow | null, note: string): Promise<void> {
  await failTalk(talk, turn, { endedNote: note });
  await appendTaskTimeline(talk.taskId, alertLine(`讨论已中止：${note}。可以再发起一次。`));
  bus.publish({ type: "task.review", taskId: talk.taskId });
  // 讨论期间用户发的话一直排着（pending-delivery-facts.ts）；断了就该放出去。
  const { flushPendingWhenTurnIdle } = await import("./pending-messages.js");
  flushPendingWhenTurnIdle(talk.taskId);
}

/**
 * 用户在回复框里按「开始讨论」。跟派审、辩论同级的原子互斥（占位身份 dispatch）：只查 DB status 挡不住
 * 「普通回合已 claim、status 还没落 running」那段窗口。
 */
export async function startDiscussion(
  taskId: string,
  input: { topic?: unknown; attachments?: unknown; rounds?: unknown; guests?: unknown },
  opts: { holdTurn?: boolean } = {},
): Promise<{ discussionId: string }> {
  const topic = typeof input.topic === "string" ? input.topic.trim() : "";
  if (!topic) throw new Error("先写下要讨论什么");
  const rounds = discussionRoundsOf(input.rounds);
  if (!rounds) throw new Error("来回几轮只能是 1、2、3 轮或谈拢为止");
  const attachments = Array.isArray(input.attachments)
    ? input.attachments.filter((item): item is string => typeof item === "string" && !!item) : [];
  // 占到的那把锁的身份一路带到 finally（同辩论：按任务 id 还锁会撤掉后来者那把，见 turn-lock.ts）。
  const turnHold = opts.holdTurn ? claimOwnTurn(taskId, "dispatch") : null;
  if (opts.holdTurn && !turnHold) throw new Error("任务回合正在进行，结束后再开讨论");
  try {
    if (!tryAcquireFreeWorkflowAction(taskId)) throw new Error("这条任务上正有别的操作在进行");
    try {
      const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
      if (!task) throw new Error("任务不存在");
      const blocked = discussionBlocker(task);
      if (blocked) throw new Error(blocked);
      const host: DiscussionParticipant = {
        agentType: (task.agentType ?? "claude") as AgentType, executorId: task.executorId, model: task.model,
        reasoningEffort: task.reasoningEffort, host: true,
      };
      const order = speakingOrder([...guestsOf(input.guests, host.agentType), host]);
      if (await discussionHolds(taskId)) throw new Error("这条任务上已经在讨论了");
      const { activeDebateOf } = await import("./free-review-debate.js");
      if (await activeDebateOf(taskId)) throw new Error("审查意见辩论正在进行，说完再开讨论");
      const reviewing = (await db.select({ id: freeReviewRuns.id }).from(freeReviewRuns)
        .where(and(eq(freeReviewRuns.taskId, taskId), eq(freeReviewRuns.status, "reviewing")))).at(0);
      if (reviewing) throw new Error("审查正在进行，审完再开讨论");

      const at = now();
      const talk: typeof freeReviewDebates.$inferInsert = {
        id: id(), kind: KIND, roundId: "", runId: "", round: 0, taskId, status: "running",
        exchanges: rounds === "agreed" ? 0 : rounds, untilAgreed: rounds === "agreed", currentSeq: 1,
        topic, participants: JSON.stringify(order), startedAt: at, updatedAt: at, finishedAt: null,
      };
      await db.insert(freeReviewDebates).values(talk);
      const row = { verdict: null, outcome: null, endedNote: null, ...talk } as TalkRow;
      const turn = await openSegment(row, 1, speakerAt(order, 1).agentType);
      // 会话里那颗气泡从这一句起头（web conversationDiscussionRows.ts 按它认），措辞改了那边一起改。
      await appendTaskTimeline(taskId, receiptLine(`开始讨论：${pair(order)}，${discussionRoundsLabel(rounds)}。`));
      await launchSegment(task, row, turn, attachments);
      return { discussionId: talk.id };
    } finally {
      releaseFreeWorkflowAction(taskId);
    }
  } finally {
    if (turnHold) releaseTurn(taskId, turnHold);
  }
}

/**
 * 讨论里的一段交卷（MCP `debate_reply`，跟辩论共用一个工具：路由按此刻在进行的是哪一种分流）。只落库，
 * 不推进（推进在结算里，见 talk/segments.ts ③）。
 */
export async function submitDiscussionStatement(
  taskId: string,
  input: { summary?: unknown; statement?: unknown; agreed?: unknown },
): Promise<{ seq: number; speaker: string; blind: boolean; agreed: boolean | null; agreedIgnored: boolean }> {
  const statement = statementOf(input.statement);
  const summary = plainSummaryOf(input.summary, "summary", "用户靠逐段的这一句看懂这场讨论谈到哪了，别让他为了一句结论去读完所有发言");
  const talk = await activeTalkOf(taskId, KIND);
  if (!talk) throw new Error("当前没有正在进行的讨论");
  const turn = await speakingTurnOf(talk);
  if (!turn || turn.status !== "speaking") throw new Error("这一段发言已经交过卷了");
  // 每一段都是这条任务上的旁路回合（主执行器、被叫来的人都是），别的回合交不了这一段。
  const role = turnRole(taskId);
  if (role !== "side") throw new Error(`这一段轮到 ${turn.side} 发言，只有它这一段的回合能交卷`);
  const blind = isBlindSeq(turn.seq, participantsOf(talk).length);
  const agreed = blind ? null : input.agreed === true;
  if (!await commitSegment(turn, { summary, statement, agreed })) throw new Error("这一段发言已经交过卷了");
  bus.publish({ type: "task.review", taskId });
  return { seq: turn.seq, speaker: turn.side, blind, agreed, agreedIgnored: blind && input.agreed !== undefined };
}

/** 说完了：记下怎么结束的，交给这条任务的执行器写合稿。 */
async function finishTalking(task: TaskRow, talk: TalkRow, agreed: boolean, turns: TalkTurnRow[]): Promise<void> {
  const order = participantsOf(talk);
  const said = turns.filter((turn) => turn.status === "done").length;
  await db.update(freeReviewDebates).set({ status: "synthesizing", outcome: agreed ? "agreed" : "rounds", updatedAt: now() })
    .where(eq(freeReviewDebates.id, talk.id));
  // 气泡在这一句收口（web conversationDiscussionRows.ts 按它认），后面那段合稿是平常的一段回复。
  await appendTaskTimeline(task.id, receiptLine(`讨论结束：${pair(order)} 谈了 ${said} 段，${agreed ? "谈拢了" : "没谈拢"}。`));
  bus.publish({ type: "task.review", taskId: task.id });
  const host = order.find((item) => item.host)!;
  const prompt = discussionSynthesisPrompt({
    taskId: task.id, topic: talk.topic ?? "", order, rounds: roundsOf(talk), agreed, segments: said,
    previous: spokenSince(turns, host.agentType, Number.MAX_SAFE_INTEGER),
  });
  continueWhenIdle(task.id, prompt, { system: "run", sideTurn: true },
    (error) => closeSynthesis(talk.id, task.id, `合稿没能起跑（${error}）`));
}

/** 合稿那一回合收尾（或根本没起来）：这场讨论到此为止。 */
async function closeSynthesis(talkId: string, taskId: string, note: string | null): Promise<void> {
  const at = now();
  await db.update(freeReviewDebates).set({ status: "finished", endedNote: note, updatedAt: at, finishedAt: at })
    .where(eq(freeReviewDebates.id, talkId));
  if (note) await appendTaskTimeline(taskId, alertLine(`${note}。讨论的记录都在，可以让它照着记录重写，或者再讨论一次。`));
  bus.publish({ type: "task.review", taskId });
  const { flushPendingWhenTurnIdle } = await import("./pending-messages.js");
  flushPendingWhenTurnIdle(taskId);
}

/**
 * 讨论里一个回合结束时的结算：换人说 / 说完了去写合稿 / 合稿写完 / 中止。由 `afterSettlement` 在所有
 * 别的结算**之前**调——讨论的每一段都是旁路回合，交给审查那一路会被当成普通回合去消费预约、推审查链。
 *
 * 返回 true = 这一回合归讨论，已经收掉，调用方不要再走别的结算。审查者回合（role=reviewer）一律不认。
 */
export async function settleDiscussionTurn(taskId: string, turnOk: boolean, role: string): Promise<boolean> {
  if (role === "reviewer") return false;
  const talk = await activeTalkOf(taskId, KIND, LIVE);
  if (!talk) return false;
  if (talk.status === "synthesizing") {
    await closeSynthesis(talk.id, taskId, turnOk ? null : "合稿没写完（被停下或异常结束）");
    return true;
  }
  const ending = await segmentEnding(talk, turnOk);
  if (ending.kind === "missing") {
    await failDiscussion(talk, null, "找不到正在说的那一段");
    return true;
  }
  const turn = ending.turn;
  if (ending.kind === "stopped") {
    await failDiscussion(talk, turn, `${turn.side} 第 ${turn.seq} 段被停下或异常结束`);
    return true;
  }
  if (ending.kind === "silent") {
    await failDiscussion(talk, turn, `${turn.side} 第 ${turn.seq} 段说完没有交卷`);
    return true;
  }
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return true;
  const order = participantsOf(talk);
  const turns = await talkTurnsOf(talk.id);
  const agreed = discussionAgreed(turns.map((item) => ({ seq: item.seq, agreed: item.agreed, status: item.status })), order.length);
  if (agreed || turn.seq >= totalOf(talk)) {
    await finishTalking(task, talk, agreed, turns);
    return true;
  }
  const seq = turn.seq + 1;
  const next = await openSegment(talk, seq, speakerAt(order, seq).agentType);
  await launchSegment(task, { ...talk, currentSeq: seq }, next, []);
  return true;
}

/**
 * 启动对账（同 `reconcileFreeReviewDebates`，排在 reattach 之后）：进程死在两段之间、或死在合稿之前，
 * 这场讨论会永远挂着，用户发的话也一直排着出不去。
 */
export async function reconcileDiscussions(): Promise<void> {
  for (const talk of await hangingTalks(KIND, LIVE)) {
    if (!await talkOrphaned(talk)) continue;
    if (talk.status === "synthesizing") await closeSynthesis(talk.id, talk.taskId, "服务重启时合稿还没写完");
    else await failDiscussion(talk, await speakingTurnOf(talk), "服务重启时这一段已经没有回合在跑");
  }
}

/** 这条任务上开过的讨论，读成对外的形状（状态快照用），按开始时间排。 */
export async function discussionViews(taskId: string): Promise<TaskDiscussion[]> {
  const talks = await db.select().from(freeReviewDebates)
    .where(and(eq(freeReviewDebates.taskId, taskId), eq(freeReviewDebates.kind, KIND)))
    .orderBy(asc(freeReviewDebates.startedAt));
  return Promise.all(talks.map(async (talk): Promise<TaskDiscussion> => ({
    id: talk.id,
    status: talk.status as TaskDiscussion["status"],
    topic: talk.topic ?? "",
    rounds: roundsOf(talk),
    participants: participantsOf(talk),
    turns: (await talkTurnsOf(talk.id)).map((turn) => ({
      seq: turn.seq,
      speaker: turn.side as AgentType,
      summary: turn.summary ?? null,
      statement: turn.statement ?? "",
      agreed: turn.agreed ?? null,
      status: turn.status as "speaking" | "done" | "error",
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
    })),
    outcome: (talk.outcome as TaskDiscussion["outcome"]) ?? null,
    note: talk.endedNote ?? null,
    startedAt: talk.startedAt,
    finishedAt: talk.finishedAt,
  })));
}
