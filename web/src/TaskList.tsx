import type { Task, Group } from "@harness/shared";
import { STATUSES, STATUS_META, PRIORITY_ORDER } from "./constants";
import { PriorityIcon } from "./ui";

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
            <div className="sticky top-0 flex items-center gap-2 bg-neutral-950/90 px-4 py-1.5 backdrop-blur">
              <span className={`h-2 w-2 rounded-full ${s.dot}`} />
              <span className="text-xs font-medium text-neutral-300">{s.label}</span>
              <span className="text-xs text-neutral-600">{inStatus.length}</span>
            </div>
            {inStatus.map((t) => (
              <button
                key={t.id}
                data-task-id={t.id}
                onClick={() => onSelect(t.id)}
                className={`flex w-full items-center gap-2.5 border-l-2 px-4 py-2 text-left text-sm ${
                  selected === t.id
                    ? "border-neutral-300 bg-neutral-900"
                    : "border-transparent hover:bg-neutral-900/60"
                }`}
              >
                <PriorityIcon p={t.priority} />
                <span className="truncate text-neutral-200">{t.title}</span>
                <div className="ml-auto flex shrink-0 items-center gap-1.5">
                  {groupName(t.groupId) && (
                    <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
                      {groupName(t.groupId)}
                    </span>
                  )}
                  {t.labels.map((l) => (
                    <span key={l} className="rounded-full bg-neutral-800 px-2 py-0.5 text-[10px] text-neutral-400">
                      {l}
                    </span>
                  ))}
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] ${
                      t.mode === "debate" ? "bg-violet-500/20 text-violet-300" : "bg-neutral-800 text-neutral-500"
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
      {!tasks.length && <p className="px-4 py-10 text-center text-xs text-neutral-600">还没有任务 · 按 C 新建</p>}
    </div>
  );
}

export { STATUS_META };
