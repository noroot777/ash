import { useState } from "react";
import type { Task, Group } from "@harness/shared";
import { canArchive } from "@harness/shared";
import { CaretRight } from "@phosphor-icons/react";
import { STATUSES, STATUS_META, PRIORITY_ORDER } from "./constants";
import { PriorityIcon, PauseHint, useCollapsedGroups } from "./ui";
import { StatusIcon } from "./StatusIcon";
import { foldTeamStatus, pairBadge } from "./util";
import { statusCounts, workersOf } from "./team/teamData";
import { executorLabel } from "./executorLabel";

// 列表只排**顶层**任务:团队任务的工人(parentId 非空)挂在它自己那一行下面,不单独
// 占状态分组的位置 —— 否则一次派 6 个工人就把列表冲垮了。
function topLevel(tasks: Task[]): Task[] {
  return tasks.filter((t) => !t.parentId);
}

// Flatten tasks into the same visual order the list renders (status groups,
// then priority, then recency) — used for j/k keyboard navigation.
export function orderedTasks(tasks: Task[]): Task[] {
  const out: Task[] = [];
  const top = topLevel(tasks);
  for (const s of STATUSES) {
    const inStatus = top
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
  // 展开了工人行的团队任务。默认全折叠 —— 团队行本身已经带了状态摘要。
  const [openTeams, setOpenTeams] = useState<Set<string>>(new Set());
  const toggleTeam = (id: string) =>
    setOpenTeams((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div className="flex-1 overflow-y-auto">
      {STATUSES.map((s) => {
        const inStatus = topLevel(tasks)
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
              inStatus.map((t) =>
                t.mode === "team" ? (
                  <TeamRow
                    key={t.id}
                    lead={t}
                    workers={workersOf(tasks, t.id)}
                    selected={selected}
                    expanded={openTeams.has(t.id)}
                    onToggle={() => toggleTeam(t.id)}
                    onSelect={onSelect}
                  />
                ) : (
                  <TaskRow key={t.id} t={t} allTasks={tasks} selected={selected} onSelect={onSelect} groupName={groupName} />
                ),
              )}
          </div>
        );
      })}
      {!tasks.length && <p className="px-4 py-10 text-center text-xs text-faint">还没有任务 · 按 C 新建</p>}
    </div>
  );
}

function TaskRow({
  t,
  allTasks,
  selected,
  onSelect,
  groupName,
}: {
  t: Task;
  allTasks: Task[];
  selected: string | null;
  onSelect: (id: string) => void;
  groupName: (id: string | null) => string | undefined;
}) {
  return (
    <div
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
      <PauseHint task={t} allTasks={allTasks} onOpen={onSelect} />
    </div>
  );
}

// 团队行。默认折叠成一行:图标是 foldTeamStatus 算出来的「最该你管的那个」,右边是
// 工人状态摘要(「1 等答复 · 1 干活 · 1 完成」)。
//
// 这个图标可能跟本行所在的状态分组不一致 —— 指挥台待命着(在「待命」组里),但某个
// 工人正卡在提问上,于是行首是青色问号。这是故意的:分组按指挥台的真实状态(免得活着
// 的团队因为工人全完掉进「完成」组),而图标要抢你的注意力。
function TeamRow({
  lead,
  workers,
  selected,
  expanded,
  onToggle,
  onSelect,
}: {
  lead: Task;
  workers: Task[];
  selected: string | null;
  expanded: boolean;
  onToggle: () => void;
  onSelect: (id: string) => void;
}) {
  const fold = foldTeamStatus(lead, workers);
  const summary = statusCounts(workers)
    .map((b) => `${b.n} ${b.label}`)
    .join(" · ");
  const badge = pairBadge(lead);
  return (
    <>
      <div
        data-task-id={lead.id}
        onClick={() => onSelect(lead.id)}
        className={`flex w-full cursor-pointer items-center gap-2 px-4 py-1.5 text-left transition-colors ${
          selected === lead.id ? "bg-raised" : "hover:bg-raised/60"
        }`}
      >
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          disabled={!workers.length}
          className="grid h-4 w-4 shrink-0 place-items-center rounded text-faint transition-colors hover:bg-overlay hover:text-ink disabled:opacity-0"
          title={expanded ? "折叠工人" : `展开 ${workers.length} 个工人`}
        >
          <CaretRight size={10} weight="bold" className={`transition-transform ${expanded ? "rotate-90" : ""}`} />
        </button>
        <StatusIcon status={fold.status} size={13} awaitingAnswer={fold.awaitingAnswer} />
        <PriorityIcon p={lead.priority} />
        <span className="min-w-[80px] flex-1 truncate text-[13px] text-ink">{lead.title}</span>
        <div className="ml-auto flex min-w-0 items-center gap-1.5 overflow-hidden">
          {summary && <span className="shrink-0 truncate font-mono text-[10px] text-faint">{summary}</span>}
          <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] ${badge.cls}`}>{badge.label}</span>
        </div>
      </div>
      {expanded &&
        workers.map((w) => (
          <div
            key={w.id}
            data-task-id={w.id}
            onClick={() => onSelect(w.id)}
            className={`flex w-full cursor-pointer items-center gap-2 py-1 pl-[42px] pr-4 text-left transition-colors ${
              selected === w.id ? "bg-raised" : "hover:bg-raised/60"
            }`}
          >
            <StatusIcon status={w.status} size={12} awaitingAnswer={!!w.question} />
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted">{w.title}</span>
            {w.queueId != null && !canArchive(w.status) && (
              <span className="shrink-0 rounded bg-overlay px-1.5 py-0.5 font-mono text-[10px] text-muted" title="串行批次里的位置">
                ↳ #{(w.queuePosition ?? 0) + 1}
              </span>
            )}
            <WorkerExecutorChip w={w} />
          </div>
        ))}
    </>
  );
}

function WorkerExecutorChip({ w }: { w: Task }) {
  const label = executorLabel({ task: w });
  return (
    <span className="max-w-[112px] shrink truncate font-mono text-[10px] text-faint" title={label}>
      {label}
    </span>
  );
}

export { STATUS_META };
