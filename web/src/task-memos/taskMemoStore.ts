// 任务备忘的前端数据层：**一个任务一份，全页面共用**。
//
// 为什么不是面板自己 useState 拉一次：加备忘有两个入口，而它们不在同一棵子树里 ——
// 面板里的「新建」，和会话选文浮条上的「添加到备忘」（它在中间栏，加完才切到面板）。
// 各拉各的话，浮条加完那条要等面板重新挂载才看得见，面板开着的时候则永远不刷新。
// 共用一份之后，谁写进来都是同一个 Map，订阅它的那几处当场一起更新。
//
// 没做 SSE 推送：备忘是**人自己写给自己看的**，不会有第二个来源在后台改它（agent 碰不到
// 这张表）。多开一个标签页的话另一页要刷新才同步 —— 为这点代价开一条实时通道不划算。
import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { TaskMemo } from "@ash/shared/task-memo";
import { api } from "../lib/api.ts";

export type TaskMemoState = {
  memos: readonly TaskMemo[];
  /** 还没从后端读到过（区分「这个任务没有备忘」和「还没问过」）。 */
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /**
   * 刚加进来那条的 id。给面板高亮用 —— 从会话里选一段「添加到备忘」时，面板是**这一下
   * 才切过去的**，列表里可能已经躺着十几条，不指一下没人知道刚才那段落在哪儿了。
   */
  justAddedId: string | null;
};

const EMPTY: TaskMemoState = { memos: [], loaded: false, loading: false, error: null, justAddedId: null };

const store = new Map<string, TaskMemoState>();
const listeners = new Map<string, Set<() => void>>();
/** 每个任务最近一次读取的代号：迟到的旧应答不许覆盖新结果。 */
const reads = new Map<string, number>();

function emit(taskId: string) {
  for (const listener of listeners.get(taskId) ?? []) listener();
}

function set(taskId: string, patch: Partial<TaskMemoState>) {
  store.set(taskId, { ...(store.get(taskId) ?? EMPTY), ...patch });
  emit(taskId);
}

function snapshot(taskId: string): TaskMemoState {
  return store.get(taskId) ?? EMPTY;
}

function subscribe(taskId: string, listener: () => void): () => void {
  const set = listeners.get(taskId) ?? new Set();
  set.add(listener);
  listeners.set(taskId, set);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(taskId);
  };
}

const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

/** 新的排前面：列表按 updatedAt 倒序，改过的一条会自己浮到最上面。 */
function sorted(rows: readonly TaskMemo[]): TaskMemo[] {
  return [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function reloadTaskMemos(taskId: string): Promise<void> {
  const token = (reads.get(taskId) ?? 0) + 1;
  reads.set(taskId, token);
  set(taskId, { loading: true, error: null });
  try {
    const rows = await api.taskMemos(taskId);
    if (reads.get(taskId) !== token) return;
    set(taskId, { memos: sorted(rows), loaded: true, loading: false, error: null });
  } catch (reason) {
    if (reads.get(taskId) !== token) return;
    set(taskId, { loading: false, error: message(reason) });
  }
}

/**
 * 写进这个任务的备忘。会话选文浮条上的「添加到备忘」直接调它 —— 它不在面板那棵子树里，
 * 拿不到面板的 hook，而这条写入必须落进同一份缓存，否则切过去看不见刚加的那条。
 */
export async function addTaskMemo(taskId: string, body: string): Promise<TaskMemo> {
  const memo = await api.createTaskMemo(taskId, body);
  const current = snapshot(taskId);
  set(taskId, { memos: sorted([memo, ...current.memos]), loaded: current.loaded, justAddedId: memo.id });
  return memo;
}

export async function editTaskMemo(taskId: string, memoId: string, body: string): Promise<TaskMemo> {
  const memo = await api.updateTaskMemo(taskId, memoId, body);
  const current = snapshot(taskId);
  set(taskId, { memos: sorted(current.memos.map((row) => (row.id === memo.id ? memo : row))) });
  return memo;
}

export async function removeTaskMemo(taskId: string, memoId: string): Promise<void> {
  await api.deleteTaskMemo(taskId, memoId);
  const current = snapshot(taskId);
  set(taskId, { memos: current.memos.filter((row) => row.id !== memoId) });
}

/** 高亮是一次性的提示，不是状态：面板认完就撤，免得下次再打开这一格它还亮着。 */
export function clearTaskMemoHighlight(taskId: string): void {
  if (snapshot(taskId).justAddedId === null) return;
  set(taskId, { justAddedId: null });
}

/**
 * 订阅一个任务的备忘。`enabled` 为 false 时只读缓存、不发请求 —— 面板没开的时候，
 * 详情页仍然要知道「这个任务有没有备忘」（图标条上那点底色），但那一发由开着的那一处
 * 统一负责，不必每个订阅者各拉一次。
 */
export function useTaskMemos(taskId: string, enabled = true): TaskMemoState {
  const state = useSyncExternalStore(
    useCallback((listener: () => void) => subscribe(taskId, listener), [taskId]),
    () => snapshot(taskId),
    () => EMPTY,
  );
  useEffect(() => {
    if (!enabled) return;
    // 已经读到过就不再重复拉：切面板来回点不该每次都打一发。要最新的用 reloadTaskMemos。
    if (snapshot(taskId).loaded || snapshot(taskId).loading) return;
    void reloadTaskMemos(taskId);
  }, [enabled, taskId]);
  return state;
}
