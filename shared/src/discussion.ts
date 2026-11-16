// 讨论：在一条普通任务的回复框里 `@` 一个（或两个）执行器、选「讨论」，它们和这条任务的执行器
// 各说各的、再来回几段，最后这条任务的执行器在主会话里照常回一段合稿。
//
// 服务端（server/src/discussion.ts）和网页（会话里那颗气泡、「审议」格里那一段、左抽屉的完整记录）
// 都按这里的几条规则算：谁在第几段说话、哪几段是「各写各的」、什么时候算谈拢了。两边各算一份迟早对不上。
//
// 这几条的来历是原来的讨论模式（server/src/duet/）：第一段互相看不到、合稿怎么写——做法搬过来，底子换成
// 审查辩论那一套（server/src/talk/segments.ts）。谈拢的判据没照搬：那边一方认同就收，这里要各方都表态。
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
 * 各方按什么顺序说：被叫来的人先、这条任务的执行器最后，每一轮都是这个顺序（合稿由最后说话的主执行器接着写）。
 *
 * 发起之前的背景不靠这个顺序保证：发起那一刻把本任务的对话记录截成一份只读副本，各方拿的是同一份
 * （server/src/discussion-background.ts）。
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
 * 说到这儿算不算谈拢了：**每一方**最新交过的那一段都表态「和各方最新的说法一致」。
 *
 * 只看最近几段不够：两方时被叫来的人一表态就收，主执行器连表态的机会都没有；三方时两位客人认了、主执行器
 * 最近明说不一致也照收。所以按人看——谁还没在第一轮之后说过话，或者最新那一段没表态认同，就还没谈拢。
 * 第一轮各写各的，谈不上一致，那几段不算表态。
 */
export function discussionAgreed(
  turns: readonly { seq: number; speaker: string; agreed: boolean | null; status: string }[],
  speakers: readonly string[],
): boolean {
  const people = speakers.length;
  if (!people) return false;
  const latest = new Map<string, { seq: number; agreed: boolean | null }>();
  for (const turn of turns) {
    if (turn.status !== "done" || isBlindSeq(turn.seq, people)) continue;
    const seen = latest.get(turn.speaker);
    if (!seen || seen.seq < turn.seq) latest.set(turn.speaker, turn);
  }
  return speakers.every((speaker) => latest.get(speaker)?.agreed === true);
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

/** 一份读不到的旧对话记录：是谁的（审查者那几条 role 不是 single）。 */
export interface DiscussionLostRecord {
  agentType: string;
  role: string;
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
  /** 按发言顺序。主执行器那一方的配置也是发起那一刻定下的：中途改了任务的执行器，这一场照旧由它说完、写合稿。 */
  participants: DiscussionParticipant[];
  /** 发起时附的图和文件：各方第一段都带上，会话里发起那一句也照它摆。 */
  attachments: string[];
  /**
   * 发起那一刻读不到的旧对话记录（被清理了，或没跟着任务搬过来）：讨论的背景里没有它们。各方的提示词里写明了，
   * 用户这边由气泡展开、「审议」格和完整记录照它写一句，不靠各方自己在发言或合稿里转述。没有为空。
   */
  lostBackground: DiscussionLostRecord[];
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
