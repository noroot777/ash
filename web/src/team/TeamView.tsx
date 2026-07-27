// /team 主视图。左边(其实是中间)是调度者的流,右边一条常驻执行者栏;点执行者从右侧滑
// 出它自己的完整会话(就是 TaskDetail 那套),不跳页、不丢调度者上下文。
//
// 数据装配全在 ./teamData 里(纯函数),这里只管把它们摆在版面上、把动作接到 api。
// 执行者是**真任务**,所以抽屉里复用真正的 TaskDetail；TaskDetail 会统一收起由
// 调度者拥有的元信息编辑，只保留会话、运行/停止/重试和答复。
import { useEffect, useMemo, useState } from "react";
import {
  batchesOf,
  teamGroupsOf,
  waitingWorkers,
  workersOf,
  type AgentType,
  type Group,
  type Task,
} from "@harness/shared";
import { ArrowSquareOut, Broom, WarningCircle, X } from "@phosphor-icons/react";
import { api, type TeamCuaStatus } from "../api";
import { toast } from "../toast";
import { StatusIcon } from "../StatusIcon";
import { TaskDetail, type LogLine } from "../TaskDetail";
import { ReplyBox } from "../ReplyBox";
import { useConversation } from "../useConversation";
import { ConfirmModal } from "../Modal";
import { TeamHeader, AttentionBar } from "./TeamHeader";
import { TeamFeed } from "./TeamFeed";
import { WorkerRail, WorkerStatusText } from "./WorkerRail";
import { activeTeamHaltMarker, leadTurns as turnsOf, mergeFeed } from "./teamData";

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
  onRequeue,
  onSelect,
}: {
  task: Task;
  groups: Group[];
  allTasks: Task[];
  /** 整张 SSE 日志表 —— 调度者和每个执行者各取自己那份。 */
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
  /** 执行者失败/取消后重新排队(位置由服务端定:被越过就到队尾)。 */
  onRequeue: (id: string) => void;
  /** 整页打开某个执行者(离开调度台)。 */
  onSelect: (id: string) => void;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [localHalted, setLocalHalted] = useState(false);
  const [groupPaused, setGroupPaused] = useState<Record<string, boolean>>({});
  const [internalGroups, setInternalGroups] = useState<Group[]>([]);
  const [cuaStatus, setCuaStatus] = useState<TeamCuaStatus | null>(null);

  const workers = useMemo(() => workersOf(allTasks, task.id), [allTasks, task.id]);
  const rawGroups = useMemo(() => {
    const byId = new Map(groups.map((g) => [g.id, g]));
    for (const g of internalGroups) byId.set(g.id, g);
    return [...byId.values()];
  }, [groups, internalGroups]);
  const viewGroups = useMemo(
    () => rawGroups.map((g) => (groupPaused[g.id] === undefined ? g : { ...g, paused: groupPaused[g.id]! })),
    [rawGroups, groupPaused],
  );
  const teamGroups = useMemo(() => teamGroupsOf(viewGroups, task.id, workers), [viewGroups, task.id, workers]);
  const batches = useMemo(() => batchesOf(workers, teamGroups), [workers, teamGroups]);
  const waiting = useMemo(() => waitingWorkers(workers), [workers]);

  const { items, sessions } = useConversation({
    task,
    logs: logs[task.id] ?? [],
    sessionsBump,
    primaryAgent: task.team?.lead ?? task.agentType ?? "claude",
  });
  const rows = useMemo(() => mergeFeed(items, batches), [items, batches]);
  const leadTurns = useMemo(() => turnsOf(items), [items]);
  const haltedByHistory = activeTeamHaltMarker(items);
  const stopped = teamGroups.some((g) => g.paused) || (teamGroups.length === 0 && (haltedByHistory || localHalted));

  const refreshInternalGroups = async () => {
    try {
      setInternalGroups(await api.groupsByOwnerTask(task.id));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  const refreshCuaStatus = async () => {
    try {
      setCuaStatus(await api.teamCuaStatus(task.id));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    setLocalHalted(false);
    setGroupPaused({});
    setInternalGroups([]);
    setCuaStatus(null);
    void refreshInternalGroups();
  }, [task.id]);

  useEffect(() => {
    if (stopped) void refreshCuaStatus();
  }, [task.id, stopped]);

  // 抽屉里的执行者被归档/删掉后别留着空抽屉。
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

  // 「让调度者答」:把问题当一条用户插话递给调度台 —— 它会自己去 get_task 看详情、
  // 调查、再 answer_question。没有新端点,因为这件事本质就是「用户催了一句」。
  const askLead = (w: Task) => {
    onReply(
      task.id,
      `【转交】执行者「${w.title}」(taskId=${w.id})在等答复,问题:\n${w.question ?? ""}\n\n你去调查并 answer_question 答复它。`,
    );
    toast("已转交调度者：它会去调查后答复这个执行者");
  };

  return (
    <main className="relative flex h-full min-h-0 flex-col">
      <TeamHeader
        task={task}
        workers={workers}
        teamGroups={teamGroups}
        haltedByHistory={teamGroups.length === 0 && (haltedByHistory || localHalted)}
        sessions={sessions}
        items={items}
        leadTurns={leadTurns}
        onPatch={(p) => onPatch(task.id, p)}
        onRun={() => onRun(task.id)}
        onTeamHalted={async () => {
          setLocalHalted(true);
          setGroupPaused(Object.fromEntries(teamGroups.map((g) => [g.id, true])));
          await refreshInternalGroups();
          await refreshCuaStatus();
        }}
        onTeamResumed={() => {
          setLocalHalted(false);
          setGroupPaused((m) => ({ ...m, ...Object.fromEntries(teamGroups.map((g) => [g.id, false])) }));
          setCuaStatus(null);
        }}
        onDelete={() => onDelete(task.id, task.title)}
        onArchive={() => onArchive(task.id)}
        onUnarchive={() => onUnarchive(task.id)}
        onOpenWorker={setOpenId}
      />

      {stopped && <CuaResidualNotice taskId={task.id} status={cuaStatus} onStatus={setCuaStatus} />}

      <AttentionBar waiting={waiting} workers={workers} onOpenWorker={setOpenId} onAskLead={askLead} />

      <div className="grid min-h-0 flex-1 grid-cols-[1fr_268px]">
        <TeamFeed rows={rows} workers={workers} empty={items.length === 0} onOpenWorker={setOpenId} />
        <WorkerRail workers={workers} groups={teamGroups} logs={logs} selected={openId} onSelect={setOpenId} />
      </div>

      {/* 插话:发出去就进同一个常驻会话(调度者正在说话时会被 interrupt 接住),所以
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
          groupPaused={!!teamGroups.find((g) => g.id === open.groupId)?.paused}
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
          onRequeue={() => onRequeue(open.id)}
        />
      )}
    </main>
  );
}

function CuaResidualNotice({
  taskId,
  status,
  onStatus,
}: {
  taskId: string;
  status: TeamCuaStatus | null;
  onStatus: (status: TeamCuaStatus | null) => void;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [killing, setKilling] = useState(false);
  const current = status?.current;
  if (!current?.detected) return null;

  const kill = async () => {
    setKilling(true);
    try {
      const res = await api.killTeamCua(taskId);
      onStatus({ taskId, current: res.status, last: current });
      toast(res.warning ? `${res.status.message} ${res.warning}` : res.status.message, "info");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setKilling(false);
    }
  };

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-amber-500/30 bg-amber-500/[0.08] px-5 py-2 text-[12.5px]">
        <WarningCircle size={14} weight="fill" className="text-amber-600" />
        <b className="text-ink">检测到 computer-use 服务仍在运行</b>
        <span className="text-muted">{current.sideEffect}</span>
        {current.processes.length > 0 && (
          <span className="font-mono text-faint">pid {current.processes.map((p) => p.pid).join(", ")}</span>
        )}
        <button
          disabled={killing}
          onClick={() => setConfirmOpen(true)}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-panel px-2.5 py-1 text-[11.5px] font-medium text-amber-700 transition-colors hover:bg-raised disabled:opacity-50"
          title="强制清理 ChatGPT.app 全局 computer-use 服务"
        >
          <Broom size={13} />
          {killing ? "清理中" : "强制清理"}
        </button>
      </div>
      {confirmOpen && (
        <ConfirmModal
          title="强制清理 computer-use？"
          message={current.sideEffect}
          confirmLabel="强制清理"
          danger
          onConfirm={kill}
          onClose={() => setConfirmOpen(false)}
        />
      )}
    </>
  );
}

// 执行者会话抽屉。上面一条细带子(状态 / 标题 / 整页打开 / 关),下面整个 TaskDetail。
function WorkerDrawer({
  worker,
  groupPaused,
  onClose,
  onOpenFull,
  ...rest
}: {
  worker: Task;
  groups: Group[];
  groupPaused: boolean;
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
  onRequeue: () => void;
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
            <WorkerStatusText w={worker} groupPaused={groupPaused} />
          </span>
          <button
            onClick={onOpenFull}
            className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-accent transition-colors hover:bg-overlay"
            title="整页打开这个执行者（离开调度台）"
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
          {/* key=worker.id:换执行者时重置内部状态(滚动位置、快照、草稿)。 */}
          <TaskDetail key={worker.id} task={worker} {...rest} />
        </div>
      </aside>
    </>
  );
}
