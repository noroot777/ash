// 「改归属」的写入口在队列认领链上(queue-claim-chain.ts)按**此刻的库**重验合法性。进门时那次
// 校验读的是请求到达那一刻的快照,隔着建任务、等链的整段 await,写入时它早就不作数了:串行只决定
// 谁先谁后,不会替后到的那一笔判断它还合不合法。
import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "./db/index.js";
import { groups, queueItems, tasks } from "./db/schema.js";
import { queueJoinRefusal } from "./queues.js";
import type { QueueJoinWriter } from "./task-store.js";
import { now } from "./util.js";
import { holdsSlot } from "./launch-slots.js";

/** 建任务时串进队列被拒(队列没了、或已经不和新任务同项目同组)。整笔创建随之回滚。 */
export class QueueJoinRefused extends Error {}

/**
 * 改 groupId 之前问一句:现在还能改吗。在链里调用。返回 null = 可以改。
 *   · 目标分组此刻还在、还属于这个项目:进门时那次查过,但删分组可能就排在它前面;
 *   · 已经占好位、在跑、或者占着名额正要起跑(库里还是 backlog)的不换组:它占着旧组的并发名额
 *     (launch-slots.ts),挪过去新组就多跑一条、名额却还在旧组账上。占名额的那几路在链上按当前
 *     分组再认一次(member-start.ts admit、queue-seat.ts `slotGroup`),所以改分组落在它占名额之前
 *     的,由起跑方发现组变了、退回去按新组重排。团队调度台不在此列:它的 running 是常驻,不占分组名额;
 *   · 跟别的成员同在一条队列里的不单独换组:同一队列必须同组(queues.ts 不变量①)。
 */
export async function groupMoveRefusal(taskId: string, groupId: string | null): Promise<string | null> {
  const row = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!row || (row.groupId ?? null) === groupId) return null;
  if (groupId !== null) {
    const target = (await db.select({ id: groups.id }).from(groups)
      .where(and(eq(groups.id, groupId), eq(groups.projectId, row.projectId)))).at(0);
    if (!target) return "目标分组已经不存在了";
  }
  if (row.mode !== "team" && (row.status === "running" || row.status === "queued")) {
    return "任务正在运行，占着原分组的并发名额，等这一轮结束再换分组";
  }
  if (row.mode !== "team" && holdsSlot(taskId)) return "任务正在起跑，占着原分组的并发名额，等这一轮结束再换分组";
  const item = (await db.select({ queueId: queueItems.queueId }).from(queueItems).where(eq(queueItems.taskId, taskId))).at(0);
  if (!item) return null;
  const mates = await db.select({ taskId: queueItems.taskId }).from(queueItems).where(eq(queueItems.queueId, item.queueId));
  return mates.length > 1 ? "同一条队列里的任务必须在同一个分组，先把它移出队列再换分组" : null;
}

/**
 * 建任务时串进队列的那一笔(createTasks 的 `atomic.after`):跟任务行同一笔事务、在链上执行,
 * 所以这里读到的候选就是刚插进去、还没有任何人见过的那几行,队里的成员也是此刻的。
 * `queueId` 已有成员 = 串到队尾;一个都没有 = 这是一条新队列(批量建任务、团队派活的串行批次)。
 */
export function joinQueueOnCreate(queueId: string, taskIds: string[], opts: { existing: boolean }) {
  return async (tx: QueueJoinWriter): Promise<void> => {
    const items = await tx.select().from(queueItems).where(eq(queueItems.queueId, queueId)).orderBy(asc(queueItems.position));
    if (opts.existing && items.length === 0) throw new QueueJoinRefused(`queue ${queueId} 不存在`);
    if (!opts.existing && items.length > 0) throw new QueueJoinRefused(`queue ${queueId} 已经存在`);
    const members = items.length ? await tx.select().from(tasks).where(inArray(tasks.id, items.map((i) => i.taskId))) : [];
    const joining = await tx.select().from(tasks).where(inArray(tasks.id, taskIds));
    const byId = new Map(joining.map((row) => [row.id, row] as const));
    const refusal = queueJoinRefusal(members, taskIds.map((id) => byId.get(id)!));
    if (refusal) throw new QueueJoinRefused(refusal.error);
    const at = now();
    await tx.insert(queueItems).values(taskIds.map((taskId, i) => ({ taskId, queueId, position: items.length + i, createdAt: at })));
  };
}
