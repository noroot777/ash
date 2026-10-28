// 还没保存的那几个字。跟 `lib/DraftStore.tsx` 同一条原则：**组件卸载不该把用户敲的字
// 弄丢**，存活范围是这一次会话（刷新即清空）。
//
// 备忘这一格尤其吃这条，有两条路都会把面板卸载掉，而且都不是用户按的：
//  · 激活哪一格由 `stateKey` 推（它含任务 status 和 reviewFocused）—— 任务一跑完、一进
//    审查焦点，右边就自己跳回「信息 / 审查」；
//  · `InspectorHost` 只渲染当前那一格，切走 = 卸载。
// 于是「编辑一条备忘、还没保存，任务这会儿结束了」就把几百字连同编辑态一起带走了
// （独立审查第 2 轮 F1 实测）。草稿挪到模块级之后，切走再切回来，字还在、还在编辑态。
//
// 单独一份而不并进 `lib/DraftStore.tsx`：那份是 Context + Provider，形状按回复框/新建框
// 定（正文 + 附件 + 在途上传 + 随手记回链）；这里要的是「新建那条的草稿 + 哪几条在编辑」。
// 备忘的两个写入点本来就共用模块级 store（taskMemoStore.ts），放一块更一致。
import { useCallback, useSyncExternalStore } from "react";

export type TaskMemoDrafts = {
  /** 新建那条的草稿。null = composer 没开；`""` = 开着但还没打字。 */
  composing: string | null;
  /** memoId → 这条正在编辑的草稿。不在表里 = 这条是读态。 */
  edits: Readonly<Record<string, string>>;
};

const EMPTY: TaskMemoDrafts = { composing: null, edits: {} };

const drafts = new Map<string, TaskMemoDrafts>();
const listeners = new Map<string, Set<() => void>>();

function snapshot(taskId: string): TaskMemoDrafts {
  return drafts.get(taskId) ?? EMPTY;
}

function set(taskId: string, next: TaskMemoDrafts): void {
  // 空了就把整条记录删掉：Map 不该随着翻过的任务一直长。
  if (next.composing === null && !Object.keys(next.edits).length) drafts.delete(taskId);
  else drafts.set(taskId, next);
  for (const listener of listeners.get(taskId) ?? []) listener();
}

/** 新建那条的草稿。传 null = 收起 composer（取消，或者已经存上了）。 */
export function setMemoComposerDraft(taskId: string, text: string | null): void {
  set(taskId, { ...snapshot(taskId), composing: text });
}

/** 某条的编辑草稿。传 null = 退出这条的编辑态（取消、Esc，或者已经存上了）。 */
export function setMemoEditDraft(taskId: string, memoId: string, text: string | null): void {
  const current = snapshot(taskId);
  const edits = { ...current.edits };
  if (text === null) delete edits[memoId];
  else edits[memoId] = text;
  set(taskId, { ...current, edits });
}

export function useTaskMemoDrafts(taskId: string): TaskMemoDrafts {
  return useSyncExternalStore(
    useCallback((listener: () => void) => {
      const set = listeners.get(taskId) ?? new Set<() => void>();
      set.add(listener);
      listeners.set(taskId, set);
      return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(taskId);
      };
    }, [taskId]),
    () => snapshot(taskId),
    () => EMPTY,
  );
}
