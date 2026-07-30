import { useEffect, useMemo, useState } from "react";
import type { Group, Task } from "@harness/shared";
import { api } from "../lib/api.ts";
import { useConversation } from "../lib/useConversation.ts";
import { conversationToMarkdown } from "./conversationModel.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { ConversationFeed } from "./ConversationFeed.tsx";
import { DeleteTaskDialog } from "./DeleteTaskDialog.tsx";
import { QuestionCard } from "./QuestionCard.tsx";
import { ReplyBox } from "./ReplyBox.tsx";
import { TaskHeader, type PrimaryAction } from "./TaskHeader.tsx";
import { TaskInspector } from "./TaskInspector.tsx";

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
  const [acceptOpen, setAcceptOpen] = useState(false);
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
    if (action === "accept") return setAcceptOpen(true);
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

  const accept = async () => {
    setBusy(true);
    try {
      const result = await api.acceptTask(task.id);
      if (!result.accepted) {
        notify(`验收未完成：${result.error}`);
        return;
      }
      await refreshTask();
      notify(result.warnings?.length ? `验收通过，但有 ${result.warnings.length} 条清理警告` : "验收通过");
      setAcceptOpen(false);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const acceptMessage = task.mode === "team"
    ? "这会确认团队整体结果；使用共享 worktree 时会合并共享分支并清理团队 worktree。已执行的合并和删除不可逆。"
    : task.useWorktree
      ? `任务分支将合并回 ${task.worktreeBase || "项目当前分支"}，随后清理任务 worktree 与分支。已执行的合并和删除不可逆。`
      : "这会确认当前项目工作区中的结果，并把任务阶段标记为已验收。";

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
        onDelete={() => setDeleteOpen(true)}
        notify={notify}
      />
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
        <TaskInspector
          task={task}
          groups={groups}
          sessions={conversation.sessions}
          allTasks={allTasks}
          onPatch={patch}
          onQueueChanged={() => void refreshTask()}
          notify={notify}
        />
      </div>
      {acceptOpen && (
        <ConfirmDialog
          title="确认验收通过？"
          message={acceptMessage}
          confirmLabel="验收通过"
          busy={busy}
          danger={!!task.useWorktree}
          onConfirm={() => void accept()}
          onClose={() => setAcceptOpen(false)}
        />
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
  );
}
