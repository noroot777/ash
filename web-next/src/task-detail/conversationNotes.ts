// 会话流里那些不是「谁说的话」的行：预约审查、验收阶段更新、合并&清理完成、
// 验证轮开始/结束、预览起停…… 服务端有 70 多处 appendTaskTimeline 写它们，文案各写各的，
// 所以这里**只按关键词判语气，不判结构**——判错了最多是颜色不对，不会把会话切错段。
//
// 结构由 conversationModel 统一决定：
//   note     旁注,贴着上一段说话继续,不重复头像/执行器名(system 时间线通告都归这档)
//   boundary 回合边界(本轮执行结束 / 执行异常结束 / 本回合结束),保留整宽横线
export type ConversationEventTone = "neutral" | "error";
export type ConversationEventVariant = "note" | "boundary";

// 只收「这件事没办成」的词。「未通过」是审查结论、也确实要显眼,归红;
// 「通过」「完成」「开始」这类正常推进不进表。
const FAILED_HINTS = [
  "失败",
  "异常",
  "未通过",
  "没通过",
  "未完成",
  "打回",
  "暂缓",
  "已取消",
  "没起来",
  "起不来",
  "用完了",
  "警告",
  "错误",
];

export function noteTone(text: string): ConversationEventTone {
  return FAILED_HINTS.some((hint) => text.includes(hint)) ? "error" : "neutral";
}
