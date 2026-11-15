// 讨论：在一条普通任务的回复框里 `@` 一个（或两个）执行器、选「讨论」，它们和这条任务的执行器
// 各说各的、再来回几段，最后这条任务的执行器在主会话里照常回一段合稿。
//
// 服务端（server/src/discussion.ts）和网页（会话里那颗气泡、「审议」格里那一段、左抽屉的完整记录）
// 都按这里的几条规则算：谁在第几段说话、哪几段是「各写各的」、什么时候算谈拢了。两边各算一份迟早对不上。
//
// 这几条的来历是原来的讨论模式（server/src/duet/）：第一段互相看不到、谈拢的判据、合稿怎么写——那条
// 流水线已经想清楚了，这里只把做法搬过来，底子换成审查辩论那一套（server/src/talk/segments.ts）。
import type { AgentType } from "./index.ts";

/** 来回几轮：1 / 2 / 3 轮，或谈拢为止（封顶 `DISCUSSION_UNTIL_AGREED_CAP` 轮）。 */
export type DiscussionRounds = 1 | 2 | 3 | "agreed";
export const DISCUSSION_ROUND_CHOICES: readonly DiscussionRounds[] = [1, 2, 3, "agreed"];
/** 「谈拢为止」最多说几轮：说到这儿还没谈拢就照「到了轮数」收，合稿如实写分歧。 */
export const DISCUSSION_UNTIL_AGREED_CAP = 6;
/** 除这条任务自己的执行器，最多再叫几个人（三方）。 */
export const MAX_DISCUSSION_GUESTS = 2;

export function discussionRoundsLabel(rounds: DiscussionRounds): string {
  return rounds === "agreed" ? "谈拢为止" : `${rounds} 轮`;
}

/** 请求体里那一格：认得的就用，其余一律退回 null（调用方决定报错还是用默认）。 */
export function discussionRoundsOf(raw: unknown): DiscussionRounds | null {
  if (raw === "agreed") return "agreed";
  const value = Number(raw);
  return value === 1 || value === 2 || value === 3 ? value : null;
}

/** 参与的一方。`agentType` 同时是它在这场讨论里的身份：一种执行器在一条任务里只有一条会话。 */
export interface DiscussionParticipant {
  agentType: AgentType;
  executorId: string | null;
  model: string | null;
  reasoningEffort: string | null;
  /** 这条任务自己的执行器：续任务自己的会话，讨论完由它写合稿。 */
  host: boolean;
}

/**
 * 各方按什么顺序说：被叫来的人先、这条任务的执行器最后，每一轮都是这个顺序。
 *
 * 被叫来的人第一次进这条任务时，「问一句」那一套会告诉它这里还有谁、对话记录在哪（peer-context.ts），
 * 它读到的应当正好是**发起讨论那一刻为止**的对话。主执行器先说的话，它那一段第一轮的发言就落进了
 * 那份记录，第一轮「互相看不到」就只剩一句提示词撑着。
 */
export function speakingOrder<T extends Pick<DiscussionParticipant, "host">>(participants: readonly T[]): T[] {
  return [...participants.filter((item) => !item.host), ...participants.filter((item) => item.host)];
}

/** 一场最多几段：轮数 × 人数（谈拢为止按封顶算）。 */
export function discussionTotalSegments(rounds: DiscussionRounds, people: number): number {
  return (rounds === "agreed" ? DISCUSSION_UNTIL_AGREED_CAP : rounds) * people;
}

/** 第 seq 段（从 1 起）由谁说：按发言顺序轮着来。 */
export function speakerAt<T>(order: readonly T[], seq: number): T {
  return order[(seq - 1) % order.length]!;
}

/** 第 seq 段是不是第一轮：各写各的，写的时候看不到别人这一场说了什么。 */
export function isBlindSeq(seq: number, people: number): boolean {
  return seq <= people;
}

/**
 * 说到这儿算不算谈拢了：第一轮之后，**最近连着 人数-1 段**都表态「和各方最新的说法一致」。
 *
 * 照原讨论模式的判据（duet/prompts.ts）：一方确认自己此刻的方案与对方一致，讨论就收敛，不必等对方
 * 再确认一遍——对方最新那一段就是它刚表态认同的东西。三方时要连着两段：第二个表态的人看得到第一个
 * 人的认同，剩下那一方最新的说法已经被两边都认了。第一轮各写各的，谈不上一致，那几段不算。
 */
export function discussionAgreed(
  turns: readonly { seq: number; agreed: boolean | null; status: string }[],
  people: number,
): boolean {
  const need = Math.max(1, people - 1);
  const done = turns.filter((turn) => turn.status === "done").sort((a, b) => a.seq - b.seq);
  const tail = done.slice(-need);
  if (tail.length < need) return false;
  return tail.every((turn) => !isBlindSeq(turn.seq, people) && turn.agreed === true);
}

export type DiscussionStatus = "running" | "synthesizing" | "finished" | "failed";
/** 怎么结束的：谈拢了 / 说满了轮数还没谈拢。 */
export type DiscussionOutcome = "agreed" | "rounds";
export type DiscussionTurnStatus = "speaking" | "done" | "error";

export interface DiscussionTurn {
  seq: number;
  /** 说这一段的那一方（`DiscussionParticipant.agentType`）。 */
  speaker: AgentType;
  /** 交卷时它自己写的那一句（写给用户看）；还没交卷为 null。 */
  summary: string | null;
  /** 完整发言；还没交卷（speaking/error）时为空串。 */
  statement: string;
  /** 它表态「谈拢了」；第一轮与没表态为 null。 */
  agreed: boolean | null;
  status: DiscussionTurnStatus;
  startedAt: string;
  endedAt: string | null;
}

export interface TaskDiscussion {
  id: string;
  /**
   * running = 还在说；synthesizing = 说完了，这条任务的执行器在写合稿（合稿就是它在主会话里的那一段
   * 回复，不在这里）；finished = 合稿也写完了；failed = 断了（`note` 写断在哪、为什么）。
   */
  status: DiscussionStatus;
  topic: string;
  rounds: DiscussionRounds;
  /** 按发言顺序。 */
  participants: DiscussionParticipant[];
  turns: DiscussionTurn[];
  outcome: DiscussionOutcome | null;
  /** 断了 / 合稿没写完时那一句；正常走完为 null。 */
  note: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** 发起一场讨论（POST /tasks/:id/discussions）。 */
export interface DiscussionStartInput {
  topic: string;
  attachments?: string[];
  rounds: DiscussionRounds;
  /** 被叫来的人（不含这条任务自己的执行器）。 */
  guests: Pick<DiscussionParticipant, "agentType" | "executorId" | "model" | "reasoningEffort">[];
}
