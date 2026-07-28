import { useState } from "react";
import {
  canArchive,
  taskDisplayStatus,
  type Group,
  type Task,
  type TaskStage,
  type TaskStatus,
} from "@harness/shared";
import { statusCounts, workersOf } from "@harness/shared/team";
import { CaretRight, UsersThree } from "@phosphor-icons/react";
import { STATUSES, STATUS_META, PRIORITY_ORDER } from "./constants";
import { PriorityIcon, PauseHint, useCollapsedGroups } from "./ui";
import { StatusIcon } from "./StatusIcon";
import { Tip } from "./Tip";
import { foldTeamStatus, pairBadge } from "./util";
import { executorLabel } from "./executorLabel";
import { isDispatchedWorker } from "./taskPolicy";
import { OriginTaskChip } from "./taskOrigin";
import { TaskWorktreeChip } from "./TaskWorktreeChip";
import { useUnreadTeamTasks } from "./useUnreadTasks";

// 一个 section 内部的分组。两个 section 的分法**刻意不同**:普通任务按 status 分,
// 协作任务按验收与否两分(见 COLLAB_GROUPS)。icon 只声明喂给 StatusIcon 的
// status × stage,颜色仍单点在 StatusIcon.tsx。
type TaskGroup = {
  key: string;
  label: string;
  matches: (task: Task) => boolean;
  icon: { status: TaskStatus; stage?: TaskStage };
};

// 协作任务(团队/辩论)不按 status 分组:调度台常驻,它的 status 只说明「这一刻忙不忙」,
// 答不了「这支团队还要不要我管」——干完活的历史团队会全堆在「运行中」里。真正的分水岭
// 是验收:stage=accepted 意味着已合并、worktree 已清理,这支团队彻底翻篇。
const COLLAB_GROUPS: TaskGroup[] = [
  {
    key: "active",
    label: "进行中",
    matches: (t) => t.stage !== "accepted",
    icon: { status: "running" },
  },
  {
    key: "accepted",
    label: "已验收",
    matches: (t) => t.stage === "accepted",
    icon: { status: "done", stage: "accepted" },
  },
];

const STATUS_GROUPS: TaskGroup[] = STATUSES.map((s) => ({
  key: s.key,
  label: s.label,
  matches: (task: Task) => groupedStatus(task) === s.key,
  icon: { status: s.key },
}));

const TASK_SECTIONS = [
  {
    key: "collab",
    label: "协作任务",
    matches: (task: Task) => task.mode === "debate" || task.mode === "team",
    groups: COLLAB_GROUPS,
  },
  { key: "single", label: "普通任务", matches: (task: Task) => task.mode === "single", groups: STATUS_GROUPS },
] as const;

type TaskSection = (typeof TASK_SECTIONS)[number];

// 列表只排**顶层**任务:团队任务的执行者(parentId 非空)挂在它自己那一行下面,不单独
// 占状态分组的位置 —— 否则一次派 6 个执行者就把列表冲垮了。
function topLevel(tasks: Task[]): Task[] {
  return tasks.filter((t) => !isDispatchedWorker(t));
}

function groupedStatus(task: Task) {
  // idle 只属于团队调度台,而协作区已经不按 status 分组了,所以这里实际不再折算什么。
  // 保留是防御:万一将来别的 mode 也用上 idle,普通任务区不会凭空多出一个「待命」组。
  return task.mode === "team" && task.status === "idle" ? "running" : task.status;
}

function tasksInGroup(tasks: Task[], section: TaskSection, group: TaskGroup): Task[] {
  return tasks
    .filter((task) => section.matches(task) && group.matches(task))
    .sort(
      (a, b) =>
        PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority) ||
        b.createdAt.localeCompare(a.createdAt),
    );
}

// Flatten tasks into the same visual order the list renders (协作/普通任务，再按各自的
// 分组、优先级、时间) — used for j/k keyboard navigation. 遍历方式必须跟渲染共用
// section.groups,否则 j/k 的顺序会跟眼睛看到的对不上。
export function orderedTasks(tasks: Task[]): Task[] {
  const out: Task[] = [];
  const top = topLevel(tasks);
  for (const section of TASK_SECTIONS) {
    for (const group of section.groups) {
      out.push(...tasksInGroup(top, section, group));
    }
  }
  return out;
}

export function TaskList({
  tasks,
  allTasks,
  groups,
  selected,
  onSelect,
  onOpenTask,
}: {
  tasks: Task[];
  allTasks: Task[];
  groups: Group[];
  selected: string | null;
  onSelect: (id: string) => void;
  onOpenTask: (id: string) => void;
}) {
  const groupName = (id: string | null) => groups.find((g) => g.id === id)?.name;
  const topTasks = topLevel(tasks);
  // Fold long status groups (e.g. 完成 93) away; remembered per browser.
  const { collapsed, toggle } = useCollapsedGroups("harness:taskList:collapsedStatuses");
  const unreadTeams = useUnreadTeamTasks(tasks, selected);
  // 展开了执行者行的团队任务。默认全折叠 —— 团队行本身已经带了状态摘要。
  const [openTeams, setOpenTeams] = useState<Set<string>>(new Set());
  const toggleTeam = (id: string) =>
    setOpenTeams((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div className="flex-1 overflow-y-auto">
      {TASK_SECTIONS.map((section) => {
        const sectionTasks = topTasks.filter(section.matches);
        if (!sectionTasks.length) return null;
        return (
          <section key={section.key} className="relative">
            <div className="sticky top-0 z-20 flex h-10 w-full items-center gap-2 border-b border-line bg-canvas/95 px-4 backdrop-blur">
              <span className="text-[13px] font-bold tracking-[0.04em] text-ink">{section.label}</span>
              <span className="font-mono text-[11px] text-muted">{sectionTasks.length}</span>
            </div>
            {section.groups.map((group) => {
              const inGroup = tasksInGroup(sectionTasks, section, group);
              if (!inGroup.length) return null;
              const collapsedKey = `${section.key}:${group.key}`;
              const isCollapsed = collapsed.has(collapsedKey);
              return (
                <div key={group.key}>
                  <button
                    onClick={() => toggle(collapsedKey)}
                    className="sticky top-10 z-10 flex w-full items-center gap-2 bg-canvas/85 px-4 py-2 text-left backdrop-blur transition-colors hover:bg-raised/50"
                    title={isCollapsed ? "展开这一组" : "折叠这一组"}
                  >
                    <StatusIcon status={group.icon.status} stage={group.icon.stage} size={13} title={group.label} />
                    <span className="text-[12px] font-semibold text-ink">{group.label}</span>
                    <span className="font-mono text-[11px] text-faint">{inGroup.length}</span>
                    <CaretRight
                      size={11}
                      weight="bold"
                      className={`text-faint transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                    />
                  </button>
                  {!isCollapsed &&
                    inGroup.map((t) =>
                      t.mode === "team" ? (
                        <TeamRow
                          key={t.id}
                          lead={t}
                          workers={workersOf(tasks, t.id)}
                          allTasks={allTasks}
                          selected={selected}
                          unread={unreadTeams.has(t.id)}
                          expanded={openTeams.has(t.id)}
                          onToggle={() => toggleTeam(t.id)}
                          onSelect={onSelect}
                          onOpenTask={onOpenTask}
                        />
                      ) : (
                        <TaskRow key={t.id} t={t} allTasks={allTasks} selected={selected} onSelect={onSelect} onOpenTask={onOpenTask} groupName={groupName} />
                      ),
                    )}
                </div>
              );
            })}
          </section>
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
  onOpenTask,
  groupName,
}: {
  t: Task;
  allTasks: Task[];
  selected: string | null;
  onSelect: (id: string) => void;
  onOpenTask: (id: string) => void;
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
        <StatusIcon status={t.status} stage={t.stage} awaitingAnswer={!!t.question} />
        <PriorityIcon p={t.priority} />
        <span className="min-w-[80px] flex-1 truncate text-[13px] text-ink">{t.title}</span>
        <div className="ml-auto flex min-w-0 items-center gap-1.5 overflow-hidden">
          {t.useWorktree && <TaskWorktreeChip cleaned={t.stage === "accepted"} />}
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
          <OriginTaskChip task={t} allTasks={allTasks} onOpen={onOpenTask} />
          {t.labels.map((l) => (
            <span
              key={l}
              className="shrink-0 rounded-full border border-line px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted"
            >
              {l}
            </span>
          ))}
          <span
            className={`max-w-[136px] shrink truncate rounded px-1.5 py-0.5 font-mono text-[10px] ${pairBadge(t).cls}`}
            title={pairBadge(t).label}
          >
            {pairBadge(t).label}
          </span>
        </div>
      </div>
      <PauseHint task={t} allTasks={allTasks} onOpen={onSelect} />
    </div>
  );
}

// 团队行。默认折叠成一行:只有出现未读动态时，才用 foldTeamStatus 算出来的「最该
// 你管的那个」色点提醒；右边只留执行者总数 + 状态微点，避免状态摘要互相争抢。
//
// 这个色点可能跟本行所在的分组不一致 —— 团队还没验收(归入「进行中」组),但某个执行者
// 正卡在提问上,于是行首是青色点。这是故意的:分组只回答「这支团队翻篇了没有」,而色点
// 要抢你的注意力。
function TeamRow({
  lead,
  workers,
  allTasks,
  selected,
  unread,
  expanded,
  onToggle,
  onSelect,
  onOpenTask,
}: {
  lead: Task;
  workers: Task[];
  allTasks: Task[];
  selected: string | null;
  unread: boolean;
  expanded: boolean;
  onToggle: () => void;
  onSelect: (id: string) => void;
  onOpenTask: (id: string) => void;
}) {
  const fold = foldTeamStatus(lead, workers);
  const unreadTitle = `有新动态 · ${taskDisplayStatus(fold.status, undefined, fold.awaitingAnswer).label}`;
  return (
    <>
      <div
        data-task-id={lead.id}
        onClick={() => onSelect(lead.id)}
        className={`flex w-full cursor-pointer items-center gap-2 px-4 py-1.5 text-left transition-colors ${
          selected === lead.id ? "bg-raised" : "hover:bg-raised/60"
        }`}
      >
        {unread && (
          <StatusIcon
            status={fold.status}
            size={13}
            awaitingAnswer={fold.awaitingAnswer}
            title={unreadTitle}
          />
        )}
        <span className="min-w-[80px] flex-1 truncate text-[13px] text-ink">{lead.title}</span>
        <div className="ml-auto flex min-w-0 items-center gap-1.5 overflow-hidden">
          {lead.useWorktree && <TaskWorktreeChip cleaned={lead.stage === "accepted"} />}
          <OriginTaskChip task={lead} allTasks={allTasks} onOpen={onOpenTask} />
          <WorkerSummary workers={workers} />
          {lead.queueId != null && !canArchive(lead.status) && (
            <span className="shrink-0 font-mono text-[10px] text-faint" title="队列位置">
              #{(lead.queuePosition ?? 0) + 1}
            </span>
          )}
          <Tip
            label="团队任务"
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted"
          >
            <UsersThree size={13} weight="fill" aria-hidden />
          </Tip>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            disabled={!workers.length}
            className="grid h-4 w-4 shrink-0 place-items-center rounded text-faint transition-colors hover:bg-overlay hover:text-ink disabled:opacity-0"
            title={expanded ? "折叠执行者" : `展开 ${workers.length} 个执行者`}
          >
            <CaretRight size={10} weight="bold" className={`transition-transform ${expanded ? "rotate-90" : ""}`} />
          </button>
        </div>
      </div>
      {expanded &&
        workers.map((w) => (
          <div
            key={w.id}
            data-task-id={w.id}
            onClick={() => onSelect(w.id)}
            className={`flex w-full cursor-pointer items-center gap-2 py-1 pl-4 pr-4 text-left transition-colors ${
              selected === w.id ? "bg-raised" : "hover:bg-raised/60"
            }`}
          >
            <StatusIcon status={w.status} stage={w.stage} awaitingAnswer={!!w.question} />
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted">{w.title}</span>
            {w.useWorktree && <TaskWorktreeChip cleaned={w.stage === "accepted"} />}
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

function WorkerSummary({ workers }: { workers: Task[] }) {
  if (!workers.length) return null;
  const counts = statusCounts(workers);
  const summary = counts.map((bucket) => `${bucket.n} ${bucket.label}`).join(" · ");
  return (
    <span className="inline-flex shrink-0 items-center gap-1" title={`${workers.length} 个执行者 · ${summary}`}>
      <span className="font-mono text-[10px] text-faint">{workers.length}</span>
      <span className="inline-flex items-center gap-[3px]" aria-label={summary}>
        {counts.map((bucket) => (
          <StatusIcon
            key={bucket.label}
            status={bucket.status}
            awaitingAnswer={bucket.awaitingAnswer}
            size={6}
            title={`${bucket.n} ${bucket.label}`}
          />
        ))}
      </span>
    </span>
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
