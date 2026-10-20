// claude 内置 `Monitor` 这一侧的**转述规则**：它报来的状态、它报来的时长、以及一条终态
// 该对外说哪句话。
//
// 从 `monitor.ts` 分出来是因为职责不同，不只是行数：那边装的是 **ash 自己的哨兵**要守的
// 规矩（能挂几个、允许多久、任务什么状态下不许挂、事件怎么合并），每一条都是 ash 说了算
// 的**策略**；这边装的是对一个**ash 管不着的外部系统**的转述——claude 报什么，我们如实
// 翻成什么。两种东西放在一起最容易出的错，是拿这边的策略去钳那边的事实（见
// `sourceMonitorTimeout` 那段）。
import type { MonitorStatus } from "./monitor.ts";

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
  // **不能只写 TaskStop**：实测绝大多数 `stopped` 根本不是智能体主动停的，而是那一轮回合
  // 结束时被 CLI 成批收走的（见 CLAUDE_MONITOR_REAPED_REASON 那段实测记录）。只说 TaskStop
  // 会让用户以为「它自己决定不等了」，而真相是「它还在等，但已经没命等了」。
  stopped: "claude 那边把它停了——要么智能体 TaskStop，要么那一轮回合结束时一并收走",
  expired: "盯满了 claude 侧约定的时长",
  lost: "agent 进程已经不在了，它跟着一起没了",
};

/**
 * 来源侧**补报孤儿**时的原话。claude 2.1.283 在新进程启动时，会对上一代进程遗留的后台
 * 任务成批补报一次 `stopped`，summary 固定是这一句（实测原文）：
 *
 * ```
 * Orphaned by a previous Claude Code process exit and reported in an aggregate summary.
 * ```
 *
 * 这是来源侧唯一一处**明说**「它是被进程退出收走的、不是等到了」的地方，所以单独认。
 */
const CLAUDE_ORPHAN_SUMMARY_RE = /orphaned by a previous claude code process exit/i;

/**
 * 「随回合结束被收走」——内置 Monitor 最常见、也最容易被误读的那个结局。
 *
 * 实测的因果链（Bp2LkwfRO37A 第 2 轮审查，run 文件原始行序）：
 *
 * ```
 * system task_started      ← 智能体挂上监听
 * assistant "监听已挂上，套件结束会叫我。"
 * result   success         ← 回合结束
 * system task_notification status=stopped   ← 紧接着就被收走，summary 原样是那条描述
 * ```
 *
 * 也就是说那句「套件结束会叫我」在说出口的那一刻就已经不成立了：内置 Monitor 的进程在
 * 智能体自己的进程树里，回合一结束 CLI 就把名下的后台任务成批收走，它盯的那件事还在跑。
 * 卡片若只写「已停止」，用户读到的是「等到了然后停了」——**意思正好相反**。
 */
export const CLAUDE_MONITOR_REAPED_REASON =
  "随那一轮智能体进程退出被一并收走——不是等到了，它盯的那件事当时还没有结果";

/**
 * 一条内置 Monitor 终态该对外说的那句话。
 *
 * 三条来源侧的 summary，三种处理：
 * - 孤儿补报那句英文原话 → 翻成上面那句，这是**明示**的「被收走」。
 * - 跟描述一字不差 → 不复读。CLI 在回合收尾成批停止时，summary 填的就是那条描述本身，
 *   于是卡片会变成「已停止 / 等待全量 unittest 跑完」——两行都没说出发生了什么。
 * - 其余 → 原样转述，那是来源侧真正多说的话。
 */
export function claudeMonitorEndedReason(
  status: MonitorStatus,
  summary: string | null | undefined,
  description: string | null | undefined,
): string | null {
  const text = (summary ?? "").trim();
  if (CLAUDE_ORPHAN_SUMMARY_RE.test(text)) return CLAUDE_MONITOR_REAPED_REASON;
  const byStatus = CLAUDE_MONITOR_ENDED_REASON[status] ?? null;
  if (!text || text === (description ?? "").trim()) return byStatus;
  return text;
}

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
