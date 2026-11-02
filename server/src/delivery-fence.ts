// **这一次投递的身份**,以及「迟到的写只许落在自己那一次上」那道条件。
//
// 为什么要有它(第 1 轮自由审查 F1,端到端实测):一条消息在它的一生里会被领取好几次 ——
// 第一次起跑被拒、归还、重投、第二次被 agent 收下。而上一版的归还(`abortDelivery`)和
// 送达确认(`markSent`)只按「消息 id + status」写:**消息 id 是一个永久可复用的操作权限**。
// 于是第一次投递留下的拒收补偿(归还那一笔第一次写失败,租约自排退避)在第二次投递已经被
// 收下之后才醒来,照样把**新一轮**的租约清掉;周期扫描看见一条「无人在送的 pending」,同一条
// `perform-operation-once` 就进了第二个回合。
//
// 所以每一次领取都铸一个**不可复用**的租约值,所有迟到的写都得证明「我手上那一次还是现在
// 这一次」才落得下:
//   · 普通消息 —— 比租约值本身(`deliveringSince`)。它原来只是一个时刻,同一毫秒里先后两次
//     领取会撞值;这里改成**进程内严格递增**的时刻,两次领取一定不同(进程一换全清,
//     见 pending-messages.ts 的 reclaimStaleDeliveries,所以不必跨进程唯一);
//   · 续跑凭证 —— 比所有权身份(`deliveringOwner`,每次接管都换,见 checkpoint-ownership.ts),
//     老库开出来的没有身份,退回比租约值(与 holdCheckpointOwnership 同一口径)。
//
// 写不中(0 行)不是错误:那就是「我那一次早就不是现在这一次了」,新持有者的账不许我写。
import { and, eq, isNull, or, type SQL } from "drizzle-orm";
import { scheduledMessages } from "./db/schema.js";

type Row = typeof scheduledMessages.$inferSelect;

let lastLeaseMs = 0;

/** 铸一个租约值:仍是 ISO 时刻(读的人照旧能当「什么时候领的」),但进程内严格递增。 */
export function mintLeaseStamp(): string {
  let at = Date.now();
  if (at <= lastLeaseMs) at = lastLeaseMs + 1;
  lastLeaseMs = at;
  return new Date(at).toISOString();
}

/**
 * 「这一行此刻还在 `row` 那一次投递手里」的 WHERE 条件。
 *
 * `row` 必须是**领取那一刻**的那一行(`beginDelivery` / 批量领取的 returning),不是领取前的
 * 快照 —— 快照的租约是空的,拿它当身份就只能写中「没人在送」的行,自己那一次反而写不中。
 */
export function leaseHeldBy(row: Pick<Row, "id" | "deliveringSince" | "deliveringOwner">): SQL {
  const held = row.deliveringOwner !== null
    ? eq(scheduledMessages.deliveringOwner, row.deliveringOwner)
    : row.deliveringSince !== null
      ? eq(scheduledMessages.deliveringSince, row.deliveringSince)
      : isNull(scheduledMessages.deliveringSince);
  return and(eq(scheduledMessages.id, row.id), held)!;
}

/** 一批行各自按自己那一次的身份(批量投递里每一行的租约值是同一笔领取铸出来的)。 */
export function leasesHeldBy(rows: Pick<Row, "id" | "deliveringSince" | "deliveringOwner">[]): SQL {
  return or(...rows.map(leaseHeldBy))!;
}
