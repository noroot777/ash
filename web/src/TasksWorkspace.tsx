import type { Task, Group, ProjectHealth, AgentType, GateAction } from "@harness/shared";
import { NotePencil } from "@phosphor-icons/react";
import { TaskList } from "./TaskList";
import { TaskDetail, type LogLine } from "./TaskDetail";
import { DebateView } from "./DebateView";
import { Board } from "./Board";
import { type DebateState, emptyDebate } from "./debateState";
import { BranchChip, ResizeHandle } from "./ui";

// The "执行" plane: the existing task workspace, extracted from App so the rail can
// switch between it and the issues plane. View (list/board) + archived filter live
// here now (they're presentations of tasks, not top-level rail items). State stays
// in App (single source); this component is presentational + raises callbacks.
export type TaskView = "list" | "board" | "archived";

export function TasksWorkspace({
  view,
  setView,
  visible,
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
  onRun,
  onStop,
  onRetry,
  onReply,
  onPatch,
  onCreateGroup,
  onDelete,
  onArchive,
  onUnarchive,
  onGate,
  onOpenIssue,
}: {
  view: TaskView;
  setView: (v: TaskView) => void;
  visible: Task[];
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
  onRun: (id: string) => void;
  onStop: (id: string) => void;
  onRetry: (id: string) => void;
  onReply: (id: string, text: string, opts?: { attachments?: string[]; agent?: AgentType }) => void;
  onPatch: (id: string, p: Partial<Task>) => void;
  onCreateGroup: () => void;
  onDelete: (id: string, title: string) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  onGate: (id: string, action: GateAction) => void;
  onOpenIssue: (issueId: string) => void;
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
        <div className="flex items-center gap-0.5 rounded-lg bg-raised p-0.5 text-[12px]">
          {tab("list", "列表")}
          {tab("board", "看板")}
          {tab("archived", `已归档${archivedCount ? ` ${archivedCount}` : ""}`)}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        {view === "board" ? (
          <div className="min-w-0 flex-1">
            <Board tasks={visible} onMove={(id, status) => onPatch(id, { status })} onOpen={(id) => { onSelect(id); setView("list"); }} />
          </div>
        ) : (
          <>
            <aside style={{ width: sidebarW }} className="relative flex shrink-0 flex-col border-r border-line">
              <TaskList tasks={visible} groups={groups} selected={selected} onSelect={onSelect} />
              <ResizeHandle width={sidebarW} onChange={setSidebarW} />
            </aside>
            <div className="flex min-w-0 flex-1 flex-col">
              {current?.issueId && (
                <button
                  onClick={() => onOpenIssue(current.issueId!)}
                  className="flex shrink-0 items-center gap-2 border-b border-line bg-[color-mix(in_srgb,var(--color-accent)_6%,#fff)] px-3.5 py-2 text-left text-[12.5px] text-accent hover:bg-[color-mix(in_srgb,var(--color-accent)_11%,#fff)]"
                  title="回到来源事项"
                >
                  ← 来自事项 · 含讨论上下文
                </button>
              )}
              <div className="min-h-0 flex-1">
                {current ? (
                  current.mode === "debate" ? (
                    <DebateView
                      key={current.id}
                      task={current}
                      state={debates[current.id] ?? emptyDebate()}
                      sessionsBump={sessionsBump}
                      onRun={() => onRun(current.id)}
                      onStop={() => onStop(current.id)}
                      onRetry={() => onRetry(current.id)}
                      onGate={(a) => onGate(current.id, a)}
                      onDelete={() => onDelete(current.id, current.title)}
                      onArchive={() => onArchive(current.id)}
                      onUnarchive={() => onUnarchive(current.id)}
                    />
                  ) : (
                    <TaskDetail
                      key={current.id}
                      task={current}
                      groups={groups}
                      allTasks={visible}
                      logs={logs[current.id] ?? []}
                      sessionsBump={sessionsBump}
                      onRun={() => onRun(current.id)}
                      onStop={() => onStop(current.id)}
                      onReply={(text, opts) => onReply(current.id, text, opts)}
                      onPatch={(p) => onPatch(current.id, p)}
                      onCreateGroup={onCreateGroup}
                      onDelete={() => onDelete(current.id, current.title)}
                      onArchive={() => onArchive(current.id)}
                      onUnarchive={() => onUnarchive(current.id)}
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
          </>
        )}
      </div>
    </div>
  );
}
