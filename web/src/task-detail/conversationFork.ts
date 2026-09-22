import type { Task } from "@ash/shared";
import type { ConversationItem } from "./conversationModel.ts";
import { parseAttachmentText } from "./utils.ts";

export const FORK_BODY_MAX_BYTES = 128 * 1024;
const encoder = new TextEncoder();
const contextSizes = new WeakMap<ConversationFork, { context: string; bytes: number }>();
export function forkContextBytes(fork: ConversationFork): number {
  const cached = contextSizes.get(fork);
  if (cached?.context === fork.context) return cached.bytes;
  const bytes = encoder.encode(fork.context).length;
  contextSizes.set(fork, { context: fork.context, bytes });
  return bytes;
}
export function forkBodyProblem(fork: ConversationFork | undefined, instruction: string): string | null {
  if (!fork) return null;
  const bytes = forkContextBytes(fork) + encoder.encode(formatForkBody({ ...fork, context: "" }, instruction)).length;
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

/**
 * 这条回复能不能当派生的落点。
 *
 * 除了「说完了、且确实说了话」，还有两条排除：
 *
 * ① 这一轮得是**自己收的口**：被下一条引导打断的半截（`interrupted`）看着有结束时刻，
 *    其实话没说完 —— 派生带走的是截至这条回复的整份上下文，半截回复当落点就是把一句
 *    没说完的话当结论（用户 2026-09-16 报的）。
 * ② **审查者的发言不是落点**（用户 2026-09-22 报的）。审查轮是搭在任务上的旁路回合，
 *    它的产出是「这份产物有什么毛病」，不是一条能往下接着做的需求；从它派生出去，新任务
 *    拿到的上下文里最后一句是验证过程与结论，读起来像「继续验证」。审查没过本来就自动
 *    打回原任务修复（`repairPrompt`），合并结果审查另有「创建修复任务」的专用入口
 *    （`createPostMergeRepairTask`）—— 两条正路都不经过这颗按钮。
 */
export function canForkReply(item: ConversationItem): boolean {
  return item.kind === "agent" && !item.reviewer && !!item.endedAt && !item.interrupted && !!item.markdown.trim();
}

export function snapshotConversationFork(task: Task, items: ConversationItem[], replyId: string) {
  const cutoff = items.findIndex((item) => item.id === replyId);
  const reply = items[cutoff];
  if (!reply || reply.kind !== "agent" || !canForkReply(reply)) {
    throw new Error(reply?.kind === "agent" && reply.reviewer
      ? "审查轮的发言不能当派生落点：它是搭在本任务上的旁路回合，产出的是结论不是新需求。审查没过会自动打回本任务修复，请挑一条实现回合的回复再派生。"
      : reply?.kind === "agent" && reply.interrupted
        ? "这条回复被后面的引导打断了，不是完整的一轮，请挑一条说完的回复再派生。"
        : "这条回复尚未完成，请等回复结束后再派生。");
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
