// **哨兵的「未了结责任」集合** —— 四类,一条语句读齐。
//
// 为什么独立成文件:这个集合有**两个**提问者,而它们问的是同一件事。
//
//  · 完成闸(task-complete-monitors.ts):「我名下还有会被这次完成毁掉的东西吗」;
//  · 审查等待判据(review-continuation.ts):「这一轮审查名下还有没了结的责任吗」。
//
// 两边只差一个过滤条件(整个任务 / 这一轮 run+round),集合本身必须是同一份。第 3 轮自由审查
// F2 实测的正是两边漂移的代价:完成闸早就认了三类,而审查那一侧只查了 `status="running"`
// 一类 —— 哨兵的命令跑完了(exited)、结果已经入了待发送、审查者一个字都还没看到,升级重启
// 之后对账读成「没有人在等」,round 落 `status:"error"`,那条 pending 随即 canceled
// (日志:WRITER_PENDING origin="monitor:m" / SOURCE_ACTIVE false / PENDING_AFTER_RECOVERY
// status="canceled")。所以这里**只提供集合**,语义由各自的调用点解释。
//
// 前三类分别是什么、为什么必须在**一条语句**里读齐(SQLite 单语句自带一致快照;拆成三条
// SELECT 会让一份正在从第三类转移到第二类的责任从指缝里漏过去),全部写在
// task-complete-monitors.ts 的文件头,这里不复述。第四类(`handed`)是回合里交出去、还没确认
// 送到的那几行(monitor-turn-handoff.ts ②):它们跟第二类是同一份责任换了个状态,所以放弃、
// 来源审查这两条规则也跟第二类同一份 —— 写在同一个集合里,两个提问者自然一起认。
import { and, eq, isNotNull, isNull, like, or, sql, type SQL } from "drizzle-orm";
import { unionAll } from "drizzle-orm/sqlite-core";
import { db } from "./db/index.js";
import { monitors, scheduledMessages } from "./db/schema.js";
import type { ConclusionTransaction } from "./regression-conclusion-commit.js";

/** 读这份集合的执行体:库本身(完成闸)或一个事务(审查结算,要跟它读的别的行同一个快照)。 */
export type ResponsibilityReader = typeof db | ConclusionTransaction;

/** `monitor:` 这个前缀的长度;SQL 里按它从 origin 切出哨兵 id(`substr` 的下标从 1 起)。 */
export const MONITOR_ORIGIN_PREFIX = "monitor:";

export type MonitorResponsibilityRow = {
  /**
   * 哪一类:`live` 还在盯 / `unread` 结果排在待发送 / `handoff` 结局已定、通知还没入队 /
   * `handed` 回合里交出去了、还没确认送到。
   */
  cls: string;
  /** 那条待发送消息的 id(只有第二、四类非空)。 */
  messageId: string | null;
  monitorId: string | null;
  origin: string | null;
  description: string | null;
  command: string | null;
  events: number | null;
  logPath: string | null;
  endedReason: string | null;
  /** **哨兵行**上记的来源身份。第二类里哨兵行可能已经没了(被删/被清)⇒ null。 */
  reviewRun: string | null;
  reviewRound: number | null;
  reviewGeneration: string | null;
  /**
   * **那条待发送消息自己带的**那份来源身份(只有第二类非空)。
   *
   * 它跟上面那对是两套独立记录:入队时从哨兵行抄下来(pending-messages.ts 的 `turnSource`),
   * 所以**哨兵行被删掉之后它还在**。按轮次归属找责任时两边任一命中都算 —— 少认一个的后果
   * 就是 F2 那条:结果明明排着,却判成「没人在等」。
   */
  messageReviewRun: string | null;
  messageReviewRound: number | null;
};

/**
 * 这个任务名下**还没了结**的哨兵责任,三类一次读齐。
 *
 * `executor` 可以是 `db` 也可以是一个事务:审查那一侧在结算事务里问,跟它读任务行/证据行用
 * 同一个快照(审查原话:「并以一致快照读取」)。
 */
export async function unsettledMonitorResponsibility(
  executor: ResponsibilityReader, taskId: string,
): Promise<MonitorResponsibilityRow[]> {
  const shape = {
    monitorId: monitors.id,
    description: monitors.description,
    command: monitors.command,
    events: monitors.events,
    logPath: monitors.logPath,
    endedReason: monitors.endedReason,
    reviewRun: monitors.sourceReviewRun,
    reviewRound: monitors.sourceReviewRound,
    reviewGeneration: monitors.sourceReviewGeneration,
  };
  const noMessageSource = {
    messageId: sql<string | null>`NULL`.as("message_id"),
    messageReviewRun: sql<string | null>`NULL`.as("message_review_run"),
    messageReviewRound: sql<number | null>`NULL`.as("message_review_round"),
  };
  // 第一类:还在盯的进程。**不按 `results_abandoned_at` 筛** —— 那一列是「不要这条哨兵的结果
  // 了」,而 `stop_monitor` 对一条 running 的哨兵同时会把进程停掉,所以这个组合实际不出现;
  // 真出现(停进程失败)时它仍然在盯,仍然会被这次完成毁掉,该拦。
  const live = executor
    .select({ cls: sql<string>`'live'`.as("cls"), origin: sql<string | null>`NULL`.as("origin"), ...shape, ...noMessageSource })
    .from(monitors)
    .where(and(eq(monitors.taskId, taskId), eq(monitors.kind, "ash"), eq(monitors.status, "running")));
  // 第三类:结局已写定、结束通知还没入队的(凭证还在)。
  const handoff = executor
    .select({ cls: sql<string>`'handoff'`.as("cls"), origin: sql<string | null>`NULL`.as("origin"), ...shape, ...noMessageSource })
    .from(monitors)
    .where(and(
      eq(monitors.taskId, taskId), eq(monitors.kind, "ash"),
      isNotNull(monitors.resultHandoffAt), isNull(monitors.resultsAbandonedAt),
    ));
  // 第二类(还排在待发送托盘里的)与第四类(回合里交出去、还没确认送到的)是**同一份结果**的
  // 两个状态,按同一套规则读:哨兵行没了的照样算;行还在但已经被明确放弃的不算(理由见
  // task-complete-monitors.ts)。
  const messages = (cls: "unread" | "handed", state: SQL) => executor
    .select({
      cls: sql<string>`${sql.raw(`'${cls}'`)}`.as("cls"), origin: scheduledMessages.origin, ...shape,
      messageId: sql<string | null>`${scheduledMessages.id}`.as("message_id"),
      messageReviewRun: scheduledMessages.reviewRun,
      messageReviewRound: scheduledMessages.reviewRound,
    })
    .from(scheduledMessages)
    .leftJoin(monitors, eq(monitors.id, sql`substr(${scheduledMessages.origin}, ${MONITOR_ORIGIN_PREFIX.length + 1})`))
    .where(and(
      eq(scheduledMessages.taskId, taskId),
      state,
      like(scheduledMessages.origin, `${MONITOR_ORIGIN_PREFIX}%`),
      or(isNull(monitors.id), isNull(monitors.resultsAbandonedAt)),
    ));
  const unread = messages("unread", eq(scheduledMessages.status, "pending"));
  const handed = messages("handed", and(
    eq(scheduledMessages.status, "sent"), isNotNull(scheduledMessages.turnTakenBy),
    sql`json_extract(${scheduledMessages.turnHandoff}, '$.ackedAt') IS NULL`,
  )!);
  // **最宽的那一支放第一位**:`unionAll` 的结果类型取第一支,而第二类是 LEFT JOIN(哨兵行可能
  // 没了),它的列全是可空的。另两支的非空列可以赋进可空类型,反过来编译不过。
  return await unionAll(unread, handed, live, handoff);
}
