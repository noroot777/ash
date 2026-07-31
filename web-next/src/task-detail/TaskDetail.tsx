import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { Group, Session, Task } from "@harness/shared";
import { Info, MagnifyingGlass } from "@phosphor-icons/react";
import { InspectorHost, type InspectorDescriptor } from "../inspector/index.ts";
import { api } from "../lib/api.ts";
import { useConversation } from "../lib/useConversation.ts";
import { useTaskReadState } from "../lib/useTaskReadState.ts";
import { conversationToMarkdown } from "./conversationModel.ts";
import { ConversationFeed } from "./ConversationFeed.tsx";
import { DeleteTaskDialog } from "./DeleteTaskDialog.tsx";
import { QuestionCard } from "./QuestionCard.tsx";
import { ReplyBox } from "./ReplyBox.tsx";
import { TaskHeader, type PrimaryAction } from "./TaskHeader.tsx";
import { TaskInspector } from "./TaskInspector.tsx";
import { TaskReviewInspector } from "./TaskReviewInspector.tsx";
import { TaskReviewWorkspace } from "../review/TaskReviewWorkspace.tsx";
import { OriginTaskBar } from "../components/TaskOrigin.tsx";

interface TaskInspectorContext {
  task: Task;
  groups: Group[];
  sessions: Session[];
  allTasks: Task[];
  onOpenTask: (taskId: string) => void;
  onOpenReview: () => void;
  onPatch: (patch: Partial<Task>) => Promise<void>;
  onQueueChanged: () => void;
  notify: (message: string) => void;
}

const TASK_INSPECTORS: readonly InspectorDescriptor<TaskInspectorContext>[] = [
  {
    id: "info",
    title: "信息",
    icon: <Info size={14} />,
    defaultOpen: true,
    render: (context) => <TaskInspector {...context} />,
  },
  {
    id: "review",
    title: "审查",
    icon: <MagnifyingGlass size={14} />,
    render: (context) => <TaskReviewInspector {...context} />,
  },
];

const REVIEW_FOCUS_STAGES = new Set(["verifying", "verified", "verify_failed", "awaiting_acceptance"]);

export function TaskDetail({
  task,
  allTasks,
  onTaskUpdate,
  onDeleted,
  onOpenTask,
  initialReviewOpen = false,
  onReviewOpenChange,
  inspectorMode = "page",
  inspectorToggleTarget = null,
  notify,
}: {
  task: Task;
  allTasks: Task[];
  onTaskUpdate: (task: Task) => void;
  onDeleted: (taskId: string) => void;
  onOpenTask: (taskId: string) => void;
  initialReviewOpen?: boolean;
  onReviewOpenChange?: (open: boolean) => void;
  inspectorMode?: "page" | "drawer";
  inspectorToggleTarget?: HTMLElement | null;
  notify: (message: string) => void;
}) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [busy, setBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(initialReviewOpen);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const { indicatorForTask } = useTaskReadState(allTasks, task.id);
  const conversation = useConversation(task.id);
  const markdown = useMemo(
    () => conversationToMarkdown(conversation.items, task),
    [conversation.items, task],
  );
  const hasConversation = conversation.sessions.length > 0 || conversation.items.length > 0;
  const reviewFocused = REVIEW_FOCUS_STAGES.has(task.stage ?? "")
    || allTasks.some((candidate) => candidate.reviewOf === task.id);
  const inspectorPolicy = useMemo(() => ({
    stateKey: `single:${task.status}:${reviewFocused ? "review" : "info"}`,
    requiredTabId: "info",
    defaultOpenTabIds: reviewFocused ? ["info", "review"] : ["info"],
    defaultActiveTabId: reviewFocused ? "review" : "info",
  }), [reviewFocused, task.status]);

  useEffect(() => {
    let alive = true;
    api.groups(task.projectId).then((rows) => { if (alive) setGroups(rows); }).catch(() => undefined);
    return () => { alive = false; };
  }, [task.projectId]);
  useEffect(() => {
    setReviewOpen(initialReviewOpen);
    setDeleteOpen(false);
  }, [initialReviewOpen, task.id]);

  const changeReviewOpen = (open: boolean) => {
    setReviewOpen(open);
    onReviewOpenChange?.(open);
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
        onOpenTask,
        onOpenReview: () => changeReviewOpen(true),
        onPatch: patch,
        onQueueChanged: () => void refreshTask(),
        notify,
      }}
      defaultVisible={inspectorMode === "page"}
      tabPolicy={inspectorPolicy}
    >
      {({ toggleButton }) => (
        <>
          <div className="task-detail">
            <OriginTaskBar task={task} allTasks={allTasks} onOpen={onOpenTask} />
            <TaskHeader
              task={task}
              conversationMarkdown={markdown}
              busy={busy}
              refreshing={conversation.refreshing}
              onTitle={(title) => patch({ title, autoTitle: false })}
              onTogglePin={() => patch({ pinnedAt: task.pinnedAt != null ? null : Date.now() })}
              onPrimary={(action) => void perform(action)}
              onArchive={() => void archive()}
              onRefresh={() => void refresh()}
              onReview={() => changeReviewOpen(!reviewOpen)}
              onDelete={() => setDeleteOpen(true)}
              indicatorForTask={indicatorForTask}
              inspectorToggle={inspectorMode === "drawer" && inspectorToggleTarget ? undefined : toggleButton}
              notify={notify}
            />
            {reviewOpen ? (
              <TaskReviewWorkspace task={task} allTasks={allTasks} onClose={() => changeReviewOpen(false)} onTaskUpdated={onTaskUpdate} notify={notify} />
            ) : (
              <div className="task-detail-body">
                <section className="task-detail-main" aria-label="任务会话">
                  <ConversationFeed
                    taskId={task.id}
                    taskBody={task.body}
                    items={conversation.items}
                    loading={conversation.refreshing}
                    error={conversation.error}
                    footer={task.question ? (
                      <QuestionCard
                        task={task}
                        onAnswer={async (answer) => {
                          await api.answerTask(task.id, answer);
                          conversation.addUser(answer);
                          notify("已发送答复，任务正在续跑");
                        }}
                      />
                    ) : undefined}
                  />
                  <ReplyBox
                    task={task}
                    hasConversation={hasConversation}
                    onSend={async (text, attachments) => {
                      await api.replyTask(task.id, text, { attachments });
                      conversation.addUser(text, attachments);
                      notify("回复已发送");
                    }}
                  />
                </section>
              </div>
            )}
            {deleteOpen && (
              <DeleteTaskDialog
                task={task}
                notify={notify}
                onDeleted={() => onDeleted(task.id)}
                onClose={() => setDeleteOpen(false)}
              />
            )}
          </div>
          {inspectorMode === "drawer" && inspectorToggleTarget
            ? createPortal(toggleButton, inspectorToggleTarget)
            : null}
        </>
      )}
    </InspectorHost>
  );
}
