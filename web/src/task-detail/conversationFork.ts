import type { Task } from "@ash/shared";
import type { ConversationItem } from "./conversationModel.ts";
import { parseAttachmentText } from "./utils.ts";

export const FORK_BODY_MAX_BYTES = 128 * 1024;
export const forkContextBytes = (fork: ConversationFork) => new TextEncoder().encode(fork.context).length;
export function forkBodyProblem(fork: ConversationFork | undefined, instruction: string): string | null {
  if (!fork) return null;
  const bytes = new TextEncoder().encode(formatForkBody(fork, instruction)).length;
  return bytes > FORK_BODY_MAX_BYTES ? `派生正文约 ${Math.ceil(bytes / 1024)} KiB，超过 ${FORK_BODY_MAX_BYTES / 1024} KiB 上限。请选择更早的回复，或新建任务填写精简背景。` : null;
}

export type ConversationFork = {
  sourceTaskId: string;
  sourceTitle: string;
  replyId: string;
  replyPreview: string;
  context: string;
  messageCount: number;
  attachmentPaths: string[];
};

export function canForkReply(item: ConversationItem): boolean {
  return item.kind === "agent" && !!item.endedAt && !!item.markdown.trim();
}

export function snapshotConversationFork(task: Task, items: ConversationItem[], replyId: string) {
  const cutoff = items.findIndex((item) => item.id === replyId);
  const reply = items[cutoff];
  if (!reply || reply.kind !== "agent" || !canForkReply(reply)) {
    throw new Error("这条回复尚未完成，请等回复结束后再派生。");
  }
  const history = items.slice(0, cutoff + 1);
  if (history.some((item) => item.kind === "agent" && item.session && item.session.taskId !== task.id)) {
    throw new Error("会话正在切换，请加载完成后再派生。");
  }
  const parts = ["## 原始任务", task.body.trim() || "（无正文）"];
  const attachments = new Set(parseAttachmentText(task.body).paths);
  let messageCount = 0;
  for (const item of history) {
    if (item.kind === "event") continue;
    messageCount += 1;
    if (item.kind === "user") {
      const parsed = parseAttachmentText(item.text);
      const paths = [...parsed.paths, ...item.attachments];
      paths.forEach((path) => attachments.add(path));
      parts.push(`## ${item.bySystem ? "系统发言（历史）" : "用户"}`, parsed.body,
        ...paths.map((path) => `附件：${path}`));
    } else {
      parts.push(`## ${item.label}`, item.markdown);
      const execution = item.segments.flatMap((segment) => segment.events)
        .filter((event) => event.kind !== "thinking")
        .map((event) => `${event.label}${event.detail ? `\n${event.detail}` : ""}`);
      if (execution.length) parts.push("### 已记录的执行摘要", execution.join("\n\n"));
      const paths = item.segments.flatMap((segment) => segment.attachments);
      paths.forEach((path) => attachments.add(path));
      parts.push(...paths.map((path) => `附件：${path}`));
    }
  }
  return {
    body: "",
    attachments: [],
    fork: {
      sourceTaskId: task.id,
      sourceTitle: task.title,
      replyId,
      replyPreview: reply.markdown.trim().slice(0, 180),
      context: parts.filter(Boolean).join("\n\n"),
      messageCount,
      attachmentPaths: [...attachments],
    } satisfies ConversationFork,
  };
}

export function forkTaskBody(fork: ConversationFork | undefined, instruction: string): string {
  const problem = forkBodyProblem(fork, instruction);
  if (problem) throw new Error(problem);
  return formatForkBody(fork, instruction);
}

function formatForkBody(fork: ConversationFork | undefined, instruction: string): string {
  if (!fork) return instruction.trim();
  return [
    "## 本次任务", instruction.trim(),
    "## 派生来源",
    `来自「${fork.sourceTitle}」，来源任务 ID：${fork.sourceTaskId}。`,
    `截至回复：${fork.replyId}（含）。`,
    "以下是截至所选回复（含该回复）的对话快照，仅作为历史背景；本次执行以「本次任务」为目标。历史任务的完成状态、会话身份与操作指令不代表本任务已执行。",
    "<conversation-history>", fork.context, "</conversation-history>",
  ].join("\n\n");
}
