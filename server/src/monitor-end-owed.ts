// **这条哨兵还欠着一声「结束」吗** —— 欠着,它名下的待发行就谁都领不走(第 5 轮审查 1)。
//
// 进程退了之后,ash 还要排干最后几行、写终态、把「结束」入队。上一版让这段时间靠**行上的期限**
// 撑着(收尾开始时推到 30 秒后、收尾函数退出时解除):期限到了、或者收尾函数退出了,都只是在
// **推断**「结束已经准备好」—— 实测两条都推断错:库慢过 30 秒,扫描先把末批单独送走;结束入队
// 失败一次,收尾的 finally 照样解除,末批被扫描送走,补发的「结束」另起一行再叫一次。
//
// 所以资格改成从**持久交接状态**直接读,不再写、也不再解除任何东西:
//
//  ① 收尾所有权槽位(`finishing`):这一进程里有人正在收这条哨兵。同步登记,不碰库 —— 写库
//     失败也挡得住;
//  ② `finishing_since` 已落、行还 running:收尾开始了、终态还没落定(活过重启:下次开机接回把它
//     收完之前照样挡着);
//  ③ 交接凭证还在(`result_handoff_at`):终态落定了、「结束」还没入队(或入了队、凭证还没销)。
//     凭证跟终态同一条语句落、入队之后才销,失败有重投(monitor-handoff-retry.ts)—— 所以这一段
//     放不放行,只看那一笔交接到底做没做完。
//
// 三样都不在 = 不欠了。**明确放弃的不算欠**(`results_abandoned_at`):用户说了不要,它名下排着的
// 照旧该送就送。
//
// 每个领取入口(扫描、批量领取、单条领取、回合里交付)都按这一份判:挑候选时用 `endOwedOrigins`,
// 领取那条 CAS 里再带一次 `endNotOwed` —— 后者是同一条语句里的原子判据,挑完之后凭证才落下的
// 那种也绕不过去;槽位那一份只在内存里,调用方在发出 CAS 之前同步问 `finishingNow`。
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { monitorIdFromOrigin, monitorMessageOrigin } from "@ash/shared/monitor";
import { db, dbClient } from "./db/index.js";
import { monitors, scheduledMessages } from "./db/schema.js";
import { now } from "./util.js";

/**
 * **这条哨兵的收尾此刻归谁**(为什么要这个槽位,见 monitor-finish.ts 的 `finishing`)。
 * 键 = 哨兵 id,值 = 那一笔跑完为止(只 resolve,不 reject)。
 */
const finishing = new Map<string, Promise<void>>();

/** 这条哨兵此刻有没有人正在收尾(手里可能还握着没交出去的行)。`null` = 没有。 */
export const finishInFlight = (monitorId: string): Promise<void> | null => finishing.get(monitorId) ?? null;

/** 占下「这条哨兵的收尾归我」。占到 = 一个幂等的 release;占不到 = `null`。 */
export function claimFinish(monitorId: string): (() => void) | null {
  if (finishing.has(monitorId)) return null;
  let settle!: () => void;
  finishing.set(monitorId, new Promise<void>((resolve) => { settle = resolve; }));
  let released = false;
  return () => {
    if (released) return;
    released = true;
    finishing.delete(monitorId);
    settle();
  };
}

/** ①:这一行所属的哨兵此刻正在这个进程里收尾。同步,领取方在发出 CAS 之前问。 */
export function finishingNow(origin: string | null | undefined): boolean {
  const id = monitorIdFromOrigin(origin);
  return id !== null && finishing.has(id);
}

/**
 * ②:收尾开始了。**落库失败不挡收尾**:这一进程里有槽位(①)挡着;这一笔只为活过重启,而写不进去
 * 的那个库,紧接着的终态那一笔多半也写不进去 —— 收尾失败会把监督交回来(`ensureSupervised`),
 * 下一次收尾再落一次。
 */
export async function markFinishing(monitorId: string): Promise<void> {
  if (dbClient.closed) return;
  await db.update(monitors).set({ finishingSince: now() })
    .where(and(eq(monitors.id, monitorId), eq(monitors.status, "running"), isNull(monitors.finishingSince)))
    .catch((e) => console.error(`[ash] 收尾开始的记号没落上 monitor=${monitorId}（这一进程里槽位照样挡着）:`, e));
}

/**
 * ② 撤掉:开机接回时确认**它当初那个进程还活着**(收尾做到一半 ash 没了,进程却没被杀掉 —— 推满
 * 上限、点到期那几种是 ash 自己去杀)。它又回到在盯,不欠结束;不撤的话它此后的每一批都要等到下一次
 * 收尾。只在这一处撤:进程退了、收尾失败后监督被交回来的那种,记号留着,下一次收尾接着用。
 */
export async function clearFinishing(monitorId: string): Promise<void> {
  await db.update(monitors).set({ finishingSince: null })
    .where(and(eq(monitors.id, monitorId), eq(monitors.status, "running")));
}

/** ②③ 的持久那一半:哪些哨兵还欠着结束。 */
const owedMonitor = and(
  isNull(monitors.resultsAbandonedAt),
  or(isNotNull(monitors.resultHandoffAt), and(eq(monitors.status, "running"), isNotNull(monitors.finishingSince))),
);

/**
 * 领取 CAS 里那一条:这一行**不是**一条还欠着结束的哨兵名下的。不是哨兵的行(origin 为空、或者
 * 别的来源)对不上任何一条哨兵,天然成立。
 */
export const endNotOwed = sql`NOT EXISTS (SELECT 1 FROM ${monitors} WHERE ${scheduledMessages.origin} = 'monitor:' || ${monitors.id} AND ${owedMonitor})`;

/**
 * 这个任务(缺省 = 全部)名下,还欠着结束的那些哨兵的 origin(①②③ 合起来)。
 *
 * 在一笔事务里问就把那笔事务传进来:全进程共用一条连接,事务里拿根 `db` 读会等这笔事务收尾。
 */
export async function endOwedOrigins(taskId?: string, executor: Pick<typeof db, "select"> = db): Promise<Set<string>> {
  const owed = new Set<string>();
  for (const id of finishing.keys()) owed.add(monitorMessageOrigin(id));
  if (dbClient.closed) return owed;
  const rows = await executor.select({ id: monitors.id }).from(monitors)
    .where(and(owedMonitor, taskId ? eq(monitors.taskId, taskId) : undefined));
  for (const r of rows) owed.add(monitorMessageOrigin(r.id));
  return owed;
}

/** 欠着的那一声落定之后(凭证销了、收尾放手了),把这条哨兵名下排着的行送出去。只是触发,不是资格。 */
export async function flushMonitorRows(monitorId: string): Promise<void> {
  if (dbClient.closed) return;
  const rows = await db.selectDistinct({ taskId: scheduledMessages.taskId }).from(scheduledMessages)
    .where(and(eq(scheduledMessages.origin, monitorMessageOrigin(monitorId)), eq(scheduledMessages.status, "pending")));
  const { flushPendingForTask } = await import("./pending-messages.js");
  for (const r of rows) flushPendingForTask(r.taskId);
}
