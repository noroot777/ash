import type { Task } from "@navi/shared";

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
  // 「同一天」必须回到真实日期上判，不能拿 formatInstant 的输出去比月日：那串里没有年份，
  // 去年今天开工、今天收工的任务会被压成「10/31 10:00 → 11:00」，看着像一小时跑完。
  const sameDay = new Date(from!).toDateString() === new Date(to!).toDateString();
  return `${start} → ${sameDay ? end.slice(6) : end}`;
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

export function taskDurationInfo(task: Pick<Task, "startedAt" | "endedAt" | "activeMs" | "liveSince">, now = Date.now()): TaskDurationInfo | null {
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

// 浏览器 `<video>` / `<audio>` 放得了的那几种（查看器据此摊播放器）。
const VIDEO_EXT = /\.(?:mp4|m4v|mov|webm|mkv|ogv)$/i;
const AUDIO_EXT = /\.(?:mp3|wav|m4a|aac|flac|ogg|opus|aiff)$/i;

export function isVideoPath(path: string): boolean {
  return VIDEO_EXT.test(path.split(/[?#]/)[0] ?? "");
}

export function isAudioPath(path: string): boolean {
  return AUDIO_EXT.test(path.split(/[?#]/)[0] ?? "");
}

// 解析逻辑搬进了 shared（server 读「最后一条消息」时要用同一份），这里只转出去，
// 免得所有调用点跟着改 import。
export { parseAttachmentText } from "@navi/shared/attachments";

/**
 * 这个站**自己服务**的那几条路径。`/` 开头的地址里只有它们是网址,其余都是磁盘路径。
 *
 * 为什么是「站内路由白名单」而不是「磁盘根白名单」:前者是我们自己的路由表,知道得全;
 * 后者是整个文件系统的顶层目录,`/System`、`/data`、`/app`、`/code`、`/projects` 都合法,
 * 列不全(审查第 1 轮 F3 —— 上一版照搬了 `localDiskPath` 的磁盘根白名单,于是容器里
 * `/app/output/x.png` 这类合法绝对路径在到达文件接口之前就被当成站内地址拒掉了)。
 * 猜错的代价也不对称:把站内地址当成磁盘路径,顶多多问一次服务端然后 404 收起;把磁盘
 * 路径当成站内地址,那张图就永远画不出来。
 */
export const SITE_ROUTE = /^\/(?:api|assets|review|mobile)(?:\/|$)/;

/**
 * 本机绝对路径(POSIX 根、盘符、反斜杠 UNC),分隔符归一成 `/`;不是就 null。
 *
 * 数据根里的资源(上传附件、验证证据)只能凭**绝对路径**认:站内地址(`/api/uploads/…`)已经
 * 是能直接用的 URL,再当文件名编码一遍就取不到了;相对路径属于引用它的那份文档(报告里的
 * `uploads/x.png` 是证据目录里那一张),不归数据根。
 */
export function absoluteDiskPath(path: string): string | null {
  const raw = path.trim();
  if (/^\\\\[^\\]+\\/.test(raw)) return raw.replaceAll("\\", "/");
  const normalized = raw.replaceAll("\\", "/");
  if (/^[A-Za-z]:\//.test(normalized)) return normalized;
  return normalized.startsWith("/") && !normalized.startsWith("//") && !SITE_ROUTE.test(normalized) ? normalized : null;
}

// 上传附件落在**数据根下的 `uploads/`**，名字恒为 `<12 位 id>-原名`（server/src/upload-names.ts）。
// 数据根不一定叫 `data`：仓库检出是 `<仓库>/data`，mac 版是 `~/Library/Application Support/<bundle>`，
// 还能被 NAVI_DATA_DIR 指到任何地方。所以认「父目录是 uploads + 带 id 前缀」这个不变式；
// `data/uploads/` 照旧无条件认，兜住早于 id 前缀的老附件。
const UPLOADED_FILE = /\/(?:data\/uploads\/([^/]+)|uploads\/([A-Za-z0-9_-]{12}-[^/]+))$/;

/** `path` 是磁盘路径(不是 URL):附件记录、agent 图副本存的都是它。 */
export function attachmentView(path: string): { name: string; url: string | null; image: boolean } {
  const normalized = path.trim().replaceAll("\\", "/");
  const name = normalized.split("/").filter(Boolean).pop() ?? normalized;
  const disk = absoluteDiskPath(path);
  const match = disk ? UPLOADED_FILE.exec(disk) : null;
  const uploaded = match?.[1] ?? match?.[2] ?? null;
  const url = uploaded ? `/api/uploads/${encodeURIComponent(uploaded)}` : null;
  const displayName = name.replace(/^[A-Za-z0-9_-]{12}-/, "") || name;
  return { name: displayName, url, image: !!url && isImagePath(uploaded ?? "") };
}

export function safeDownloadName(task: Task): string {
  return (task.title || task.id).replace(/[\\/:*?"<>|]/g, "_").slice(0, 80).trim() || "conversation";
}
