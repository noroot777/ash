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
export function liveDeadline(monitor: TaskMonitor): string {
  if (monitor.lifetime === "persistent") return "持续盯着（来源没设期限）";
  if (monitor.expiresAt) return `盯到 ${formatInstant(monitor.expiresAt)}`;
  if (monitor.lifetime === "bounded" && monitor.timeoutMs) return `总共盯 ${formatSpan(monitor.timeoutMs)}（起点不确定）`;
  return "盯到什么时候由它自己定";
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
