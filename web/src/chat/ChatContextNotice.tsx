import type { ChatContextStatus } from "@ash/shared/chat";

export function ChatContextNotice({ context }: { context?: ChatContextStatus }) {
  if (!context) return null;
  const text = context.status === "compacting" ? "正在整理较早的群聊历史，近期消息与原文会保留。"
    : context.status === "failed" ? `历史整理失败，原文已保留。${context.error ?? "请稍后重新 @ 重试。"}`
    : context.status === "stopped" ? context.error ?? "历史整理已停止，下次点名时按需继续。"
    : context.hasSummary ? "较早历史已整理为共享摘要，近期消息保留原文。"
    : context.clearedAt ? "上下文已清空，后续点名从这里重新开始；旧消息仅供查看。" : "";
  return text ? <p className="chat-context-note" role="status">{text}</p> : null;
}
