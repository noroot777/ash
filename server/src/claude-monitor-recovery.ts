// 投影账本的**待恢复**事实 + 自动往下推的那条路。
//
// 为什么非有不可：这份投影的每一条事实都是**一次性**的——来源侧不会重发，ash 这边
// `pending`/`byToolUse` 处理过就删了，扫描游标读过就往前走了。所以「观察到了、但还没确认
// 落到行上」这个中间态必须有地方存着，否则它就等于**丢了**。第 6 轮审查实测三条互不相同
// 的触发路径，掉进的却是同一个坑：
//
// ① **扫描没读到 EOF**（单次 128MB 上限 / 读文件失败）——上一版只打一行日志说「下次打开
//    面板继续往后读」，于是剩下那一段要等**用户再开一次**才有人读。
// ② **暂态写失败**（SQLITE_BUSY 之类）——事实已经从事件流里消费掉了，重试仍失败就只留一句
//    「历史回填会再补」，而历史回填本身也只在用户打开面板时才跑。
// ③ **条件更新 0 行**（CAS miss：读到写之间别的 writer 改了状态）——上一版把它当成「已提交」
//    返回 true，于是那次更新**永久消失**（实测 casAtRace：完成抢先到达后时长再也补不上）。
//
// 三条都不该以「用户再开一次」「来源再发一条」「另一个 writer 会发成功事件」为前提。这个
// 文件就是那条**共同的、能自己继续往下推**的路：记下待恢复 → 退避重排 → 干净跑完才清账。
//
// 两条边界，免得它从「兜底」变成「刷盘」：
// - **次数有上限**。一直失败的那种（文件权限坏了、磁盘满）再推一万次也一样，推到上限就
//   停下定时器、**但账留着**——面板据此显示「还有历史没读完」，而不是谎称「这个任务没用过
//   哨兵」。用户/SSE 下一次真的来读时预算重置（`resetMonitorRecoveryBudget`）。
// - **定时器一律 unref**。这是兜底路径，不许拖着进程不让退（测试脚本尤其）。
import type { MonitorRecovery, MonitorRecoveryReason } from "@ash/shared/monitor";
import { dbClient } from "./db/index.js";

export type { MonitorRecoveryReason } from "@ash/shared/monitor";

/** 退避阶梯。头两档短（扫描上限这种每推一次都真的往前读了一段），越往后越稀。 */
const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000] as const;

type Entry = {
  reasons: Set<MonitorRecoveryReason>;
  attempts: number;
  timer: NodeJS.Timeout | null;
};

const pending = new Map<string, Entry>();

/**
 * 记下「这个任务还有没确认的事实」，并排一次自动推进。
 *
 * @param progress 这一轮有没有真的往前走（读进了新字节 / 落了新行）。走了就把退避预算
 *   清零——还在前进的扫描不该因为「推了 8 次」就被判定没救，128MB 上限的大文件正常就要
 *   推很多次。原地打转的才消耗预算。
 */
export function noteMonitorRecovery(
  taskId: string, reason: MonitorRecoveryReason, progress = false,
): void {
  const entry = pending.get(taskId) ?? { reasons: new Set<MonitorRecoveryReason>(), attempts: 0, timer: null };
  entry.reasons.add(reason);
  if (progress) entry.attempts = 0;
  pending.set(taskId, entry);
  arm(taskId, entry);
}

/** 这一轮干净跑完了：销账、撤定时器。 */
export function clearMonitorRecovery(taskId: string): void {
  const entry = pending.get(taskId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  pending.delete(taskId);
}

/** 对外（HTTP → 面板）：这个任务现在有没有待恢复的事实。 */
export function monitorRecoveryOf(taskId: string): MonitorRecovery | null {
  const entry = pending.get(taskId);
  if (!entry) return null;
  return {
    pending: true,
    reasons: [...entry.reasons],
    attempts: entry.attempts,
    exhausted: entry.timer === null && entry.attempts >= BACKOFF_MS.length,
  };
}

/**
 * 真实请求（用户打开面板、SSE 触发重读）进来时重置退避预算。
 *
 * 推到上限停下来之后，账是留着的；这一步让下一次真实请求重新把它推起来，而不是永远卡在
 * 「已停、且没人会再推」。
 */
export function resetMonitorRecoveryBudget(taskId: string): void {
  const entry = pending.get(taskId);
  if (!entry || entry.timer) return;
  entry.attempts = 0;
}

/** 测试与关库时用：撤掉全部定时器（`unref` 过，但别留着在后面乱跑）。 */
export function stopAllMonitorRecovery(): void {
  for (const entry of pending.values()) if (entry.timer) clearTimeout(entry.timer);
  pending.clear();
}

function arm(taskId: string, entry: Entry): void {
  if (entry.timer) return;                        // 已经排着了，别排第二个
  if (entry.attempts >= BACKOFF_MS.length) return; // 预算用完：账留着，定时器不排
  const delay = BACKOFF_MS[entry.attempts]!;
  entry.attempts += 1;
  const timer = setTimeout(() => {
    entry.timer = null;
    void drive(taskId);
  }, delay);
  timer.unref?.();
  entry.timer = timer;
}

async function drive(taskId: string): Promise<void> {
  if (dbClient.closed) {
    clearMonitorRecovery(taskId);
    return;
  }
  try {
    // **动态 import**：回填那一侧要用这个文件记账，这一侧要调回填去推进——静态互引会成环。
    // 动态 import 只在真要推进的那一刻解析，模块初始化顺序上不构成循环。
    const { backfillClaudeMonitors } = await import("./claude-monitor-backfill.js");
    await backfillClaudeMonitors(taskId);
    // 销账与否由那一轮自己判：干净跑完它会 clear，又出问题会再 note（并重排）。
  } catch (e) {
    console.warn(`[ash] 内置 Monitor 待恢复事实自动推进失败（task=${taskId}）:`, e);
    const entry = pending.get(taskId);
    if (entry) arm(taskId, entry); // 推进本身炸了也要接着排，别把账烂在这儿
  }
}
