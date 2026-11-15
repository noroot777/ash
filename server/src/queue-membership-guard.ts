// 两个「改归属」的写入口在队列认领链上(queue-claim-chain.ts)按**此刻的库**重验合法性。进门时那次
// 校验读的是请求到达那一刻的快照,隔着建任务、等链的整段 await,写入时它早就不作数了:串行只决定
// 谁先谁后,不会替后到的那一笔判断它还合不合法。
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "./db/index.js";
import { queueItems, tasks } from "./db/schema.js";
import { serializeQueueClaims } from "./queue-claim-chain.js";

/** 追加到队尾在链上被拒(队列没了、或已经不和新任务同项目同组)。建任务那一步会把刚插的行撤掉。 */
export class QueueJoinRefused extends Error {}

/**
 * 改 groupId 之前问一句:现在还能改吗。在链里调用。返回 null = 可以改。
 *   · 已经占好位或在跑的不换组:它占着旧组的并发名额(member-start.ts / group-slots.ts),挪过去
 *     新组就多跑一条、名额却还在旧组账上。团队调度台不在此列:它的 running 是常驻,不占分组名额;
 *   · 跟别的成员同在一条队列里的不单独换组:同一队列必须同组(queues.ts 不变量①)。
 */
export async function groupMoveRefusal(taskId: string, groupId: string | null): Promise<string | null> {
  const row = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!row || (row.groupId ?? null) === groupId) return null;
  if (row.mode !== "team" && (row.status === "running" || row.status === "queued")) {
    return "任务正在运行，占着原分组的并发名额，等这一轮结束再换分组";
  }
  const item = (await db.select({ queueId: queueItems.queueId }).from(queueItems).where(eq(queueItems.taskId, taskId))).at(0);
  if (!item) return null;
  const mates = await db.select({ taskId: queueItems.taskId }).from(queueItems).where(eq(queueItems.queueId, item.queueId));
  return mates.length > 1 ? "同一条队列里的任务必须在同一个分组，先把它移出队列再换分组" : null;
}

/** 建任务时把它串到已有队列的队尾:合法性与队尾位置都在链上现读。 */
export function appendToQueue(queueId: string, task: { id: string; projectId: string; groupId: string | null },
  createdAt: string): Promise<void> {
  return serializeQueueClaims(async () => {
    const items = await db.select().from(queueItems).where(eq(queueItems.queueId, queueId)).orderBy(asc(queueItems.position));
    if (items.length === 0) throw new QueueJoinRefused(`queue ${queueId} 不存在`);
    const members = await db.select({ projectId: tasks.projectId, groupId: tasks.groupId }).from(tasks)
      .where(inArray(tasks.id, items.map((i) => i.taskId)));
    if (members.some((m) => m.projectId !== task.projectId)) throw new QueueJoinRefused(`queue ${queueId} 不存在`);
    const groups = new Set(members.map((m) => m.groupId ?? null));
    if (groups.size !== 1 || !groups.has(task.groupId)) {
      throw new QueueJoinRefused(`跨 group 不允许:queue 属于 group ${[...groups].join(", ")},新任务属于 ${task.groupId}`);
    }
    await db.insert(queueItems).values({ taskId: task.id, queueId, position: items.length, createdAt });
  });
}
