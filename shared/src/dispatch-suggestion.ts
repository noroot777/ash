// 可以派出去的活：智能体干活时发现「这件事该做、但不属于本任务」，顺手把说明写好挂在回复框顶上
// （MCP `suggest_dispatch`）；用户一按就派成一条新任务，也可以先补一句、换人、改说明。
//
// 跟派活单（dispatch-plan.ts）的分别：派活单是智能体把**自己的活**拆出去，任务停下来等用户点头，
// 借的是提问那一格；建议不停任务、不占提问那一格、不影响完成确认，挂着就能派。一件的内容照派活单的
// 一条（标题、完整说明、一行为什么、交给谁），多一样「从哪开工」。
//
// 活多久（server/src/dispatch-suggestion.ts）：落库，一直挂到有人明着处理它，只有三种去处——用户派出去、
// 用户点了叉、挂它的智能体收回（`withdraw`，要写一句为什么；这句话记在会话里那一回合下面，用户看得到它
// 为什么不在了）。没有按回合数、按时间自动收掉的：用户还没处理的东西不在他不知情时消失，会话里那句
// 「挂在回复框顶上了」也就一直对得上。过时靠智能体自己收回或用户点叉；同一个标题不挂第二件。
import type { DispatchRunTarget } from "./dispatch-plan.ts";

/** 新任务从哪开工：从主分支开工 / 接着这条任务的代码。 */
export type DispatchSuggestionBase = "trunk" | "here";

export type DispatchSuggestion = {
  id: string;
  title: string;
  /** 完整说明：建出来的任务正文就是它（用户改过就是改过的）。 */
  body: string;
  /** 那一行「为什么」。 */
  note: string;
  /** 智能体指明了交给谁；null = 这条任务「派出去的活交给谁」的默认值。 */
  target: DispatchRunTarget | null;
  base: DispatchSuggestionBase;
  proposedAt: string;
};

/** 智能体收回一件：哪一件、为什么（这句话原样给用户看）。 */
export type DispatchSuggestionWithdrawal = { id: string; reason: string };

/** 用户按「派出去」时交给 ash 的那一件：此刻那一行上的样子。 */
export type DispatchSuggestionLaunchItem = {
  id: string;
  title: string;
  body: string;
  /** 用户补的那句话（只有选中着派时才有）。 */
  extra?: string;
  target: DispatchRunTarget;
  /** 落到 worktreeBase 上的开工起点；null = 项目目录此刻的 HEAD。 */
  worktreeBase: string | null;
};

export type DispatchSuggestionLaunchInput = {
  order: "serial" | "parallel";
  items: DispatchSuggestionLaunchItem[];
  /** 选中着派时框里贴的图：随新任务走。 */
  attachments?: string[];
};

/** 一次至多挂几件、一条任务上至多挂着几件。 */
export const MAX_SUGGESTIONS_PER_CALL = 6;
export const MAX_SUGGESTIONS_PER_TASK = 12;
export const MAX_SUGGESTION_NOTE_LEN = 120;
export const MAX_WITHDRAW_REASON_LEN = 120;

/** 补的话接在说明后面，标明是用户说的，跟智能体写的说明分得开。 */
export const SUGGESTION_EXTRA_HEADING = "## 用户补充";

export function suggestionTaskBody(body: string, extra?: string | null): string {
  const said = extra?.trim();
  return said ? `${body.trimEnd()}\n\n${SUGGESTION_EXTRA_HEADING}\n\n${said}` : body;
}

export function parseDispatchSuggestions(raw: string | null | undefined): DispatchSuggestion[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is DispatchSuggestion =>
      !!item && typeof item.id === "string" && typeof item.title === "string" && typeof item.body === "string");
  } catch {
    return [];
  }
}

/** 下发给页面的那一份：只给这几样（更早的版本在库里多记过一个回合令牌，不带出去）。 */
export function publicSuggestions(items: DispatchSuggestion[]): DispatchSuggestion[] {
  return items.map((item) => ({
    id: item.id, title: item.title, body: item.body, note: item.note ?? "", target: item.target ?? null,
    base: item.base === "here" ? "here" : "trunk", proposedAt: item.proposedAt,
  }));
}

/** 收回那一下记进会话的原文（时间线旁注的 text；页面按 notice 的参数另写说法，手机和读转录的看这一份）。 */
export function withdrawnSuggestionsText(items: readonly { title: string; reason: string }[]): string {
  return items.map((item) => `收回了建议任务「${item.title}」：${item.reason}`).join("\n");
}
