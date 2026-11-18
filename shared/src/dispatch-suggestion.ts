// 可以派出去的活：智能体干活时发现「这件事该做、但不属于本任务」，顺手把说明写好挂在回复框顶上
// （MCP `suggest_dispatch`）；用户一按就派成一条新任务，也可以先补一句、换人、改说明。
//
// 跟派活单（dispatch-plan.ts）的分别：派活单是智能体把**自己的活**拆出去，任务停下来等用户点头，
// 借的是提问那一格；建议不停任务、不占提问那一格、不影响完成确认，挂着就能派。一件的内容照派活单的
// 一条（标题、完整说明、一行为什么、交给谁），多一样「从哪开工」。
//
// 活多久（server/src/dispatch-suggestion.ts）：落库，一直挂到有人明着处理它，只有三种去处——用户派出去、
// 用户点了叉、挂它的智能体收回（`withdraw`，要写一句为什么）。没有按回合数、按时间自动收掉的：用户还没
// 处理的东西不在他不知情时消失，会话里那句「挂在回复框顶上了」也就一直对得上。过时靠智能体自己收回或
// 用户点叉；同一个标题不挂第二件。
//
// 收回的那一件和它的原因是**同一笔**落库的（`WithdrawnSuggestion`，同一行、同一条更新）：那一行从框顶
// 不见了，原因就一定读得到，中间没有「拿掉了、还没来得及记」的空档。页面按时刻把它写在会话里收回的那一处
// （web/src/task-detail/suggestions/withdrawalNotes.ts），不经过会话正文，所以不看有没有会话、写不写得进文件。
// 这份记录只增不减（见 `WithdrawnSuggestion`）。
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

/**
 * 收回过的一件留下的记录：是哪一件、叫什么、为什么、什么时候。跟拿掉那一件同一笔落库，随任务下发。
 * 每一件都留着、跟任务同寿：没有条数上限、没有过期——这里没有任何东西知道用户看没看过，清掉哪一条都可能
 * 清掉他还没看到的那一句。一条记录要智能体先挂、再收回一次才有，两百来字节，量由它调用的次数定。
 */
export type WithdrawnSuggestion = { id: string; title: string; reason: string; at: string };

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

export function parseWithdrawnSuggestions(raw: string | null | undefined): WithdrawnSuggestion[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is WithdrawnSuggestion =>
      !!item && typeof item.id === "string" && typeof item.title === "string" && typeof item.reason === "string" && typeof item.at === "string");
  } catch {
    return [];
  }
}
