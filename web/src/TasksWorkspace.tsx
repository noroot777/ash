import type { Task, Group, ProjectHealth, AgentType, GateAction } from "@harness/shared";
import { NotePencil } from "@phosphor-icons/react";
import { TaskList } from "./TaskList";
import { TaskDetail, type LogLine } from "./TaskDetail";
import { DebateView } from "./DebateView";
import { TeamView } from "./team/TeamView";
import { type DebateState, emptyDebate } from "./debateState";
import { BranchChip, ResizeHandle } from "./ui";
import { OriginTaskBar } from "./taskOrigin";

// The task workspace. View (list) + archived filter live here; state stays in App
// as the single source of truth, while this component raises callbacks.
export type TaskView = "list" | "archived";

export function TasksWorkspace({
  view,
  setView,
  visible,
  allTasks,
  current,
  groups,
  selected,
  onSelect,
  logs,
  debates,
  sessionsBump,
  curHealth,
  sidebarW,
  setSidebarW,
  archivedCount,
  onNewTask,
  onNotes,
  onGroups,
  onRun,
  onStop,
  onRetry,
  onReply,
  onPatch,
  onCreateGroup,
  onDelete,
  onArchive,
  onUnarchive,
  onRequeue,
  onGate,
  onOpenTask,
  onTaskCreated,
}: {
  view: TaskView;
  setView: (v: TaskView) => void;
  visible: Task[];
  allTasks: Task[];
  current: Task | null;
  groups: Group[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  logs: Record<string, LogLine[]>;
  debates: Record<string, DebateState>;
  sessionsBump: number;
  curHealth: ProjectHealth | null;
  sidebarW: number;
  setSidebarW: (w: number) => void;
  archivedCount: number;
  onNewTask: () => void;
  onNotes: () => void;
  onGroups: () => void;
  onRun: (id: string) => void;
  onStop: (id: string) => void;
  onRetry: (id: string) => void;
  onReply: (id: string, text: string, opts?: { attachments?: string[]; agent?: AgentType }) => void;
  onPatch: (id: string, p: Partial<Task>) => void;
  onCreateGroup: () => void;
  onDelete: (id: string, title: string) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  onRequeue: (id: string) => void;
  onGate: (id: string, action: GateAction) => void;
  onOpenTask: (taskId: string) => void;
  onTaskCreated: (task: Task, doRun?: boolean, select?: boolean) => void;
}) {
  const tab = (v: TaskView, label: string) => (
    <button
      onClick={() => setView(v)}
      className={`rounded-md px-2.5 py-1 transition-colors ${view === v ? "bg-panel text-ink shadow-sm" : "text-muted hover:text-ink"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* slim sub-header (replaces the old h-12 top bar for this plane) */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-panel px-3.5">
        <BranchChip health={curHealth} />
        <button
          onClick={onNewTask}
          className="grid h-7 w-7 place-items-center rounded-md text-muted transition-colors hover:bg-raised hover:text-ink"
          title="新建任务"
        >
          <NotePencil size={17} />
        </button>
        <span className="flex-1" />
        <button
          onClick={onNotes}
          className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] text-muted transition-colors hover:bg-raised hover:text-ink"
          title="随手记"
        >
          <NotePencil size={14} /> 随手记
        </button>
        <button
          onClick={onGroups}
          className="rounded-md px-2.5 py-1 text-[12px] text-muted transition-colors hover:bg-raised hover:text-ink"
          title="分组管理"
        >
          分组
        </button>
        <div className="flex items-center gap-0.5 rounded-lg bg-raised p-0.5 text-[12px]">
          {tab("list", "列表")}
          {tab("archived", `已归档${archivedCount ? ` ${archivedCount}` : ""}`)}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside style={{ width: sidebarW }} className="relative flex shrink-0 flex-col border-r border-line">
          <TaskList tasks={visible} allTasks={allTasks} groups={groups} selected={selected} onSelect={onSelect} onOpenTask={onOpenTask} />
          <ResizeHandle width={sidebarW} onChange={setSidebarW} />
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          {current && <OriginTaskBar task={current} allTasks={allTasks} onOpen={onOpenTask} />}
          <div className="min-h-0 flex-1">
            {current ? (
              current.mode === "debate" ? (
                <DebateView
                  key={current.id}
                  task={current}
                  allTasks={allTasks}
                  state={debates[current.id] ?? emptyDebate()}
                  sessionsBump={sessionsBump}
                  onRun={() => onRun(current.id)}
                  onStop={() => onStop(current.id)}
                  onRetry={() => onRetry(current.id)}
                  onGate={(a) => onGate(current.id, a)}
                  onDelete={() => onDelete(current.id, current.title)}
                  onArchive={() => onArchive(current.id)}
                  onUnarchive={() => onUnarchive(current.id)}
                  onOpenTask={onOpenTask}
                  onTeamCreated={onTaskCreated}
                />
              ) : current.mode === "team" ? (
                // 团队模式:整张 logs 表都给它 —— 调度者的流、每个执行者卡片上的
                // 实时最后一行、抽屉里那个执行者的会话,取的是不同任务的日志。
                <TeamView
                  key={current.id}
                  task={current}
                  groups={groups}
                  allTasks={allTasks}
                  logs={logs}
                  sessionsBump={sessionsBump}
                  onRun={onRun}
                  onStop={onStop}
                  onRetry={onRetry}
                  onReply={onReply}
                  onPatch={onPatch}
                  onCreateGroup={onCreateGroup}
                  onDelete={onDelete}
                  onArchive={onArchive}
                  onUnarchive={onUnarchive}
                  onRequeue={onRequeue}
                  onSelect={onSelect}
                  onTaskCreated={onTaskCreated}
                />
              ) : (
                <TaskDetail
                  key={current.id}
                  task={current}
                  groups={groups}
                  allTasks={allTasks}
                  logs={logs[current.id] ?? []}
                  sessionsBump={sessionsBump}
                  onRun={() => onRun(current.id)}
                  onStop={() => onStop(current.id)}
                  onRetry={() => onRetry(current.id)}
                  onReply={(text, opts) => onReply(current.id, text, opts)}
                  onPatch={(p) => onPatch(current.id, p)}
                  onCreateGroup={onCreateGroup}
                  onDelete={() => onDelete(current.id, current.title)}
                  onArchive={() => onArchive(current.id)}
                  onUnarchive={() => onUnarchive(current.id)}
                  onRequeue={() => onRequeue(current.id)}
                  onOpenTask={onOpenTask}
                  onTaskCreated={onTaskCreated}
                />
              )
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-1 text-[13px] text-faint">
                <span>选择左侧任务,或新建</span>
                <span className="text-[12px]">按 <kbd>C</kbd> 新建 · <kbd>⌘K</kbd> 命令面板</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
