// 回合里交出去的哨兵结果**到没到 agent 手上**:认的是 MCP 那一侧发回来的确认(monitor-turn-handoff.ts ②)。
//
// 返回里带着这一次的交付号(`monitorResultsReceipt`,随机、只出现在那一次返回里)。ash 的 MCP 进程
// 拿到返回之后、交给执行器之前,先把这个号 POST 回来;落进行上的 `turn_handoff.ackedAt`。为什么
// 是这一侧:pause_task / complete_task 只经过 ash 自己的 MCP 进程,所以它对每一家执行器都成立
// —— 不像读执行器的事件流,那只对把工具返回原文记下来的那几家成立,也不用每次去扫文件。
//
// 剩下的那一截(MCP 进程发完确认、还没把返回写出去就死了,或者执行器拿到之后自己丢了)这里管
// 不到,如实算作已送达;在那之前的每一种断法都停在「交了、没确认」,按 ② 退回或再交。
//
// 三种状态,判据全在行上:
//   · 有 `ackedAt` = 送到了(等那一轮正常收口销记号);
//   · 没有、交出去不到 `ACK_WAIT_MS` = **在路上**:那一次返回还没回到 MCP 手上(并发的另一次调用、
//     通道慢),拦着完成,但**不再交** —— 再交一次就会让同一批结果出现两遍、把交付号换掉;
//   · 没有、超过了 = **丢了**:同一轮再调 pause_task / complete_task 时换一个号再交;迟到的那个
//     旧号对不上,确认一行都改不到。
import { randomBytes } from "node:crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { db, dbClient } from "./db/index.js";
import { scheduledMessages } from "./db/schema.js";
import { serialize } from "./monitors.js";
import { now } from "./util.js";

/** 交出去之后多久还没确认就算丢了。MCP 那一侧拿到返回就确认,正常是毫秒级。 */
export const ACK_WAIT_MS = 30_000;

export const newHand = (): string => randomBytes(6).toString("hex");

type Handoff = { hand: string; at: string; ackedAt?: string } | null;

/** 这一行交出去的那一次还在路上吗(没确认、也还没到算丢的时候)。 */
export const handInFlight = (h: Handoff, at = Date.now()): boolean =>
  !!h && !h.ackedAt && Date.parse(h.at) > at - ACK_WAIT_MS;

/** MCP 那一侧发回来的确认:按交付号落到那几行上。号已经换了(再交过)、行已经结清的,一行都不改。 */
export async function ackTurnHandoff(taskId: string, hand: string): Promise<number> {
  if (!/^[0-9a-f]{12}$/.test(hand) || dbClient.closed) return 0;
  // 排在 `task:<id>` 那条队列上:跟领取、再交、收口结清同一条,确认不会夹在它们读和写之间。
  return serialize(`task:${taskId}`, async () => (await db.update(scheduledMessages)
    .set({ turnHandoff: sql`json_set(${scheduledMessages.turnHandoff}, '$.ackedAt', ${now()})` })
    .where(and(
      eq(scheduledMessages.taskId, taskId), eq(scheduledMessages.status, "sent"),
      isNotNull(scheduledMessages.turnTakenBy),
      sql`json_extract(${scheduledMessages.turnHandoff}, '$.hand') = ${hand}`,
      sql`json_extract(${scheduledMessages.turnHandoff}, '$.ackedAt') IS NULL`,
    ))
    .returning({ id: scheduledMessages.id })).length);
}

export function mountMonitorAckRoute(api: Hono): void {
  api.post("/tasks/:id/monitor-results/ack", async (c) => {
    const b = await c.req.json<{ hand?: unknown }>().catch(() => ({}) as { hand?: unknown });
    return c.json({ acked: await ackTurnHandoff(c.req.param("id"), typeof b.hand === "string" ? b.hand : "") });
  });
}
