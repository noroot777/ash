import { useEffect, useState } from "react";
import { DotsSixVertical, X } from "@phosphor-icons/react";
import type { TaskStatus } from "@harness/shared";
import { Modal, ConfirmModal } from "./Modal";
import { StatusIcon } from "./StatusIcon";
import { api } from "./api";
import { toast } from "./toast";

type Item = {
  taskId: string;
  position: number;
  title: string;
  status: string | null;
  archived: boolean;
};

// 队列详情弹层(DESIGN-scheduling.md §1):列出 queue 里所有 task,支持
// 拖拽改顺序 + 把某 task 移出队列。running/queued task 不能被改位置或
// 移除(server 返回 409,这里 disable 掉对应的交互让用户少撞墙)。
export function QueueModal({
  queueId,
  currentTaskId,
  onClose,
  onChanged,
}: {
  queueId: string;
  currentTaskId?: string;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [confirmRemove, setConfirmRemove] = useState<Item | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  const load = () => {
    setLoading(true);
    api.queue(queueId).then(
      (q) => {
        setItems(q.items);
        setLoading(false);
      },
      (e) => {
        toast(`加载队列失败: ${e.message}`);
        setLoading(false);
      },
    );
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queueId]);

  const isLocked = (it: Item) =>
    it.status === "running" || it.status === "queued";

  const onDragStart = (i: number) => (e: React.DragEvent) => {
    if (isLocked(items[i])) {
      e.preventDefault();
      return;
    }
    setDragIdx(i);
    e.dataTransfer.effectAllowed = "move";
  };
  const onDragOver = (i: number) => (e: React.DragEvent) => {
    if (dragIdx === null) return;
    e.preventDefault();
    setOverIdx(i);
  };
  const onDragLeave = () => setOverIdx(null);
  const onDragEnd = () => {
    setDragIdx(null);
    setOverIdx(null);
  };
  const onDrop = (i: number) => async (e: React.DragEvent) => {
    e.preventDefault();
    const from = dragIdx;
    setDragIdx(null);
    setOverIdx(null);
    if (from === null || from === i) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(i, 0, moved);
    setItems(next); // optimistic
    try {
      await api.queueReorder(
        queueId,
        next.map((it) => it.taskId),
      );
      onChanged?.();
    } catch (err) {
      toast(`reorder 失败: ${(err as Error).message}`);
      load(); // revert
    }
  };

  const remove = async (it: Item) => {
    try {
      await api.queueRemove(queueId, it.taskId);
      onChanged?.();
      load();
    } catch (err) {
      toast(`移除失败: ${(err as Error).message}`);
    }
  };

  return (
    <>
      <Modal title={`队列 (${items.length} 个任务)`} onClose={onClose} width={600}>
        {loading ? (
          <div className="text-faint">加载中…</div>
        ) : items.length === 0 ? (
          <div className="text-faint">队列已空</div>
        ) : (
          <div className="flex flex-col gap-1">
            <p className="mb-2 text-[12px] text-faint">
              前一个 done / canceled 后下一个自动启动。拖拽可改顺序;摘出后任务本身保留、只是脱离队列。在跑的任务无法拖动或移出。
            </p>
            {items.map((it, i) => {
              const isCurrent = currentTaskId === it.taskId;
              const isOver = overIdx === i && dragIdx !== null && dragIdx !== i;
              const locked = isLocked(it);
              return (
                <div
                  key={it.taskId}
                  draggable={!locked}
                  onDragStart={onDragStart(i)}
                  onDragOver={onDragOver(i)}
                  onDragLeave={onDragLeave}
                  onDragEnd={onDragEnd}
                  onDrop={onDrop(i)}
                  className={`group flex items-center gap-2 rounded border bg-overlay px-2 py-1.5 text-[13px] transition ${
                    isCurrent ? "border-accent ring-1 ring-accent/40" : "border-line2"
                  } ${isOver ? "border-accent" : ""} ${dragIdx === i ? "opacity-50" : ""}`}
                >
                  <DotsSixVertical
                    size={12}
                    className={locked ? "text-faint/30" : "cursor-grab text-faint"}
                  />
                  <span className="w-6 text-right text-faint">{i + 1}.</span>
                  <StatusIcon status={(it.status as TaskStatus) ?? "backlog"} size={12} />
                  <span
                    className={`flex-1 truncate ${
                      isCurrent ? "font-medium text-ink" : "text-muted"
                    }`}
                    title={it.title}
                  >
                    {it.title}
                    {isCurrent && <span className="ml-1 text-[10px] text-faint">(当前)</span>}
                  </span>
                  {!locked && (
                    <button
                      onClick={() => setConfirmRemove(it)}
                      className="opacity-0 transition group-hover:opacity-100 hover:text-fail"
                      title="从队列移除(任务保留)"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Modal>
      {confirmRemove && (
        <ConfirmModal
          title="从队列移除"
          message={`确定把"${confirmRemove.title}"移出队列?任务本身不删,只是脱离队列、变成独立任务。`}
          confirmLabel="移除"
          onConfirm={() => {
            const it = confirmRemove;
            setConfirmRemove(null);
            void remove(it);
          }}
          onClose={() => setConfirmRemove(null)}
        />
      )}
    </>
  );
}
