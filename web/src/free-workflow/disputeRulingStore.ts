import { useCallback, useEffect, useReducer } from "react";
import type { FreeReviewDebateTurn, FreeReviewDisputeTarget } from "@ash/shared";
import { useLeftDrawer } from "../components/LeftDrawer.tsx";
import { focusReplyInput } from "../task-detail/replyQuote.ts";
import { DEBATE_SIDE_LABEL, turnGist } from "./debateModel.ts";
import { sameDisputeTarget, type RulingChoice } from "./disputeRuling.ts";

/**
 * 回复框顶上那一行选中的那一档、写的要点、辩几个来回——**连同它针对的那一条驳回**。
 *
 * 目标在选的那一刻就定死，提交只认它。只记档位的话，目标要到按发送时才从当前状态现算——而轮询或
 * 另一个窗口的裁定可以把这条驳回换成另一条，用户给 B 写的要点就会连同裁定一起落到 A 上（原来那张
 * 卡第 3 轮审查实测）。所以：驳回换了一条，这份草稿跟着旧那条走掉，不落到新那条上；提交带着冻结的
 * 目标，B 已经不在等裁定时服务端会如实拒，不会换人。
 *
 * 按任务存在模块里，不在回复框的 state 里：会话里那几颗「用这段作要点」、审查格、左侧抽屉都要往里写，
 * 它们跟回复框不在同一棵子树上。
 *
 * 要点三档共用一份：用户在几档之间来回比的时候不该丢掉已经写的话。它跟平常回复的草稿是两份——
 * 不选任何一档时回复框照常发普通消息。
 */
export type RulingDraft = {
  target: FreeReviewDisputeTarget;
  choice: RulingChoice | null;
  note: string;
  exchanges: number;
};

const drafts = new Map<string, RulingDraft>();
const listeners = new Map<string, Set<() => void>>();

function emit(taskId: string) {
  for (const listener of listeners.get(taskId) ?? []) listener();
}

function write(taskId: string, draft: RulingDraft | null) {
  if (draft) drafts.set(taskId, draft);
  else drafts.delete(taskId);
  emit(taskId);
}

/** 这个任务的草稿或那一行一变就重画。 */
function useTaskListener(taskId: string) {
  const [, rerender] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    const set = listeners.get(taskId) ?? new Set();
    set.add(rerender);
    listeners.set(taskId, set);
    return () => {
      set.delete(rerender);
      if (!set.size) listeners.delete(taskId);
    };
  }, [taskId]);
}

const fresh = (target: FreeReviewDisputeTarget): RulingDraft => ({ target, choice: null, note: "", exchanges: 1 });

/** 这一条驳回的草稿：存的那份不是它的就当没有（也不拿来起头）。 */
function draftFor(taskId: string, target: FreeReviewDisputeTarget): RulingDraft {
  const stored = drafts.get(taskId);
  return stored && sameDisputeTarget(stored.target, target) ? stored : fresh(target);
}

/**
 * `target` = 此刻等裁定的那一条；`known` = 审查状态已经读到（没读到时 target 为 null 不代表「没有」，
 * 切走再切回来那一下草稿不能就这么被清掉）。
 */
export function useRulingDraft(taskId: string, target: FreeReviewDisputeTarget | null, known: boolean) {
  useTaskListener(taskId);
  const stored = drafts.get(taskId) ?? null;
  const stale = !!stored && (target ? !sameDisputeTarget(stored.target, target) : known);
  useEffect(() => {
    if (stale && drafts.get(taskId) === stored) write(taskId, null);
  }, [stale, stored, taskId]);
  const draft = stored && !stale ? stored : null;
  const update = useCallback((change: (draft: RulingDraft) => RulingDraft) => {
    if (target) write(taskId, change(draftFor(taskId, target)));
  }, [target?.runId, target?.round, taskId]);
  return { draft, update };
}

/** 交完了（或者用户换了主意）：这一条的草稿清掉；不是它的那份不碰。 */
export function clearRulingDraft(taskId: string, target: FreeReviewDisputeTarget, keepNote = false) {
  const stored = drafts.get(taskId);
  if (!stored || !sameDisputeTarget(stored.target, target)) return;
  write(taskId, keepNote ? { ...stored, choice: null } : null);
}

/**
 * 回复框顶上那一行此刻真的画着（以及它针对哪一条、按不按得动）。登记的是那一行自己：它挂在回复框里，
 * 答题卡展开占着那一格时回复框连同它一起不挂，收起又回来——「用这段作要点」认的就是这份登记，
 * 跟那一行同生共死，不用各处再拿任务和审查状态各算一遍（左侧抽屉里拿的还是打开那一刻的任务）。
 */
type Dock = { target: FreeReviewDisputeTarget; blocked: boolean };
const docks = new Map<string, Dock>();

export function useRulingDockPresence(taskId: string, target: FreeReviewDisputeTarget, blocked: boolean) {
  useEffect(() => {
    const dock = { target, blocked };
    docks.set(taskId, dock);
    emit(taskId);
    return () => {
      if (docks.get(taskId) !== dock) return;
      docks.delete(taskId);
      emit(taskId);
    };
  }, [taskId, target.runId, target.round, blocked]);
}

/** 「用这段作要点」落进去的那一句：谁的第几段 + 概览上看到的那一句（完整发言留在抽屉里读）。 */
export function quotedTurn(turn: Pick<FreeReviewDebateTurn, "side" | "seq" | "summary" | "statement" | "status">): string {
  return `〔${DEBATE_SIDE_LABEL[turn.side]}第 ${turn.seq} 段〕${turnGist(turn)}`;
}

/**
 * 「用这段作要点」：把那一句落进要点、选中「让它接着改」、光标送回回复框。
 *
 * 已经写了字就往后追加而不是覆盖——用户可能先自己写了半句再想起来引用，覆盖掉等于把刚打的字吃了。
 * 落点是 upheld 那一档：引用一段发言的意思就是「照这个改」。
 */
export function quoteIntoRuling(taskId: string, target: FreeReviewDisputeTarget, text: string) {
  const base = draftFor(taskId, target);
  write(taskId, { ...base, choice: "upheld", note: base.note.trim() ? `${base.note.trimEnd()}\n\n${text}` : text });
  focusReplyInput(taskId);
}

/**
 * 会话气泡、审查格、左侧抽屉三处「用这段作要点」共用这一个：那一行此刻画着、按得动、针对的就是
 * `target` 这一条才给；按了落进要点，左侧抽屉收起（它盖着回复框）。
 */
export function useRulingQuote(taskId: string, target: FreeReviewDisputeTarget | null | undefined) {
  useTaskListener(taskId);
  const drawer = useLeftDrawer();
  const dock = docks.get(taskId);
  if (!target || !dock || dock.blocked || !sameDisputeTarget(dock.target, target)) return undefined;
  return (turn: FreeReviewDebateTurn) => {
    quoteIntoRuling(taskId, target, quotedTurn(turn));
    drawer?.close();
  };
}
