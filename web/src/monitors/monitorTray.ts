// 回复框上方那块「排队 · 哨兵」里，哨兵那几行要说的话（components/MonitorTrayRow.tsx、ScheduledMessageTray.tsx）。
//
// 只算还在盯的那几个：结束了的是存档，在右侧哨兵格里看。两种出身都列：navi 自己起的会把任务叫醒，
// claude 内置 Monitor 的只读投影不会（它的通知只注回它那一轮的会话），这一点在那一行上要说清，
// 不能当它不存在——agent 明明在对话里说了「已挂监听」。
import type { TaskMonitor } from "@navi/shared/monitor";
import { liveDeadline } from "./monitorCopy.ts";

/** 盯了多久 / 等了多久：只到分钟，不让这一格每秒跳一次。 */
export function elapsedLabel(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "不到 1 分钟";
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} 小时 ${minutes % 60} 分` : `${hours} 小时`;
}

/** 最迟等到几点。算不出确切时刻时退回「总共盯多久（起点不确定）」那句，持续盯着的不说。 */
export function monitorDue(monitor: TaskMonitor): string | null {
  if (monitor.lifetime === "persistent") return null;
  const at = monitor.expiresAt
    ?? (monitor.lifetime === "bounded" && monitor.timeoutMs && monitor.startedAtExact
      ? new Date(Date.parse(monitor.startedAt) + monitor.timeoutMs).toISOString()
      : null);
  if (!at) return monitor.lifetime === "bounded" && monitor.timeoutMs ? liveDeadline(monitor) : null;
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return null;
  const two = (number: number) => String(number).padStart(2, "0");
  const sameDay = date.toDateString() === new Date().toDateString();
  return `最迟 ${sameDay ? "" : `${two(date.getMonth() + 1)}/${two(date.getDate())} `}${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** 起点作数时从哪一刻数；起点不作数的（历史投影上的占位值）不拿来数。 */
export function monitorStart(monitor: TaskMonitor): number | null {
  if (!monitor.startedAtExact) return null;
  const at = Date.parse(monitor.startedAt);
  return Number.isFinite(at) ? at : null;
}

/**
 * 那一行「什么时候」那一格：盯了多久（任务在跑）/ 等了多久（任务停下来等它）· 最迟几点。
 * 内置的那种只说它不会叫醒任务——它的期限是来源说了算，navi 只是转述。
 */
export function monitorWhen(monitor: TaskMonitor, running: boolean, now: number): string {
  if (monitor.kind !== "ash") return "不会叫醒任务";
  const start = monitorStart(monitor);
  const elapsed = start === null ? null : `${running ? "盯了" : "等了"} ${elapsedLabel(now - start)}`;
  return [elapsed, monitorDue(monitor)].filter(Boolean).join(" · ");
}

/** 收着那一行上只说一句：第一个的名字（还有几个），和盯了多久。 */
export function monitorsBrief(monitors: readonly TaskMonitor[], running: boolean, now: number): string {
  const first = monitors[0];
  if (!first) return "";
  const name = `${first.description}${monitors.length > 1 ? ` +${monitors.length - 1}` : ""}`;
  const starts = monitors.flatMap((monitor) => monitor.kind === "ash" ? [monitorStart(monitor)] : [])
    .filter((at): at is number => at !== null);
  if (!starts.length) return name;
  return `${name} · ${running ? "盯了" : "等了"} ${elapsedLabel(now - Math.min(...starts))}`;
}

/**
 * 读到了明确终态的那几个哨兵（排队里它们送来的结果据此画「已结束」）。列表还没读成功过（刚进来、
 * 切任务、首次读失败）就一个都不算：列表里没有它，不等于它停了。
 */
export function endedMonitorIds(monitors: readonly TaskMonitor[], listed: boolean): ReadonlySet<string> {
  return new Set(listed ? monitors.filter((monitor) => monitor.status !== "running").map((monitor) => monitor.id) : []);
}
