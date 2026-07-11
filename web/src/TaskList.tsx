import type { Task, Group } from "@harness/shared";
import { canArchive } from "@harness/shared";
import { CaretRight } from "@phosphor-icons/react";
import { STATUSES, STATUS_META, PRIORITY_ORDER } from "./constants";
import { PriorityIcon, PauseHint, useCollapsedGroups } from "./ui";
import { StatusIcon } from "./StatusIcon";
import { pairBadge } from "./util";

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
  // Fold long status groups (e.g. 完成 93) away; remembered per browser.
  const { collapsed, toggle } = useCollapsedGroups("harness:taskList:collapsedStatuses");

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
        const isCollapsed = collapsed.has(s.key);
        return (
          <div key={s.key}>
            <button
              onClick={() => toggle(s.key)}
              className="sticky top-0 z-10 flex w-full items-center gap-2 bg-canvas/85 px-4 py-2 text-left backdrop-blur transition-colors hover:bg-raised/50"
              title={isCollapsed ? "展开这一组" : "折叠这一组"}
            >
              <StatusIcon status={s.key} size={13} />
              <span className="text-[12px] font-semibold text-ink">{s.label}</span>
              <span className="font-mono text-[11px] text-faint">{inStatus.length}</span>
              <CaretRight
                size={11}
                weight="bold"
                className={`text-faint transition-transform ${isCollapsed ? "" : "rotate-90"}`}
              />
            </button>
            {!isCollapsed &&
              inStatus.map((t) => (
              <div
                key={t.id}
                data-task-id={t.id}
                onClick={() => onSelect(t.id)}
                className={`flex w-full cursor-pointer flex-col gap-0.5 px-4 py-1.5 text-left transition-colors ${
                  selected === t.id ? "bg-raised" : "hover:bg-raised/60"
                }`}
              >
                <div className="flex w-full items-center gap-2.5">
                  <PriorityIcon p={t.priority} />
                  <span className="min-w-[80px] flex-1 truncate text-[13px] text-ink">{t.title}</span>
                  <div className="ml-auto flex min-w-0 items-center gap-1.5 overflow-hidden">
                    {t.queueId != null && !canArchive(t.status) && (
                      <span
                        className="shrink-0 rounded bg-overlay px-1.5 py-0.5 font-mono text-[10px] text-muted"
                        title="在某个队列里的位置(详情页可以点开看完整队列)"
                      >
                        ↳ #{(t.queuePosition ?? 0) + 1}
                      </span>
                    )}
                    {groupName(t.groupId) && (
                      <span className="shrink-0 rounded bg-overlay px-1.5 py-0.5 font-mono text-[10px] text-muted">
                        {groupName(t.groupId)}
                      </span>
                    )}
                    {t.labels.map((l) => (
                      <span
                        key={l}
                        className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted"
                      >
                        {l}
                      </span>
                    ))}
                    <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] ${pairBadge(t).cls}`}>
                      {pairBadge(t).label}
                    </span>
                  </div>
                </div>
                <PauseHint task={t} allTasks={tasks} onOpen={onSelect} />
              </div>
            ))}
          </div>
        );
      })}
      {!tasks.length && <p className="px-4 py-10 text-center text-xs text-faint">还没有任务 · 按 C 新建</p>}
    </div>
  );
}

export { STATUS_META };
