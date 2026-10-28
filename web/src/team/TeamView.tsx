import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Group, Task, TaskListItem } from "@ash/shared";
import { batchesOf, mergeFeed, teamGroupsOf, waitingWorkers, workersOf } from "@ash/shared/team";
import { ArrowSquareOut } from "@phosphor-icons/react";
import { SideDrawer } from "../components/SideDrawer.tsx";
import { InspectorHost } from "../inspector/index.ts";
import { FileViewer } from "../files/FileViewer.tsx";
import { FolderViewer } from "../files/FolderViewer.tsx";
import { useFileView } from "../files/useFileView.ts";
import { ScmDiffViewer } from "../scm/ScmDiffViewer.tsx";
import type { ScmDiffTarget } from "../scm/scmModel.ts";
import { api, type TeamCuaStatus } from "../lib/api.ts";
import { toggleArchive } from "../lib/archive.ts";
import type { Notify } from "../lib/notify.ts";
import { useTaskBody } from "../lib/useTaskBody.ts";
import { OriginTaskBar } from "../components/TaskOrigin.tsx";
import { useConversation } from "../lib/useConversation.ts";
import { useTaskReadState } from "../lib/useTaskReadState.ts";
import { AcceptGateWaitCard } from "../review/AcceptGateWaitCard.tsx";
import { useExecutorGate } from "../task-detail/ExecutorGate.tsx";
import { QuestionCard } from "../task-detail/QuestionCard.tsx";
import { DeleteTaskDialog } from "../task-detail/DeleteTaskDialog.tsx";
import { TaskDetail } from "../task-detail/TaskDetail.tsx";
import { useSubagents } from "../task-detail/useSubagents.tsx";
import { useMonitorInspector } from "../monitors/useMonitorInspector.tsx";
import { CuaResidualNotice, HaltNotice } from "./TeamNotices.tsx";
import { conversationToMarkdown } from "../task-detail/conversationModel.ts";
import { TeamFeed } from "./TeamFeed.tsx";
import { TeamReplyBox } from "./TeamReplyBox.tsx";
import { MemoSelectionScope } from "../task-memos/MemoSelectionScope.tsx";
import { TeamAttentionBar } from "./TeamAttentionBar.tsx";
import { TeamHeader } from "./TeamHeader.tsx";
import { TEAM_INSPECTORS, type TeamInspectorContext } from "./TeamInspector.tsx";
import { TeamReviewWorkspace } from "./TeamReviewWorkspace.tsx";
import { activeTeamHaltMarker, leadTurns, teamFeedOptions } from "./teamModel.ts";
import { useWorkerLiveLines } from "./workerLiveLines.ts";


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
  worker: TaskListItem;
  allTasks: TaskListItem[];
  onClose: () => void;
  onOpenFull: () => void;
  onOpenTask: (taskId: string) => void;
  onTaskUpdate: (task: Task) => void;
  onDeleted: (taskId: string) => void;
  notify: Notify;
}) {
  const [inspectorToggleTarget, setInspectorToggleTarget] = useState<HTMLSpanElement | null>(null);
  // 抽屉里是完整的 TaskDetail，要正文；执行者行来自列表（不带正文），按需补。
  const fullWorker = useTaskBody(worker);
  return (
    <SideDrawer
      variant="worker"
      contentKey={worker.id}
      kind="执行者"
      title={worker.title}
      ariaLabel={`执行者详情：${worker.title}`}
      closeLabel="关闭执行者抽屉"
      onClose={onClose}
      actions={<>
        <button type="button" onClick={onOpenFull}><ArrowSquareOut size={13} />整页打开</button>
        <span className="side-drawer__slot" ref={setInspectorToggleTarget} />
      </>}
    >
      {fullWorker && <TaskDetail key={fullWorker.id} task={fullWorker} allTasks={allTasks} onTaskUpdate={onTaskUpdate} onDeleted={onDeleted} onOpenTask={onOpenTask} inspectorMode="drawer" inspectorToggleTarget={inspectorToggleTarget} notify={notify} />}
    </SideDrawer>
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
  allTasks: TaskListItem[];
  onTaskUpdate: (task: Task) => void;
  onTaskDeleted: (taskId: string) => void;
  onSelectTask: (task: TaskListItem) => void;
  initialReviewOpen?: boolean;
  onReviewOpenChange?: (open: boolean) => void;
  notify: Notify;
}) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(initialReviewOpen);
  // 中间那一栏同一时刻只放一样东西：团队会话 / 验收台 / 文件（全文或 diff）。
  const fileView = useFileView(task.id);
  const [busy, setBusy] = useState(false);
  // 「这一轮会换执行器」的确认闸(§八);对话框住在 App 层。
  const confirmExecutorSwap = useExecutorGate();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [localHalted, setLocalHalted] = useState(false);
  const [cuaStatus, setCuaStatus] = useState<TeamCuaStatus | null>(null);
  const [delegatingIds, setDelegatingIds] = useState<ReadonlySet<string>>(() => new Set());
  const delegatingRef = useRef(new Set<string>());
  const { indicatorForTask, markTaskRead } = useTaskReadState(allTasks, task.id);
  const conversation = useConversation(task.id);
  // 子智能体执行详情和执行者详情都是从左侧推出来的抽屉，一次只留一个。
  const subagents = useSubagents(TEAM_INSPECTORS, {
    taskId: task.id,
    items: conversation.items,
    status: task.status,
    loading: conversation.refreshing,
    error: conversation.error ?? conversation.traceError,
    onRetry: conversation.refetch,
  }, { onOpen: () => setSelectedWorkerId(null) });
  // 哨兵那一格：挂在调度台自己身上，看着别的面板时也要拉（图标条上那点活信号靠它）。
  const monitorTab = useMonitorInspector(subagents.inspectors, task.id);
  const inspectors = monitorTab.inspectors;
  const workers = useMemo(() => workersOf(allTasks, task.id), [allTasks, task.id]);
  const waiting = useMemo(() => waitingWorkers(workers), [workers]);
  const workerLiveLines = useWorkerLiveLines(task.id, workers);
  const teamGroups = useMemo(() => teamGroupsOf(groups, task.id, workers), [groups, task.id, workers]);
  const batches = useMemo(() => batchesOf(workers, teamGroups), [teamGroups, workers]);
  const rows = useMemo(() => mergeFeed(conversation.items, batches, teamFeedOptions()), [batches, conversation.items]);
  const turns = useMemo(() => leadTurns(conversation.items), [conversation.items]);
  const historyHalt = activeTeamHaltMarker(conversation.items);
  const stopped = teamGroups.some((group) => group.paused) || (teamGroups.length === 0 && (historyHalt || localHalted));
  const selectedWorker = selectedWorkerId ? workers.find((worker) => worker.id === selectedWorkerId) ?? null : null;
  const markdown = useMemo(() => conversationToMarkdown(conversation.items, task), [conversation.items, task]);
  const allWorkersComplete = task.status !== "running"
    && workers.length > 0
    && workers.every((worker) => worker.status === "done");
  const inspectorPolicy = useMemo(() => ({
    // `-v4`：生成物、备忘那两格是后加的，存量用户的 `openTabs` 躺在 localStorage 里，
    // 只有 `stateKey` 变过一次才会拿下面这张表去并集。加面板要连带跳一版（同 TaskDetail）。
    //
    // 哨兵和子智能体**故意不在这张表里**：那两格走「用过才浮现」（inspector/usedTabs.tsx），
    // 开合由各自的 hook 翻 `defaultOpen`，写进这里会被每次语义换挡无条件并集回去。
    stateKey: `team:timeline-v4:${allWorkersComplete ? "complete" : "active"}`,
    requiredTabId: "info",
    defaultOpenTabIds: allWorkersComplete
      ? ["info", "review", "artifacts", "memos", "timeline"]
      : ["info", "workers", "artifacts", "memos", "timeline"],
    defaultActiveTabId: allWorkersComplete ? "review" : "workers",
  }), [allWorkersComplete]);
  const selectWorker = useCallback((taskId: string) => {
    const worker = workers.find((item) => item.id === taskId);
    if (worker) markTaskRead(worker);
    subagents.closeAgent();
    setSelectedWorkerId(taskId);
  }, [markTaskRead, subagents.closeAgent, workers]);
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
    setDeleteOpen(false);
    setLocalHalted(false);
    setCuaStatus(null);
    delegatingRef.current.clear();
    setDelegatingIds(new Set());
    void refreshGroups();
  }, [refreshGroups, task.id]);

  const changeReviewOpen = (open: boolean) => {
    setReviewOpen(open);
    if (open) {
      fileView.close();
      subagents.closeAgent();
    }
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
    // 起调度台 = 起一轮(团队三个角色各有一格执行器,别人的解析不到会降级到我的)。
    if ((action === "run" || action === "resume") && !(await confirmExecutorSwap(task.id))) return;
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
      // 归档这一支的 toast 由 toggleArchive 自己发（它要把 worktree/分支的清理结果带上）
      if (action === "archive") onTaskUpdate(await toggleArchive(task, notify, "团队"));
      else await refreshTask();
      await refreshGroups();
      if (action !== "archive") notify(action === "halt" ? "已停止全组，暂停状态会持久保留" : action === "resume" ? "已恢复全组" : "团队已启动");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const askLead = async (worker: TaskListItem) => {
    const question = worker.question?.trim();
    if (!question || delegatingRef.current.has(worker.id)) return;
    delegatingRef.current.add(worker.id);
    setDelegatingIds((current) => new Set(current).add(worker.id));
    const message = `【转交】执行者「${worker.title}」(taskId=${worker.id})在等答复,问题:\n${question}\n\n你去调查并 answer_question 答复它。`;
    if (!(await confirmExecutorSwap(task.id))) {
      delegatingRef.current.delete(worker.id);
      setDelegatingIds((current) => { const next = new Set(current); next.delete(worker.id); return next; });
      return;
    }
    try {
      await api.replyTask(task.id, message);
      conversation.addUser(message);
      notify("已转交调度者：它会调查后答复这个执行者");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      delegatingRef.current.delete(worker.id);
      setDelegatingIds((current) => {
        const next = new Set(current);
        next.delete(worker.id);
        return next;
      });
    }
  };

  return (
    <InspectorHost
      contextKey={`team:${task.id}`}
      descriptors={inspectors}
      context={{
        nativeWork: subagents.nativeWork,
        monitors: monitorTab.monitors,
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
        activeFilePath: fileView.activePath,
        onOpenFile: (path: string, reel?: readonly string[]) => {
          fileView.openFile(path, reel);
          setSelectedWorkerId(null);
          subagents.closeAgent();
          if (reviewOpen) changeReviewOpen(false);
        },
        onOpenFolder: (path: string) => {
          fileView.openFolder(path);
          setSelectedWorkerId(null);
          subagents.closeAgent();
          if (reviewOpen) changeReviewOpen(false);
        },
        onOpenDiff: (target: ScmDiffTarget) => {
          fileView.openDiff(target);
          setSelectedWorkerId(null);
          subagents.closeAgent();
          if (reviewOpen) changeReviewOpen(false);
        },
        notify,
      } satisfies TeamInspectorContext}
      tabPolicy={inspectorPolicy}
    >
      {({ toggleButton, openTab }) => <div className="team-view">
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
        onDelete={() => setDeleteOpen(true)}
        indicatorForTask={indicatorForTask}
        inspectorToggle={toggleButton}
        notify={notify}
      />
      {reviewOpen ? (
        <TeamReviewWorkspace lead={task} workers={workers} onTaskUpdated={onTaskUpdate} indicatorForTask={indicatorForTask} onReadTask={markTaskRead} notify={notify} />
      ) : fileView.filePath ? (
        <FileViewer
          taskId={task.id}
          path={fileView.filePath}
          reel={fileView.reel}
          onStep={fileView.stepFile}
          zoomed={fileView.zoomed}
          onToggleZoom={fileView.toggleZoom}
          onExitZoom={fileView.exitZoom}
          onOpenDiff={fileView.canShowDiff ? fileView.showDiff : undefined}
          onClose={fileView.close}
          notify={notify}
        />
      ) : fileView.folderPath ? (
        <FolderViewer
          taskId={task.id}
          path={fileView.folderPath}
          zoomed={fileView.zoomed}
          onToggleZoom={fileView.toggleZoom}
          onExitZoom={fileView.exitZoom}
          onOpenFile={fileView.openFile}
          onOpenFolder={fileView.openFolder}
          onClose={fileView.close}
          notify={notify}
        />
      ) : fileView.diff ? (
        <ScmDiffViewer
          taskId={task.id}
          path={fileView.diff.path}
          source={fileView.diff.source}
          origPath={fileView.diff.origPath}
          kind={fileView.diff.kind}
          zoomed={fileView.zoomed}
          onToggleZoom={fileView.toggleZoom}
          onExitZoom={fileView.exitZoom}
          onOpenFile={fileView.showFile}
          onClose={fileView.close}
        />
      ) : (
        <>
          {task.question && (
            <div className="team-lead-question">
              <QuestionCard task={task} onAnswer={async (answer, input) => {
                await api.answerTask(task.id, answer, input);
                await refreshTask();
                notify("已答复调度者，原会话正在续跑");
              }} />
            </div>
          )}
          {stopped && <HaltNotice workers={workers} groupCount={teamGroups.length} historyOnly={teamGroups.length === 0} />}
          {stopped && <CuaResidualNotice taskId={task.id} status={cuaStatus} onStatus={setCuaStatus} notify={notify} />}
          <TeamAttentionBar
            waiting={waiting}
            workers={workers}
            delegatingIds={delegatingIds}
            onOpenWorker={selectWorker}
            onAskLead={askLead}
          />
          <section className="team-flow-main" aria-label="团队会话">
            {/* 选中调度台会话里的一段 →「添加到备忘」,跟普通任务详情页**同一个组件、同一张表**
                (独立审查第 1 轮 F4:只接了面板、没接选文入口,等于逼人手抄)。团队这一页没有
                侧聊那一格,所以 onAsk 不传 —— 浮条上只出「添加到备忘」一颗。 */}
            <MemoSelectionScope taskId={task.id} openTab={openTab} notify={notify}>
              <TeamFeed
                task={task}
                rows={rows}
                workers={workers}
                onOpenWorker={selectWorker}
                onAskLead={askLead}
                delegatingIds={delegatingIds}
                indicatorForTask={indicatorForTask}
                historyReady={conversation.transcriptReady}
              />
            </MemoSelectionScope>
            {/* 验收前置命令那一条，跟普通任务详情页同一个组件、同一条 rail 几何（第 1 轮
                审查 F4）：团队走的是这套独立的主会话 + 回复框，不经过 TaskDetail，于是
                给团队点验收之后，命令在工作区里跑十几分钟而这一页上一个字都看不出来。 */}
            {task.acceptGateRunning && (
              <div className="task-reply-rail">
                <AcceptGateWaitCard key={task.id} taskId={task.id} expected notify={notify} />
              </div>
            )}
            <TeamReplyBox task={task} onSend={async (text, attachments, options) => {
              // 回复也会起一轮(与普通任务详情页同口径)。
              if (!(await confirmExecutorSwap(task.id))) return null;
              const result = await api.replyTask(task.id, text, { attachments, ...options });
              // 调度台是常驻会话,忙着也接得住,所以这里只可能是定时发送;仍按结果
              // 分支(而不是按请求参数),口径与普通任务一致。
              if ("scheduled" in result) {
                notify(`已安排 ${new Date(result.message.sendAt).toLocaleString()} 发送给调度者`);
                return result;
              }
              conversation.addUser(text, attachments);
              notify("已发送给调度者");
              return result;
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
      {/* 子智能体抽屉不跟着验收台让位：那一格列表在验收台开着时也点得到，按了就得有反应
          （反过来打开验收台会先收起它，见 changeReviewOpen）。 */}
      {subagents.drawer}
      {deleteOpen && (
        <DeleteTaskDialog
          task={task}
          notify={notify}
          onDeleted={(ids) => ids.forEach(onTaskDeleted)}
          onClose={() => setDeleteOpen(false)}
        />
      )}
      </div>}
    </InspectorHost>
  );
}
