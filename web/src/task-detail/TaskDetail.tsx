import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Group, Task, TaskListItem } from "@navi/shared";
import { isUserFollowUp } from "@navi/shared";
import { annotationBatchDisplayText } from "@navi/shared/page-annotation-display";
import { PreviewWorkspace } from "../preview-workspace/PreviewWorkspace.tsx";
import { RuntimeAutoOpen } from "../task-runtime/RuntimeAutoOpen.tsx";
import { PlanModeChip } from "./PlanModeChip.tsx";
import { AcceptGateWaitCard } from "../review/AcceptGateWaitCard.tsx";
import { InspectorHost } from "../inspector/index.ts";
import { TaskFileLinks } from "../components/TaskFileLink.tsx";
import { useFileView } from "../files/useFileView.ts";
import { useFileViewTab } from "../files/fileViewTab.tsx";
import { TASK_FILE_TABS } from "./taskInspectors.tsx";
import { api } from "../lib/api.ts";
import { toggleArchive } from "../lib/archive.ts";
import type { Notify } from "../lib/notify.ts";
import { useConversation } from "../lib/useConversation.ts";
import { useSkills } from "../lib/useSkills.ts";
import { useTaskReadState } from "../lib/useTaskReadState.ts";
import { conversationToMarkdown } from "./conversationModel.ts";
import { ConversationFeed } from "./ConversationFeed.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { DeleteTaskDialog } from "./DeleteTaskDialog.tsx";
import { HandoffBanner } from "./HandoffBanner.tsx";
import { HandoffAuditBanner } from "./HandoffAuditBanner.tsx";
import { ReplyBox } from "./ReplyBox.tsx";
import { replySend } from "./replySend.ts";
import { replyDispatch } from "./replyDispatch.ts";
import { launchPlan, saveDispatchTarget } from "./dispatchPlanActions.ts";
import { replyDiscuss } from "./replyDiscuss.ts";
import { dispatchNotes } from "./dispatchNotes.ts";
import { withdrawalNotes } from "./suggestions/withdrawalNotes.ts";
import { DispatchNoteLine } from "./DispatchNoteLine.tsx";
import { FootnoteLine } from "./FootnoteLine.tsx";
import { LeftDrawerProvider } from "../components/LeftDrawer.tsx";
import { useDisputeRulingDock } from "../free-workflow/DisputeRulingDock.tsx";
import { TaskHeader, type PrimaryAction } from "./TaskHeader.tsx";
import { canDeriveTask } from "./taskDerivation.ts";
import { TaskReviewWorkspace } from "../review/TaskReviewWorkspace.tsx";
import { reviewTargetRequest } from "../review/reviewTarget.ts";
import { DerivedTaskLinks } from "../components/DerivedTaskLinks.tsx";
import { TaskReplyRail } from "./TaskReplyRail.tsx";
import { useTaskReplyActions } from "./TaskReplyActions.tsx";
import { useWaitingTitle } from "./useWaitingTitle.ts";
import { FreeReviewDialog } from "../free-workflow/FreeReviewDialog.tsx";
import { discussionDrawerKey } from "../free-workflow/DiscussionRecord.tsx";
import { retryTurnActions, type TurnRetryTarget } from "./turnRetry.ts";
import { blocker, refreshTaskActions, shown, useTaskActions } from "../lib/useTaskActions.ts";
import { useExecutorGate } from "./ExecutorGate.tsx";
import type { ComposerDraft } from "../composer/composerDraft.ts";
import { forkReadBlock, snapshotConversationFork } from "./conversationFork.ts";
import { useTaskDrawers } from "./useTaskDrawers.tsx";
import { MemoSelectionScope } from "../task-memos/MemoSelectionScope.tsx";
import { stageSideChatQuote } from "../side-chat/sideChatQuote.ts";
import { useAddReplyQuote } from "./replyQuote.ts";
import { useReuseInput } from "./ReuseInput.tsx";
import { DispatchHeldLine, useDispatchHolder } from "./dispatched/DispatchHeldLine.tsx";


export function TaskDetail({
  task,
  allTasks,
  tasksReady = true,
  onTaskUpdate,
  onTasksSynced,
  onDeleted,
  onOpenTask,
  onHandoff,
  onForkTask,
  initialReviewOpen = false,
  onReviewOpenChange,
  inspectorMode = "page",
  inspectorToggleTarget = null,
  notify,
}: {
  task: Task;
  allTasks: TaskListItem[];
  tasksReady?: boolean;
  onTaskUpdate: (task: Task) => void;
  /** 入队响应的全体成员快照整批上交,由工作台按 updatedAt 合并进任务列表;
   * 不传的挂载面(团队成员抽屉,排队入口本就不可见)退回逐个 onTaskUpdate。 */
  onTasksSynced?: (tasks: Task[]) => void;
  onDeleted: (taskId: string) => void;
  onOpenTask: (taskId: string) => void;
  onHandoff?: (task: Task) => void;
  onForkTask?: (draft: ComposerDraft) => void;
  initialReviewOpen?: boolean;
  onReviewOpenChange?: (open: boolean) => void;
  inspectorMode?: "page" | "drawer";
  inspectorToggleTarget?: HTMLElement | null;
  notify: Notify;
}) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [busy, setBusy] = useState(false);
  // 共享项目里动别人的任务会换执行器 —— 起轮之前先确认(§八)。自用模式恒不弹。
  // 确认闸的对话框住在 App 层(见 ExecutorGate.tsx),这里只拿判据。
  const confirmExecutorSwap = useExecutorGate();
  const [reviewOpen, setReviewOpen] = useState(initialReviewOpen);
  const [previewOpen, setPreviewOpen] = useState(false);
  // 中间那一栏同一时刻只放一样东西：会话 / 预览指正 / 审查工作区。点开的文件、文件夹、diff
  // 摊在右侧面板「查看」那一格（files/fileViewTab.tsx），会话和回复框一直留着。
  const fileView = useFileView(task.id);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [markDoneOpen, setMarkDoneOpen] = useState(false);
  const [postMergeDialogOpen, setPostMergeDialogOpen] = useState(false);
  // 刚发出去的那一回合由谁跑。会话行一落库就由它接管(见 runActivityExecutor),
  // 这里只补中间那一两秒;任务停下来就作废,免得下一次「运行」照抄旧目标。
  // 读过 / 没读过的账（侧栏那一行的点）随打开的任务对齐；头上不再画状态点，返回值这里用不上。
  useTaskReadState(allTasks, task.id);
  // 只在它确实停着（已暂停 / 排着）时说；已经做完的那几条不用解释为什么没在跑。
  const holder = useDispatchHolder(task.id, allTasks, task.status === "paused" || task.status === "backlog");
  const conversation = useConversation(task.id);
  // 审查链状态（free）也在那一层订阅：同时服务竖轨上审查格的点和验收后快照入口。
  const { subagents, monitorTab, inspectors: stackInspectors, inspectorPolicy, liveMonitors, endedMonitorIds, free, runFacts, dispatchedFolds, runtime, leftDrawer, closeDrawers, drawers } = useTaskDrawers({
    task, allTasks, tasksReady, conversation,
  });
  const { inspectors, reveal: fileViewReveal } = useFileViewTab(stackInspectors, fileView, TASK_FILE_TABS);
  // 等你裁定时回复框顶上那一行（DisputeRulingDock）：选了一档，这一个框就成了那一步。
  const ruling = useDisputeRulingDock({ task, reviews: free.state?.reviews, known: !!free.state, onChanged: free.setState, notify });
  // 此刻能做什么（运行 / 停止 / 归档 / 重新排队 / 重跑上一回合 / 派验证）整份由服务端判，这里只照着画。
  const actions = useTaskActions(task.id);
  // 「上一回合崩了、任务却停在终态」的那颗重来落在说这件事的地方，带字：普通回合挂在会话里那一回合
  // 失败那句话后面；审查档挂在审查格结论行和会话尾注上（turnRetry.ts）。
  const { turn: crashedTurnRetry, review: reviewRetry } = retryTurnActions(actions?.retryTurn, (target) => retryTurn(target));
  const followUps = useMemo(
    () => conversation.items.flatMap((item) => (
      item.kind === "user" && isUserFollowUp(item)
        ? [{ text: annotationBatchDisplayText(item.text) ?? item.text, attachments: item.attachments, ...(item.at ? { at: item.at } : {}) }]
        : []
    )),
    [conversation.items],
  );
  const markdown = useMemo(
    () => conversationToMarkdown(conversation.items, task),
    [conversation.items, task],
  );
  const hasConversation = conversation.sessions.length > 0 || conversation.items.length > 0;
  const postMergeTarget = task.stage === "accepted" && task.workflowMode === "free"
    && task.acceptedTargetBranch && task.acceptedBaseCommit && task.acceptedMergeCommit
    ? { branch: task.acceptedTargetBranch, baseCommit: task.acceptedBaseCommit, mergeCommit: task.acceptedMergeCommit }
    : null;
  const latestPostMerge = free.state?.reviews.find((run) => run.target?.kind === "accepted_merge");
  const postMergeReviewLabel = postMergeTarget
    ? latestPostMerge?.status === "reviewing" ? "查看合并审查" : latestPostMerge ? "再次审查合并结果" : "审查合并结果"
    : null;
  const derivationAllowed = canDeriveTask(task);
  // 你在回复框里派出去的那几条：会话里各留一句靠右的小灰字（dispatchNotes.ts）。
  // 子任务后来来问、失败，这里一概不画：提示在侧栏和任务头那颗「子任务」键的数、右侧那一格里。
  // 智能体收回的建议任务：收回的那一刻留一句为什么（suggestions/withdrawalNotes.ts），跟尾注同一种小灰字。
  const asides = useMemo(() => [
    ...dispatchNotes(task.id, allTasks).map((note) => ({
      key: `dispatch:${note.id}`, at: note.at, node: <DispatchNoteLine note={note} onOpen={onOpenTask} />,
    })),
    ...withdrawalNotes(task.dispatchWithdrawals).map((note) => ({
      key: note.key, at: note.at, node: <FootnoteLine footnote={note.footnote} placement="standalone" />,
    })),
  ], [allTasks, onOpenTask, task.id, task.dispatchWithdrawals]);
  // 接力入口:已接力出去的任务在本机是存档,除非那次还悬着(可以撤/重试)。
  const canHandoff = task.mode === "single" && task.parentId === null && !task.archived && task.queueId == null
    && (task.handoff?.direction !== "out" || !!task.handoff.pending);
  const handedOut = task.handoff?.direction === "out" && !task.handoff.pending;
  // 选中会话正文后的「添加到对话」：写进这个任务的回复草稿。没有对话框的任务不给这个入口。
  const addToReply = useAddReplyQuote(task.id);
  const reuseInput = useReuseInput(task.id);
  useWaitingTitle(!!task.question, task.id);
  // 回复框那一行左边的动作：再审、打开预览、接力到…（reply-3）。
  const replyActions = useTaskReplyActions({ task, canHandoff, onHandoff: () => onHandoff?.(task), notify });

  // 这一轮由哪个执行器跑,`/` 就补它自己装的技能(ReplyBox 里 @ 召唤别人时列表
  // 不跟着变——那是「本回合换人」,而技能清单按任务常设执行器给,够用且不闪)。
  const skills = useSkills({
    agentType: task.agentType,
    projectId: task.projectId,
    enabled: task.mode === "single" && !task.archived,
  });

  useEffect(() => {
    let alive = true;
    api.groups(task.projectId).then((rows) => { if (alive) setGroups(rows); }).catch(() => undefined);
    return () => { alive = false; };
  }, [task.projectId]);
  useEffect(() => {
    setReviewOpen(initialReviewOpen);
    setPreviewOpen(false);
    setDeleteOpen(false);
    setMarkDoneOpen(false);
    setPostMergeDialogOpen(false);
    fileView.close();
  }, [fileView.close, initialReviewOpen, task.id]);

  const changeReviewOpen = (open: boolean) => {
    setReviewOpen(open);
    if (open) {
      setPreviewOpen(false);
      closeDrawers();
    }
    onReviewOpenChange?.(open);
  };

  const refreshTask = async () => {
    const updated = await api.task(task.id);
    onTaskUpdate(updated);
    return updated;
  };

  // 队列相关快照的统一落点:上层给了按版本合并的通路就用它;没给的挂载面
  // (团队成员抽屉,排队入口本就不可见)退回逐个 onTaskUpdate。
  const applySnapshots = onTasksSynced ?? ((synced: Task[]) => synced.forEach(onTaskUpdate));

  const patch = async (value: Partial<Task>) => {
    const updated = await api.patchTask(task.id, value);
    onTaskUpdate(updated);
  };

  const perform = async (action: Exclude<PrimaryAction, null>) => {
    if (action === "accept") return changeReviewOpen(true);
    // 会起一轮的动作先过「换执行器」确认闸(§八)。stop / unarchive 不起轮,不问。
    if ((action === "run" || action === "retry") && !(await confirmExecutorSwap(task.id))) return;
    setBusy(true);
    try {
      if (action === "run") await api.runTask(task.id);
      if (action === "retry") await api.retryTask(task.id);
      if (action === "stop") await api.stopTask(task.id);
      if (action === "unarchive") onTaskUpdate(await toggleArchive(task, notify));
      else await refreshTask();
    } catch (reason) {
      // 被拒多半是撞车（另一个操作刚占住这个任务）：原因照说，结论顺手重取一份。
      notify(reason instanceof Error ? reason.message : String(reason));
      void refreshTaskActions(task.id);
    } finally {
      setBusy(false);
    }
  };

  const retryTurn = async (target: TurnRetryTarget) => {
    try {
      if (!(await confirmExecutorSwap(task.id))) return;
      const result = await api.retryTurn(task.id, target);
      // 审查档同一颗按钮有两种结果：上下文还在就接着做，上下文是空的
      // （CLI 当时压根没起来）才重发整份任务书。别只说「已重跑」——
      // 用户按之前看到的承诺是「继续」，退回从头跑时必须当面说清楚。
      notify(result.mode === "review"
        ? result.resumed
          ? "已从中断处继续这一轮审查"
          : "上一轮没留下可接着做的上下文，已重新交代任务书跑这一轮"
        : result.mode === "resend" ? "已重发上一条指令，任务续跑中" : "已从中断处续跑");
      // 只重取会话正文。任务本身的 running 由 SSE 推过来 —— 这里再补一发
      // GET，回来的很可能还是重投前的 done，反手把跑起来的状态盖回去
      // （WorkspaceShell 按 onTaskUpdate 覆盖，没有版本门禁）。
      await conversation.refetch();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
      void refreshTaskActions(task.id);
    }
  };

  // 「没交卷」被记 failed 时的收尾出口：结算说明让用户核对产物后直接标记完成，这就是那句
  // 话对应的动作。走通用的 PATCH status —— 服务端对 running/queued 一律 409，所以按不到
  // 一个还活着的任务上（真要停得先 stop_task）。
  const markDone = async () => {
    setBusy(true);
    try {
      await patch({ status: "done" });
      setMarkDoneOpen(false);
      notify("已标记为完成");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    setBusy(true);
    try {
      onTaskUpdate(await toggleArchive(task, notify));
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const requeue = async () => {
    setBusy(true);
    try {
      const result = await api.requeueTask(task.id);
      onTaskUpdate(result.task);
      notify(result.movedToEnd ? "已重新排队并移到队尾" : "已重新排队");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async () => {
    try {
      await Promise.all([conversation.refetch(), refreshTask()]);
      notify("任务详情已刷新");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const inspectorContextKey = inspectorMode === "drawer" ? `task-drawer:${task.id}` : `task:${task.id}`;

  return (
    // 正文里提到的路径跟侧栏的生成物、文件树同一个出口：摊进「查看」那一格。InspectorHost 也在它里面——
    // 那一格里的 Markdown 再点别的文件，走的是同一条路，在原地换内容。
    <TaskFileLinks taskId={task.id} onOpenFile={fileView.openFile} onOpenFolder={fileView.openFolder} onOpenError={notify}>
      <LeftDrawerProvider value={leftDrawer.api}>
      <InspectorHost
        contextKey={inspectorContextKey}
        descriptors={inspectors}
        context={{
          nativeWork: subagents.nativeWork,
          dispatchedFolds,
          monitors: monitorTab.monitors,
          task,
          groups,
          sessions: conversation.sessions,
          allTasks,
          followUps,
          runFacts,
          onOpenTask,
          onOpenReview: () => changeReviewOpen(true),
          onOpenPreview: () => { setPreviewOpen(true); changeReviewOpen(false); closeDrawers(); },
          onTaskUpdated: onTaskUpdate,
          onPatch: patch,
          onQueueChanged: (updatedTask) => {
            // 带参分支也走按 updatedAt 的合并路径(applySnapshots),不做无条件覆盖:
            // 迟到的旧响应不能反转 SSE 已送达的更晚状态(第 6 轮审查)。
            if (updatedTask) applySnapshots([updatedTask]);
            // 没带快照的兜底读取也要兜住失败:入队/排队本身已成功,GET 挂了只能
            // 如实提示,不能让 rejection 裸冒(第 5 轮审查)。
            else refreshTask().catch(() => notify("队列已更新，但刷新任务状态失败"));
          },
          onTasksSynced: applySnapshots,
          reviewRetry,
          runtime,
          fileView,
          notify,
        }}
        defaultVisible={inspectorMode === "page"}
        tabPolicy={inspectorPolicy}
        reveal={fileViewReveal}
      >
        {({ toggleButton, openTab }) => (
          <>
            <div className="task-detail">
              <TaskHeader
                task={task}
                actions={actions}
                allTasks={allTasks}
                conversationMarkdown={markdown}
                busy={busy}
                refreshing={conversation.refreshing}
                reviewOpen={reviewOpen}
                onTitle={(title) => patch({ title, autoTitle: false })}
                onTogglePin={() => patch({ pinnedAt: task.pinnedAt != null ? null : Date.now() })}
                onPrimary={(action) => void perform(action)}
                onRequeue={() => void requeue()}
                onMarkDone={() => setMarkDoneOpen(true)}
                onArchive={() => void archive()}
                onRefresh={() => void refresh()}
                onReview={() => changeReviewOpen(!reviewOpen)}
                postMergeReviewLabel={postMergeReviewLabel}
                onPostMergeReview={postMergeTarget ? () => {
                  if (latestPostMerge?.status === "reviewing") openTab("review");
                  else setPostMergeDialogOpen(true);
                } : undefined}
                onDelete={() => setDeleteOpen(true)}
                onOpenTask={onOpenTask}
                inspectorToggle={inspectorMode === "drawer" && inspectorToggleTarget ? undefined : toggleButton}
                planChip={<PlanModeChip task={task} onOff={(executorId) => {
                  replySend({ task, allTasks, conversation, confirmExecutorSwap, notify })("/plan off", [], { agent: "codex", executorId })
                    .catch((reason) => notify(reason instanceof Error ? reason.message : String(reason)));
                }} />}
                notify={notify}
              />
              {task.handoffAudit && <HandoffAuditBanner audit={task.handoffAudit} />}
              {task.handoff && (
                <HandoffBanner
                  taskId={task.id}
                  handoff={task.handoff}
                  notify={notify}
                  onTaskUpdate={onTaskUpdate}
                />
              )}
              {previewOpen ? (
                <PreviewWorkspace key={task.id} taskId={task.id} onClose={() => setPreviewOpen(false)} />
              ) : reviewOpen ? (
                <TaskReviewWorkspace
                  task={task}
                  allTasks={allTasks}
                  onTaskUpdated={onTaskUpdate}
                  notify={notify}
                  onPostMergeReview={postMergeTarget ? () => {
                    if (latestPostMerge?.status === "reviewing") openTab("review");
                    else setPostMergeDialogOpen(true);
                  } : undefined}
                  onOpenReview={() => openTab("review")}
                  onClose={() => changeReviewOpen(false)}
                />
              ) : (
                <div className="task-detail-body">
                  <section className="task-detail-main" aria-label="任务会话">
                    <MemoSelectionScope
                      taskId={task.id}
                      openTab={openTab}
                      notify={notify}
                      onAsk={() => openTab("side-chat")}
                      onAddToReply={handedOut ? undefined : addToReply}
                    >
                    <ConversationFeed
                      task={task}
                      requirement={{ text: task.body, at: task.createdAt, origin: task.creationOrigin }}
                      questionHistory={task.questionHistory}
                      liveQuestionHistory
                      historyReady={conversation.transcriptReady}
                      bodyReady={conversation.ready}
                      items={conversation.items}
                      sessions={conversation.sessions}
                      loading={conversation.refreshing}
                      error={conversation.error}
                      forkBlockedReason={forkReadBlock(conversation)}
                      onForkReply={
                        // `!task.reviewOf`：历史那种独立审查任务整条会话都是审查，而逐条的
                        // reviewer 标只认 verifyRound 与 role=reviewer，认不出它 —— 那条路上
                        // 每一条发言都不是派生落点，在这里整体关掉。
                        onForkTask && !task.reviewOf && !forkReadBlock(conversation) && !handedOut
                        && conversation.sessions.every((session) => session.taskId === task.id) ? (replyId) => {
                        try { onForkTask(snapshotConversationFork(task, conversation.items, replyId)); }
                        catch (reason) { notify(reason instanceof Error ? reason.message : String(reason)); }
                      } : undefined}
                      // 只有单个智能体的任务、且此刻没在跑才能删：服务端同样会挡，这里不出按钮是
                      // 为了不让人点了才知道（团队调度台、duet 还没接「下一轮重建上下文」）。
                      onDeleteMessage={task.mode === "single" && !handedOut && task.status !== "running" && task.status !== "queued"
                        ? async (sources) => {
                          // 一条都不发：多条会话是逐条删的，先删了别的再撞上这条就成了删一半。
                          if (sources.some((source) => "trace" in source && source.entangled)) {
                            notify("这条消息有几步和另一条消息记在同一时刻，分不开，没法单独删除");
                            return;
                          }
                          try {
                            for (const sessionId of new Set(sources.map((source) => source.sessionId))) {
                              await api.deleteConversationSegments(sessionId, sources.filter((source) => source.sessionId === sessionId)
                                .map(({ sessionId: _, ...target }) => target));
                            }
                            notify("已删除。下一轮会换一条新的会话，只带着删除后留下的记录继续");
                          } catch (reason) {
                            notify(reason instanceof Error ? reason.message : String(reason));
                          }
                          await conversation.refetch();
                        }
                        : undefined}
                      onDeleteDiscussion={task.mode === "single" && !handedOut && task.status !== "running" && task.status !== "queued"
                        ? async (discussionId) => {
                          try {
                            await api.deleteDiscussion(task.id, discussionId);
                            if (leftDrawer.api.activeKey === discussionDrawerKey(task.id, discussionId)) leftDrawer.api.close();
                            notify("已删除这场讨论。下一轮会换一条新的会话，只带着删除后留下的记录继续");
                          } catch (reason) {
                            notify(reason instanceof Error ? reason.message : String(reason));
                          }
                          await Promise.all([conversation.refetch(), free.reload(true, true)]);
                        }
                        : undefined}
                      onAskSideChat={(quote) => { stageSideChatQuote(task.id, quote); openTab("side-chat"); }}
                      // 跟回复框可用同一口径（ReplyBox 的 disabled）：框是灰的，放回去也没法发。
                      onReuseInput={task.mode === "single" && !task.archived && !handedOut && hasConversation ? reuseInput : undefined}
                      // 被派它的那条按住了（名下全部停下）：会话最后多一行「是谁按的」，点过去接着跑。
                      // 哨兵那一行不在这里：它是进行中的状态，住在回复框上方（见下面的 topRail）。
                      footer={task.status !== "running" && task.status !== "queued" && holder
                        ? <DispatchHeldLine holder={holder} onOpen={onOpenTask} /> : undefined}
                      reviewRetry={reviewRetry}
                      turnRetry={crashedTurnRetry}
                      reviews={free.state?.reviews}
                      discussions={free.state?.discussions}
                      asides={asides}
                      // 会话里那一句审查结论点过来：审查格展开那一轮（feed-10 / insp-5）。
                      onOpenReviewPanel={(target) => openTab("review", target ? reviewTargetRequest(target) : undefined)}
                      onOpenMonitorPanel={(monitorId) => openTab("monitors", monitorId ? { monitorId } : undefined)}
                      onOpenTask={onOpenTask}
                    />
                    </MemoSelectionScope>
                    <DerivedTaskLinks sourceTaskId={task.id} allTasks={allTasks} onOpen={onOpenTask} />
                    {!handedOut && <ReplyBox
                      task={task}
                      tasks={allTasks}
                      hasConversation={hasConversation}
                      conversationItems={conversation.items}
                      // 还在盯的哨兵跟排队消息并在框上方同一块里（任务在跑、在等都在）。
                      monitors={{
                        live: liveMonitors,
                        ended: endedMonitorIds,
                        running: task.status === "running" || task.status === "queued",
                        resumePrompt: task.resumePrompt ?? null,
                        reviewArmed: !!free.state?.reviewReservation.armed,
                        onOpen: (monitorId) => openTab("monitors", { monitorId }),
                        onStop: async (monitor) => {
                          const running = task.status === "running" || task.status === "queued";
                          try { await api.stopMonitor(monitor.id, `用户在回复框上方点了「${running ? "停掉" : "不等了"}」`); }
                          catch (reason) { notify(reason instanceof Error ? reason.message : String(reason)); }
                        },
                      }}
                      // 框上方另一样状态：验收前置命令那一条。点了验收之后它在工作区里跑十几分钟,
                      // 而任务本身 status/stage 一个字都不变 —— 不摆在这儿,主会话页上就完全
                      // 看不出有东西在跑(时间轴那行很快被顶走)。
                      // 卡自己判要不要出现（它读门禁状态，不只看任务投影），没在跑时这一条是空的、不占地方。
                      topRail={(
                        <TaskReplyRail
                          gateWait={(
                            <AcceptGateWaitCard
                              key={`accept-gate:${task.id}`}
                              taskId={task.id}
                              expected={!!task.acceptGateRunning}
                              notify={notify}
                            />
                          )}
                        />
                      )}
                      // 这条任务自己的提问在等时，回复框那一格是答题卡（QuestionSlot）：全页只有一处打字、一颗发送键。
                      // 名下子任务来问不占这一格：那张卡在它自己的页面上。
                      onAnswer={async (answer, input, attachments) => {
                        await api.answerTask(task.id, answer, input, attachments);
                        notify("已发送答复，任务正在续跑");
                      }}
                      onLaunchPlan={launchPlan(task.id, notify)}
                      onDispatchTargetChange={task.mode === "single" && !task.parentId && !task.archived ? saveDispatchTarget(task, onTaskUpdate, notify) : undefined}
                      actions={replyActions.actions}
                      moreItems={replyActions.moreItems}
                      moreRef={replyActions.moreRef}
                      skills={skills.skills}
                      onStop={shown(actions?.stop) ? () => perform("stop") : undefined}
                      stopBlocked={blocker(actions?.stop)}
                      onStandingExecutorChange={async (next, label) => {
                        const updated = await api.patchTask(task.id, next);
                        onTaskUpdate(updated);
                        const run = [label, updated.model, updated.reasoningEffort]
                          .filter(Boolean).join(" · ");
                        // 已经在跑的那一轮换不了人（进程都起来了），说清楚从哪一句开始算数。
                        notify(task.status === "running" || task.status === "queued"
                          ? `以后这个任务交给 ${run}；当前这一轮跑完后生效`
                          : `以后这个任务交给 ${run}`);
                      }}
                      onSend={replySend({ task, allTasks, conversation, confirmExecutorSwap, notify })}
                      onOpenTask={onOpenTask}
                      // 「派出去」只在普通的独立任务里有（团队执行者、审查任务各有归属，服务端也不收）。
                      onDispatch={derivationAllowed && task.mode === "single" && !task.archived
                        ? replyDispatch({ task, onCreated: onTaskUpdate, notify }) : undefined}
                      // 「讨论」同样只在普通的独立任务里有，且只认自由工作流（服务端 discussionBlocker 同一口径）。
                      onDiscuss={derivationAllowed && task.mode === "single" && !task.archived && task.workflowMode === "free"
                        ? replyDiscuss({ task, onChanged: free.setState }) : undefined}
                      discussHeld={(free.state?.discussions ?? []).some((item) => item.status === "running" || item.status === "synthesizing")
                        ? "这条任务上正在讨论，说完再开下一场" : null}
                      override={ruling}
                    />}
                  </section>
                </div>
              )}
              <RuntimeAutoOpen taskId={task.id} browser={runtime.state.browser} openTab={openTab} />
              {markDoneOpen && (
                <ConfirmDialog
                  title="标记为已完成"
                  message={"把这个任务直接落成「已完成」。用在 agent 其实干完了、只是没调 complete_task 交卷的时候 —— 请先核对产物（提交、改动、产出文件）确实在。\n\n它跟「重试」是两条路：重试会从中断处接着跑，标记完成则就此收尾，队列里排在后面的任务会开始跑。"}
                  confirmLabel="标记完成"
                  busy={busy}
                  onConfirm={() => void markDone()}
                  onClose={() => setMarkDoneOpen(false)}
                />
              )}
              {deleteOpen && (
                <DeleteTaskDialog
                  task={task}
                  notify={notify}
                  onDeleted={(ids) => ids.forEach(onDeleted)}
                  onClose={() => setDeleteOpen(false)}
                />
              )}
              {postMergeDialogOpen && postMergeTarget && (
                <FreeReviewDialog
                  taskId={task.id}
                  state={free.state}
                  reservationMode={false}
                  postMergeTarget={postMergeTarget}
                  onChanged={free.setState}
                  onClose={() => setPostMergeDialogOpen(false)}
                  notify={notify}
                />
              )}
              {/* 左边那一屉（子智能体 / 读全文）：盖住中间那一栏，右侧 Inspector 仍然看得见、点得着。 */}
              {drawers}
            </div>
            {inspectorMode === "drawer" && inspectorToggleTarget
              ? createPortal(toggleButton, inspectorToggleTarget)
              : null}
          </>
        )}
      </InspectorHost>
      </LeftDrawerProvider>
    </TaskFileLinks>
  );
}
