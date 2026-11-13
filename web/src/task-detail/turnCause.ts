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
 * 系统续跑记录认领它起头的那一回合：同一条会话上、它之后的第一个回合。中间隔着这条会话收到的输入
 * 就不是它起的头了。
 *
 * 待认领的记录**按会话**各存一份：同一任务里几条会话可以先后起续跑、稍后才各自开口（直播里回复
 * 要等第一条正文或工具事件才成气泡），合并时间线上它们是交错的。别的会话的续跑、输入、发言都碰
 * 不到这一条会话的待认领记录。没落到任何会话上的输入（你刚打的字，还没有 sessionId）对每条会话
 * 都算插话。
 *
 * 审查者那一侧的回合、就地验证回合不认：它们有自己的身份和开头。旁路回合起的续跑（side）同理，
 * 那条记录照旧是一条回执。
 */
export function markSystemResumes(items: readonly ConversationItem[]): void {
  // 会话 id → 这条会话上还没认到回合的续跑记录。记录没写会话（拿不到归属）的存在 "" 下，谁先开口归谁。
  const pending = new Map<string, EventItem>();
  for (const item of items) {
    if (item.kind === "user") {
      if (item.sessionId) pending.delete(item.sessionId);
      else pending.clear();
      continue;
    }
    if (item.kind === "event") {
      if (!item.resume) continue;
      const key = item.sessionId ?? "";
      if (item.resume.side) pending.delete(key);
      else pending.set(key, item);
      continue;
    }
    const key = pending.has(item.sessionId) ? item.sessionId : pending.has("") ? "" : null;
    if (key === null) continue;
    const note = pending.get(key)!;
    pending.delete(key);
    if (item.reviewer || item.sessionRole === "reviewer") continue;
    item.resumeCause = { reason: note.resume!.reason };
    note.onTurnHead = true;
  }
}
