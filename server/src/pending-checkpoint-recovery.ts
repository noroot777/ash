import { and, eq, gte, isNotNull, ne } from "drizzle-orm";
import { db, dbClient } from "./db/index.js";
import { scheduledMessages, sessions, tasks } from "./db/schema.js";
import { restoreMonitorCheckpoint } from "./monitor-checkpoint-handoff.js";

export const CHECKPOINT_RUN_ORIGIN = "checkpoint:resume";

const undeliveredCheckpoint = () => and(
  ne(scheduledMessages.status, "sent"),
  isNotNull(scheduledMessages.checkpointTaken),
);

/**
 * 本进程此刻有一条路**正在送**这几张续跑凭证(claimCheckpointForRun 登记,送达确认成功或者
 * 归还时划掉)。
 *
 * 它是「谁可以接管这张在途租约」的第一道闸:登记里有 = 送它的那条路还在跑,它自己会把
 * `markSent` 或者归还做完,别人插手只会双写(把一条正在送的交代归还回任务 → 送完再送一遍)。
 * 重启之后这张表是空的 —— 按定义此刻没有任何投递在进行中(同 `reclaimStaleDeliveries` 的
 * 理由),所以开机那一拍什么都接得了。
 */
const deliveringNow = new Set<string>();
export const noteCheckpointDelivering = (messageId: string): void => void deliveringNow.add(messageId);
export const forgetCheckpointDelivering = (messageId: string): void => void deliveringNow.delete(messageId);

/**
 * 这张**带着在途租约**的凭证,到底送出去没有。
 *
 * 判据是一条可证伪的因果:送达回调(`onDelivered`)排在 orchestrator 的 `persistRunner`
 * 之后,而那一步必定把这一轮的起点刷进 `sessions.turn_started_at`(新建走
 * `freshTurnFields`、复用走 `resumedTurnFields`,两条分支都从 session-turns.ts 的 helper 取)。
 * 于是
 *
 *     送达 ⟹ 租约时刻之后有回合开起来过。
 *
 * 能拿来用的是它的**逆否**:这之后一个回合都没开过 ⇒ 一定没送出去 ⇒ 归还安全。反方向不成立
 * (那个回合也可能是别的入口开的),所以另一侧一律按「已送达」处理 —— 这是**故意偏向**的那
 * 一边:多卡一会儿只是晚一点能启动(确认会被补记上去),误归还却会把已经喂给 agent 的那段话
 * 重新变成待执行输入,同一段交代执行两遍(第 1 轮审查必须修 3 明确点了这条约束)。
 */
export async function checkpointDelivered(
  receipt: { taskId: string; deliveringSince: string | null },
): Promise<boolean> {
  if (!receipt.deliveringSince) return false;
  const opened = await db.select({ id: sessions.id }).from(sessions).where(and(
    eq(sessions.taskId, receipt.taskId),
    isNotNull(sessions.turnStartedAt),
    gte(sessions.turnStartedAt, receipt.deliveringSince),
  ));
  return opened.length > 0;
}

/**
 * 在途租约的**对账**:把「送达已经发生、只差一笔确认」和「压根没送出去」分开,各走各的出路。
 *
 * 为什么非得有这一步:`onDelivered` 里 `delivered = true` 排在 `await markSent` 之前
 * (task-resume.ts),所以 `markSent` 抛错时既不落 sent、也不走归还,而那个异常又被
 * orchestrator 的 `catch {}` 吞掉 —— 那张 `status=canceled` + 在途租约 + `checkpoint_taken`
 * 的凭证就地滞留:`recoverPendingCheckpoints` 一律跳过带租约的行,`pendingCheckpointBlockReason`
 * 却一律按它拒绝启动,于是这个任务此后一律起不来(第 1 轮审查必须修 3,已实测)。
 *
 * 而「把 `delivered = true` 挪到确认之后」不是解法:那样 `markSent` 失败就会走归还,把**已经
 * 喂给 agent 的那段话**重新变成待执行输入。所以这里的取舍是明的 ——
 * **送达一旦成为事实,这张凭证就只能往前走(标 sent),永不归还。**
 *
 * 开机那一拍(`reclaimStaleDeliveries` 的第一句)和每一次启动前(`preparePendingCheckpointStart`)
 * 都跑一遍:前者接管上一个进程留下的,后者让用户再点一次运行就能把补记推进一步。
 */
export async function reconcileCheckpointDeliveries(taskId?: string): Promise<void> {
  if (dbClient.closed) return;
  try {
    await reconcileLeasedCheckpoints(await db.select().from(scheduledMessages).where(and(
      undeliveredCheckpoint(),
      isNotNull(scheduledMessages.deliveringSince),
      taskId ? eq(scheduledMessages.taskId, taskId) : undefined,
    )));
  } catch (error) {
    console.error(`[ash] 在途续跑交代读取失败 task=${taskId ?? "all"}:`, error);
  }
}

/**
 * 上面那一问的本体,行由调用方给 —— `recoverPendingCheckpoints` 已经把这些行读出来了,
 * 这里不再读第二遍。
 *
 * 只认 `CHECKPOINT_RUN_ORIGIN`:哨兵唤醒那种消息也会带 `checkpoint_taken` + 租约,但它滞留的
 * 后果是「消息留在托盘等重投」,既有口径,不在这一问的范围里(第 1 轮审查必须修 3 只点了
 * task-resume.ts 那一处)。
 */
async function reconcileLeasedCheckpoints(rows: (typeof scheduledMessages.$inferSelect)[]): Promise<void> {
  const stranded = rows.filter((row) => row.deliveringSince !== null
    && row.origin === CHECKPOINT_RUN_ORIGIN && !deliveringNow.has(row.id));
  if (!stranded.length) return;
  const delivery = await import("./task-checkpoint-delivery.js");
  for (const receipt of stranded) {
    try {
      if (await checkpointDelivered(receipt)) {
        console.warn(`[ash] 接管在途续跑交代 task=${receipt.taskId} message=${receipt.id}：`
          + `原文已送达（租约之后有回合开起来过），补记这一笔确认`);
        await delivery.acknowledgeCheckpointRun(receipt);
      } else {
        console.warn(`[ash] 接管在途续跑交代 task=${receipt.taskId} message=${receipt.id}：`
          + `租约之后一个回合都没开过（一定没送出去），归还给任务`);
        await delivery.returnCheckpointRun(receipt);
      }
    } catch (error) {
      console.error(`[ash] 在途续跑交代对账失败 task=${receipt.taskId} message=${receipt.id}:`, error);
    }
  }
}

export async function recoverPendingCheckpoints(taskId?: string): Promise<Map<string, "read" | "restore">> {
  const failed = new Map<string, "read" | "restore">();
  if (dbClient.closed) return failed;
  let receipts: (typeof scheduledMessages.$inferSelect)[];
  try {
    // 带租约的行**也一起读出来**(早先这一问只读 `delivering_since IS NULL`):它们不是「没人
    // 管」,而是「有一次投递在途」,该走的是对账而不是回填 —— 两种在同一张表上只差这一列,
    // 分两次读就会多一趟查询,把按序号注入故障的回归用例一起带偏。
    receipts = await db.select().from(scheduledMessages).where(and(
      undeliveredCheckpoint(),
      taskId ? eq(scheduledMessages.taskId, taskId) : undefined,
    ));
  } catch (error) {
    console.error(`[ash] 未送达续跑交代读取失败 task=${taskId ?? "all"}:`, error);
    if (!taskId) throw error;
    failed.set(taskId, "read");
    return failed;
  }
  for (const receipt of receipts) {
    if (receipt.deliveringSince !== null || failed.has(receipt.taskId)) continue;
    try {
      await restoreMonitorCheckpoint(receipt);
    } catch {
      failed.set(receipt.taskId, "restore");
    }
  }
  await reconcileLeasedCheckpoints(receipts);
  return failed;
}

export async function pendingCheckpointBlockReason(
  taskId: string,
  ownedMessageIds: readonly string[] = [],
): Promise<string | null> {
  const receipts = await db.select().from(scheduledMessages).where(and(
    eq(scheduledMessages.taskId, taskId), undeliveredCheckpoint(),
  ));
  const owned = new Set(ownedMessageIds);
  const blocking = receipts.filter((receipt) => !owned.has(receipt.id) || receipt.deliveringSince === null
    || (receipt.status !== "pending" && receipt.origin !== CHECKPOINT_RUN_ORIGIN));
  if (!blocking.length) return null;
  // 「已经送到 agent 手里、只差这一笔确认」必须跟「还没送出去」**分开说**:前者的出路是补记
  // (系统自己在退避重试,见 acknowledgeCheckpointRun),后者才是归还。两种挤成同一句话时,
  // 用户看到的是一条没有出路的死信 —— 实测这个任务此后一律起不来,界面上连一个可取消的东西
  // 都看不到(那张凭证不在待发送托盘里),只有重启服务能解。这一句就是那条缝的**可见状态**。
  for (const receipt of blocking) {
    if (receipt.origin !== CHECKPOINT_RUN_ORIGIN || !receipt.deliveringSince) continue;
    if (await checkpointDelivered(receipt)) {
      return "这一轮的续跑交代已经送到 agent 手里，只差系统把「已送达」记上账（正在自动补记）"
        + " —— 补记成功后就能再启动；它不会被归还，否则同一段交代会被执行两遍";
    }
  }
  return "未送达的续跑交代仍由消息账本保管，归还或完成交接后才能启动";
}

export async function preparePendingCheckpointStart(taskId: string): Promise<string | null> {
  try {
    if (dbClient.closed) return "数据库正在关闭，续跑交代尚未交接";
    // recoverPendingCheckpoints 这一趟连带把在途租约对一遍账(见它里面那句
    // reconcileLeasedCheckpoints):一张「已送达、确认没写成」的凭证于此被推到 sent,
    // 所以**用户点一次运行**就是这条路上能把补记推进一步的动作,不必非等重启。
    const failed = await recoverPendingCheckpoints(taskId);
    if (failed.get(taskId) === "read") return "暂时无法确认续跑交代的持久归属，请稍后重试";
    if (failed.has(taskId)) return "续跑交代归还失败，原文仍保存在消息账本中，请稍后重试";
    return await pendingCheckpointBlockReason(taskId);
  } catch (error) {
    console.error(`[ash] 续跑交代准入检查失败 task=${taskId}:`, error);
    return "暂时无法确认续跑交代的持久归属，请稍后重试";
  }
}

export async function checkpointReadyTask(taskId: string): Promise<typeof tasks.$inferSelect | null> {
  return db.transaction(async (transaction) => {
    const outstanding = await transaction.select({ id: scheduledMessages.id }).from(scheduledMessages)
      .where(and(eq(scheduledMessages.taskId, taskId), undeliveredCheckpoint()));
    if (outstanding.length) return null;
    return (await transaction.select().from(tasks).where(eq(tasks.id, taskId))).at(0) ?? null;
  });
}
