import type { Session, Task } from "@ash/shared";
import { TASK_STATUS_LABELS } from "@ash/shared";
import { taskBranchName, taskBranchNames } from "@ash/shared/task-branch";

// 回复框里「派出去」的新任务从这条任务的哪儿接着来：能不能派、从哪个分支开工、正文怎么带上这场对话。

export function canDeriveTask(task: Pick<Task, "parentId" | "reviewOf">): boolean {
  return task.parentId === null && !task.reviewOf;
}

/** 这条任务自己的分支：改名之前建的叫 `ash/<id8>`，在 `branches`（仓库现有分支）里找实际存在的那个，都不在就是当前名。 */
export function sourceWorktreeBranch(task: Pick<Task, "id" | "useWorktree">, branches: readonly string[]): string | null {
  if (!task.useWorktree) return null;
  return taskBranchNames(task.id).find((name) => branches.includes(name)) ?? taskBranchName(task.id);
}

function latestTranscriptPath(sessions: Session[]): string | null {
  return [...sessions]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map((session) => session.transcriptPath?.trim())
    .find(Boolean) ?? null;
}

/** 「这场对话」那几段：来源任务是什么、现在什么状态、完整会话在哪。 */
function sourceContextLines(task: Task, sessions: Session[], derived: string): string[] {
  const transcriptPath = latestTranscriptPath(sessions);
  const lines = [
    "## 来源普通任务",
    `任务标题：${task.title}`,
    task.body.trim() || "（原任务未填写正文）",
    "",
    "## 当前状态",
    `来源任务当前为「${TASK_STATUS_LABELS[task.status]}」；创建${derived}不会改变来源任务的状态。`,
  ];
  if (transcriptPath) {
    lines.push(
      "",
      "## 最新完整会话（执行前必读）",
      "执行前先用 Read 完整读完以下会话记录，再开始讨论或拆解工作。",
      `最新会话记录：\`${transcriptPath}\``,
    );
  }
  return lines;
}

/**
 * 回复框里「派出去」的新任务正文：用户写的那句话就是这条任务要做的事，排在最前；后面是它从哪来、
 * 那场对话在哪。
 */
export function buildDispatchBody(task: Task, sessions: Session[], ask: string): string {
  return [
    ask.trim(),
    "",
    "---",
    "这件事是从另一条任务的对话里派出来的。先读完下面的背景再动手；那条任务的目标与进展是背景，你要做成的是上面这件事。",
    "",
    ...sourceContextLines(task, sessions, "这条任务"),
    "",
    `来源任务 ID（仅供溯源）：${task.id}`,
  ].join("\n");
}
