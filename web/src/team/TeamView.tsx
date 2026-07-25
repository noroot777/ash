// /team 主视图。左边(其实是中间)是指挥者的流,右边一条常驻工人栏;点工人从右侧滑
// 出它自己的完整会话(就是 TaskDetail 那套),不跳页、不丢指挥者上下文。
//
// 数据装配全在 ./teamData 里(纯函数),这里只管把它们摆在版面上、把动作接到 api。
// 一个刻意的取舍:工人是**真任务**,所以抽屉里塞的是真正的 TaskDetail —— 重跑、改
// 执行者、看队列、答它的提问,全部白嫖单任务那套 UI,不做第二份。
import { useEffect, useMemo, useState } from "react";
import type { Task, Group, AgentType } from "@harness/shared";
import { ArrowSquareOut, X } from "@phosphor-icons/react";
import { toast } from "../toast";
import { StatusIcon } from "../StatusIcon";
import { TaskDetail, type LogLine } from "../TaskDetail";
import { ReplyBox } from "../ReplyBox";
import { useConversation } from "../useConversation";
import { TeamHeader, AttentionBar } from "./TeamHeader";
import { TeamFeed } from "./TeamFeed";
import { WorkerRail, WorkerStatusText } from "./WorkerRail";
import { batchesOf, leadTurns as turnsOf, mergeFeed, waitingWorkers, workersOf } from "./teamData";

export function TeamView({
  task,
  groups,
  allTasks,
  logs,
  sessionsBump,
  onRun,
  onRetry,
  onStop,
  onReply,
  onPatch,
  onCreateGroup,
  onDelete,
  onArchive,
  onUnarchive,
  onSelect,
}: {
  task: Task;
  groups: Group[];
  allTasks: Task[];
  /** 整张 SSE 日志表 —— 指挥者和每个工人各取自己那份。 */
  logs: Record<string, LogLine[]>;
  sessionsBump: number;
  onRun: (id: string) => void;
  onRetry: (id: string) => void;
  onStop: (id: string) => void;
  onReply: (id: string, text: string, opts?: { attachments?: string[]; agent?: AgentType }) => void;
  onPatch: (id: string, patch: Partial<Task>) => void | Promise<void>;
  onCreateGroup: () => void;
  onDelete: (id: string, title: string) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  /** 整页打开某个工人(离开指挥台)。 */
  onSelect: (id: string) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);

  const workers = useMemo(() => workersOf(allTasks, task.id), [allTasks, task.id]);
  const batches = useMemo(() => batchesOf(workers), [workers]);
  const waiting = useMemo(() => waitingWorkers(workers), [workers]);

  const { items, sessions } = useConversation({
    task,
    logs: logs[task.id] ?? [],
    sessionsBump,
    primaryAgent: task.team?.lead ?? task.agentType ?? "claude",
  });
  const rows = useMemo(() => mergeFeed(items, batches), [items, batches]);
  const leadTurns = useMemo(() => turnsOf(items), [items]);

  // 抽屉里的工人被归档/删掉后别留着空抽屉。
  const open = openId ? (allTasks.find((t) => t.id === openId) ?? null) : null;
  useEffect(() => {
    if (openId && !open) setOpenId(null);
  }, [openId, open]);

  // Esc 关抽屉。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // 「让指挥者答」:把问题当一条用户插话递给指挥台 —— 它会自己去 get_task 看详情、
  // 调查、再 answer_question。没有新端点,因为这件事本质就是「用户催了一句」。
  const askLead = (w: Task) => {
    onReply(
      task.id,
      `【转交】工人「${w.title}」(taskId=${w.id})在等答复,问题:\n${w.question ?? ""}\n\n你去调查并 answer_question 答复它。`,
    );
    toast("已转交指挥者：它会去调查后答复这个工人");
  };

  return (
    <main className="relative flex h-full min-h-0 flex-col">
      <TeamHeader
        task={task}
        workers={workers}
        sessions={sessions}
        items={items}
        leadTurns={leadTurns}
        onPatch={(p) => onPatch(task.id, p)}
        onRun={() => onRun(task.id)}
        onDelete={() => onDelete(task.id, task.title)}
        onArchive={() => onArchive(task.id)}
        onUnarchive={() => onUnarchive(task.id)}
        onOpenWorker={setOpenId}
      />

      <AttentionBar waiting={waiting} workers={workers} onOpenWorker={setOpenId} onAskLead={askLead} />

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_268px]">
        <TeamFeed rows={rows} workers={workers} empty={items.length === 0} onOpenWorker={setOpenId} />
        <WorkerRail workers={workers} logs={logs} selected={openId} onSelect={setOpenId} />
      </div>

      {/* 插话:发出去就进同一个常驻会话(指挥者正在说话时会被 interrupt 接住),所以
          除了归档之外不禁用 —— 这是 /team 跟单任务最大的手感差别。 */}
      <ReplyBox
        taskId={task.id}
        onReply={(text, opts) => onReply(task.id, text, opts)}
        disabled={!!task.archived}
        mention={false}
        placeholder="插一句话（改方向、加要求、直接替它拍板）… ⌘↵ 发送"
        disabledPlaceholder="已归档（只读）"
      />

      {open && (
        <WorkerDrawer
          worker={open}
          groups={groups}
          allTasks={allTasks}
          logs={logs[open.id] ?? []}
          sessionsBump={sessionsBump}
          onClose={() => setOpenId(null)}
          onOpenFull={() => {
            setOpenId(null);
            onSelect(open.id);
          }}
          onRun={() => onRun(open.id)}
          onStop={() => onStop(open.id)}
          onRetry={() => onRetry(open.id)}
          onReply={(text, opts) => onReply(open.id, text, opts)}
          onPatch={(p) => onPatch(open.id, p)}
          onCreateGroup={onCreateGroup}
          onDelete={() => {
            onDelete(open.id, open.title);
            setOpenId(null);
          }}
          onArchive={() => onArchive(open.id)}
          onUnarchive={() => onUnarchive(open.id)}
        />
      )}
    </main>
  );
}

// 工人会话抽屉。上面一条细带子(状态 / 标题 / 整页打开 / 关),下面整个 TaskDetail。
function WorkerDrawer({
  worker,
  onClose,
  onOpenFull,
  ...rest
}: {
  worker: Task;
  groups: Group[];
  allTasks: Task[];
  logs: LogLine[];
  sessionsBump: number;
  onClose: () => void;
  onOpenFull: () => void;
  onRun: () => void;
  onStop: () => void;
  onRetry: () => void;
  onReply: (text: string, opts?: { attachments?: string[]; agent?: AgentType }) => void;
  onPatch: (patch: Partial<Task>) => void | Promise<void>;
  onCreateGroup: () => void;
  onDelete: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
}) {
  return (
    <>
      <div
        onClick={onClose}
        className="t-modal-overlay absolute inset-0 z-20 bg-black/25"
        title="点空白处关闭（Esc）"
      />
      <aside className="t-drawer absolute inset-y-0 right-0 z-30 flex w-[min(620px,74%)] flex-col border-l border-line2 bg-panel shadow-[-8px_0_28px_rgba(0,0,0,.13)]">
        <div className="flex shrink-0 items-center gap-2 border-b border-line bg-raised px-3 py-1.5 text-[12px]">
          <StatusIcon status={worker.status} size={12} awaitingAnswer={!!worker.question} />
          <span className="min-w-0 flex-1 truncate font-medium text-ink">{worker.title}</span>
          <span className="shrink-0 text-faint">
            <WorkerStatusText w={worker} />
          </span>
          <button
            onClick={onOpenFull}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-accent transition-colors hover:bg-overlay"
            title="整页打开这个工人（离开指挥台）"
          >
            <ArrowSquareOut size={13} />
            整页打开
          </button>
          <button
            onClick={onClose}
            className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded text-muted transition-colors hover:bg-overlay hover:text-ink"
            title="关闭（Esc）"
          >
            <X size={13} weight="bold" />
          </button>
        </div>
        <div className="min-h-0 flex-1">
          {/* key=worker.id:换工人时重置内部状态(滚动位置、快照、草稿)。 */}
          <TaskDetail key={worker.id} task={worker} {...rest} />
        </div>
      </aside>
    </>
  );
}
