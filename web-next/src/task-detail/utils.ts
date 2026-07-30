import type { Task, TaskStatus } from "@harness/shared";

export const STATUS_TONES: Record<TaskStatus | "awaiting_answer", string> = {
  awaiting_answer: "cyan",
  backlog: "muted",
  queued: "amber",
  running: "green",
  idle: "muted",
  awaiting_review: "amber",
  paused: "cyan",
  done: "green",
  failed: "red",
  canceled: "muted",
};

export const PRIORITY_LABELS: Record<Task["priority"], string> = {
  none: "无",
  low: "低",
  medium: "中",
  high: "高",
  urgent: "紧急",
};

export function formatInstant(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const two = (number: number) => String(number).padStart(2, "0");
  return `${two(date.getMonth() + 1)}/${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

export function formatDuration(milliseconds: number): string {
  let seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  if (days) return `${days}d ${hours}h ${minutes}m`;
  if (hours) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function durationBetween(from?: string | null, to?: string | null): string | null {
  if (!from || !to) return null;
  const start = Date.parse(from);
  const end = Date.parse(to);
  return Number.isFinite(start) && Number.isFinite(end) ? formatDuration(end - start) : null;
}

export type TaskDurationInfo = {
  label: "用时" | "跨度";
  text: string;
  title?: string;
};

export function taskDurationInfo(task: Task, now = Date.now()): TaskDurationInfo | null {
  if (!task.startedAt) return null;
  const endTitle = task.endedAt ? `结束 ${formatInstant(task.endedAt)}` : undefined;
  if (typeof task.activeMs === "number") {
    const liveStart = task.liveSince && !task.endedAt ? Date.parse(task.liveSince) : NaN;
    const live = Number.isFinite(liveStart) ? Math.max(0, now - liveStart) : 0;
    return { label: "用时", text: formatDuration(task.activeMs + live), title: endTitle };
  }
  const start = Date.parse(task.startedAt);
  const end = task.endedAt ? Date.parse(task.endedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (task.activeMs === undefined) {
    return { label: "用时", text: formatDuration(end - start), title: endTitle };
  }
  return {
    label: "跨度",
    text: formatDuration(end - start),
    title: `${endTitle ? `${endTitle} · ` : ""}跨度含等待回复的空闲，非纯执行时长`,
  };
}

const ATTACHMENT_HEADER = /^\s*\[用户附带的文件[^\]]*\]\s*$/;
const ATTACHMENT_PATH = /^\s*-\s+(.+?)\s*$/;
const IMAGE_EXT = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i;

export function parseAttachmentText(text: string): { body: string; paths: string[] } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const body: string[] = [];
  const paths: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!ATTACHMENT_HEADER.test(lines[index] ?? "")) {
      body.push(lines[index] ?? "");
      continue;
    }
    let cursor = index + 1;
    while (cursor < lines.length && !(lines[cursor] ?? "").trim()) cursor += 1;
    const block: string[] = [];
    while (cursor < lines.length) {
      const match = ATTACHMENT_PATH.exec(lines[cursor] ?? "");
      if (!match) break;
      block.push(match[1]!);
      cursor += 1;
    }
    if (!block.length) {
      body.push(lines[index] ?? "");
      continue;
    }
    paths.push(...block);
    index = cursor - 1;
  }
  return { body: body.join("\n").trim(), paths };
}

export function attachmentView(path: string): { name: string; url: string | null; image: boolean } {
  const normalized = path.trim().replaceAll("\\", "/");
  const name = normalized.split("/").filter(Boolean).pop() ?? normalized;
  const uploaded = /(?:^|\/)data\/uploads\/([^/]+)$/.exec(normalized)?.[1] ?? null;
  const url = uploaded ? `/api/uploads/${encodeURIComponent(uploaded)}` : null;
  const displayName = name.replace(/^[A-Za-z0-9_-]{12}-/, "") || name;
  return { name: displayName, url, image: !!url && IMAGE_EXT.test(uploaded ?? "") };
}

export function safeDownloadName(task: Task): string {
  return (task.title || task.id).replace(/[\\/:*?"<>|]/g, "_").slice(0, 80).trim() || "conversation";
}
