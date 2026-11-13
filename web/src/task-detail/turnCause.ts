// 回合头上「起因」那一句：这一回合不是你发话起的头，那是谁让它接着跑的。
//
// 两种来源：哨兵叫醒（monitorWakeTurns 认出来的，`wokenByMonitor`）、系统续跑（这里认）。系统续跑
// 在会话里只有一条「〔系统〕继续（从中断处）」记录，紧挨着它起头的那一回合。服务端写它时带上了
// 缘由（@ash/shared/system-resume），这里把缘由挂到那一回合头上；那条记录本身就不再作为回执收进
// 上一回合的「N 条记录」（同一件事不写两遍，见 conversationSystemRows 的 shown）。
//
// 只改排法，不改数据：那条记录仍在条目表里、原文不变——审查段的起止（conversationReviewLanes、
// conversationReviewer）照旧认它。
import { LEGACY_SYS_MARKER } from "@ash/shared";
import type { ResumeReason, SystemResume } from "@ash/shared/system-resume";
import type { ConversationItem } from "./conversationModel.ts";

type EventItem = Extract<ConversationItem, { kind: "event" }>;
type AgentItem = Extract<ConversationItem, { kind: "agent" }>;

/** 一条系统续跑记录的缘由。reason=null：老记录，没写缘由。 */
export type ResumeNote = { reason: ResumeReason | null; side?: true };

/** 这条系统注记是不是系统续跑的开头：带缘由的认缘由，老记录只能认原文。 */
export function resumeNoteOf(text: string, resume: SystemResume | undefined): ResumeNote | undefined {
  if (resume) return resume;
  return text.includes(LEGACY_SYS_MARKER) ? { reason: null } : undefined;
}

const RESUME_CAUSE: Record<ResumeReason, string> = {
  queue: "队列续跑",
  // run 不只来自界面上的按钮：智能体调 run_task、接力导入后起跑也是它，所以不写「你点了」。
  run: "手动续跑",
  retry: "你点了重试",
  group: "分组运行",
  wake: "上游完成后续跑",
  repair: "打回重做",
};

export function turnCauseText(item: AgentItem): string | null {
  if (item.wokenByMonitor) return "被哨兵叫醒";
  if (item.resumeCause) return item.resumeCause.reason ? RESUME_CAUSE[item.resumeCause.reason] : "系统续跑";
  return null;
}

/**
 * 系统续跑记录认领它起头的那一回合：同一条会话上、它之后的第一个回合。中间隔着你的话就不是它起
 * 的头了；隔着别的会话的发言不算（排序按时刻，别的会话可能插在中间）。
 *
 * 审查者那一侧的回合、就地验证回合不认：它们有自己的身份和开头。旁路回合起的续跑（side）同理，
 * 那条记录照旧是一条回执。
 */
export function markSystemResumes(items: readonly ConversationItem[]): void {
  let pending: EventItem | null = null;
  for (const item of items) {
    if (item.kind === "user") { pending = null; continue; }
    if (item.kind === "event") {
      if (item.resume) pending = item.resume.side ? null : item;
      continue;
    }
    if (!pending || (pending.sessionId && item.sessionId !== pending.sessionId)) continue;
    if (!item.reviewer && item.sessionRole !== "reviewer") {
      item.resumeCause = { reason: pending.resume!.reason };
      pending.onTurnHead = true;
    }
    pending = null;
  }
}
