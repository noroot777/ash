import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Group, Session, Task, TaskListItem } from "@ash/shared";
import { isUserFollowUp } from "@ash/shared";
import { FolderOpen, GitBranch, GitPullRequest, Info, MagnifyingGlass } from "@phosphor-icons/react";
import { InspectorHost, type InspectorDescriptor } from "../inspector/index.ts";
import { FileTreeInspector } from "../files/FileTreeInspector.tsx";
import { FileViewer } from "../files/FileViewer.tsx";
import { ScmDiffViewer } from "../scm/ScmDiffViewer.tsx";
import { ScmInspector } from "../scm/ScmInspector.tsx";
import type { ScmDiffTarget } from "../scm/scmModel.ts";
import { api } from "../lib/api.ts";
import { useConversation } from "../lib/useConversation.ts";
import { useSkills } from "../lib/useSkills.ts";
import { useTaskReadState } from "../lib/useTaskReadState.ts";
import { conversationToMarkdown } from "./conversationModel.ts";
import { ConversationFeed } from "./ConversationFeed.tsx";
import { DeleteTaskDialog } from "./DeleteTaskDialog.tsx";
import { HandoffBanner } from "./HandoffDialog.tsx";
import { HandoffAuditBanner } from "./HandoffAuditBanner.tsx";
import { QuestionCard } from "./QuestionCard.tsx";
import { ReplyBox } from "./ReplyBox.tsx";
import { TaskDerivationComposer } from "./TaskDerivationComposer.tsx";
import { TaskHeader, type PrimaryAction } from "./TaskHeader.tsx";
import { TaskInspector } from "./TaskInspector.tsx";
import {
  canDeriveTask,
  isTaskDerivationCommand,
  parseTaskDerivationCommand,
  TASK_DERIVATION_COMMANDS,
  type TaskDerivationCommand,
} from "./taskDerivation.ts";
import { TaskReviewInspector } from "./TaskReviewInspector.tsx";
import { TaskReviewWorkspace } from "../review/TaskReviewWorkspace.tsx";
import { WorkflowInspector } from "../workflow/WorkflowInspector.tsx";
import { OriginTaskBar } from "../components/TaskOrigin.tsx";
import { DerivedTaskLinks } from "../components/DerivedTaskLinks.tsx";
import { FreeWorkflowInspector } from "../free-workflow/FreeWorkflowInspector.tsx";
import { TaskReplyRail } from "./TaskReplyRail.tsx";
import { FreeReviewDialog } from "../free-workflow/FreeReviewDialog.tsx";
import { useFreeWorkflowState } from "../free-workflow/useFreeWorkflowState.ts";
import { freeReviewRetryable } from "./turnRetry.ts";
import { useExecutorDowngradeConfirm } from "./useExecutorDowngradeConfirm.tsx";

interface TaskInspectorContext {
  task: Task;
  groups: Group[];
  sessions: Session[];
  allTasks: TaskListItem[];
  followUps: { text: string; attachments: string[]; at?: string }[];
  onOpenTask: (taskId: string) => void;
  onOpenReview: () => void;
  onTaskUpdated: (task: Task) => void;
  onPatch: (patch: Partial<Task>) => Promise<void>;
  onQueueChanged: (updatedTask?: Task) => void;
  openFilePath: string | null;
  onOpenFile: (path: string) => void;
  openScmDiff: ScmDiffTarget | null;
  onOpenScmDiff: (target: ScmDiffTarget) => void;
  notify: (message: string) => void;
}

const TASK_INSPECTORS: readonly InspectorDescriptor<TaskInspectorContext>[] = [
  {
    id: "info",
    title: "信息",
    icon: <Info size={14} />,
    defaultOpen: true,
    shortcut: "i",
    render: (context) => <TaskInspector {...context} />,
  },
  {
    id: "files",
    title: "文件",
    icon: <FolderOpen size={14} />,
    defaultOpen: true,
    shortcut: "f",
    render: (context) => (
      <FileTreeInspector
        taskId={context.task.id}
        activePath={context.openFilePath}
        onOpenFile={context.onOpenFile}
      />
    ),
  },
  {
    id: "scm",
    title: "改动",
    icon: <GitPullRequest size={14} />,
    defaultOpen: true,
    shortcut: "g",
    render: (context) => (
      <ScmInspector
        taskId={context.task.id}
        activeDiff={context.openScmDiff}
        onOpenDiff={context.onOpenScmDiff}
        onOpenReview={context.onOpenReview}
        notify={context.notify}
      />
    ),
  },
  {
    id: "workflow",
    title: "工作流",
    icon: <GitBranch size={14} />,
    defaultOpen: true,
    shortcut: "w",
    render: (context) => context.task.workflowMode === "free"
      ? <FreeWorkflowInspector task={context.task} />
      : <WorkflowInspector task={context.task} onTaskUpdated={context.onTaskUpdated} notify={context.notify} />,
  },
  {
    id: "review",
    title: "审查",
    icon: <MagnifyingGlass size={14} />,
    defaultOpen: true,
    shortcut: "r",
    render: (context) => context.task.workflowMode === "free"
      ? <FreeWorkflowInspector task={context.task} reviewOnly onOpenReview={context.onOpenReview} onOpenTask={context.onOpenTask} notify={context.notify} />
      : <TaskReviewInspector {...context} />,
  },
];

const REVIEW_FOCUS_STAGES = new Set(["verifying", "verified", "verify_failed", "awaiting_acceptance"]);

export function TaskDetail({
  task,
  allTasks,
  onTaskUpdate,
  onDeleted,
  onOpenTask,
  onHandoff,
  initialReviewOpen = false,
  onReviewOpenChange,
  inspectorMode = "page",
  inspectorToggleTarget = null,
  terminalToggle,
  notify,
}: {
  task: Task;
  allTasks: TaskListItem[];
  onTaskUpdate: (task: Task) => void;
  onDeleted: (taskId: string) => void;
  onOpenTask: (taskId: string) => void;
  onHandoff?: (task: Task) => void;
  initialReviewOpen?: boolean;
  onReviewOpenChange?: (open: boolean) => void;
  inspectorMode?: "page" | "drawer";
  inspectorToggleTarget?: HTMLElement | null;
  terminalToggle?: ReactNode;
  notify: (message: string) => void;
}) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [busy, setBusy] = useState(false);
  // 共享项目里动别人的任务会换执行器 —— 起轮之前先确认(§八)。自用模式恒不弹。
  const { confirmRun, dialog: executorDowngradeDialog } = useExecutorDowngradeConfirm(task.id);
  const [reviewOpen, setReviewOpen] = useState(initialReviewOpen);
  // 中间那一栏同一时刻只放一样东西：会话 / 审查工作区 / 文件 / 工作区 diff。
  const [openFilePath, setOpenFilePath] = useState<string | null>(null);
  const [openScmDiff, setOpenScmDiff] = useState<ScmDiffTarget | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [postMergeDialogOpen, setPostMergeDialogOpen] = useState(false);
  const [derivation, setDerivation] = useState<{
    command: TaskDerivationCommand;
    committed: boolean;
  } | null>(null);
  const [derivationResetKey, setDerivationResetKey] = useState(0);
  // 刚发出去的那一回合由谁跑。会话行一落库就由它接管(见 runActivityExecutor),
  // 这里只补中间那一两秒;任务停下来就作废,免得下一次「运行」照抄旧目标。
  const [pendingExecutor, setPendingExecutor] = useState<string | null>(null);
  const { indicatorForTask } = useTaskReadState(allTasks, task.id);
  const conversation = useConversation(task.id);
  // 审查链状态同时服务验收后快照入口和会话尾栏的异常回合重试；共享一份缓存与订阅。
  const free = useFreeWorkflowState(task.id, task.workflowMode === "free");
  const followUps = useMemo(
    () => conversation.items.flatMap((item) => (
      item.kind === "user" && isUserFollowUp(item)
        ? [{ text: item.text, attachments: item.attachments, ...(item.at ? { at: item.at } : {}) }]
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
  // 接力入口:已接力出去的任务在本机是存档,除非那次还悬着(可以撤/重试)。
  const canHandoff = task.mode === "single" && task.parentId === null && !task.archived && task.queueId == null
    && (task.handoff?.direction !== "out" || !!task.handoff.pending);
  const handedOut = task.handoff?.direction === "out" && !task.handoff.pending;
  // 与 FreeWorkflowToolbar 自己的判据一致:两处都得知道这一条 rail 里到底有没有东西,
  // 空的时候不能给 ReplyBox 挂 has-top-rail(那会白留一条内边距)。
  const freeToolbarVisible = task.workflowMode === "free" && task.mode === "single"
    && !task.parentId && !task.reviewOf;
  const reviewFocused = REVIEW_FOCUS_STAGES.has(task.stage ?? "")
    || allTasks.some((candidate) => candidate.reviewOf === task.id);
  const inspectorPolicy = useMemo(() => ({
    stateKey: `single:all-tabs-v2:${task.status}:${reviewFocused ? "review" : "info"}`,
    requiredTabId: "info",
    defaultOpenTabIds: ["info", "files", "scm", "workflow", "review"],
    defaultActiveTabId: reviewFocused ? "review" : "info",
  }), [reviewFocused, task.status]);

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
    setDeleteOpen(false);
    setPostMergeDialogOpen(false);
    setDerivation(null);
    setOpenFilePath(null);
    setOpenScmDiff(null);
  }, [initialReviewOpen, task.id]);
  // 换任务一律作废(别把上一个任务的目标念到这一个头上);同一个任务停下来也作废,
  // 免得下一次「运行」照抄旧目标。
  useEffect(() => setPendingExecutor(null), [task.id]);
  useEffect(() => {
    if (task.status !== "running" && task.status !== "queued") setPendingExecutor(null);
  }, [task.status]);

  const changeReviewOpen = (open: boolean) => {
    setReviewOpen(open);
    if (open) {
      setOpenFilePath(null);
      setOpenScmDiff(null);
    }
    onReviewOpenChange?.(open);
  };

  const closeDerivation = () => {
    setDerivation(null);
    setDerivationResetKey((current) => current + 1);
  };

  const refreshTask = async () => {
    const updated = await api.task(task.id);
    onTaskUpdate(updated);
    return updated;
  };

  const patch = async (value: Partial<Task>) => {
    const updated = await api.patchTask(task.id, value);
    onTaskUpdate(updated);
  };

  const perform = async (action: Exclude<PrimaryAction, null>) => {
    if (action === "accept") return changeReviewOpen(true);
    // 会起一轮的动作先过「换执行器」确认闸(§八)。stop / unarchive 不起轮,不问。
    if ((action === "run" || action === "retry") && !(await confirmRun())) return;
    setBusy(true);
    try {
      if (action === "run") await api.runTask(task.id);
      if (action === "retry") await api.retryTask(task.id);
      if (action === "stop") await api.stopTask(task.id);
      if (action === "unarchive") onTaskUpdate(await api.unarchiveTask(task.id));
      else await refreshTask();
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    setBusy(true);
    try {
      onTaskUpdate(task.archived ? await api.unarchiveTask(task.id) : await api.archiveTask(task.id));
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
    <InspectorHost
      contextKey={inspectorContextKey}
      descriptors={TASK_INSPECTORS}
      context={{
        task,
        groups,
        sessions: conversation.sessions,
        allTasks,
        followUps,
        onOpenTask,
        onOpenReview: () => changeReviewOpen(true),
        onTaskUpdated: onTaskUpdate,
        onPatch: patch,
        onQueueChanged: (updatedTask) => {
          if (updatedTask) onTaskUpdate(updatedTask);
          else void refreshTask();
        },
        openFilePath,
        onOpenFile: (path: string) => {
          setOpenFilePath(path);
          setOpenScmDiff(null);
          if (reviewOpen) changeReviewOpen(false);
        },
        openScmDiff,
        onOpenScmDiff: (target: ScmDiffTarget) => {
          setOpenScmDiff(target);
          setOpenFilePath(null);
          if (reviewOpen) changeReviewOpen(false);
        },
        notify,
      }}
      defaultVisible={inspectorMode === "page"}
      tabPolicy={inspectorPolicy}
    >
      {({ toggleButton, openTab }) => (
        <>
          <div className="task-detail">
            <OriginTaskBar task={task} allTasks={allTasks} onOpen={onOpenTask} />
            <TaskHeader
              task={task}
              conversationMarkdown={markdown}
              busy={busy}
              refreshing={conversation.refreshing}
              reviewOpen={reviewOpen}
              onTitle={(title) => patch({ title, autoTitle: false })}
              onTogglePin={() => patch({ pinnedAt: task.pinnedAt != null ? null : Date.now() })}
              onPrimary={(action) => void perform(action)}
              onRequeue={() => void requeue()}
              onArchive={() => void archive()}
              onRefresh={() => void refresh()}
              onReview={() => changeReviewOpen(!reviewOpen)}
              postMergeReviewLabel={postMergeReviewLabel}
              onPostMergeReview={postMergeTarget ? () => {
                if (latestPostMerge?.status === "reviewing") openTab("review");
                else setPostMergeDialogOpen(true);
              } : undefined}
              onDelete={() => setDeleteOpen(true)}
              indicatorForTask={indicatorForTask}
              terminalToggle={terminalToggle}
              inspectorToggle={inspectorMode === "drawer" && inspectorToggleTarget ? undefined : toggleButton}
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
            {reviewOpen ? (
              <TaskReviewWorkspace
                task={task}
                allTasks={allTasks}
                onTaskUpdated={onTaskUpdate}
                notify={notify}
                onPostMergeReview={postMergeTarget ? () => {
                  if (latestPostMerge?.status === "reviewing") openTab("review");
                  else setPostMergeDialogOpen(true);
                } : undefined}
              />
            ) : openFilePath ? (
              <FileViewer
                taskId={task.id}
                path={openFilePath}
                onClose={() => setOpenFilePath(null)}
                notify={notify}
              />
            ) : openScmDiff ? (
              <ScmDiffViewer
                taskId={task.id}
                path={openScmDiff.path}
                source={openScmDiff.source}
                origPath={openScmDiff.origPath}
                onClose={() => setOpenScmDiff(null)}
              />
            ) : (
              <div className="task-detail-body">
                <section className="task-detail-main" aria-label="任务会话">
                  <ConversationFeed
                    task={task}
                    items={conversation.items}
                    sessions={conversation.sessions}
                    pendingExecutor={pendingExecutor}
                    loading={conversation.refreshing}
                    error={conversation.error}
                    onRetryTurn={async (target) => {
                      try {
                        if (!(await confirmRun())) return;
                        const result = await api.retryTurn(task.id, target.sessionId);
                        notify(result.mode === "review"
                          ? "已重跑这一轮审查"
                          : result.mode === "resend" ? "已重发上一条指令，任务续跑中" : "已从中断处续跑");
                        // 只重取会话正文。任务本身的 running 由 SSE 推过来 —— 这里再补一发
                        // GET，回来的很可能还是重投前的 done，反手把跑起来的状态盖回去
                        // （WorkspaceShell 按 onTaskUpdate 覆盖，没有版本门禁）。
                        await conversation.refetch();
                      } catch (reason) {
                        notify(reason instanceof Error ? reason.message : String(reason));
                      }
                    }}
                    reviewRetryable={freeReviewRetryable(free.state?.reviews)}
                    reviews={free.state?.reviews}
                    footer={task.question ? (
                      <QuestionCard
                        task={task}
                        onAnswer={async (answer) => {
                          await api.answerTask(task.id, answer);
                          notify("已发送答复，任务正在续跑");
                        }}
                      />
                    ) : undefined}
                  />
                  <DerivedTaskLinks sourceTaskId={task.id} allTasks={allTasks} onOpen={onOpenTask} />
                  {!handedOut && <ReplyBox
                    task={task}
                    hasConversation={hasConversation}
                    topRail={freeToolbarVisible || canHandoff
                      ? (
                        <TaskReplyRail
                          task={task}
                          freeToolbar={freeToolbarVisible}
                          canHandoff={canHandoff}
                          onHandoff={() => onHandoff?.(task)}
                          notify={notify}
                        />
                      )
                      : undefined}
                    skills={skills.skills}
                    onSend={async (text, attachments, { executorLabel, ...options }) => {
                      if (!(await confirmRun())) return null;
                      const result = await api.replyTask(task.id, text, { attachments, ...options });
                      // 按**结果**分支而不是按请求参数:任务正在跑时后端会把这条落成
                      // 排队消息(前端没传 sendAt 也一样)。没真发出去就绝不能先贴进会话,
                      // 否则用户看到自己的话已在时间线上、agent 却还没收到。
                      if ("scheduled" in result) {
                        notify(result.message.mode === "queued"
                          ? "任务进行中，已排队；这一轮结束后自动发出"
                          : `已安排 ${new Date(result.message.sendAt).toLocaleString()} 发送`);
                        return result;
                      }
                      // 这一轮真发出去了,横幅先按这个名字报,等会话行落库再由它接管。
                      setPendingExecutor(executorLabel ?? null);
                      conversation.addUser(text, attachments);
                      notify(options.agent
                        ? `已召唤 @${options.agent}${options.model ? ` · ${options.model}` : ""}${options.reasoningEffort ? ` · ${options.reasoningEffort}` : ""} 继续任务`
                        : "回复已发送");
                      return result;
                    }}
                    command={derivationAllowed ? {
                      matches: isTaskDerivationCommand,
                      items: TASK_DERIVATION_COMMANDS,
                      resetKey: derivationResetKey,
                      onSubmit: (text) => {
                        const parsed = parseTaskDerivationCommand(text);
                        if (parsed) setDerivation({ command: parsed, committed: true });
                      },
                      onChange: (text) => {
                        setDerivation((current) => {
                          if (current?.committed) return current;
                          const parsed = parseTaskDerivationCommand(text);
                          return parsed ? { command: parsed, committed: false } : null;
                        });
                      },
                      onCancel: closeDerivation,
                    } : undefined}
                    inlinePanel={derivationAllowed && derivation ? (
                      <TaskDerivationComposer
                        key={derivation.command.kind}
                        task={task}
                        command={derivation.command}
                        live={!derivation.committed}
                        onClose={closeDerivation}
                        onCreated={(created) => {
                          onTaskUpdate(created);
                          onOpenTask(created.id);
                        }}
                        notify={notify}
                      />
                    ) : undefined}
                  />}
                </section>
              </div>
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
            {executorDowngradeDialog}
          </div>
          {inspectorMode === "drawer" && inspectorToggleTarget
            ? createPortal(toggleButton, inspectorToggleTarget)
            : null}
        </>
      )}
    </InspectorHost>
  );
}
