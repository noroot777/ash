import type { Task, Group } from "@harness/shared";
import { STATUSES, STATUS_META, PRIORITY_ORDER } from "./constants";
import { PriorityIcon } from "./ui";
import { StatusIcon } from "./StatusIcon";

// Flatten tasks into the same visual order the list renders (status groups,
// then priority, then recency) — used for j/k keyboard navigation.
export function orderedTasks(tasks: Task[]): Task[] {
  const out: Task[] = [];
  for (const s of STATUSES) {
    const inStatus = tasks
      .filter((t) => t.status === s.key)
      .sort(
        (a, b) =>
          PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) ||
          b.createdAt.localeCompare(a.createdAt),
      );
    out.push(...inStatus);
  }
  return out;
}

export function TaskList({
  tasks,
  groups,
  selected,
  onSelect,
}: {
  tasks: Task[];
  groups: Group[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const groupName = (id: string | null) => groups.find((g) => g.id === id)?.name;

  return (
    <div className="flex-1 overflow-y-auto">
      {STATUSES.map((s) => {
        const inStatus = tasks
          .filter((t) => t.status === s.key)
          .sort(
            (a, b) =>
              PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) ||
              b.createdAt.localeCompare(a.createdAt),
          );
        if (!inStatus.length) return null;
        return (
          <div key={s.key}>
            <div className="sticky top-0 z-10 flex items-center gap-2 bg-canvas/85 px-4 py-2 backdrop-blur">
              <StatusIcon status={s.key} size={13} />
              <span className="text-[12px] font-semibold text-ink">{s.label}</span>
              <span className="font-mono text-[11px] text-faint">{inStatus.length}</span>
            </div>
            {inStatus.map((t) => (
              <button
                key={t.id}
                data-task-id={t.id}
                onClick={() => onSelect(t.id)}
                className={`flex w-full items-center gap-2.5 px-4 py-1.5 text-left transition-colors ${
                  selected === t.id ? "bg-raised" : "hover:bg-raised/60"
                }`}
              >
                <PriorityIcon p={t.priority} />
                <span className="truncate text-[13px] text-ink">{t.title}</span>
                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                  {groupName(t.groupId) && (
                    <span className="rounded bg-overlay px-1.5 py-0.5 font-mono text-[10px] text-muted">
                      {groupName(t.groupId)}
                    </span>
                  )}
                  {t.labels.map((l) => (
                    <span
                      key={l}
                      className="rounded-full border border-line px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted"
                    >
                      {l}
                    </span>
                  ))}
                  <span
                    className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                      t.mode === "debate" ? "bg-violet-500/15 text-violet-700" : "text-faint"
                    }`}
                  >
                    {t.mode === "debate" ? "debate" : `@${t.agentType ?? "—"}`}
                  </span>
                </div>
              </button>
            ))}
          </div>
        );
      })}
      {!tasks.length && <p className="px-4 py-10 text-center text-xs text-faint">还没有任务 · 按 C 新建</p>}
    </div>
  );
}

export { STATUS_META };
