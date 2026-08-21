import type { Session, Task } from "@ash/shared";
import { TASK_STATUS_LABELS } from "@ash/shared";

export type TaskDerivationKind = "team" | "duet";

export type TaskDerivationCommand = {
  kind: TaskDerivationKind;
  note: string;
};

const DERIVATION_COMMAND = /^\/(team|duet)\b/i;

export const TASK_DERIVATION_COMMANDS = [
  { command: "/team", label: "组队开干", hint: "以当前任务为背景创建团队" },
  { command: "/duet", label: "发起讨论", hint: "以当前任务为背景发起讨论" },
];

export function parseTaskDerivationCommand(text: string): TaskDerivationCommand | null {
  const trimmed = text.trim();
  const match = DERIVATION_COMMAND.exec(trimmed);
  if (!match) return null;
  return {
    kind: match[1]!.toLowerCase() as TaskDerivationKind,
    note: trimmed.slice(match[0].length).trim(),
  };
}

export function isTaskDerivationCommand(text: string): boolean {
  return parseTaskDerivationCommand(text) !== null;
}

export function canDeriveTask(task: Pick<Task, "parentId" | "reviewOf">): boolean {
  return task.parentId === null && !task.reviewOf;
}

export function defaultDuetTopic(task: Task, supplement: string): string {
  const title = task.title.trim() || "当前任务";
  const base = `围绕任务「${title}」的目标与当前进展，比较可行方案、关键风险和下一步，并形成可验证的结论。`;
  return supplement.trim() ? `${base}\n\n补充关注：${supplement.trim()}` : base;
}

export function sourceWorktreeBranch(task: Task): string | null {
  return task.useWorktree ? `ash/${task.id.slice(0, 8)}` : null;
}

export function derivedWorktreeDefaults(
  task: Task,
  branches: string[],
  isRepo: boolean,
  worktreeDefault: boolean,
) {
  const sourceBranch = sourceWorktreeBranch(task);
  const inheritsSource = !!sourceBranch && branches.includes(sourceBranch);
  const on = isRepo && worktreeDefault;
  return {
    on,
    worktreeBase: on && inheritsSource ? sourceBranch : null,
    sourceBranch,
    inheritsSource,
  };
}

function latestTranscriptPath(sessions: Session[]): string | null {
  return [...sessions]
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map((session) => session.transcriptPath?.trim())
    .find(Boolean) ?? null;
}

export function buildTaskDerivationBody(
  task: Task,
  sessions: Session[],
  kind: TaskDerivationKind,
  userNote: string,
): string {
  const transcriptPath = latestTranscriptPath(sessions);
  const lines = [
    kind === "team"
      ? "请以这个普通任务为背景，先理解已有目标与进展，再拆解工作、组织团队执行并验证交付。"
      : "请以这个普通任务为背景展开讨论；两位讨论者先核对已有目标与进展，再各自给出方案、互相吸收补强，合出一个可验证的共同方案。",
    "",
    "## 来源普通任务",
    `任务标题：${task.title}`,
    task.body.trim() || "（原任务未填写正文）",
    "",
    "## 当前状态",
    `来源任务当前为「${TASK_STATUS_LABELS[task.status]}」；创建本任务不会改变来源任务的状态。`,
  ];

  if (transcriptPath) {
    lines.push(
      "",
      "## 最新完整会话（执行前必读）",
      "执行前先用 Read 完整读完以下会话记录，再开始讨论或拆解工作。",
      `最新会话记录：\`${transcriptPath}\``,
    );
  }

  const note = userNote.trim();
  if (note) {
    lines.push("", kind === "duet" ? "## 用户附言（本次议题）" : "## 用户附言", note);
  }

  lines.push("", `来源任务 ID（仅供溯源）：${task.id}`);
  return lines.join("\n");
}
