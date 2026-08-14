import type { Task } from "@harness/shared";

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

const IMAGE_EXT = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i;

/** 这个路径/URL 指向图片吗（查询串与 #hash 不参与判断）。判定单点，别再另写一份后缀表。 */
export function isImagePath(path: string): boolean {
  return IMAGE_EXT.test(path.split(/[?#]/)[0] ?? "");
}

// 解析逻辑搬进了 shared（server 读「最后一条消息」时要用同一份），这里只转出去，
// 免得所有调用点跟着改 import。
export { parseAttachmentText } from "@harness/shared/attachments";

export function attachmentView(path: string): { name: string; url: string | null; image: boolean } {
  const normalized = path.trim().replaceAll("\\", "/");
  const name = normalized.split("/").filter(Boolean).pop() ?? normalized;
  const uploaded = /(?:^|\/)data\/uploads\/([^/]+)$/.exec(normalized)?.[1] ?? null;
  const url = uploaded ? `/api/uploads/${encodeURIComponent(uploaded)}` : null;
  const displayName = name.replace(/^[A-Za-z0-9_-]{12}-/, "") || name;
  return { name: displayName, url, image: !!url && isImagePath(uploaded ?? "") };
}

export function safeDownloadName(task: Task): string {
  return (task.title || task.id).replace(/[\\/:*?"<>|]/g, "_").slice(0, 80).trim() || "conversation";
}
