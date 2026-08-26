import type { Task } from "@ash/shared";
import type { ConversationItem } from "./conversationModel.ts";
import { formatInstant, parseAttachmentText } from "./utils.ts";

export function conversationToMarkdown(items: ConversationItem[], task: Task): string {
  const parts = [`# ${task.title || "未命名任务"}`];
  if (task.body.trim()) parts.push(`> ${task.body.trim().replace(/\n/g, "\n> ")}`);
  for (const item of items) {
    if (item.kind === "event") {
      parts.push(`_${item.text}${item.at ? ` · ${formatInstant(item.at)}` : ""}_`);
      continue;
    }
    if (item.kind === "user") {
      const parsed = parseAttachmentText(item.text);
      const paths = [...parsed.paths, ...item.attachments];
      const body = [parsed.body, ...paths.map((path) => `- ${path}`)].filter(Boolean).join("\n");
      if (body) parts.push(`## ${item.bySystem ? "系统" : "你"}${item.at ? ` · ${formatInstant(item.at)}` : ""}\n\n${body}`);
      continue;
    }
    const body = item.markdown.trim();
    const who = item.reviewer
      ? `${item.label}（审查者${item.reviewer.round ? ` · 第 ${item.reviewer.round} 轮` : ""}）`
      : item.label;
    if (body) parts.push(`## ${who}${item.at ? ` · ${formatInstant(item.at)}` : ""}\n\n${body}`);
  }
  return `${parts.join("\n\n")}\n`;
}
