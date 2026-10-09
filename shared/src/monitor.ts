// 哨兵（Monitor）：一条绑在任务上的长跑命令，stdout 每一行就是一条事件。
//
// 它要解决的是 agent 侧「盯着一件慢事」的老问题：轮询要反复烧回合去 cat 日志，
// 挂在会话上的后台进程又会随会话一起被回收（claude 自带的 Monitor 就死在这一点上：
// 会话一结束，它和被它盯着的活一起没了）。ash 版把进程的归属上移一层——进程由 **ash
// server** 起，不在 agent 进程树里，于是 agent 回合结束、会话结束、server 重启都动
// 不到它；有事件时再按既有的待发送消息链路把任务唤醒。
//
// 一条事件 = 唤醒任务一次 = 真金白银的一个模型回合。所以这里的上限不是防御性冗余，
// 而是功能的一部分：批量合并、单批行数上限、总事件上限，三道都写在下面。

export const MONITOR_STATUSES = ["running", "stopped", "expired", "exited", "lost"] as const;
export type MonitorStatus = (typeof MONITOR_STATUSES)[number];

export interface TaskMonitor {
  id: string;
  taskId: string;
  /** 原样交给用户 shell 执行的命令行。 */
  command: string;
  /** 一句话说明，会出现在每条事件的抬头和界面上。 */
  description: string;
  cwd: string;
  status: MonitorStatus;
  /** 进程组组长的 pid；重启后靠 pid + 启动时刻一起认人（pid 会被复用）。 */
  pid: number | null;
  /** 已推送出去的事件（行）条数。 */
  events: number;
  /** 命令自己退出时的退出码；跨 server 重启接回来的那种拿不到，记 null。 */
  exitCode: number | null;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endedReason: string | null;
}

/** 还在盯着的那几种状态。 */
export function isMonitorLive(status: MonitorStatus): boolean {
  return status === "running";
}

/** 默认盯 2 小时——哨兵存在的理由就是那种「要跑两小时」的活。 */
export const MONITOR_DEFAULT_TIMEOUT_MS = 2 * 60 * 60_000;
export const MONITOR_MIN_TIMEOUT_MS = 60_000;
export const MONITOR_MAX_TIMEOUT_MS = 24 * 60 * 60_000;

/** 攒多久算一批。tail 轮询本身就是这个量级，再大就拖慢「有事马上知道」的手感。 */
export const MONITOR_BATCH_MS = 300;
/** 单批最多列多少行，超出的只报条数——一次刷屏不该把整个回合的上下文吃光。 */
export const MONITOR_MAX_LINES_PER_PUSH = 40;
/** 单行最长字符数，超了截断。 */
export const MONITOR_MAX_LINE_CHARS = 2000;
/** 一个哨兵总共最多推多少条事件，到顶自动停——这是花钱的闸，不是防御性冗余。 */
export const MONITOR_MAX_EVENTS = 200;
/** 一个任务同时最多挂几个哨兵。 */
export const MONITOR_MAX_PER_TASK = 4;

/** 面板上回看哨兵输出的尾巴：默认多少行、最多多少行、以及回读多少字节封顶。 */
export const MONITOR_TAIL_DEFAULT_LINES = 80;
export const MONITOR_TAIL_MAX_LINES = 500;
export const MONITOR_TAIL_MAX_BYTES = 256 * 1024;

export function normalizeMonitorTimeout(ms: unknown): number {
  const n = typeof ms === "number" && Number.isFinite(ms) ? Math.round(ms) : MONITOR_DEFAULT_TIMEOUT_MS;
  return Math.min(MONITOR_MAX_TIMEOUT_MS, Math.max(MONITOR_MIN_TIMEOUT_MS, n));
}

/**
 * 合并进同一条待发送消息的正文上限。任务忙上几个钟头时，攒下的事件会一直往同一行后面
 * 追加；不封顶的话，它醒来读到的第一样东西就是一份几十万字的流水账，把整轮上下文吃光。
 * 超了从**最早的那头**丢，并如实说明丢了多少——刚发生的才是它醒来要处理的那件事。
 */
export const MONITOR_MAX_MERGED_CHARS = 20_000;

export function mergeMonitorEventText(existing: string, incoming: string): string {
  const merged = existing ? `${existing}\n\n${incoming}` : incoming;
  if (merged.length <= MONITOR_MAX_MERGED_CHARS) return merged;
  // 永远保住最新这一段：它比任何历史都重要，哪怕它自己就超了上限（此时前面不留历史）。
  const room = Math.max(0, MONITOR_MAX_MERGED_CHARS - incoming.length);
  const kept = room > 0 ? merged.slice(merged.length - incoming.length - room, merged.length - incoming.length) : "";
  const dropped = merged.length - kept.length - incoming.length;
  return `（更早的 ${dropped} 个字符已略去，完整输出在哨兵的日志文件里）\n${kept}${kept ? "\n\n" : ""}${incoming}`;
}

/** 待发送消息上的来源标记（`scheduled_messages.origin`）。同一个哨兵的事件按它合并。 */
export const monitorMessageOrigin = (monitorId: string) => `monitor:${monitorId}`;
export const monitorIdFromOrigin = (origin: string | null | undefined): string | null =>
  origin?.startsWith("monitor:") ? origin.slice("monitor:".length) : null;
