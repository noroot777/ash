import type { TaskDiscussion } from "@ash/shared";
import { discussionRoundsLabel, discussionTotalSegments, isBlindSeq, speakerAt } from "@ash/shared/discussion";
import { turnGist } from "./debateModel.ts";
import type { TalkSegment } from "./TalkOverview.tsx";

/**
 * 讨论的读取侧模型：会话里那颗讨论气泡、「审议」格里那一段、左侧抽屉里的完整记录，三处共用。
 *
 * 同辩论：**记录是每一段交卷落库的 statement**，不是各方在会话里随口说了什么（server/src/discussion.ts）。
 * 谁在第几段说、哪几段是各写各的，按 @ash/shared/discussion 那几条算，跟服务端同一份。
 */

const host = (discussion: TaskDiscussion) => discussion.participants.find((item) => item.host)?.agentType ?? "";

/** 「claude 和 codex」「claude、codex 和 gemini」：这条任务的执行器在前。 */
export function discussionPair(discussion: Pick<TaskDiscussion, "participants">): string {
  const names = [
    ...discussion.participants.filter((item) => item.host),
    ...discussion.participants.filter((item) => !item.host),
  ].map((item) => item.agentType);
  return names.length > 1 ? `${names.slice(0, -1).join("、")} 和 ${names.at(-1)}` : names.join("");
}

export function discussionTotal(discussion: TaskDiscussion): number {
  return discussionTotalSegments(discussion.rounds, discussion.participants.length);
}

const said = (discussion: TaskDiscussion) => discussion.turns.filter((turn) => turn.status === "done");

/** 正在说的（或该轮到的）那一段：第几段、谁。 */
export function discussionSpeaking(discussion: TaskDiscussion): { seq: number; who: string } {
  const speaking = discussion.turns.find((turn) => turn.status === "speaking");
  if (speaking) return { seq: speaking.seq, who: speaking.speaker };
  const seq = discussion.turns.length + 1;
  return { seq, who: speakerAt(discussion.participants, seq).agentType };
}

/** 上一段说完、下一段还没起头的那一下（概览和记录里照样有一行「正在组织发言…」）。 */
export function discussionWaiting(discussion: TaskDiscussion): { seq: number; who: string } | null {
  if (discussion.status !== "running" || discussion.turns.some((turn) => turn.status === "speaking")) return null;
  return discussionSpeaking(discussion);
}

export function discussionSegments(discussion: TaskDiscussion): TalkSegment[] {
  return discussion.turns.map((turn) => ({ ...turn, who: turn.speaker }));
}

/** 节头「第 N 段」后面那一句：第一轮写明写的时候没看别人的。 */
export function discussionSegmentHead(discussion: TaskDiscussion, seq: number): string | null {
  const people = discussion.participants.length;
  return isBlindSeq(seq, people) ? `写的时候没看${people > 2 ? "别人" : "对方"}的` : null;
}

export function discussionLive(discussion: TaskDiscussion): boolean {
  return discussion.status === "running" || discussion.status === "synthesizing";
}

/** 说完了怎么样：「claude 和 codex 谈了 4 段 · 谈拢了」。 */
function endedText(discussion: TaskDiscussion): string {
  const agreed = discussion.outcome === "agreed";
  return `${discussionPair(discussion)} 谈了 ${said(discussion).length} 段 · ${agreed ? "谈拢了" : "没谈拢"}`;
}

/**
 * 会话里那颗讨论气泡此刻写什么：
 * - 一段都还没交卷：各自在写第一段，互相看不到；
 * - 还在说：谁 + 刚说完那一段的一句话（新的一段说完就原地换字）；
 * - 说完了：谈了几段、谈拢没谈拢（在写合稿 / 合稿没写完另起一句说）；
 * - 中途断了：断在哪、为什么（服务端落的那一句，刷新后照样在），前面说过的几段都在。
 */
export function discussionBubbleText(discussion: TaskDiscussion): { lead: string | null; text: string } {
  const last = said(discussion).at(-1) ?? null;
  if (discussion.status === "running") {
    if (!last) return { lead: null, text: "各自在写第一段，互相看不到" };
    return { lead: last.speaker, text: turnGist(last) };
  }
  if (discussion.status === "failed") {
    const kept = said(discussion).length;
    return { lead: null, text: `讨论中止：${discussion.note ?? "没说完"}${kept ? `，前 ${kept} 段都在` : ""}` };
  }
  const tail = discussion.status === "finished" && discussion.note ? "，合稿没写完" : "";
  return { lead: null, text: `${endedText(discussion)}${tail}` };
}

/** 还在进行时气泡下面那一行小灰字：此刻谁在说第几段 / 谁在写合稿。 */
export function discussionNowText(discussion: TaskDiscussion): string {
  if (discussion.status === "synthesizing") return `${host(discussion)} 在写合稿`;
  const speaking = discussionSpeaking(discussion);
  return `${speaking.who} 在说第 ${speaking.seq} / ${discussionTotal(discussion)} 段`;
}

/** 气泡头上、「审议」格那一行底下的那一句：谁和谁 · 几轮。 */
export function discussionMeta(discussion: TaskDiscussion): string {
  return `${discussionPair(discussion)} · ${discussionRoundsLabel(discussion.rounds)}`;
}

/** 「审议」格那一行右边的状态字。 */
export function discussionStatusLabel(discussion: TaskDiscussion): string {
  if (discussion.status === "running") return "讨论中";
  if (discussion.status === "synthesizing") return "写合稿";
  if (discussion.status === "failed") return "中止";
  return discussion.outcome === "agreed" ? "谈拢了" : "没谈拢";
}
