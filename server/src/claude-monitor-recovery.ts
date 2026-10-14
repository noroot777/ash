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
import { and, eq } from "drizzle-orm";
import { bus } from "./bus.js";
import { db, dbClient } from "./db/index.js";
import { sessions } from "./db/schema.js";

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
  const changed = !entry.reasons.has(reason);
  entry.reasons.add(reason);
  if (progress) entry.attempts = 0;
  pending.set(taskId, entry);
  arm(taskId, entry);
  // **状态变化要推出去。** 前端只订阅 `task.monitors`，而「文件一直读不开」这种情况根本
  // 不产生行变化——没有这一句，第一次打开时拿到的 `pending:false` 会永远留在页面上，面板
  // 一直写着「这个任务上还没有哨兵」（第 7 轮审查用真实页面复现）。
  // 只在**可见状态真的变了**的时候推：每秒重试一次、原因不变时不该把前端也拖着重读。
  if (changed) bus.publish({ type: "task.monitors", taskId });
}

/** 这一轮干净跑完了：销账、撤定时器。 */
export function clearMonitorRecovery(taskId: string): void {
  const entry = pending.get(taskId);
  if (!entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  pending.delete(taskId);
  // 反方向同样要推：读完了而这一轮没有新增/纠正任何行时，页面上那句「还没读完」也得撤。
  bus.publish({ type: "task.monitors", taskId });
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

/**
 * **还没认到任务头上**的恢复责任（CLI 会话 id → 原因）。
 *
 * 为什么需要这一档：实时投影记账需要 taskId，而它来自查 `sessions`。如果连第一次查询都
 * 失败（磁盘/权限/SQLITE_BUSY），上一版就只能 catch 一兜——而那一刻来源事实**已经消费掉
 * 了**（tool_use/task_started/回执/完成都读过了），于是既没有待恢复任务、也没有重试定时器，
 * 故障恢复之后也不会自己补出来（第 8 轮审查实测）。
 *
 * CLI 会话 id 是这条流**自己的身份**，不用查库就有。所以先按它记账，等库好了再解析成
 * taskId、折进正常账本。
 */
const unattributed = new Map<string, { reasons: Set<MonitorRecoveryReason>; attempts: number; timer: NodeJS.Timeout | null }>();

/**
 * 记下一条**还不知道属于哪个任务**的恢复责任。身份用 CLI 会话 id（流自己的身份，不查库）。
 */
export function noteMonitorRecoveryBySession(
  cliSessionId: string, reason: MonitorRecoveryReason,
): void {
  if (!cliSessionId) return; // 连会话身份都没有：这条流还没认出自己，没有可挂的锚
  const entry = unattributed.get(cliSessionId)
    ?? { reasons: new Set<MonitorRecoveryReason>(), attempts: 0, timer: null };
  entry.reasons.add(reason);
  unattributed.set(cliSessionId, entry);
  armSession(cliSessionId, entry);
}

function armSession(cliSessionId: string, entry: { reasons: Set<MonitorRecoveryReason>; attempts: number; timer: NodeJS.Timeout | null }): void {
  if (entry.timer) return;
  if (entry.attempts >= BACKOFF_MS.length) return; // 解析不出来就先留着，等下一次真实请求
  const delay = BACKOFF_MS[entry.attempts]!;
  entry.attempts += 1;
  const timer = setTimeout(() => {
    entry.timer = null;
    void resolveSession(cliSessionId);
  }, delay);
  timer.unref?.();
  entry.timer = timer;
}

/** 库好了吗：解析得出 taskId 就折进正常账本（那边会把事实重新读回来）。 */
async function resolveSession(cliSessionId: string): Promise<void> {
  const entry = unattributed.get(cliSessionId);
  if (!entry) return;
  if (dbClient.closed) {
    unattributed.delete(cliSessionId);
    return;
  }
  try {
    const row = (await db
      .select({ taskId: sessions.taskId })
      .from(sessions)
      .where(and(eq(sessions.cliSessionId, cliSessionId), eq(sessions.agentType, "claude")))).at(0);
    if (!row) {
      armSession(cliSessionId, entry); // 会话行可能还没写进去，再等一轮
      return;
    }
    unattributed.delete(cliSessionId);
    for (const reason of entry.reasons) noteMonitorRecovery(row.taskId, reason);
  } catch (e) {
    console.warn(`[ash] 内置 Monitor 待恢复责任还认不到任务上（session=${cliSessionId}）:`, e);
    armSession(cliSessionId, entry);
  }
}

/** 这条会话名下还有没有「认不到任务上」的责任（给回归用）。 */
export const monitorRecoverySessionPending = (cliSessionId: string): boolean =>
  unattributed.has(cliSessionId);

/** 现在还有待恢复事实的任务。给扫描快照的淘汰用：这些任务的游标不能被当普通缓存挤掉。 */
export const monitorRecoveryTasks = (): ReadonlySet<string> => new Set(pending.keys());

/** 测试与关库时用：撤掉全部定时器（`unref` 过，但别留着在后面乱跑）。 */
export function stopAllMonitorRecovery(): void {
  for (const entry of pending.values()) if (entry.timer) clearTimeout(entry.timer);
  pending.clear();
  for (const entry of unattributed.values()) if (entry.timer) clearTimeout(entry.timer);
  unattributed.clear();
}

function arm(taskId: string, entry: Entry): void {
  if (entry.timer) return;                        // 已经排着了，别排第二个
  if (entry.attempts >= BACKOFF_MS.length) {
    // **预算用完也是一次可见的状态变化**：账留着、定时器不排，而面板得把「正在自动继续」
    // 改口成「已停止自动重试」。不推的话用户看到的永远是上一次的 exhausted=false
    // （第 8 轮审查不拦项 1）。
    //
    // 这不会变成紧循环：面板收到之后那次重读确实会把预算还回去（`resetMonitorRecoveryBudget`
    // 只在定时器已停时才还），但接下来要再走完整条阶梯（1+2+5+15+30+60+120+300 秒 ≈ 9 分钟）
    // 才会回到这里。面板开着时每 9 分钟自己再试一轮，是想要的行为。
    bus.publish({ type: "task.monitors", taskId });
    return;
  }
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
    // **自己推进不算「外部真实请求」**：公共入口会把退避预算还原，于是每次失败都排回第一
    // 档 1 秒、永远到不了后面的档位和 exhausted（第 7 轮审查实测 4 次间隔全是 ~1003ms）。
    await backfillClaudeMonitors(taskId, { external: false });
    // 销账与否由那一轮自己判：干净跑完它会 clear，又出问题会再 note（并重排）。
  } catch (e) {
    console.warn(`[ash] 内置 Monitor 待恢复事实自动推进失败（task=${taskId}）:`, e);
    const entry = pending.get(taskId);
    if (entry) arm(taskId, entry); // 推进本身炸了也要接着排，别把账烂在这儿
  }
}
