import type { Task } from "@ash/shared";

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

/**
 * 任务级时长：只留最高两个单位（`18h 18m`、`2d 3h`），第二个是 0 就连它一起省掉
 * （`10m`）。回合级时长照旧用 `formatDuration` —— 跑了几分零几秒在那里是有意义的，
 * 跑了十八小时零几秒在这里不是。
 */
export function formatDurationShort(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const units: [number, string][] = [
    [Math.floor(total / 86400), "d"],
    [Math.floor(total / 3600) % 24, "h"],
    [Math.floor(total / 60) % 60, "m"],
    [total % 60, "s"],
  ];
  const head = units.findIndex(([value]) => value > 0);
  if (head < 0) return "0s";
  const [value, unit] = units[head]!;
  const next = units[head + 1];
  return next && next[0] > 0 ? `${value}${unit} ${next[0]}${next[1]}` : `${value}${unit}`;
}

/** 执行区间：同一天只写一次日期（`10/27 13:20 → 14:05`），还没结束就写「起」。 */
export function formatInstantRange(from?: string | null, to?: string | null): string {
  const start = formatInstant(from);
  if (!start) return "";
  const end = formatInstant(to);
  if (!end) return `${start} 起`;
  return `${start} → ${start.slice(0, 5) === end.slice(0, 5) ? end.slice(6) : end}`;
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
  /** 只有「跨度」才有的口径说明。起止时刻已经摆在明面上的表面拿它当 title，免得 hover 一下只换来一遍已经看得见的结束时间。 */
  note?: string;
};

export function taskDurationInfo(task: Task, now = Date.now()): TaskDurationInfo | null {
  if (!task.startedAt) return null;
  const endTitle = task.endedAt ? `结束 ${formatInstant(task.endedAt)}` : undefined;
  if (typeof task.activeMs === "number") {
    const liveStart = task.liveSince && !task.endedAt ? Date.parse(task.liveSince) : NaN;
    const live = Number.isFinite(liveStart) ? Math.max(0, now - liveStart) : 0;
    return { label: "用时", text: formatDurationShort(task.activeMs + live), title: endTitle };
  }
  const start = Date.parse(task.startedAt);
  const end = task.endedAt ? Date.parse(task.endedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (task.activeMs === undefined) {
    return { label: "用时", text: formatDurationShort(end - start), title: endTitle };
  }
  const note = "跨度含等待回复的空闲，非纯执行时长";
  return {
    label: "跨度",
    text: formatDurationShort(end - start),
    title: `${endTitle ? `${endTitle} · ` : ""}${note}`,
    note,
  };
}

const IMAGE_EXT = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i;

/** 这个路径/URL 指向图片吗（查询串与 #hash 不参与判断）。判定单点，别再另写一份后缀表。 */
export function isImagePath(path: string): boolean {
  return IMAGE_EXT.test(path.split(/[?#]/)[0] ?? "");
}

// 解析逻辑搬进了 shared（server 读「最后一条消息」时要用同一份），这里只转出去，
// 免得所有调用点跟着改 import。
export { parseAttachmentText } from "@ash/shared/attachments";

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
