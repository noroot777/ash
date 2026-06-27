import type { Task, TaskStatus } from "@harness/shared";
import { isUserSettableStatus } from "@harness/shared";
import { STATUSES } from "./constants";
import { PriorityIcon, PauseHint } from "./ui";
import { StatusIcon } from "./StatusIcon";
import { pairBadge } from "./util";

// Kanban board: one column per status, drag a card across columns to change its
// status. Clicking a card opens it (switches back to list+detail).
// paused 不单独成列 —— 它在视觉上属于"进行中"的一种（跑到检查点等续跑），
// 跟 running 同住一列；卡片本身用 StatusIcon + PauseHint 区分。
export function Board({
  tasks,
  onMove,
  onOpen,
}: {
  tasks: Task[];
  onMove: (id: string, status: TaskStatus) => void;
  onOpen: (id: string) => void;
}) {
  const columns = STATUSES.filter((s) => s.key !== "paused");
  return (
    <div className="flex h-full gap-3 overflow-x-auto px-4 py-4">
      {columns.map((s) => {
        const col = tasks.filter((t) =>
          s.key === "running" ? t.status === "running" || t.status === "paused" : t.status === s.key,
        );
        // running/queued/awaiting_review are system-owned — you can't drop a card
        // into them by hand (that would fake an execution state).
        const droppable = isUserSettableStatus(s.key);
        return (
          <div
            key={s.key}
            className={`flex w-72 shrink-0 flex-col rounded-lg border border-line bg-panel ${droppable ? "" : "opacity-75"}`}
            onDragOver={(e) => droppable && e.preventDefault()}
            onDrop={(e) => {
              if (!droppable) return;
              const id = e.dataTransfer.getData("text/plain");
              if (id) onMove(id, s.key);
            }}
          >
            <div className="flex items-center gap-2 border-b border-line px-3 py-2">
              <StatusIcon status={s.key} size={13} />
              <span className="text-[12px] font-semibold text-ink">{s.label}</span>
              <span className="font-mono text-[11px] text-faint">{col.length}</span>
              {!droppable && <span className="ml-auto text-[10px] text-faint">系统态</span>}
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto p-2">
              {col.map((t) => (
                <div
                  key={t.id}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData("text/plain", t.id)}
                  onClick={() => onOpen(t.id)}
                  className="rise cursor-pointer rounded-md border border-line bg-raised/50 p-2.5 transition-colors hover:border-line2"
                >
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5">
                      <PriorityIcon p={t.priority} />
                    </span>
                    {/* paused 任务在 running 列里靠图标自我标识 */}
                    {t.status === "paused" && (
                      <span className="mt-0.5">
                        <StatusIcon status="paused" size={13} />
                      </span>
                    )}
                    <span className="text-sm leading-snug text-ink">{t.title}</span>
                  </div>
                  <PauseHint task={t} allTasks={tasks} onOpen={onOpen} />
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {t.labels.map((l) => (
                      <span key={l} className="rounded-full border border-line px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                        {l}
                      </span>
                    ))}
                    <span className={`ml-auto rounded px-1.5 py-0.5 font-mono text-[10px] ${pairBadge(t).cls}`}>
                      {pairBadge(t).label}
                    </span>
                  </div>
                </div>
              ))}
              {col.length === 0 && <div className="py-6 text-center text-[11px] text-faint">—</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
