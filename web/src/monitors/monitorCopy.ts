// 哨兵的两句共用文案：「盯到什么时候」和「把毫秒说成人话」。
//
// 单独成文件是因为**会话区那张等待卡和 inspector 里那张卡必须说同一句话**：同一个哨兵
// 在两处显示成不同的期限，用户只会以为其中一处是坏的。
import type { TaskMonitor } from "@ash/shared/monitor";
import { isSilentWaitLoop } from "@ash/shared/monitor-silence";
import { formatInstant } from "../task-detail/utils.ts";

/**
 * 还在盯着的那张卡，右上角那句「盯到什么时候」。
 *
 * **不能无脑写 `盯到 ${expiresAt}`**：claude 内置 Monitor 的期限是来源侧说了算的，而它
 * 可能是持续监听（没有到期时刻），也可能回执还没到（我们还不知道）。编一个确定时刻出来，
 * 用户会当真——第 2 轮审查实测来源侧会把请求的 1 小时钳成 30 分钟甚至 10 分钟。
 *
 * 第四种情况是**知道盯多久、但不知道从哪一刻起算**（历史重建时起点只是一个区间，见
 * shared/monitor.ts 的 MonitorStartEvidence）。那时说时长，不说时刻——上一版会按回执时刻
 * 编一个，而回执要等 PostToolUse hooks 跑完才生成，期限跟着往后漂。
 */
export function liveDeadline(
  monitor: TaskMonitor,
  /**
   * 调用处**已经单独说过起点了没有**（哨兵卡片上那一段 {@link startedAtLabel}）。
   *
   * 说过就别再带那句「（起点不确定）」：同一行上连说两遍不是更保险，是噪音
   * （「挂上的时刻不确定 · 总共盯 10 分钟（起点不确定）」）。回复框上那条等待卡只显示这
   * 一句、没有起点那一段，所以它缺省仍然要带着。
   */
  opts: { startSaidSeparately?: boolean } = {},
): string {
  if (monitor.lifetime === "persistent") return "持续盯着（来源没设期限）";
  if (monitor.expiresAt) return `盯到 ${formatInstant(monitor.expiresAt)}`;
  if (monitor.lifetime === "bounded" && monitor.timeoutMs) {
    const span = `总共盯 ${formatSpan(monitor.timeoutMs)}`;
    return opts.startSaidSeparately ? span : `${span}（起点不确定）`;
  }
  return "盯到什么时候由它自己定";
}

/**
 * 「它是什么时候挂上的」那一段。
 *
 * **不能无脑写 `起于 ${startedAt}`**：那一列在历史投影上允许退化成占位值 —— 真实起点裁不
 * 出来时它退到那一整轮执行的开始时刻、甚至退到落库时刻（见 server/src/claude-monitor-commit.ts
 * 的 `anchor.startedAt ?? startedAtLow ?? fileStartedAt ?? now()`）。退化值仍然是一个**合法
 * 日期**，所以 `formatInstant` 的「坏日期不显示」一个字都挡不住它。第 1 轮审查用真实 backfill +
 * 真实 `listMonitors` 复现到的卡片，同一行先写「起于 10/19 10:00」再写「总共盯 10 分钟
 * （起点不确定）」—— 自相矛盾，而被当真的恰恰是前半句。
 *
 * 所以判据只认服务端带过来的那一列（`startedAtExact`，源头是 shared 的
 * `monitorStartTrusted`）：答不出来时只说「答不出来」，不画一个会被当真的时刻。
 */
export function startedAtLabel(monitor: TaskMonitor): string | null {
  if (!monitor.startedAtExact) return "挂上的时刻不确定";
  const at = formatInstant(monitor.startedAt);
  return at ? `起于 ${at}` : null;
}

/**
 * 把毫秒说成人话。只给上面那句用。
 *
 * **先把总秒数取整，再拆分钟和秒**。反过来（先拆再对余数四舍五入）会在余数落在 59.5~60 秒
 * 时进位到「X 分 60 秒」——例如 119 600ms 显示成「1 分 60 秒」（第 6 轮审查不拦项）。
 */
function formatSpan(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds >= 3_600 && seconds % 3_600 === 0) return `${seconds / 3_600} 小时`;
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} 分钟`;
  if (seconds >= 60) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${seconds} 秒`;
}

/**
 * claude 投影**结束之后**那半句。要答的是「那它为什么没叫醒谁」,所以必须按它**是怎么结束
 * 的**分开说。
 *
 * 统一说成「那个会话已经随进程结束」对 `exited` 是错的 —— 那一档是「命令自己跑完了（claude
 * 侧报的完成）」,而真实页面上抓到的样本恰恰是它（第 4 轮审查 N1）。那种情况下会话未必已经
 * 没了:回合还在跑,智能体自己就看见了那条完成通知;回合已经结束,它才没人看见。两种都不会
 * 唤醒任务 —— 这一句无论哪一档都成立,也是用户真正要的那个答案。
 */
export function claudeMonitorEpilogue(status: TaskMonitor["status"]): string {
  const tail = "——所以它没有、也不会唤醒任务。要跨回合等一件事，用 ash 自己的哨兵。";
  if (status === "exited")
    return `它盯的命令自己跑完了，而那条完成通知只注回智能体自己的会话：那一轮要是已经结束，就没人看见它${tail}`;
  if (status === "lost")
    return `起它的那个智能体进程已经不在了，它的通知没有任何去处${tail}`;
  return `它的通知只注回那个会话，而它已经没命等到结果了${tail}`;
}

/**
 * 日志那一格是空的时候说什么。
 *
 * 「这个命令到现在一个字都还没吐」是对的，但它只报现象、不答用户真正在问的那一句：**那它
 * 到底是还在等，还是已经没戏了**。2026-10-20 那次空转（任务 u7nb4wnGcX2O）里，用户盯着
 * 这一格和一句「共推送 0 条事件」，两句话加起来仍然推不出「它等的标记永远不会出现了」。
 *
 * 所以这里多答两件事：
 *  · **静默了多久** —— 刚挂上 10 秒和已经哑了 40 分钟是完全不同的处境（起点不可信的投影
 *    行不说，宁可少说一句也不编一个时长出来，判据同 {@link startedAtLabel}）；
 *  · **这条命令会不会说话** —— 循环体里只有 sleep 的等待循环在条件成立之前**结构上**不
 *    可能有输出（判据在 shared/monitor-silence.ts）。说清这一点，沉默本身才从「像是坏了」
 *    变成一条可读的事实。
 */
export function emptyLogCopy(monitor: TaskMonitor, live: boolean): string {
  const silent = isSilentWaitLoop(monitor.command);
  if (!live) {
    return "它从头到尾一个字都没吐。"
      + (silent ? "这条命令只在条件成立时才说话，所以它一直沉默 = 那个条件始终没出现。" : "");
  }
  const started = Date.parse(monitor.startedAt);
  const span = monitor.startedAtExact && Number.isFinite(started)
    ? `（已经静默 ${formatSpan(Math.max(0, Date.now() - started))}）`
    : "";
  return `这个命令到现在一个字都还没吐${span}。`
    + (silent
      ? "它在跳出等待循环之前本来就不会说话——所以这既可能是「还在等」，也可能是它等的条件已经不会出现了。"
      : "");
}
