// 可以派出去的活在页面上的那几份可变状态：用户改过的标题 / 说明 / 交给谁 / 谁来审 / 从哪开工，此刻选中的是哪一件，
// 抽屉里是不是在改。放在模块里而不是组件里：切到别的任务再回来，改过的东西还在（派出去之前别丢）；读全文的
// 抽屉是开的那一刻交出去的元素（components/LeftDrawer.tsx），它里面的标题、正文要跟着那一行变，就按身份订阅这里。
import { useSyncExternalStore } from "react";
import type { DispatchRunTarget } from "@navi/shared/dispatch-target";
import type { DispatchSuggestionBase } from "@navi/shared/dispatch-suggestion";
import type { CreateReviewChoice } from "@navi/shared/review-on-create";

export type SuggestionEdit = {
  title?: string; body?: string; target?: DispatchRunTarget; review?: CreateReviewChoice; base?: DispatchSuggestionBase;
};

/** 那一行此刻的样子，抽屉照着它画（由回复框里那一行发布，见 useSuggestionDock）。 */
export type SuggestionView = {
  id: string;
  taskId: string;
  title: string;
  body: string;
  who: string;
  /** 「从 main 开工」「接着这条的代码」；只有一处可开工时为空。 */
  baseLabel: string | null;
  /** 选中着时框里写的那句（补的话）。 */
  extra: string;
};

const edits = new Map<string, SuggestionEdit>();
const views = new Map<string, SuggestionView>();
const armed = new Map<string, string>();
let editing: string | null = null;
let version = 0;
const listeners = new Set<() => void>();

const changed = () => {
  version += 1;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** 订阅整份（版本号变了就重画）；读具体哪一件用下面几个读法。 */
export function useSuggestionStore(): number {
  return useSyncExternalStore(subscribe, () => version);
}

export const editOf = (id: string): SuggestionEdit => edits.get(id) ?? {};
export function editSuggestion(id: string, patch: SuggestionEdit): void {
  edits.set(id, { ...edits.get(id), ...patch });
  changed();
}

export const viewOf = (id: string): SuggestionView | null => views.get(id) ?? null;
export function publishViews(next: SuggestionView[]): void {
  let dirty = false;
  for (const view of next) {
    const old = views.get(view.id);
    if (old && old.title === view.title && old.body === view.body && old.who === view.who
      && old.baseLabel === view.baseLabel && old.extra === view.extra) continue;
    views.set(view.id, view);
    dirty = true;
  }
  if (dirty) changed();
}

export const armedOf = (taskId: string): string | null => armed.get(taskId) ?? null;
export function setArmed(taskId: string, id: string | null): void {
  if ((armed.get(taskId) ?? null) === id) return;
  if (id) armed.set(taskId, id);
  else armed.delete(taskId);
  changed();
}

export const editingOf = (id: string): boolean => editing === id;
export function setEditing(id: string | null): void {
  if (editing === id) return;
  editing = id;
  changed();
}

/** 派出去了、叉掉了：那一件的改动和画法都不用再留。 */
export function forgetSuggestions(ids: readonly string[]): void {
  for (const id of ids) {
    edits.delete(id);
    views.delete(id);
    if (editing === id) editing = null;
  }
  changed();
}
