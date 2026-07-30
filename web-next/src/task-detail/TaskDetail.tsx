import { useEffect, useMemo, useState } from "react";
import type { Group, Task } from "@harness/shared";
import { api } from "../lib/api.ts";
import { useConversation } from "../lib/useConversation.ts";
import { conversationToMarkdown } from "./conversationModel.ts";
import { ConversationFeed } from "./ConversationFeed.tsx";
import { DeleteTaskDialog } from "./DeleteTaskDialog.tsx";
import { QuestionCard } from "./QuestionCard.tsx";
import { ReplyBox } from "./ReplyBox.tsx";
import { TaskHeader, type PrimaryAction } from "./TaskHeader.tsx";
import { TaskInspector } from "./TaskInspector.tsx";
import { TaskReviewWorkspace } from "../review/TaskReviewWorkspace.tsx";

export function TaskDetail({
  task,
  allTasks,
  onTaskUpdate,
  onDeleted,
  notify,
}: {
  task: Task;
  allTasks: Task[];
  onTaskUpdate: (task: Task) => void;
  onDeleted: (taskId: string) => void;
  notify: (message: string) => void;
}) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [busy, setBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const conversation = useConversation(task.id);
  const markdown = useMemo(
    () => conversationToMarkdown(conversation.items, task),
    [conversation.items, task],
  );
  const hasConversation = conversation.sessions.length > 0 || conversation.items.length > 0;

  useEffect(() => {
    let alive = true;
    api.groups(task.projectId).then((rows) => { if (alive) setGroups(rows); }).catch(() => undefined);
    return () => { alive = false; };
  }, [task.projectId]);
  useEffect(() => {
    setReviewOpen(false);
    setDeleteOpen(false);
  }, [task.id]);

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
    if (action === "accept") return setReviewOpen(true);
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

  return (
    <div className="task-detail">
      <TaskHeader
        task={task}
        conversationMarkdown={markdown}
        busy={busy}
        refreshing={conversation.refreshing}
        onTitle={(title) => patch({ title, autoTitle: false })}
        onPrimary={(action) => void perform(action)}
        onArchive={() => void archive()}
        onRefresh={() => void refresh()}
        onReview={() => setReviewOpen((open) => !open)}
        onDelete={() => setDeleteOpen(true)}
        notify={notify}
      />
      {reviewOpen ? (
        <TaskReviewWorkspace task={task} allTasks={allTasks} onClose={() => setReviewOpen(false)} onTaskUpdated={onTaskUpdate} notify={notify} />
      ) : <div className="task-detail-body">
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
        <TaskInspector
          task={task}
          groups={groups}
          sessions={conversation.sessions}
          allTasks={allTasks}
          onPatch={patch}
          onQueueChanged={() => void refreshTask()}
          notify={notify}
        />
      </div>}
      {deleteOpen && (
        <DeleteTaskDialog
          task={task}
          notify={notify}
          onDeleted={() => onDeleted(task.id)}
          onClose={() => setDeleteOpen(false)}
        />
      )}
    </div>
  );
}
