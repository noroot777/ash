import type { Task, TaskStatus } from "@harness/shared";
import { STATUSES } from "./constants";
import { PriorityIcon } from "./ui";

// Kanban board: one column per status, drag a card across columns to change its
// status. Clicking a card opens it (switches back to list+detail).
export function Board({
  tasks,
  onMove,
  onOpen,
}: {
  tasks: Task[];
  onMove: (id: string, status: TaskStatus) => void;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="flex h-full gap-3 overflow-x-auto px-4 py-4">
      {STATUSES.map((s) => {
        const col = tasks.filter((t) => t.status === s.key);
        return (
          <div
            key={s.key}
            className="flex w-72 shrink-0 flex-col rounded-lg border border-line bg-panel"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              const id = e.dataTransfer.getData("text/plain");
              if (id) onMove(id, s.key);
            }}
          >
            <div className="flex items-center gap-2 border-b border-line px-3 py-2">
              <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
              <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-muted">{s.label}</span>
              <span className="font-mono text-[10px] text-faint">{col.length}</span>
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
                    <span className="text-sm leading-snug text-ink">{t.title}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {t.labels.map((l) => (
                      <span key={l} className="rounded-full border border-line px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                        {l}
                      </span>
                    ))}
                    <span
                      className={`ml-auto rounded px-1.5 py-0.5 font-mono text-[10px] ${
                        t.mode === "debate" ? "bg-violet-500/20 text-violet-700" : "text-faint"
                      }`}
                    >
                      {t.mode === "debate" ? "debate" : `@${t.agentType ?? "—"}`}
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
