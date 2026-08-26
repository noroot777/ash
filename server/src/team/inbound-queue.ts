// 调度台待送入站消息的**持久**队列(表定义与理由见 db/schema.ts 的 teamInbound)。
//
// 一句话规矩:**只有 ResidentHandle.send() 明确回执「收下了」才销账**。在那之前这条消息
// 归队列所有 —— 换台、拒收、抛错、server 重启,下一台调度台照样能把它认领走。
//
// 为什么不是内存:前两版修复分别用「搬给新 lead」和「模块级托盘 Map」接住了换台和关台,
// 重启那一种接不住 —— 新进程的 Map 是空的,而落回 idle 的团队任务开机时不会被唤醒
// (task-reconcile.ts 只叫醒当时还 running/queued 的),消息就永久消失了。
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { teamInbound } from "../db/schema.js";
import { now } from "../util.js";

/** 队列里的一条:`seq` 是到达序号,送成之后拿它销账。 */
export interface PendingInbound {
  seq: number;
  text: string;
}

/** 排进待送队列。返回值带着 seq —— 调用方得拿它才能在真送出去之后销账。 */
export async function enqueueInbound(taskId: string, text: string): Promise<PendingInbound> {
  const [row] = await db
    .insert(teamInbound)
    .values({ taskId, text, createdAt: now() })
    .returning({ seq: teamInbound.seq, text: teamInbound.text });
  return row;
}

/** 这条任务名下还没送出去的消息,按到达顺序。 */
export function pendingInbound(taskId: string): Promise<PendingInbound[]> {
  return db
    .select({ seq: teamInbound.seq, text: teamInbound.text })
    .from(teamInbound)
    .where(eq(teamInbound.taskId, taskId))
    .orderBy(asc(teamInbound.seq));
}

/** 销账。**只在进程明确收下之后调** —— 早一步删,这条消息就再也没人送得出去了。 */
export async function consumeInbound(seqs: number[]): Promise<void> {
  if (!seqs.length) return;
  await db.delete(teamInbound).where(inArray(teamInbound.seq, seqs));
}
