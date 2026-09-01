import type { ConversationEventTone } from "./conversationNotes.ts";

export type SystemEventKind = "neutral" | "progress" | "success" | "warning" | "error" | "notice" | "recovery";
export type SystemNoticeMode = "footnote" | "collapsed" | "attached";

export const SYSTEM_NOTICE_MODES: ReadonlyArray<{ value: SystemNoticeMode; label: string }> = [
  { value: "footnote", label: "会话脚注" },
  { value: "collapsed", label: "系统记录折叠" },
  { value: "attached", label: "消息尾注" },
];

const CONFLICT_HANDOFF = /^【验收未通过\s*·\s*需要你解冲突】/;
const BRACKET_TITLE = /^【([^】]+)】\s*/;
const SUCCESS = /已完成|完成|通过|已合并|合并完成|清理完成|已删除|已打开|已关闭|已保存|已同步|已恢复/;
const ACTIVE_PROGRESS = /开始|正在|已预约|已发起|已叫醒|等待|排队|继续|重跑|交接|处理中|即将/;
const WARNING = /警告|暂缓|等待用户|需要你|卡在|用完了/;

export function isConflictHandoff(text: string): boolean {
  return CONFLICT_HANDOFF.test(text.trimStart());
}

export function systemEventKind(text: string, tone?: ConversationEventTone): SystemEventKind {
  if (text.includes("原工作目录(worktree 与分支)已不存在") && text.includes("已重建为空目录")) return "recovery";
  if (tone === "notice") return "notice";
  if (tone === "error") return WARNING.test(text) && !/失败|异常|错误|未完成|未通过/.test(text) ? "warning" : "error";
  if (ACTIVE_PROGRESS.test(text)) return "progress";
  if (SUCCESS.test(text)) return "success";
  if (/更新/.test(text)) return "progress";
  return "neutral";
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
  return /^开始验收[：:]|^验收未完成[：:].*冲突|^冲突交接[：:]|^预览已回收|卡在「?合并(?:并清理)?」?这一站/.test(text);
}

export function systemNoticeModeFromSearch(search: string, hash = ""): SystemNoticeMode {
  const value = new URLSearchParams(search).get("systemNotices")
    ?? new URLSearchParams(hash.replace(/^#/, "")).get("systemNotices");
  return value === "collapsed" || value === "attached" ? value : "footnote";
}

const INITIAL_SEARCH = typeof window === "undefined" ? "" : window.location.search;
const INITIAL_HASH = typeof window === "undefined" ? "" : window.location.hash;
export const INITIAL_SYSTEM_NOTICE_MODE = systemNoticeModeFromSearch(INITIAL_SEARCH, INITIAL_HASH);
export const SYSTEM_NOTICE_DEMO_REQUESTED = new URLSearchParams(INITIAL_SEARCH).has("systemNotices")
  || new URLSearchParams(INITIAL_HASH.replace(/^#/, "")).has("systemNotices");
