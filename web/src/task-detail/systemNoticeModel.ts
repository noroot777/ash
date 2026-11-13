// 后端代写、占着真人回合的那几种指令（验收冲突交接、审查打回）怎么读。时间线旁注的类型与
// 文案不在这里，在 timelineNoticeCopy.ts。
const CONFLICT_HANDOFF = /^【验收未通过\s*·\s*需要你解冲突】/;
const REVIEW_SYSTEM_PROMPT = /^【(?:自由工作流审查未通过|自动(?:验证|审查)未通过|审查未通过)(?:\s*·[^】]+)?】/;
const BRACKET_TITLE = /^【([^】]+)】\s*/;

export function isConflictHandoff(text: string): boolean {
  return CONFLICT_HANDOFF.test(text.trimStart());
}

export function isReviewSystemPrompt(text: string): boolean {
  return REVIEW_SYSTEM_PROMPT.test(text.trimStart());
}

export function systemPromptTitle(text: string): string {
  const matched = BRACKET_TITLE.exec(text.trimStart());
  return matched?.[1]?.trim() || "系统指令";
}

export function systemPromptBody(text: string): string {
  return text.trimStart().replace(BRACKET_TITLE, "").trim();
}

export function systemPromptSummary(text: string): string {
  const body = systemPromptBody(text);
  const paragraph = body.split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  return paragraph.length > 180 ? `${paragraph.slice(0, 177)}…` : paragraph;
}

export function conflictFiles(text: string): string[] {
  const section = /冲突文件：\s*\n([\s\S]*?)(?:\n\s*\n请你来解决：|$)/.exec(text)?.[1] ?? "";
  return section.split("\n").map((line) => line.replace(/^\s*-\s*/, "").trim()).filter(Boolean);
}

export function conflictContextEvent(text: string): boolean {
  return /^开始验收[：:]|^验收未完成[：:].*冲突|^冲突交接[：:]|卡在「?合并(?:并清理)?」?这一站/.test(text);
}

/**
 * 「执行者驳回了这一轮意见，现在等你裁定」那条时间线旁注——**只给没有类型的老记录用**；
 * 新记录由服务端标成 `review.dispute`（见 timelineNoticeCopy.ts）。
 *
 * 匹配的是 `server/src/free-review-dispute.ts` 里唯一写它的那一处结尾——那句话把三/四条
 * 出路**列了出来却没给任何能点的东西**，用户读完还得自己去右边找审查面板（用户 2026-09-24
 * 反馈：「直接给个按钮不行吗」）。所以这条旁注上要挂一颗「去裁定」。
 *
 * 认这句而不是认句首：句首会随「驳回了 / 认可但越界 / 部分驳回」三种形态变，而「现在由你
 * 裁定」是三种共有的收尾。**光靠它还不够**——它只说明这条旁注当时在等裁定，不说明现在还
 * 等着；按钮的在与不在由 `openDisputeIn(reviews)` 决定，这里只负责挑中哪一行。
 */
export function pendingDisputeEvent(text: string): boolean {
  return /现在由你裁定[：:]/.test(text);
}
