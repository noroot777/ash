// 系统续跑（「〔系统〕继续（从中断处）」那条记录）是**谁让它接着跑的**。
//
// 服务端起这一回合时手里就有缘由（continueTask 的 `system`），跟原文一起落进会话 .md 的
// sentinel、也跟着直播事件走；展示端据它在那一回合头上写一句（web 的 systemResumeTurns.ts），
// 不再回头认原文里的字。原文照旧落盘：老记录没有这个字段，只能认原文，写「系统续跑」。

/**
 * queue 队列推进 / run 有人点了运行或继续（界面上的按钮，或 agent 调 run_task）/ retry 用户点
 * 重试 / group 分组运行 / wake 上游完成后叫醒下游 / repair 预设工作流把这一站打回重做。
 */
export const RESUME_REASONS = ["queue", "run", "retry", "group", "wake", "repair"] as const;
export type ResumeReason = (typeof RESUME_REASONS)[number];

/**
 * side = 旁路回合（审查、就地验证、辩论那一段）起的续跑：它们自有身份和开头，展示端不在
 * 回合头上再说一遍缘由。
 */
export type SystemResume = { reason: ResumeReason; side?: true };

/** 读盘 / 读事件时的校验：形状不对就当没有（按老记录读），不抛。 */
export function systemResumeOf(value: unknown): SystemResume | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { reason, side } = value as { reason?: unknown; side?: unknown };
  if (!RESUME_REASONS.includes(reason as ResumeReason)) return undefined;
  return { reason: reason as ResumeReason, ...(side === true ? { side: true as const } : {}) };
}
