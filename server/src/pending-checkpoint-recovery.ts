import { and, eq, isNotNull, ne } from "drizzle-orm";
import { db, dbClient } from "./db/index.js";
import { scheduledMessages, sessionTurns, sessions, tasks } from "./db/schema.js";
import { crossingProvesAbsence, readDeliveryCrossing, type CrossingTurn } from "./delivery-crossing.js";
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
 * 这张**带着在途租约**的凭证,到底送出去没有 —— 三态,不是布尔。
 *
 *  · `not-started` —— **证明**这段输入还没越过 spawn 那条线:归还安全。
 *  · `delivered`   —— **证明**它已经到了 agent 手里:只能往前走(标 sent),永不归还。
 *  · `uncertain`   —— 越了线,但这一轮的记账没做完:**既不能归还也拿不到确认**。
 *
 * 为什么必须有第三态:早先这一问只有两态,判据是「租约时刻之后有没有回合开起来过」
 * (`sessions.turn_started_at`)—— 而那一列是在 **spawn 之后**才写的,于是「没有会话行」被
 * 当成了「一定没送出去」。真正不可逆的外部效果是 spawn/投喂,会话行只是事后记账;两者之间
 * 那条缝里进程被换掉,同一段交代就会被归还、重投、执行两遍(第 1 轮审查 F1 跨进程实测,
 * 现场与判据见 delivery-crossing.ts 的文件头)。
 *
 * **只认带身份的那一份证据**。越线记号上写着交出这段话的是哪条会话、哪一刻开的回合
 * (orchestrator 在 spawn 前那一行落的);「送达」= 记号在、**而且记号上那一轮**确实开起来了
 * (`session_turns` 有那个 `(会话, 起点)`,或者那条会话行此刻正停在那个起点上)。早先这里先问
 * 「这个任务在租约之后开过任何一个回合没有」,命中就判送达 —— 可同一个任务上别的回合(审查
 * 旁路、续聊、用户再点一次运行)一样会命中,那段交代于是被当成已送达划掉,agent 从没收到,
 * 时间线上也不留「交付不明」那条带原文的记录(第 1 轮逻辑审查 4)。时间窗是同一件事的弱证据,
 * 它跟带身份的那一份说法不同时不该由它定论,所以现在不再单独参与判定。
 *
 *  · 记号在、那一轮有行             —— `delivered`;
 *  · 记号在、那一轮没有行(或者记号上读不出是哪一轮) —— 越了线、记账没做完:`uncertain`;
 *  · 记号不在、目录在、凭证是硬前置那一代 —— 否证:`not-started`;
 *  · 其余(读不出来、旧代凭证)        —— `uncertain`。
 *
 * 记号读不出来(目录没了、权限没了、I/O 错)**不是否证**:第 2 轮自由审查实测,凭据写入
 * 失败只告警的那一版里,`existsSync` 的失败方向同样是 false,两头一夹,一段已经喂给 agent
 * 的交代被归还重投、执行了两遍。现在写入是硬前置(delivery-crossing.ts 的文件头),读取
 * 这一侧也必须把「没有」和「没问出来」分开 —— 后者归到交付不明,由人裁定。
 *
 * 偏向仍然是明的:宁可多卡一会儿(确认会被补记上去)也不误归还,因为误归还会把已经喂给
 * agent 的那段话重新变成待执行输入。
 */
export type CheckpointDelivery = "not-started" | "delivered" | "uncertain";

export async function checkpointDeliveryVerdict(
  receipt: { id: string; taskId: string; deliveringSince: string | null; crossingProtocol: string | null },
): Promise<CheckpointDelivery> {
  if (!receipt.deliveringSince) return "not-started";
  const crossing = readDeliveryCrossing(receipt.taskId, receipt.id);
  if (crossing.state === "crossed") {
    return crossing.about && await turnRecorded(crossing.about) ? "delivered" : "uncertain";
  }
  // 否证的效力**跟着凭证走**,不跟着当前代码走:只有在「写记号是硬前置」的那一代里开出来的
  // 票据,才有资格拿「目录在、这一条不在」当「没送出去」。旧代的凭证长得一模一样,但它当时
  // 允许记号写失败后照常 spawn —— 升级之后用新判据读它,就是把它当时没有的证明力追认给它
  // (第 2 轮自由审查 F1:同一段交代在升级后被执行两遍)。不认得的代次按旧代处理。
  if (!crossingProvesAbsence(receipt.crossingProtocol)) return "uncertain";
  return crossing.state === "absent" ? "not-started" : "uncertain";
}

/** 记号上那一轮确实开起来过吗。两处都按**同一个身份**问:回合表一个回合一行;会话行跨回合
 *  复用,只在它此刻正停在那个起点上时才算数(后来又开过一轮,它就说不出那一轮了)。 */
async function turnRecorded(turn: CrossingTurn): Promise<boolean> {
  const opened = await db.select({ id: sessionTurns.id }).from(sessionTurns).where(and(
    eq(sessionTurns.sessionId, turn.sessionId), eq(sessionTurns.startedAt, turn.turnStart),
  )).limit(1);
  if (opened.length) return true;
  const current = await db.select({ id: sessions.id }).from(sessions).where(and(
    eq(sessions.id, turn.sessionId), eq(sessions.turnStartedAt, turn.turnStart),
  )).limit(1);
  return current.length > 0;
}

/**
 * 在途租约的**对账**:把「送达已经发生、只差一笔确认」「压根没越过 spawn」「越了线却没落下
 * 会话行」三种分开,各走各的出路(判定 `checkpointDeliveryVerdict`,出路 `settleStrandedCheckpointRun`)。
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
      await delivery.settleStrandedCheckpointRun(receipt, "接管在途续跑交代");
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
    const verdict = await checkpointDeliveryVerdict(receipt);
    if (verdict === "delivered") {
      return "这一轮的续跑交代已经送到 agent 手里，只差系统把「已送达」记上账（正在自动补记）"
        + " —— 补记成功后就能再启动；它不会被归还，否则同一段交代会被执行两遍";
    }
    // 交付不明:这一句只会在「对账还没跑到 / 刚才那趟对账自己失败了」的窗口里出现 ——
    // 对账会把它就地了结成一条交付不明的可见交代(settleStrandedCheckpointRun),不留死局。
    if (verdict === "uncertain") {
      return "这一轮的续跑交代可能已经交给 agent 进程了（越线记号还在，或者读不出来），但"
        + "「送达」那一笔没来得及记下，系统分不清它到底执行了没有 —— 正在把它结成一条交付不明的"
        + "记录（原文会留在任务时间线里，由你决定要不要再送一遍）；它不会被自动重投，否则同一段"
        + "交代可能被执行两遍";
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
