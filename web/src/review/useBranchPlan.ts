import { useCallback, useEffect, useState } from "react";
import type { BranchPlanView, TaskListItem } from "@ash/shared";
import { api } from "../lib/api.ts";

/**
 * `loading` = 还不知道（手上没有可显示的 view）；`refreshing` = 手上有 view，正在做一次
 * **用户自己触发得出来**的重取（点刷新、任务刚变过）。
 *
 * 15 秒一次的后台重验两者都不置位：它是 stale-while-revalidate，界面上那份数据一直有效，
 * 宣布「取数中」只会让消费方把内容顶开又收回。判据是「用户能不能把这次取数跟自己的动作
 * 对上」——对不上的就必须静默。
 *
 * 失败路径同一把尺子，所以失败分两种：
 * - `error`：**可归因**的失败（首屏、点刷新、任务刚变过）。用户正等着这次结果，照常摆出来
 *   并阻塞验收。
 * - `staleReason`：后台静默重验失败。手上那份 view 并没有失效，把它升级成一行 alert 只会
 *   在用户什么都没做的时候把版面顶开 56px、顺手禁掉验收按钮——就是这次要修的毛病本身。
 *   不阻塞、不占版面，只够消费方在原地做个记号说明「这是上次的结果」。
 *
 * 两者都在下一次取数成功时清掉：恢复也不该留痕。
 */
type Snapshot = {
  view: BranchPlanView | null;
  error: string | null;
  staleReason: string | null;
  loading: boolean;
  refreshing: boolean;
};
type Entry = {
  snapshot: Snapshot;
  listeners: Set<(snapshot: Snapshot) => void>;
  version?: string;
  sequence: number;
  pending?: Promise<void>;
  timer?: ReturnType<typeof setInterval>;
};
const empty: Snapshot = { view: null, error: null, staleReason: null, loading: false, refreshing: false };
const entries = new Map<string, Entry>();

function load(taskId: string, entry: Entry, mode: "background" | "explicit" = "background"): Promise<void> {
  const force = mode === "explicit";
  if (entry.pending && !force) return entry.pending;
  const sequence = ++entry.sequence;
  const publish = (snapshot: Snapshot) => {
    if (sequence !== entry.sequence) return;
    entry.snapshot = snapshot;
    for (const listener of entry.listeners) listener(snapshot);
  };
  const hasView = !!entry.snapshot.view;
  // 这一次取数用户归不归得到自己头上——开头宣不宣布、失败怎么摆，都看它。
  const attributable = force || !hasView;
  // 后台重验且已有 view：一个字都不宣布，连一次空转的 publish 都不发。
  if (attributable) publish({ ...entry.snapshot, loading: !hasView, refreshing: hasView });
  const pending = api.branchPlan(taskId).then(
    view => publish({ view, error: null, staleReason: null, loading: false, refreshing: false }),
    reason => {
      const message = reason instanceof Error ? reason.message : String(reason);
      publish(attributable
        ? { view: entry.snapshot.view, error: message, staleReason: null, loading: false, refreshing: false }
        : { ...entry.snapshot, staleReason: message, loading: false, refreshing: false });
    },
  ).finally(() => { if (entry.pending === pending) entry.pending = undefined; });
  entry.pending = pending;
  return pending;
}

export function useBranchPlan(task: TaskListItem, enabled = true) {
  const active = enabled && !!task.useWorktree;
  const [state, setState] = useState<{ taskId: string; snapshot: Snapshot }>({ taskId: task.id, snapshot: empty });
  useEffect(() => {
    if (!active) return;
    let entry = entries.get(task.id);
    if (!entry) {
      entry = { snapshot: empty, listeners: new Set(), sequence: 0 };
      entries.set(task.id, entry);
    }
    const current = entry;
    const listener = (snapshot: Snapshot) => setState({ taskId: task.id, snapshot });
    current.listeners.add(listener);
    listener(current.snapshot);
    current.timer ??= setInterval(() => void load(task.id, current), 15_000);
    return () => {
      current.listeners.delete(listener);
      queueMicrotask(() => {
        if (current.listeners.size) return;
        clearInterval(current.timer);
        current.sequence++;
        if (entries.get(task.id) === current) entries.delete(task.id);
      });
    };
  }, [task.id, active]);
  useEffect(() => {
    const entry = active && entries.get(task.id);
    if (!entry || (entry.sequence > 0 && entry.version === task.updatedAt)) return;
    entry.version = task.updatedAt;
    void load(task.id, entry, "explicit");
  }, [task.id, task.updatedAt, active]);
  const refresh = useCallback(async () => {
    const entry = active && entries.get(task.id);
    if (entry) await load(task.id, entry, "explicit");
  }, [task.id, active]);
  return { ...(active && state.taskId === task.id ? state.snapshot : empty), refresh };
}
