// 哨兵结果的**第二个出口**:回合还在跑、结果已经排在托盘里时,随 `pause_task` / `complete_task`
// 的返回当场交给 agent,这一回合接着做,不为它暂停、再被叫醒一次。
//
// 第一个出口是老路:托盘里排着,任务空下来由 `flushPendingForTask` 起一个唤醒回合送进去
// (pending-messages.ts / pending-dispatch.ts)。量过的现场:七成的唤醒是排在某个回合后面等出来的,
// 其中一大半哨兵在 agent 调 `pause_task` 之前就已经结束 —— 结果明明在手边,它还是先收尾、再
// 被叫醒、把刚说过的结论重说一遍。
//
// ── 三条不变量 ──────────────────────────────────────────────────────────────────
//
// ① **只走一条路**。两个出口抢的是同一行、同一个条件:`status='pending' AND delivering_since
//    IS NULL`。唤醒那一路用租约 CAS 领取(`beginPendingBatch`),这一路用同一个条件把它直接写成
//    `sent` —— 谁的 UPDATE 真改到行谁就拿走,另一位那一行就不在候选里了。两边都只看这一个条件,
//    所以不需要另一把锁。**资格也写在那一条 UPDATE 里**(任务身份 / 方向 / running 作为 EXISTS
//    子句,合并窗口作为同一条件):前面那几次 SELECT 只是挑候选,改方向、落终态发生在挑完之后,
//    那一笔照样一行都改不到。来源审查在内存里判,改完再复核一次,失效的原样还回去。
//
// ② **不丢,宁可重复**。交出去那一刻只是「已交」,不是「已送达」:返回之后还隔着 MCP 进程、执行器、
//    一条可能断掉的通道,那一轮也完全可能随后崩掉、被停。所以行上记下**交给了哪一轮**
//    (`turn_taken_by` = 那一轮的回合令牌)和**这一次的回执号**(`turn_handoff`,随返回一起交出),
//    而「送到了」**只认一个证据**:那条会话自己的事件流里出现了这个回执号(monitor-turn-receipt.ts)。
//    服务端这一侧写下的任何一笔都不算 —— 出错之后补的那一笔写入本身也会失败,所以这里不做补偿,
//    出错就让它停在「交了、没有回执」:
//      · 同一轮再调 `pause_task` / `complete_task`:没有回执的那几行照样拦着完成、照样再交一次
//        (换一个回执号);
//      · 那一轮收口(`settleTurnHandoffs`,在 `settleTaskStatus` 最前面调):正常收口(交卷 / 留了
//        检查点 / 提问,续聊与旁路回合则是干净退出)**且**有回执 = 送达,销掉记号;其余(没有回执、
//        失败、被停、看门狗熔断、没交卷就退出)= 没送达,退回 pending,并记下 `turn_returned_at`;
//      · ash 自己没了(那一轮的结算根本没跑)→ 开机与每分钟一趟的 `returnOrphanTurnHandoffs` 把记号
//        对不上任何接回来的回合的那几行同样退回(逐任务排在 `task:<id>` 队列上、写之前复核归属)。
//    退回排在结算判终态**之前**,所以完成闸、终态落位的哨兵闸看得见它(没交卷的那一轮因此落成
//    检查点暂停、随后被唤醒送达)。会被终态连坐的落位(失败、被取消)也收不走它:带着退回记号
//    的 pending 行在任务终态时**留着等下一次起跑**(`cancelPendingMonitorEvents` 的
//    `keepReturned`、`deliveryVerdict` 的 wait),下一轮跑起来再从两个出口之一送达。
//    所有退回与销记号都按「行 id + 当时的领取者」做 CAS,不拿旧快照推断现在是谁的。
//    拿不出回执的执行器(事件流里不记工具返回原文的那几家)不做回合内交付,照老路唤醒。
//
// ③ **只交给本来会被它叫醒的那条会话**。判据跟唤醒那一路投递时恢复的身份是同一份:
//    消息上的 `session_role` + `review_run`/`review_round`(入队时从哨兵行抄下来,见
//    monitor-events.ts),对上这一轮回合身份里的角色与审查代次才算。审查者挂的哨兵,执行回合的
//    `pause_task` 收不走;反过来也一样。来源审查已经结束的(唤醒那一路会作废它)也不交。
//
// 这一侧**不碰**:真人排的话、定时消息、其它系统消息(只认 `monitor:` 来源、queued 模式);
// 团队调度台(只认 single 任务);带着续跑交代的那几行(`checkpoint_taken` 非空 —— 它们是唤醒
// 那一路上一次没送成的,交代的转手只有那一路会做,见 monitor-checkpoint-handoff.ts)。
import { and, eq, exists, inArray, isNotNull, isNull, like, lte, or, sql } from "drizzle-orm";
import { monitorIdFromOrigin } from "@ash/shared/monitor";
import { readMonitorWake, type MonitorWakeData, type MonitorWakeEvent } from "@ash/shared/monitor-wake";
import { bus } from "./bus.js";
import { db, dbClient } from "./db/index.js";
import { scheduledMessages, sessions, tasks } from "./db/schema.js";
import { monitorEventSourceState } from "./monitor-session.js";
import { serialize } from "./monitors.js";
import { hasPendingDeliveryRecovery } from "./pending-delivery-recovery.js";
import { turnIdentity } from "./runs.js";
import { newHand, RECEIPT_AGENTS, receiptMark, receivedRows } from "./monitor-turn-receipt.js";
import { appendTaskTimeline, noticeLine, receiptLine } from "./task-timeline.js";
import { now } from "./util.js";
import type { SQL } from "drizzle-orm";

type Row = typeof scheduledMessages.$inferSelect;

/**
 * 交到 agent 手上的那一份:正文(原样拼进工具返回,打头是这一次的回执号)+ 结构化来源(落进会话记录)。
 */
export type HandedMonitorResults = { text: string; monitorWake: MonitorWakeData; count: number };

// ── 返回里那句话 ──────────────────────────────────────────────────────────────
// 「结果已经给你了、接着做」只在**返回**里说:工具说明常驻每个回合的上下文、有字节预算,
// 而这句话只在真交了的那一次有用。
export const PAUSE_HANDED_NOTE =
  "没有暂停：调用这一刻你名下的哨兵结果已经到了，就在下面，这一回合接着做。"
  + "还有别的要等就再调一次 pause_task，没有了就 complete_task。";

/** `still` = 交完之后完成闸里还剩的那句拒绝(`null` = 没剩)。 */
export const completeHandedNote = (still: string | null): string =>
  "完成确认这一次没有生效：你名下有哨兵结果到了、还没送到你手上，现在随这次返回交给你（就在下面），先看过再定。"
  + (still ? `看完之后还有这一层：${still}` : "看完没有别的要做，再调一次 complete_task 就能确认。");

/**
 * **这一轮已经开始收口了** —— 收口那一刻起不许再交(键 = 任务,值 = 那一轮的令牌)。
 *
 * 结算把「交过的那几行」结清之后,这一轮在库里仍是 running、回合身份也还占着,一个迟到的
 * `pause_task` 照样过得了身份校验;它要是再交一次,记号就挂在一个再也不会被结清的回合上。
 * 两边都排在 `task:<id>` 那条队列上,所以这个标记要么在交付之前立起、要么在它之后 —— 前者
 * 一个都不交,后者由结清那一笔一起处理。令牌每轮一换,所以不用清。
 */
const closing = new Map<string, string>();

/** 这条消息醒来时叫的是哪条会话,跟这一轮对得上吗(判据见文件头 ③)。 */
function targetsTurn(m: Row, turn: { role: string; review: { run: string; round: number } | null }): boolean {
  const reviewer = m.sessionRole === "reviewer";
  if (reviewer !== (turn.role === "reviewer")) return false;
  if (!reviewer) return true;
  // 消息没记下是哪一轮(存量 / unbound)只配给同样不绑审查的那一轮。
  if (!m.reviewRun || !turn.review) return !m.reviewRun && !turn.review;
  return m.reviewRun === turn.review.run && (m.reviewRound ?? 1) === turn.review.round;
}

/** 把交出去的几行拼成跟唤醒输入同一个形状的来源(缺结构的老行按原文补一条)。 */
function handedWake(rows: Row[]): MonitorWakeData {
  const events: MonitorWakeEvent[] = [];
  let omittedEvents = 0;
  for (const row of rows) {
    const wake = readMonitorWake(row.monitorWake);
    if (wake) {
      events.push(...wake.events);
      omittedEvents += wake.omittedEvents;
    } else {
      // 升级前入队的老行没有结构:正文里带着结束抬头就是结束(合并过的那种也以结束计),否则是输出。
      const kind = row.text.includes("【哨兵结束】") ? "ended" : "output";
      events.push({ kind, monitorId: monitorIdFromOrigin(row.origin) ?? "", source: "", body: row.text });
    }
  }
  return { version: 1, events, omittedEvents };
}

/**
 * 这一轮调用 `pause_task` / `complete_task` 的那一刻,托盘里**本来就会把这条会话叫醒**的
 * 哨兵结果,当场交给它;这一轮早先交过、它却没收到(没有回执)的那几行一起再交一次。没有可交的
 * = `null`(调用方照老路走)。
 *
 * **调用方必须排在 `task:<id>` 那条队列上**(完成闸、结算的结清都在那上面,见 `closing`)。
 * `where` 是调用方那套身份条件(回合令牌、方向令牌、running),跟交付同一时刻核:身份对不上
 * 就一行都不交。
 */
export async function takeMonitorResultsForTurn(a: {
  taskId: string;
  token: string | null | undefined;
  where: (SQL | undefined)[];
  via: "pause" | "complete";
}): Promise<HandedMonitorResults | null> {
  if (!a.token || dbClient.closed) return null;
  const token = a.token;
  const turn = turnIdentity(a.taskId);
  if (!turn || turn.token !== token || closing.get(a.taskId) === token) return null;
  // 唤醒那一路正在退回一批没送成的(补偿还没做完):那几行的去向归它,这里不插手。
  if (hasPendingDeliveryRecovery(a.taskId)) return null;
  const eligible = and(eq(tasks.id, a.taskId), eq(tasks.mode, "single"), eq(tasks.archived, false), ...a.where);
  if (!(await db.select({ id: tasks.id }).from(tasks).where(eligible)).length) return null;
  // 这一轮自己那条会话:回执要从它的事件流里认,会话记录也落在它上面。拿不出回执的执行器不交。
  const session = (await db.select({ id: sessions.id, agentType: sessions.agentType }).from(sessions)
    .where(and(eq(sessions.taskId, a.taskId), isNull(sessions.endedAt),
      eq(sessions.role, turn.role === "reviewer" ? "reviewer" : "single")))
    .orderBy(sessions.turnStartedAt)).at(-1);
  if (!session || !RECEIPT_AGENTS.has(session.agentType)) return null;
  const at = now();
  const pending = await db.select().from(scheduledMessages).where(and(
    eq(scheduledMessages.taskId, a.taskId),
    eq(scheduledMessages.status, "pending"),
    isNull(scheduledMessages.deliveringSince),
    eq(scheduledMessages.mode, "queued"),
    like(scheduledMessages.origin, "monitor:%"),
    isNull(scheduledMessages.checkpointTaken),
  ));
  const candidates: Row[] = [];
  for (const m of pending) {
    if (!targetsTurn(m, turn)) continue;
    if (await monitorEventSourceState(m.origin) === "stale") continue;
    candidates.push(m);
  }
  // 这一轮早先交过、它却没收到的(那一次返回出错 / 没回到它手上):这一次一起再交。
  const owed = await owedRows(a.taskId, token);
  if (!candidates.length && !owed.length) return null;
  const handoff = { hand: newHand(), session: session.id, at };
  const claimable = exists(db.select({ one: sql`1` }).from(tasks).where(eligible));
  // 同一个条件、一条语句(文件头 ①):唤醒那一路刚领走的、挑完之后身份变了的,都不会出现在 returning 里。
  const claimed = candidates.length ? await db.update(scheduledMessages)
    .set({ status: "sent", sentAt: at, turnTakenBy: token, turnHandoff: handoff })
    .where(and(
      inArray(scheduledMessages.id, candidates.map((m) => m.id)),
      eq(scheduledMessages.status, "pending"),
      isNull(scheduledMessages.deliveringSince),
      or(isNull(scheduledMessages.mergeHoldUntil), lte(scheduledMessages.mergeHoldUntil, at)),
      claimable,
    ))
    .returning() : [];
  const reissued = owed.length ? await db.update(scheduledMessages).set({ turnHandoff: handoff })
    .where(and(inArray(scheduledMessages.id, owed.map((m) => m.id)), eq(scheduledMessages.status, "sent"),
      eq(scheduledMessages.turnTakenBy, token), claimable))
    .returning() : [];
  // 来源审查在挑完之后结束了的:原样还回去(不打退回记号),唤醒那一路会照来源失效作废它。
  const stale: string[] = [];
  for (const m of claimed) if (await monitorEventSourceState(m.origin) === "stale") stale.push(m.id);
  if (stale.length) {
    await db.update(scheduledMessages).set({ status: "pending", sentAt: null, turnTakenBy: null, turnHandoff: null })
      .where(and(inArray(scheduledMessages.id, stale), eq(scheduledMessages.status, "sent"),
        eq(scheduledMessages.turnTakenBy, token)));
  }
  const taken = [...reissued, ...claimed.filter((m) => !stale.includes(m.id))]
    .sort((x, y) => x.sendAt.localeCompare(y.sendAt) || x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id));
  if (claimed.length) {
    bus.publish({ type: "task.pendingMessages", taskId: a.taskId });
    bus.publish({ type: "task.monitors", taskId: a.taskId });
  }
  if (!taken.length) return null;
  const body = taken.map((m) => m.text).join("\n\n");
  const monitorWake = handedWake(taken);
  // 会话里留一条带类型的记录:交了哪几条哨兵的什么、什么时候。写不下来就不交(这几行停在「交了、
  // 没有回执」,下一次照样再交、收口时退回):没有这条记录,刷新之后谁也看不出这一轮里发生过这件事。
  const recorded = await appendTaskTimeline(a.taskId,
    noticeLine({ kind: "monitor.handed", via: a.via, monitorWake }, body), { sessionId: session.id });
  if (!recorded) return null;
  return { text: `${receiptMark(handoff.hand)}\n${body}`, monitorWake, count: taken.length };
}

/** 这一轮交过、它的事件流里却没有回执的那几行(`token` 缺省 = 不管是哪一轮交的)。 */
async function owedRows(taskId: string, token?: string): Promise<Row[]> {
  const held = await db.select().from(scheduledMessages).where(and(
    eq(scheduledMessages.taskId, taskId), eq(scheduledMessages.status, "sent"),
    token ? eq(scheduledMessages.turnTakenBy, token) : isNotNull(scheduledMessages.turnTakenBy),
  ));
  const received = receivedRows(taskId, held);
  return held.filter((m) => !received.has(m));
}

/**
 * 交过、却还没有回执的那几行有几条 —— 完成闸的第四类(task-complete.ts):它们跟托盘里排着的
 * 一样是「结果到了、还没送到它手上」,确认完成之前必须先送到。
 */
export async function owedTurnHandoffs(taskId: string): Promise<number> {
  if (dbClient.closed) return 0;
  return (await owedRows(taskId)).length;
}

/** 完成闸只因为这一类被拦、却没能再交出去时(身份不对、会话记录写不下)的那句拒绝。 */
export const owedHandoffNote = (count: number): string =>
  `你名下有 ${count} 条哨兵结果交给过你、却没能确认送到你手上，确认完成之前得先收到它们。`
  + "再调一次 complete_task 会把它们重新交给你；不想在这一轮收就调 pause_task，醒来时会再送一遍。";

/**
 * `pause_task` 那一刻:有可交的就交、这次不暂停;没有就 `null`,调用方照老路记检查点。
 *
 * 排在 `task:<id>` 那条队列上 —— 跟完成闸、结算的结清同一条(见 `closing`)。
 */
export async function handMonitorResultsOnPause(
  taskId: string, token: string | null, where: (SQL | undefined)[],
): Promise<HandedMonitorResults | null> {
  return serialize(`task:${taskId}`, () => takeMonitorResultsForTurn({ taskId, token, where, via: "pause" }));
}

/**
 * 一轮收口:它在回合里拿过的那几条,按它怎么收口、它收没收到结清(判据见文件头 ②)。
 *
 * 在 `settleTaskStatus` 的最前面调 —— 排在完成闸、终态哨兵闸之前,退回来的那几行它们才看得见。
 * **只把这一轮的当送达**;同一个任务上记号对不上这一轮的(前一轮的残留:结算没跑完 ash 就没了,
 * 开机那一扫又没赶上)一律按没送达退回。
 */
export async function settleTurnHandoffs(taskId: string, token: string | null, closedNormally: boolean): Promise<void> {
  if (dbClient.closed) return;
  await serialize(`task:${taskId}`, async () => {
    if (token) closing.set(taskId, token);
    const held = await db.select().from(scheduledMessages)
      .where(and(eq(scheduledMessages.taskId, taskId), eq(scheduledMessages.status, "sent"),
        isNotNull(scheduledMessages.turnTakenBy)));
    if (!held.length) return;
    const received = receivedRows(taskId, held);
    const mine = held.filter((m) => m.turnTakenBy === token);
    const delivered = closedNormally ? mine.filter((m) => received.has(m)).map((m) => m.id) : [];
    if (delivered.length && token) {
      await db.update(scheduledMessages).set({ turnTakenBy: null })
        .where(and(inArray(scheduledMessages.id, delivered), eq(scheduledMessages.status, "sent"),
          eq(scheduledMessages.turnTakenBy, token)));
    }
    const back = held.filter((m) => !delivered.includes(m.id));
    const unread = back.filter((m) => closedNormally && m.turnTakenBy === token);
    const crashed = back.filter((m) => !unread.includes(m));
    const rows = (list: Row[]) => list.map((m) => ({ id: m.id, by: m.turnTakenBy! }));
    if (unread.length) await returnTaken(taskId, rows(unread), "那次返回没有回到它手上（事件流里没有回执）");
    if (crashed.length) await returnTaken(taskId, rows(crashed), "这一回合没有正常收口");
  });
}

/**
 * 退回 pending,并留下退回记号(它让这几行熬得过终态连坐,见文件头 ②)。
 * 按「行 id + 当时的领取者」逐组 CAS:领取者已经换了的(先被退回、又交给了下一轮)一行都不碰。
 */
async function returnTaken(taskId: string, rows: Array<{ id: string; by: string }>, why: string): Promise<number> {
  const byTaker = new Map<string, string[]>();
  for (const r of rows) byTaker.set(r.by, [...(byTaker.get(r.by) ?? []), r.id]);
  const back: string[] = [];
  for (const [by, ids] of byTaker) {
    back.push(...(await db.update(scheduledMessages)
      .set({ status: "pending", sentAt: null, turnTakenBy: null, turnHandoff: null, turnReturnedAt: now() })
      .where(and(inArray(scheduledMessages.id, ids), eq(scheduledMessages.status, "sent"),
        eq(scheduledMessages.turnTakenBy, by)))
      .returning({ id: scheduledMessages.id })).map((m) => m.id));
  }
  if (!back.length) return 0;
  bus.publish({ type: "task.pendingMessages", taskId });
  bus.publish({ type: "task.monitors", taskId });
  await appendTaskTimeline(taskId, receiptLine(
    `回合里交给它的 ${back.length} 条哨兵结果退回了待发送：${why}，不能确定它读到了。下一次跑起来会再送一遍。`,
  ));
  return back.length;
}

/**
 * 开机那一扫:记号挂在一个**没被接回来**的回合上的那几行,一律按没送达退回。
 *
 * 必须排在 `reattachRunningTasks` 之后(接回来的回合令牌已经绑回内存,它们还在跑,照旧等自己
 * 收口)、`reconcileInterrupted` 之前(那一步会把没接回的落终态,退回来的行要先在场才熬得过
 * 那次连坐,见文件头 ②)。
 */
export async function returnOrphanTurnHandoffs(): Promise<number> {
  // 开机那一趟和每分钟那一趟可能撞上:同一时刻只跑一趟,后到的拿同一个结果。
  sweeping ??= sweepOrphans().finally(() => { sweeping = null; });
  return sweeping;
}

let sweeping: Promise<number> | null = null;

async function sweepOrphans(): Promise<number> {
  if (dbClient.closed) return 0;
  const taskIds = new Set((await db.select({ taskId: scheduledMessages.taskId }).from(scheduledMessages)
    .where(and(eq(scheduledMessages.status, "sent"), isNotNull(scheduledMessages.turnTakenBy)))).map((m) => m.taskId));
  let returned = 0;
  // 逐任务排进 `task:<id>` 那条队列、在里面重读:领取、结算、补捞都排在同一条上,快照不跨过它们。
  for (const taskId of taskIds) {
    await serialize(`task:${taskId}`, async () => {
      if (dbClient.closed) return;
      const held = await db.select({ id: scheduledMessages.id, by: scheduledMessages.turnTakenBy })
        .from(scheduledMessages)
        .where(and(eq(scheduledMessages.taskId, taskId), eq(scheduledMessages.status, "sent"),
          isNotNull(scheduledMessages.turnTakenBy)));
      const token = turnIdentity(taskId)?.token;
      const orphans = held.filter((m) => m.by !== token).map((m) => ({ id: m.id, by: m.by! }));
      if (!orphans.length) return;
      returned += await returnTaken(taskId, orphans, "ash 重启时那一回合没能接回来");
    });
  }
  return returned;
}
