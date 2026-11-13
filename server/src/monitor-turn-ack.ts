// 回合里交出去的哨兵结果**到没到 agent 手上**:只认 agent 自己报回来的回执号(monitor-turn-handoff.ts ②)。
//
// 交出去的那一次返回里带着一个随机回执号,而且**只有那一次返回里有**。agent 下一次调 pause_task /
// complete_task 时把它原样带回来(`monitorReceipt`)= 它读到了那次返回 —— 这是能拿到的、离真正的
// 接收者最近的证据,而且对每一家执行器都一样成立。中间任何一跳(服务端写完、MCP 收到)都只证明
// 那一跳自己做到了哪一步:第 3 轮那一版让 MCP 拿到返回就确认,MCP 进程随后被杀、执行器一个字都
// 没收到,完成照样放行(第 4 轮审查 1)。
//
// **没有超时**(第 4 轮审查 2):交出去多久都不能证明那一次丢了 —— 慢了半分钟的那次返回照样会
// 到、照样会被读到。所以回合里交过的行**不再在回合里重交**:带回回执号就确认,没带回就一直算
// 「交了、没确认」,拦着完成;那一轮收口时按没送达退回,由唤醒那一路再送一遍。最坏是重复一次,
// 不是丢、也不是同一批在回合里出现两遍。
import { and, eq, sql } from "drizzle-orm";
import { db, dbClient } from "./db/index.js";
import { scheduledMessages } from "./db/schema.js";
import { now } from "./util.js";
import { randomBytes } from "node:crypto";

export const newHand = (): string => randomBytes(6).toString("hex");

/** agent 带回来的那一串里认得出的回执号(可以一次带回好几个,空格、逗号随便隔)。 */
export const receiptHands = (raw: unknown): string[] =>
  typeof raw === "string" ? [...new Set(raw.match(/\b[0-9a-f]{12}\b/g) ?? [])] : [];

/**
 * 把这一轮带回来的回执号落到它们那几行上:只认**交给这一轮**的(`turn_taken_by` = 这一轮的令牌)、
 * 还没确认过的。返回确认了几行。调用方排在 `task:<id>` 那条队列上(跟领取、收口结清同一条)。
 */
export async function confirmHandoffs(taskId: string, token: string | null | undefined, hands: string[]): Promise<number> {
  if (!token || !hands.length || dbClient.closed) return 0;
  let confirmed = 0;
  for (const hand of hands) {
    confirmed += (await db.update(scheduledMessages)
      .set({ turnHandoff: sql`json_set(${scheduledMessages.turnHandoff}, '$.ackedAt', ${now()})` })
      .where(and(
        eq(scheduledMessages.taskId, taskId), eq(scheduledMessages.status, "sent"),
        eq(scheduledMessages.turnTakenBy, token),
        sql`json_extract(${scheduledMessages.turnHandoff}, '$.hand') = ${hand}`,
        sql`json_extract(${scheduledMessages.turnHandoff}, '$.ackedAt') IS NULL`,
      ))
      .returning({ id: scheduledMessages.id })).length;
  }
  return confirmed;
}
