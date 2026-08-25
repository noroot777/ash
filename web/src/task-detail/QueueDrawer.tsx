import { useCallback, useEffect, useMemo, useState } from "react";
import type { TaskListItem } from "@ash/shared";
import { DotsSixVertical, Lock, X } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

type QueueItem = {
  taskId: string;
  position: number;
  title: string;
  status: string | null;
  archived: boolean;
};

export function QueueDrawer({
  queueId,
  currentTaskId,
  allTasks,
  onClose,
  onChanged,
}: {
  queueId: string;
  currentTaskId: string;
  allTasks: TaskListItem[];
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [removeItem, setRemoveItem] = useState<QueueItem | null>(null);
  const [removing, setRemoving] = useState(false);
  const dispatcherManaged = useMemo(
    () => items.some((item) => allTasks.some((task) => task.id === item.taskId && task.parentId !== null)),
    [allTasks, items],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const queue = await api.queue(queueId);
      setItems(queue.items);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  }, [queueId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !removeItem) onClose(); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose, removeItem]);

  const locked = (item: QueueItem) => dispatcherManaged || item.status === "running" || item.status === "queued";
  const drop = async (index: number) => {
    const from = dragIndex;
    setDragIndex(null);
    setOverIndex(null);
    if (from === null || from === index || dispatcherManaged) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(index, 0, moved);
    setItems(next);
    try {
      await api.queueReorder(queueId, next.map((item) => item.taskId));
      onChanged?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      void load();
    }
  };

  const remove = async () => {
    if (!removeItem) return;
    setRemoving(true);
    try {
      await api.queueRemove(queueId, removeItem.taskId);
      setRemoveItem(null);
      await load();
      onChanged?.();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRemoving(false);
    }
  };

  return (
    <>
      <div className="task-drawer-scrim" onMouseDown={onClose} />
      <aside className="task-queue-drawer" aria-label="任务队列">
        <header>
          <div><span>队列</span><b>{items.length} 个任务</b></div>
          <button type="button" onClick={onClose} aria-label="关闭队列"><X size={16} /></button>
        </header>
        <p className="task-queue-hint">
          {dispatcherManaged
            ? "此队列含调度者派出的执行者，只读展示；顺序由调度者统一管理。"
            : "拖拽可调整顺序；运行中和排队中的任务不可移动或移出。"}
        </p>
        {error && <p className="task-queue-error">{error}</p>}
        <div className="task-queue-list">
          {loading ? <p>正在读取队列…</p> : items.map((item, index) => {
            const isLocked = locked(item);
            return (
              <div
                className={`task-queue-row${item.taskId === currentTaskId ? " is-current" : ""}${overIndex === index ? " is-over" : ""}`}
                key={item.taskId}
                draggable={!isLocked}
                onDragStart={(event) => {
                  if (isLocked) return event.preventDefault();
                  setDragIndex(index);
                  event.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(event) => {
                  if (dragIndex === null) return;
                  event.preventDefault();
                  setOverIndex(index);
                }}
                onDragEnd={() => { setDragIndex(null); setOverIndex(null); }}
                onDrop={(event) => { event.preventDefault(); void drop(index); }}
              >
                {isLocked ? <Lock size={12} /> : <DotsSixVertical size={13} />}
                <span className="task-queue-position">{index + 1}</span>
                <div><b>{item.title}</b><small>{item.status ?? "backlog"}{item.archived ? " · 已归档" : ""}</small></div>
                {!isLocked && (
                  <button type="button" onClick={() => setRemoveItem(item)} aria-label={`把 ${item.title} 移出队列`}>
                    <X size={13} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <footer>摘出后任务本身保留，只是不再由这条队列自动调度。</footer>
      </aside>
      {removeItem && (
        <ConfirmDialog
          title="从队列移除"
          message={`确定把“${removeItem.title}”移出队列？任务本身不会删除。`}
          confirmLabel="移出队列"
          busy={removing}
          onConfirm={() => void remove()}
          onClose={() => setRemoveItem(null)}
        />
      )}
    </>
  );
}
