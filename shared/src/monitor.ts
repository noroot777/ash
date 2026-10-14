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
//
// ── 两种来源（`kind`）─────────────────────────────────────────────────────────
//
// 面板上并排显示的哨兵有两种出身，能力**不对等**，所以 `kind` 不是装饰性标签，是读这份
// 结构时必须先看的一列：
//
// - `ash`：上面说的那种，ash server 自己起的进程。全套都有——停得掉、看得到日志尾巴、
//   跨回合/会话/重启都活着。
// - `claude`：claude CLI 自带的 `Monitor` 工具起的，**进程在 agent 自己的进程树里**。
//   ash 只是从 stream-json 里把它认出来并记账，是一份**只读投影**：停不掉（`TaskStop`
//   是 claude 进程内的工具，ash 没有手柄）、没有日志文件、agent 进程一死它就跟着没了。
//
// 为什么还要记它：不记的话，agent 在对话里说一句「已挂 Monitor，等通知」，而哨兵面板
// 空空如也——用户翻遍界面也对不上账，只能得出「这功能坏了」。2026-10-14 实测的那个任务
// 挂了 12 个内置 Monitor、ash 一个都不知道，用户的第一反应正是「为什么 inspector 里没
// 东西」。只读也比没有强，前提是**界面必须如实说明它只读**（见 MonitorCard）。

export const MONITOR_STATUSES = ["running", "stopped", "expired", "exited", "lost"] as const;
export type MonitorStatus = (typeof MONITOR_STATUSES)[number];

/** 哨兵的出身。能力差异见文件头那一段——`claude` 那种是只读投影。 */
export const MONITOR_KINDS = ["ash", "claude"] as const;
export type MonitorKind = (typeof MONITOR_KINDS)[number];

/**
 * 这个哨兵**盯到什么时候**——三态，不是一个「到期时刻」就能表达的。
 *
 * ash 自己起的恒为 `bounded`：期限是它自己定的，当然知道。但 claude 内置 Monitor 的期限
 * 是**来源侧说了算**，而 ash 只是转述：
 * - `bounded`：来源明确回执了有效期（`expiresAt` 可信）。
 * - `persistent`：来源说它不设会话内超时（持续盯着），没有到期时刻。
 * - `unknown`：还没拿到回执，或者回执里没提期限。
 *
 * 为什么必须有 `unknown` 这一档：claude 的回执（tool_result 里那句 `expires in 20m`）
 * **在 `task_started` 之后才到**（实测顺序 tool_use → task_started → tool_result），所以
 * 投影刚落库那一刻我们确实不知道。更要命的是来源侧会**自己钳**——请求 1 小时、实际可能
 * 只给 30 分钟或 10 分钟（第 2 轮审查从本机 claude 2.1.283 的归一化函数实测到两个分支）。
 * 拿请求参数冒充生效期限，卡片上那句「盯到 X」就是编的。不知道就说不知道。
 */
export const MONITOR_LIFETIMES = ["bounded", "persistent", "unknown"] as const;
export type MonitorLifetime = (typeof MONITOR_LIFETIMES)[number];

/**
 * 从 claude 起 Monitor 的回执里读**实际生效**的期限。
 *
 * 回执长这样：`Monitor started (task bvvsd32ii, expires in 20m unless the source ends
 * first; ...)`。这是来源侧唯一一处说出生效值的地方——它已经把请求值钳过了，所以它才是
 * 事实，`timeout_ms` 只是我们请求了什么。
 *
 * 认不出来一律返回 `unknown` 而不是退回请求值：两者不同的那种情况（来源钳了）恰恰是这个
 * 函数存在的全部理由，退回去等于白做。
 */
export function parseMonitorStartReceipt(text: string): { lifetime: MonitorLifetime; ms: number | null } {
  if (!/Monitor started/i.test(text)) return { lifetime: "unknown", ms: null };
  // 没有到期、明说持续盯着的那种。
  if (/\bpersistent\b/i.test(text) && !/expires in/i.test(text)) return { lifetime: "persistent", ms: null };
  const m = /expires in\s+(\d+(?:\.\d+)?)\s*(ms|s|m|h)\b/i.exec(text);
  if (!m) return { lifetime: "unknown", ms: null };
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return { lifetime: "unknown", ms: null };
  const unit = m[2]!.toLowerCase();
  const scale = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  return { lifetime: "bounded", ms: Math.round(value * scale) };
}

/** 能不能从 ash 这边停掉它。`claude` 那种的进程在 agent 进程树里，ash 够不着。 */
export const canStopMonitor = (kind: MonitorKind) => kind === "ash";
/** 有没有日志文件可以回看尾巴。只有 ash 自己起的才有。 */
export const hasMonitorLog = (kind: MonitorKind) => kind === "ash";

export interface TaskMonitor {
  id: string;
  taskId: string;
  /** 出身。读这份结构的任何一处都要先看它——两种的能力不对等。 */
  kind: MonitorKind;
  /**
   * 来源侧的原生 id（`claude` 那种是 claude 的后台任务 id，形如 `b69ym4qzv`）。
   * `ash` 那种恒为 null：它的 `id` 就是唯一那一个。
   */
  nativeId: string | null;
  /** 盯到什么时候：有限期 / 持续 / 还不知道。见 {@link MonitorLifetime}。 */
  lifetime: MonitorLifetime;
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
  /**
   * 到期时刻。**只有 `lifetime === "bounded"` 时非空**——持续监听没有到期时刻，期限未知时
   * 编一个出来就是假的（卡片上那句「盯到 X」会被当真）。
   */
  expiresAt: string | null;
  endedAt: string | null;
  endedReason: string | null;
}

/** 还在盯着的那几种状态。 */
export function isMonitorLive(status: MonitorStatus): boolean {
  return status === "running";
}

/**
 * 时长：**与 claude 内置 `Monitor` 对齐**（用户 2026-10-14 指定）。
 *
 * 两种哨兵并排显示在同一个面板里，时长语义就不该各说各话——一个缺省 2 小时、另一个缺省
 * 5 分钟，用户看两张卡上的「还剩多久」会得出互相矛盾的预期。claude 那边是缺省 5 分钟、
 * 超过 30 分钟一律钳到 30 分钟，这里照搬。
 *
 * 取舍要说清楚：ash 哨兵原本能盯 24 小时，这是它相对内置 Monitor 的硬优势之一（进程不在
 * agent 进程树里，本来就撑得住）。对齐之后那条优势缩到 30 分钟，更长的活得靠「到期续挂」。
 * 换来的是两种卡的时间读数可以直接相互比较。要改回去只动下面这两个常量。
 *
 * 下限同样对齐到 1 秒（本机 claude 2.1.283 的 Monitor schema 两个模式都是 1000ms）。
 * 一开始留的 60 秒是「ash 要 spawn 进程 + 起 tail，1 秒的哨兵没意义」——但那是**建议**
 * 不是**边界**，拿它当硬下限会让 ash 连「claude 挂得出来的那种哨兵」都挂不了，而用户要的
 * 就是两边能力一致。短得没意义的时长由调用方自己负责。
 */
export const MONITOR_DEFAULT_TIMEOUT_MS = 5 * 60_000;
export const MONITOR_MIN_TIMEOUT_MS = 1_000;
export const MONITOR_MAX_TIMEOUT_MS = 30 * 60_000;

/**
 * 手动表单的时长选项。**从上面那几个常量推导，不另列一张硬编码表**。
 *
 * 这是一处类问题的根因：原来那张表把「2 小时 / 8 小时 / 24 小时」写死在前端，常量一改就
 * 整张表失真——用户选「2 小时」实际只盯 5 分钟，而且因为提交值恰好等于缺省值，连「已钳到
 * 边界」的回执都不会有，完全无从察觉（第 1 轮审查实测三个选项错两个、第三个靠巧合对上）。
 * 推导出来之后，改上面的常量这里自动跟着走。
 *
 * 取值规则：缺省必须在列、上限必须在列，中间按常用档位取那些落在 [min, max] 区间内的。
 */
export function monitorDurationOptions(): { label: string; ms: number }[] {
  const label = (ms: number): string => {
    if (ms % 3_600_000 === 0) return `${ms / 3_600_000} 小时`;
    if (ms % 60_000 === 0) return `${ms / 60_000} 分钟`;
    return `${Math.round(ms / 1000)} 秒`;
  };
  const candidates = [
    60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000,
    60 * 60_000, 2 * 60 * 60_000, 8 * 60 * 60_000, 24 * 60 * 60_000,
    MONITOR_DEFAULT_TIMEOUT_MS, MONITOR_MAX_TIMEOUT_MS,
  ];
  const seen = new Set<number>();
  return candidates
    .filter((ms) => ms >= MONITOR_MIN_TIMEOUT_MS && ms <= MONITOR_MAX_TIMEOUT_MS)
    .filter((ms) => (seen.has(ms) ? false : (seen.add(ms), true)))
    .sort((a, b) => a - b)
    .map((ms) => ({ label: label(ms), ms }));
}

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

/**
 * 「这个任务现在能不能挂哨兵」——**创建入口与投递出口共用的那一份判据**。
 *
 * 两边不同源就会长出这样一个洞：界面允许在一个已完成的任务上起哨兵，命令真的跑起来、
 * 卡片上事件数还在涨，而投递那一侧按终态把每一条都拒了，任务永远不醒（第 2 轮审查实测：
 * 待发送消息数 0、任务一直 done，用户只会以为通知已经处理过了）。所以判据只留这一份，
 * server 的 `startMonitor` 和界面的「+」按钮都读它。
 *
 * 终态的那三种和归档分开说：归档是「这个任务收进柜子了」，终态是「它跑完了」——后者
 * 重新跑起来就又能挂，措辞得给出这条出路。
 */
const MONITOR_BLOCKING_STATUSES = new Set(["done", "failed", "canceled"]);

export function monitorBlockedReason(
  task: { status: string; archived?: boolean | null },
): string | null {
  if (task.archived) return "任务已归档，不能再挂哨兵";
  if (MONITOR_BLOCKING_STATUSES.has(task.status))
    return "任务已经结束，哨兵的输出不会再唤醒它——要盯新的活，先让这个任务重新跑起来";
  return null;
}

/** 待发送消息上的来源标记（`scheduled_messages.origin`）。同一个哨兵的事件按它合并。 */
export const monitorMessageOrigin = (monitorId: string) => `monitor:${monitorId}`;
export const monitorIdFromOrigin = (origin: string | null | undefined): string | null =>
  origin?.startsWith("monitor:") ? origin.slice("monitor:".length) : null;

/**
 * claude 后台任务的状态 → 哨兵状态。
 *
 * claude 侧的取值来自 `system/task_notification` 的 `status`，实测见过 `completed`
 * （命令自己跑完）和 `stopped`（被 `TaskStop` 停掉）。拿不准的一律当 `exited` 收口而不是
 * 留在 `running`：面板上一个永远「正在盯着」的僵尸条目，比一个状态说得略粗的存档更误导人。
 */
export function claudeMonitorStatus(status: unknown): MonitorStatus {
  switch (String(status ?? "").toLowerCase()) {
    case "stopped":
    case "canceled":
    case "cancelled":
    case "killed":
      return "stopped";
    case "timeout":
    case "timed_out":
    case "expired":
      return "expired";
    case "running":
    case "in_progress":
    case "pending":
      return "running";
    default:
      return "exited";
  }
}

/** claude 内置 Monitor 的结束原因文案，按状态给。 */
export const CLAUDE_MONITOR_ENDED_REASON: Partial<Record<MonitorStatus, string>> = {
  exited: "命令自己跑完了（claude 侧报的完成）",
  stopped: "被 claude 自己停掉了（TaskStop）",
  expired: "盯满了 claude 侧约定的时长",
  lost: "agent 进程已经不在了，它跟着一起没了",
};

/**
 * **来源侧**报的时长 → 投影的有效期。
 *
 * 和 `normalizeMonitorTimeout` 的区别是这份代码里最容易搞错的一处：那一个是「ash 自己要
 * 起一个哨兵，允许多久」——是一条**创建策略**；这一个是「claude 那边说它要盯多久」——是
 * 一条**既成事实**。拿创建策略去钳来源事实，卡片上就会显示一个与来源侧不符的到期时刻
 * （claude 盯 5 秒，ash 按自己的下限写成 60 秒后到期）。投影的职责是如实转述，不是裁决。
 *
 * 所以这里只做「是不是个正数」这一道校验，不钳到 ash 的区间里。拿不到就返回 null，由调用
 * 方决定怎么表示「来源没说」，而不是替它编一个。
 */
export function sourceMonitorTimeout(ms: unknown): number | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  return Math.round(ms);
}
