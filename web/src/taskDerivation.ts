import type { Session, Task } from "@harness/shared";
import { STATUS_META } from "./constants";

export type TaskDerivationKind = "team" | "pair";

export type TaskDerivationCommand = {
  kind: TaskDerivationKind;
  note: string;
};

const DERIVATION_COMMAND = /^\/(team|pair)\b/i;

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

export function defaultPairTopic(task: Task, supplement: string): string {
  const title = task.title.trim() || "当前任务";
  const base = `围绕任务「${title}」的目标与当前进展，比较可行方案、关键风险和下一步，并形成可验证的结论。`;
  return supplement.trim() ? `${base}\n\n补充关注：${supplement.trim()}` : base;
}

export function sourceWorktreeBranch(task: Task): string | null {
  return task.useWorktree ? `harness/${task.id.slice(0, 8)}` : null;
}

// 派生卡片没有 worktree 开关，属于「未显式指定」的创建路径：payload 里省略
// useWorktree，让 createTasks 单点按全局 worktreeDefault 决定；这里只算 base
// 和展示用的预判(`on`)。worktreeBase 在 worktree 最终关闭时由服务端清空。
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
      : "请以这个普通任务为背景展开对抗式讨论；两位辩手先核对已有目标与进展，再比较方案并给出可验证结论。",
    "",
    "## 来源普通任务",
    `任务标题：${task.title}`,
    task.body.trim() || "（原任务未填写正文）",
    "",
    "## 当前状态",
    `来源任务当前为「${STATUS_META[task.status].label}」；创建本任务不会改变来源任务的状态。`,
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
    lines.push("", kind === "pair" ? "## 用户附言（本次辩题）" : "## 用户附言", note);
  }

  lines.push("", `来源任务 ID（仅供溯源）：${task.id}`);
  return lines.join("\n");
}
