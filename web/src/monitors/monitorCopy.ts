// 哨兵的两句共用文案：「盯到什么时候」和「把毫秒说成人话」。
//
// 单独成文件是因为**会话区那张等待卡和 inspector 里那张卡必须说同一句话**：同一个哨兵
// 在两处显示成不同的期限，用户只会以为其中一处是坏的。
import type { TaskMonitor } from "@ash/shared/monitor";
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
 * 到底还在等，还是已经没戏了**。2026-10-20 那次空转里，用户盯着这一格和一句「共推送 0 条
 * 事件」，两句加起来仍然推不出「它等的标记永远不会出现了」。
 *
 * 但**这一层也答不出那一句**（第 1 轮审查 F3 实测：`until true; do sleep 1; done` 的条件
 * 一开始就满足，命令正常退出、日志为空，第一版照样写「那个条件始终没出现」，而同一张卡
 * 上方还写着「命令自己跑完了」）。所以这里只说两件能证实的事：**静默了多久**（起点不可信
 * 的投影行不说，判据同 {@link startedAtLabel}），以及**它是怎么结束的** —— 一条空日志配上
 * 「命令自己跑完了」和配上「盯到期了」，对用户是完全不同的两件事。
 */
export function emptyLogCopy(monitor: TaskMonitor, live: boolean, bytes: number | null | undefined): string {
  // **「没有完整行」不等于「没有产出」**（第 1 轮审查 F4）。读不出来、或者尾部那一段里一个
  // 换行都没有（超长单行）时,行列表同样是空的,而文件里可能有几兆字节。所以这两种先说清,
  // 再谈「它一个字都没吐」—— 否则这一句就是拿一份不充分的代理数据断言一件没观测到的事实。
  // **「这个后端没给」跟「读不出来」是两件事**（第 2 轮审查 N3）：上一版把字段缺失也说成读取
  // 失败 —— 而旧后端完全可能成功读出一个空文件，只是那一版的响应里压根没有这一列。凭「字段
  // 不在」断言「读失败」，就是又替它编了一次没观测到的事实。
  if (bytes === undefined) {
    return "这个后端的响应里没有日志大小这一项（版本比当前界面旧），所以这里说不准它是真的"
      + "一个字都没吐、还是只是这一段尾巴里切不出完整内容。";
  }
  if (bytes === null) {
    return "它的日志这一刻读不出来（文件可能被删掉或挪走了，也可能是权限/读写出错）——"
      + "所以这里说不准它有没有产出过。";
  }
  if (bytes > 0) {
    return `它的日志文件里有 ${bytes} 字节，但这一段尾巴里切不出一行完整内容`
      + "（最可能是一条长到没有换行的输出）。完整内容在哨兵的日志文件里。";
  }
  if (live) {
    const started = Date.parse(monitor.startedAt);
    const span = monitor.startedAtExact && Number.isFinite(started)
      ? `（已经静默 ${formatSpan(Math.max(0, Date.now() - started))}）`
      : "";
    return `这个命令到现在一个字都还没吐${span}。`;
  }
  return `它的日志从头到尾是空的。${endedWithoutOutput(monitor)}`;
}

/** 空日志 + 已经结束：按**结束方式**把这件事说完整，不猜它在等的东西到底来没来。 */
function endedWithoutOutput(monitor: TaskMonitor): string {
  switch (monitor.status) {
    case "exited":
      if (monitor.exitCode === 0) return "命令自己跑完了（退出码 0），只是没有产生任何输出。";
      // 非 0 要把码带上：那是「它为什么没输出」目前唯一的线索。拿不到码（离线补读过）就不编。
      return typeof monitor.exitCode === "number"
        ? `命令自己结束了（退出码 ${monitor.exitCode}），没有产生任何输出。`
        : "命令自己结束了（退出码没记下来），没有产生任何输出。";
    case "expired":
      return "一直到盯满时长，它都没有输出过。";
    case "stopped":
      return "它被停掉之前没有输出过。";
    case "lost":
      // **不替它编一次重启**（第 2 轮审查 R2-4）：`lost` 还有另一个来源 —— 创建期的补偿没能
      // 确认那个壳的归属（`monitor-create.ts` 的两处 `lost`），那一路压根没发生过重启，也
      // 证明不了那个进程已经不在。这一层说得出的只有两件事：ash 认不回它了，以及它一条
      // 输出都没送到。到底是哪一种由 `endedReason` 答（就显示在这句话旁边），不从一个通用
      // 终态反推一个没观测到的事实。
      return "ash 已经认不回这个进程了，期间它也没有一条输出送到这个任务头上。";
    default:
      return "";
  }
}
