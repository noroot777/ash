import { useEffect, useMemo, useState } from "react";
import type { Group, Task } from "@harness/shared";
import { api } from "../lib/api.ts";
import { useConversation } from "../lib/useConversation.ts";
import { conversationToMarkdown } from "./conversationModel.ts";
import { ConversationFeed } from "./ConversationFeed.tsx";
import { DeleteTaskDialog } from "./DeleteTaskDialog.tsx";
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
import { TaskReviewWorkspace } from "../review/TaskReviewWorkspace.tsx";
import { OriginTaskBar } from "../components/TaskOrigin.tsx";

export function TaskDetail({
  task,
  allTasks,
  onTaskUpdate,
  onDeleted,
  onOpenTask,
  initialReviewOpen = false,
  onReviewOpenChange,
  notify,
}: {
  task: Task;
  allTasks: Task[];
  onTaskUpdate: (task: Task) => void;
  onDeleted: (taskId: string) => void;
  onOpenTask: (taskId: string) => void;
  initialReviewOpen?: boolean;
  onReviewOpenChange?: (open: boolean) => void;
  notify: (message: string) => void;
}) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [busy, setBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(initialReviewOpen);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [derivation, setDerivation] = useState<{
    command: TaskDerivationCommand;
    committed: boolean;
  } | null>(null);
  const [derivationResetKey, setDerivationResetKey] = useState(0);
  const conversation = useConversation(task.id);
  const markdown = useMemo(
    () => conversationToMarkdown(conversation.items, task),
    [conversation.items, task],
  );
  const hasConversation = conversation.sessions.length > 0 || conversation.items.length > 0;
  const derivationAllowed = canDeriveTask(task);

  useEffect(() => {
    let alive = true;
    api.groups(task.projectId).then((rows) => { if (alive) setGroups(rows); }).catch(() => undefined);
    return () => { alive = false; };
  }, [task.projectId]);
  useEffect(() => {
    setReviewOpen(initialReviewOpen);
    setDeleteOpen(false);
    setDerivation(null);
  }, [initialReviewOpen, task.id]);

  const changeReviewOpen = (open: boolean) => {
    setReviewOpen(open);
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

  return (
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
        onRequeue={() => void requeue()}
        onArchive={() => void archive()}
        onRefresh={() => void refresh()}
        onReview={() => changeReviewOpen(!reviewOpen)}
        onDelete={() => setDeleteOpen(true)}
        notify={notify}
      />
      {reviewOpen ? (
        <TaskReviewWorkspace task={task} allTasks={allTasks} onClose={() => changeReviewOpen(false)} onTaskUpdated={onTaskUpdate} notify={notify} />
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
            onSend={async (text, attachments, options) => {
              const result = await api.replyTask(task.id, text, { attachments, ...options });
              if (options.sendAt) {
                notify(`已安排 ${new Date(options.sendAt).toLocaleString()} 发送`);
                return result;
              }
              conversation.addUser(text, attachments);
              notify(options.agent ? `已召唤 @${options.agent} 继续任务` : "回复已发送");
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
          />
        </section>
        <TaskInspector
          task={task}
          groups={groups}
          sessions={conversation.sessions}
          allTasks={allTasks}
          onOpenTask={onOpenTask}
          onPatch={patch}
          onQueueChanged={(updatedTask) => {
            if (updatedTask) onTaskUpdate(updatedTask);
            else void refreshTask();
          }}
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
