// queue_advance_intents 表。从 schema.ts 拆出来只为那份的 700 行上限;`schema.ts` 原样转发。
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * 「这条队列被请求推进过,还没有哪一次推进把它做完」—— 一次**已被接受的推进意图**。
 *
 * 为什么不能靠现场推断:推进请求(`tasks.queue_advance_request`)是写在**候选任务**那一行上的,
 * 那一笔写失败时,「这条队列该推进」这件事就只剩进程内存里的一个重试闭包,进程一消失就蒸发。
 * 重启后的恢复只能回头猜 —— 早先那条判据是「候选前面已经有成员落了终态」,可「请求是否已被
 * 接受」跟「现在还看不看得见一个终态前驱」根本不是同一件事:只有队首的队列、以及故障窗口里
 * 前驱被移走/归档的队列,一律猜不出来,于是永久停住(第 1 轮审查发现 3 跨进程复现)。
 *
 * 所以把意图本身落下来:推进一开始就记一行,这一趟不用再重试了才删。
 */
export const queueAdvanceIntents = sqliteTable("queue_advance_intents", {
  queueId: text("queue_id").primaryKey(),
  acceptedAt: text("accepted_at").notNull(),
  // **这一行代表的是哪一次接受。** 一条队列上同时只有一行意图,但先后被接受的两趟推进不是
  // 同一份责任:后来那一趟只是借到了旧那行。了结因此必须条件写在这个代次上 —— 早先那趟做完
  // 自己那份、按 queueId 裸删时,删掉的是**后来**那次接受的恢复责任,重启后于是没人补办
  // (第 1 轮自由审查 F2 跨进程实测:新队首既无意图也无单任务请求,链永久停住)。
  // 老库开出来的行没有代次(NULL):谁观察到它、谁就按「代次为 NULL」条件了结,口径在
  // queue-advance-admission.ts。
  generation: text("generation"),
});
