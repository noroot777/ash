// **一份结果交接只许对应一条消息**（第 3 轮审查 N1），以及**存量库里已经有重复时**怎么把这条
// 保证装上去（第 4 轮审查 N1）。
//
// 去重原来是「先查有没有同口令的消息，没有就入队」：两位发送者（收尾、退避重试、每分钟巡检、
// 另一次收尾）可以同时读到「没有」，然后各建一条 —— 实测 `Promise.all` 两次投递得到两条正文
// 和口令都一模一样的待发消息，agent 被同一个结果叫醒两轮。单实例不等于单一在途调用。
//
// 唯一性只能由库给：有了这条索引，第二位发送者的入队直接被拒（调用方把它读成「已经送过了」，
// 见 monitor-events.ts），而不是靠两次读之间什么都没发生这种运气。普通事件的这一列是 NULL，
// SQLite 的唯一索引认为 NULL 彼此不等，所以它们一条都不受影响。
//
// ## 为什么不能「建不起来就只警告」
//
// 这条索引建不起来只有一种原因：**上一版那个竞态真的发生过**，库里已经有两条消息认着同一笔
// 交接。而那恰恰是最需要这条保证的库 —— 上一版在这里只打一行警告就继续启动，于是去重退回
// 「先查后写」那一档，重复叫醒照旧（第 4 轮审查实测 `N1_OLD_DUPLICATES_DISABLE_NEW_DEDUP`：
// 旧重复数据在场时索引数为 0，两次并发投递又排出两条）。
//
// 所以装之前先把重复那几条的**身份**收归一条：`handoff_token` 只留给最早那一条（它就是真正
// 送达的那一次），后来的几条把这一列置空。**正文一个字都不动** —— 那是用户在界面上看得见的
// 待发内容，不替他删；去掉的只是「我认下这笔交接」这个身份。身份留在最早那一条上，所以
// 「这笔结果送过了吗」仍然答得对。
//
// 归并之后这条索引**不再容错**：已知的那个失败原因就在上一段里处理掉了，再失败说明库出了别的
// 问题，而那时「悄悄退回先查后写」正是上一轮被拦下来的那种结果 —— 装不上就不算升级成功，照
// `ensureChatSchema` 那几笔 DDL 的口径往上抛（宽容只属于那串「列可能已经有了」的 `ALTER`）。
import type { Client } from "./node-sqlite-client.js";

const INDEX = "scheduled_messages_handoff_token";

/** **必须排在容错 `ALTER` 之后**：`handoff_token` 这一列是 ALTER 补上的，建早了老库就没有。 */
export async function ensureHandoffTokenUnique(client: Pick<Client, "execute">): Promise<void> {
  // 索引已经在 ⇒ 库里不可能有重复，那条全表 UPDATE 也就不必每次启动都跑一遍。
  const present = await client.execute(
    `SELECT 1 AS one FROM sqlite_master WHERE type='index' AND name='${INDEX}'`,
  );
  if (present.rows.length) return;
  const merged = await client.execute(
    "UPDATE scheduled_messages SET handoff_token = NULL"
    + " WHERE handoff_token IS NOT NULL AND rowid NOT IN ("
    + "   SELECT MIN(rowid) FROM scheduled_messages"
    + "   WHERE handoff_token IS NOT NULL GROUP BY handoff_token)",
  );
  if (merged.rowsAffected) {
    console.warn(
      `[ash] 存量库里有 ${merged.rowsAffected} 条消息跟别人认着同一笔结果交接`
      + "（上一版那个竞态真的发生过）：已把这笔交接的身份归给最早那一条，正文一条都没动。",
    );
  }
  await client.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX}`
    + " ON scheduled_messages(handoff_token) WHERE handoff_token IS NOT NULL",
  );
}
