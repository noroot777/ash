// 「结局已写定、结束通知还没入队」那一笔交接的**常驻恢复责任**（第 2 轮审查 F3）。
//
// 凭证（`monitors.result_handoff_at` + 原文）记下的是事实，不是「会自行送达」的保证。上一版
// 只有两处会去送：收尾那一笔当场送一次，以及**开机**扫一遍。于是一次瞬时写失败（库忙了一下、
// 事务被别人 ABORT）之后：结果一直不来、完成闸一直拦着、agent 反复 complete 只拿到 409「等一
// 下再调一次就行」，而事实上要等到下次重启才会再试一次（实测 `F3_NO_LIVE_RESULT_RETRY`：故障
// 撤掉后进程里再没有任何人去送，手工调一次开机用的补偿函数立刻就入队了 —— 缺的是调度，不是
// 数据或权限）。
//
// 所以这里给那份凭证配一个**常驻**的负责人，两条腿：
//
//  ① **退避重试**：谁送失败了就排下一跳（1s → 3s → 10s → 30s → 60s）。阶梯有界，到顶交给②。
//  ② **兜底巡检**：每分钟扫一遍库里还挂着凭证的行。覆盖①够不到的那些 —— 比如收尾在「写时间
//     线」那一笔就抛了（压根没走到投递入口）、或者进程换过一次（内存里的阶梯跟着没了）。
//
// 两条腿都走同一个入口（`deliverResultHandoff`），而那个入口是幂等的（消息侧的身份，见
// monitor-events.ts），所以重叠、重入、重启后再来一遍都不会把同一条通知送成两条。
import { and, isNotNull, isNull } from "drizzle-orm";
import { db, dbClient } from "./db/index.js";
import { monitors } from "./db/schema.js";

/** 退避阶梯（毫秒）。到顶之后不再自己排 —— 兜底巡检接着负责，不会无限制地占着定时器。 */
const RETRY_LADDER_MS = [1_000, 3_000, 10_000, 30_000, 60_000];

const retries = new Map<string, NodeJS.Timeout>();

/**
 * 给这一条凭证排下一跳重投。同一条同时只有一跳（后排的覆盖前面的）。
 *
 * **不抛**：调用点都在收尾/投递的 catch 里，这里再抛就把那一笔本来已经落定的终态也带翻。
 */
export function scheduleResultHandoffRetry(monitorId: string, step = 0): void {
  const existing = retries.get(monitorId);
  if (existing) clearTimeout(existing);
  if (step >= RETRY_LADDER_MS.length) return; // 阶梯到顶：交给兜底巡检
  const timer = setTimeout(() => {
    retries.delete(monitorId);
    void (async () => {
      const { deliverResultHandoff } = await import("./monitor-events.js");
      const outcome = await deliverResultHandoff(monitorId);
      // `failed` 那一支自己会排下一跳（它知道自己是第几跳吗——不知道，所以这里补排）。
      if (outcome === "failed") scheduleResultHandoffRetry(monitorId, step + 1);
    })().catch((e) => {
      console.error(`[ash] 重投哨兵结束通知这一跳自己出错 monitor=${monitorId}:`, e);
      scheduleResultHandoffRetry(monitorId, step + 1);
    });
  }, RETRY_LADDER_MS[step]);
  // 不拦着进程退出：这是兜底责任，不是必须跑完的活（凭证在库里，下次开机还认得出）。
  (timer as { unref?: () => void }).unref?.();
  retries.set(monitorId, timer);
}

/** 测试与退出用：把排着的那几跳都撤掉。 */
export function cancelResultHandoffRetries(): void {
  for (const t of retries.values()) clearTimeout(t);
  retries.clear();
}

/**
 * 库里**还挂着凭证**的那几条（已经明确放弃结果的不算 —— 那是「我不要了」，不是「还没送到」）。
 *
 * `kind='ash'` 之外不看：claude 投影没有自己的收尾路径，也从不写这一列。
 */
async function outstanding(): Promise<string[]> {
  const rows = await db
    .select({ id: monitors.id })
    .from(monitors)
    .where(and(isNotNull(monitors.resultHandoffAt), isNull(monitors.resultsAbandonedAt)));
  return rows.map((r) => r.id);
}

/** 一趟巡检的结果。分项的理由见 `HandoffOutcome`：**不以「没抛异常」冒充送达**。 */
export type HandoffSweep = { delivered: number; dropped: number; failed: number };

/**
 * 扫一遍还挂着的凭证，逐条把交接做完。开机那一趟和常驻巡检走的是同一个函数。
 *
 * 逐条隔离：一条的失败不影响其余（它自己会排重试）。
 */
export async function sweepResultHandoffs(): Promise<HandoffSweep> {
  const out: HandoffSweep = { delivered: 0, dropped: 0, failed: 0 };
  if (dbClient.closed) return out;
  const { deliverResultHandoff } = await import("./monitor-events.js");
  for (const id of await outstanding()) {
    try {
      const outcome = await deliverResultHandoff(id);
      if (outcome === "delivered") out.delivered += 1;
      else if (outcome === "dropped") out.dropped += 1;
      else if (outcome === "failed") out.failed += 1;
      // `already` 不计数：那一笔早就送过了，这一趟只是把残留的凭证销掉。
    } catch (e) {
      // `deliverResultHandoff` 自己不抛，所以走到这里是它之外的意外（库关了/模块加载失败）。
      console.error(`[ash] 巡检重投这一条时出错 monitor=${id}（凭证留着,下一趟再试）:`, e);
      out.failed += 1;
      scheduleResultHandoffRetry(id);
    }
  }
  return out;
}

const SWEEP_INTERVAL_MS = 60_000;
let sweeper: NodeJS.Timeout | null = null;

/**
 * 起常驻巡检。幂等（起过就不再起第二个）。
 *
 * 开机那一趟补发**不在**这里，而是 `reattachMonitors` 里按顺序跑的那一次（接回只管 running 的
 * 行，补发管的全是已经终态的行，两边不重叠）；这里只负责「开机之后的每一分钟」。
 */
export function startResultHandoffSweeper(intervalMs = SWEEP_INTERVAL_MS): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    void sweepResultHandoffs().then((s) => {
      if (s.delivered || s.dropped || s.failed) {
        console.log(
          `[ash] 结束通知巡检：补发 ${s.delivered} 条`
          + (s.dropped ? `，${s.dropped} 条已无人可收（任务终态/归档）` : "")
          + (s.failed ? `，${s.failed} 条这一趟仍没送出去（已排重试）` : ""),
        );
      }
    }).catch((e) => console.error("[ash] 结束通知巡检这一趟出错:", e));
  }, intervalMs);
  (sweeper as { unref?: () => void }).unref?.();
}

/** 停掉常驻巡检（进程退出 / 测试收场）。 */
export function stopResultHandoffSweeper(): void {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
  cancelResultHandoffRetries();
}

/** 这一刻库里还挂着几笔没做完的交接 —— 给「可观察」用（启动日志、测试）。 */
export const outstandingResultHandoffs = outstanding;
