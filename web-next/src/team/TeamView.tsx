import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentEvent, Group, Task } from "@harness/shared";
import { batchesOf, mergeFeed, teamGroupsOf, workerHaltStats, workersOf } from "@harness/shared/team";
import { ArrowSquareOut, Broom, PaperPlaneTilt, SpinnerGap, WarningCircle, X } from "@phosphor-icons/react";
import { InspectorHost } from "../inspector/index.ts";
import { api, type TeamCuaStatus } from "../lib/api.ts";
import { OriginTaskBar } from "../components/TaskOrigin.tsx";
import { useConversation } from "../lib/useConversation.ts";
import { useServerEvents } from "../lib/events.ts";
import { useTaskReadState } from "../lib/useTaskReadState.ts";
import { AttachmentPicker, UploadAttachmentList, useAttachments } from "../task-detail/Attachments.tsx";
import { QuestionCard } from "../task-detail/QuestionCard.tsx";
import { ConfirmDialog } from "../task-detail/ConfirmDialog.tsx";
import { TaskDetail } from "../task-detail/TaskDetail.tsx";
import { conversationToMarkdown } from "../task-detail/conversationModel.ts";
import { TeamFeed } from "./TeamFeed.tsx";
import { TeamHeader } from "./TeamHeader.tsx";
import { TEAM_INSPECTORS, type TeamInspectorContext } from "./TeamInspector.tsx";
import { TeamReviewWorkspace } from "./TeamReviewWorkspace.tsx";
import { activeTeamHaltMarker, leadTurns, teamFeedOptions } from "./teamModel.ts";

function liveLineForEvent(event: AgentEvent, textBuffer: string): string | null {
  if (event.kind === "text") {
    return textBuffer.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? null;
  }
  if (event.kind === "tool") return `⚙ ${event.name || "tool"}`;
  if (event.kind === "error") return `✕ ${event.message}`;
  return null;
}

function useWorkerLiveLines(teamId: string, workers: Task[]) {
  const [lines, setLines] = useState<Record<string, string>>({});
  const textBuffers = useRef<Record<string, string>>({});
  const workerIds = useMemo(() => new Set(workers.map((worker) => worker.id)), [workers]);

  useEffect(() => {
    textBuffers.current = {};
    setLines({});
  }, [teamId]);

  useServerEvents(useCallback((event) => {
    if (event.type !== "agent.event" || !workerIds.has(event.taskId)) return;
    let textBuffer = textBuffers.current[event.taskId] ?? "";
    if (event.event.kind === "text") {
      textBuffer = `${textBuffer}${event.event.text}`.slice(-4000);
      textBuffers.current[event.taskId] = textBuffer;
    }
    const line = liveLineForEvent(event.event, textBuffer);
    if (!line) return;
    setLines((current) => current[event.taskId] === line
      ? current
      : { ...current, [event.taskId]: line });
  }, [workerIds]));

  return lines;
}

function TeamReplyBox({
  task,
  onSend,
}: {
  task: Task;
  onSend: (text: string, attachments: string[]) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uploads = useAttachments();
  const disabled = !!task.archived;
  const send = async () => {
    if (disabled || sending || uploads.uploading || (!value.trim() && !uploads.attachments.length)) return;
    setSending(true);
    setError(null);
    try {
      await onSend(value.trim(), uploads.attachments.map((attachment) => attachment.path));
      setValue("");
      uploads.clear();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="team-reply-shell">
      <UploadAttachmentList attachments={uploads.attachments} error={uploads.error} onRemove={uploads.remove} />
      {error && <p>{error}</p>}
      <div className="team-reply-box">
        <textarea
          rows={2}
          value={value}
          disabled={disabled}
          placeholder={disabled ? "团队已归档（只读）" : task.status === "idle" ? "调度者待命中，说句话就接回同一会话…" : "插一句话（改方向、加要求、直接替它拍板）…"}
          onChange={(event) => setValue(event.target.value)}
          onPaste={uploads.onPaste}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void send(); }
          }}
        />
        <footer>
          <AttachmentPicker addFiles={uploads.addFiles} disabled={disabled || sending} />
          <span>调度台 · ⌘↵ 发送</span>
          <button type="button" disabled={disabled || sending || uploads.uploading || (!value.trim() && !uploads.attachments.length)} onClick={() => void send()} aria-label="发送给调度者">
            {sending ? <SpinnerGap size={14} className="is-spinning" /> : <PaperPlaneTilt size={14} weight="fill" />}
          </button>
        </footer>
      </div>
    </div>
  );
}

function HaltNotice({ workers, groupCount, historyOnly }: { workers: Task[]; groupCount: number; historyOnly: boolean }) {
  const stats = workerHaltStats(workers);
  return (
    <div className="team-halt-notice" role="status">
      <b>全组已停止</b>
      <span>{stats.interrupted} 个执行者被暂停打断 · {stats.completed} 个已完成 · {stats.waiting} 个尚未启动</span>
      <small>{historyOnly ? "停止记录来自持久会话；内部组详情暂未返回" : `${groupCount} 个内部组保持暂停，刷新页面后仍可见`}</small>
    </div>
  );
}

function CuaResidualNotice({ taskId, status, onStatus, notify }: { taskId: string; status: TeamCuaStatus | null; onStatus: (status: TeamCuaStatus | null) => void; notify: (message: string) => void }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const current = status?.current;
  if (!current?.detected) return null;
  const kill = async () => {
    setBusy(true);
    try {
      await api.killTeamCua(taskId);
      onStatus(await api.teamCuaStatus(taskId));
      setConfirmOpen(false);
      notify("已请求强制清理 computer-use 服务");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="team-cua-notice" role="alert">
        <WarningCircle size={14} weight="fill" />
        <b>computer-use 服务仍在运行</b>
        <span>{current.sideEffect}</span>
        {current.processes.length > 0 && <code>pid {current.processes.map((process) => process.pid).join(", ")}</code>}
        <button type="button" onClick={() => setConfirmOpen(true)}><Broom size={13} />强制清理</button>
      </div>
      {confirmOpen && <ConfirmDialog title="强制清理 computer-use？" message={current.sideEffect} confirmLabel="强制清理" danger busy={busy} onConfirm={() => void kill()} onClose={() => setConfirmOpen(false)} />}
    </>
  );
}

function WorkerDrawer({
  worker,
  allTasks,
  onClose,
  onOpenFull,
  onOpenTask,
  onTaskUpdate,
  onDeleted,
  notify,
}: {
  worker: Task;
  allTasks: Task[];
  onClose: () => void;
  onOpenFull: () => void;
  onOpenTask: (taskId: string) => void;
  onTaskUpdate: (task: Task) => void;
  onDeleted: (taskId: string) => void;
  notify: (message: string) => void;
}) {
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const closeTimer = useRef<number | null>(null);
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) closeTimer.current = window.setTimeout(onClose, 0);
  }, [onClose]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") requestClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [requestClose]);
  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
  }, []);
  return (
    <>
      <div className={`team-worker-scrim${closing ? " is-closing" : ""}`} onClick={requestClose} />
      <aside
        className={`team-worker-drawer${closing ? " is-closing" : ""}`}
        aria-label={`执行者详情：${worker.title}`}
        onAnimationEnd={(event) => {
          if (closing && event.animationName === "team-worker-drawer-out") onClose();
        }}
      >
        <header>
          <span>执行者</span><b>{worker.title}</b>
          <button type="button" onClick={onOpenFull}><ArrowSquareOut size={13} />整页打开</button>
          <button type="button" aria-label="关闭执行者抽屉" onClick={requestClose}><X size={14} weight="bold" /></button>
        </header>
        <TaskDetail key={worker.id} task={worker} allTasks={allTasks} onTaskUpdate={onTaskUpdate} onDeleted={onDeleted} onOpenTask={onOpenTask} inspectorMode="drawer" notify={notify} />
      </aside>
    </>
  );
}

export function TeamView({
  task,
  allTasks,
  onTaskUpdate,
  onTaskDeleted,
  onSelectTask,
  initialReviewOpen = false,
  onReviewOpenChange,
  notify,
}: {
  task: Task;
  allTasks: Task[];
  onTaskUpdate: (task: Task) => void;
  onTaskDeleted: (taskId: string) => void;
  onSelectTask: (task: Task) => void;
  initialReviewOpen?: boolean;
  onReviewOpenChange?: (open: boolean) => void;
  notify: (message: string) => void;
}) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(initialReviewOpen);
  const [busy, setBusy] = useState(false);
  const [localHalted, setLocalHalted] = useState(false);
  const [cuaStatus, setCuaStatus] = useState<TeamCuaStatus | null>(null);
  const { indicatorForTask, markTaskRead } = useTaskReadState(allTasks, task.id);
  const conversation = useConversation(task.id);
  const workers = useMemo(() => workersOf(allTasks, task.id), [allTasks, task.id]);
  const workerLiveLines = useWorkerLiveLines(task.id, workers);
  const teamGroups = useMemo(() => teamGroupsOf(groups, task.id, workers), [groups, task.id, workers]);
  const batches = useMemo(() => batchesOf(workers, teamGroups), [teamGroups, workers]);
  const rows = useMemo(() => mergeFeed(conversation.items, batches, teamFeedOptions()), [batches, conversation.items]);
  const turns = useMemo(() => leadTurns(conversation.items), [conversation.items]);
  const historyHalt = activeTeamHaltMarker(conversation.items);
  const stopped = teamGroups.some((group) => group.paused) || (teamGroups.length === 0 && (historyHalt || localHalted));
  const selectedWorker = selectedWorkerId ? workers.find((worker) => worker.id === selectedWorkerId) ?? null : null;
  const markdown = useMemo(() => conversationToMarkdown(conversation.items, task), [conversation.items, task]);
  const selectWorker = useCallback((taskId: string) => {
    const worker = workers.find((item) => item.id === taskId);
    if (worker) markTaskRead(worker);
    setSelectedWorkerId(taskId);
  }, [markTaskRead, workers]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable)) return;
      const index = Number(event.key) - 1;
      if (!Number.isInteger(index) || index < 0 || index > 8 || !workers[index]) return;
      event.preventDefault();
      selectWorker(workers[index].id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectWorker, workers]);
  const openTaskById = (taskId: string) => {
    const target = allTasks.find((item) => item.id === taskId);
    if (target) {
      setSelectedWorkerId(null);
      onSelectTask(target);
      return;
    }
    void api.task(taskId).then((loaded) => {
      onTaskUpdate(loaded);
      setSelectedWorkerId(null);
      onSelectTask(loaded);
    }).catch(() => notify("关联任务不存在或读取失败"));
  };

  const refreshGroups = useCallback(async () => {
    try {
      setGroups(await api.groupsByOwnerTask(task.id));
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    }
  }, [notify, task.id]);
  const refreshTask = useCallback(async () => onTaskUpdate(await api.task(task.id)), [onTaskUpdate, task.id]);
  useEffect(() => {
    setSelectedWorkerId(null);
    setReviewOpen(initialReviewOpen);
    setLocalHalted(false);
    setCuaStatus(null);
    void refreshGroups();
  }, [refreshGroups, task.id]);

  const changeReviewOpen = (open: boolean) => {
    setReviewOpen(open);
    onReviewOpenChange?.(open);
  };
  useEffect(() => {
    if (!stopped) return;
    void api.teamCuaStatus(task.id).then(setCuaStatus).catch(() => undefined);
  }, [stopped, task.id]);
  useEffect(() => {
    if (selectedWorkerId && !selectedWorker) setSelectedWorkerId(null);
  }, [selectedWorker, selectedWorkerId]);
  useEffect(() => {
    if (selectedWorker) markTaskRead(selectedWorker);
  }, [markTaskRead, selectedWorker]);

  const perform = async (action: "run" | "halt" | "resume" | "archive") => {
    setBusy(true);
    try {
      if (action === "run") await api.runTask(task.id);
      if (action === "halt") { await api.teamHalt(task.id); setLocalHalted(true); }
      if (action === "resume") {
        await Promise.all(teamGroups.filter((group) => group.paused).map((group) => api.runGroup(group.id)));
        if (task.status !== "running") await api.runTask(task.id);
        setLocalHalted(false);
        setCuaStatus(null);
      }
      if (action === "archive") onTaskUpdate(task.archived ? await api.unarchiveTask(task.id) : await api.archiveTask(task.id));
      else await refreshTask();
      await refreshGroups();
      notify(action === "halt" ? "已停止全组，暂停状态会持久保留" : action === "resume" ? "已恢复全组" : action === "archive" ? (task.archived ? "已取消归档" : "团队已归档") : "团队已启动");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <InspectorHost
      contextKey={`team:${task.id}`}
      descriptors={TEAM_INSPECTORS}
      context={{
        task,
        workers,
        groups: teamGroups,
        sessions: conversation.sessions,
        leadTurns: turns,
        selectedWorkerId,
        onSelectWorker: selectWorker,
        onOpenReview: () => changeReviewOpen(true),
        onOpenTask: openTaskById,
        indicatorForTask,
        workerLiveLines,
      } satisfies TeamInspectorContext}
    >
      {({ toggleButton }) => <div className="team-view">
      <OriginTaskBar task={task} allTasks={allTasks} onOpen={openTaskById} />
      <TeamHeader
        task={task}
        workers={workers}
        groups={teamGroups}
        haltedByHistory={teamGroups.length === 0 && (historyHalt || localHalted)}
        conversationMarkdown={markdown}
        busy={busy}
        reviewOpen={reviewOpen}
        onTitle={async (title) => onTaskUpdate(await api.patchTask(task.id, { title, autoTitle: false }))}
        onTogglePin={async () => onTaskUpdate(await api.patchTask(task.id, { pinnedAt: task.pinnedAt != null ? null : Date.now() }))}
        onReview={() => { setSelectedWorkerId(null); changeReviewOpen(!reviewOpen); }}
        onRun={() => void perform("run")}
        onHalt={() => void perform("halt")}
        onResume={() => void perform("resume")}
        onArchive={() => void perform("archive")}
        indicatorForTask={indicatorForTask}
        inspectorToggle={toggleButton}
        notify={notify}
      />
      {reviewOpen ? (
        <TeamReviewWorkspace lead={task} workers={workers} onClose={() => changeReviewOpen(false)} onTaskUpdated={onTaskUpdate} indicatorForTask={indicatorForTask} onReadTask={markTaskRead} notify={notify} />
      ) : (
        <>
          {task.question && (
            <div className="team-lead-question">
              <QuestionCard task={task} onAnswer={async (answer) => {
                await api.answerTask(task.id, answer);
                conversation.addUser(answer);
                await refreshTask();
                notify("已答复调度者，原会话正在续跑");
              }} />
            </div>
          )}
          {stopped && <HaltNotice workers={workers} groupCount={teamGroups.length} historyOnly={teamGroups.length === 0} />}
          {stopped && <CuaResidualNotice taskId={task.id} status={cuaStatus} onStatus={setCuaStatus} notify={notify} />}
          <section className="team-flow-main" aria-label="团队会话">
            <TeamFeed taskId={task.id} rows={rows} workers={workers} onOpenWorker={selectWorker} indicatorForTask={indicatorForTask} />
            <TeamReplyBox task={task} onSend={async (text, attachments) => {
              await api.replyTask(task.id, text, { attachments });
              conversation.addUser(text, attachments);
              notify("已发送给调度者");
            }} />
          </section>
        </>
      )}
      {!reviewOpen && selectedWorker && (
        <WorkerDrawer
          worker={selectedWorker}
          allTasks={allTasks}
          onClose={() => setSelectedWorkerId(null)}
          onOpenFull={() => onSelectTask(selectedWorker)}
          onOpenTask={openTaskById}
          onTaskUpdate={onTaskUpdate}
          onDeleted={onTaskDeleted}
          notify={notify}
        />
      )}
      </div>}
    </InspectorHost>
  );
}
