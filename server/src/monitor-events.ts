// 哨兵事件 → 待发送消息：**出口**这一侧。
//
// 从 `monitors.ts` 分出来的是「一条事件怎么进任务的托盘、什么时候不许进、不该进了怎么
// 作废」这一摊；那边留下的是哨兵自己的运行时（起进程、盯 stdout、收尾、重启接回）。
// 分界线就是这个文件里的三个函数：它们一个都不碰 `runtimes` / `serialize` 那套进程账本，
// 只跟 `pending-messages.ts` 和「这个哨兵还能不能唤醒任务」那条判据打交道。
//
// 贯穿这一侧的两条（原样从 monitors.ts 带过来）：
//
// ① **事件走既有的待发送消息链路，不另开一条唤醒通道。** 一条事件要做的事（任务在跑就
//    等它跑完、空闲就立刻续会话、归档就作废、server 重启后不丢、界面托盘里看得见、用户
//    能撤）`pending-messages.ts` 全都已经做对了，而且每一条都踩过坑。
// ② **一条事件 = 唤醒一次 = 一个真实的模型回合。** 所以合并是第一位的。
import { and, eq, inArray, isNull, like, notInArray } from "drizzle-orm";
import type { AgentType } from "@ash/shared";
import { handoffToken, mergeMonitorEventText, monitorMessageOrigin } from "@ash/shared/monitor";
import { db, dbClient } from "./db/index.js";
import { monitors, scheduledMessages, tasks } from "./db/schema.js";
import { monitorTurnSource, monitorWakeExecutor, monitorWakeGate } from "./monitor-session.js";
import { enqueueMessage, flushPendingForTask, publishPendingMessages } from "./pending-messages.js";

type Row = typeof monitors.$inferSelect;

/**
 * 把一段事件文本送到任务头上。
 *
 * **先合并、再新建**：这个哨兵名下还有一条没送出去（也没人正在送）的消息时，直接往它后面
 * 追加。任务正忙的那几分钟里攒下的十几条事件于是只唤醒它一次；而不是排十几行、醒十几轮。
 * 带着投递租约的那一行不能碰 —— 它正在被送进会话，改它等于改一句已经出口的话。
 */
export async function pushToTask(
  row: Row,
  text: string,
  /** 这一笔是结果交接时的身份(见 schema 的 `handoff_token`);普通事件不填。 */
  handoffToken?: string,
): Promise<boolean> {
  // **库关了就什么都送不出去**:ash 退出时会关库,而这一侧的调用方有几个是「放后台跑」的
  // (探活那一问判出结束之后的 `void finish`),所以这一刻完全可能撞上关库。那时这里不该抛
  // —— 抛出去就是一个没人接的 rejection,把正在退出的进程变成异常退出。
  // 丢的那几行不会真丢:读取位置只在消息落库之后才推进,所以重启接回时会从同一处再读一遍。
  if (dbClient.closed) return false;
  // 任务自己已经结束/归档了就不再往它头上排事件——排了就是在某个深夜把一个 done 的任务
  // 重新叫起来跑一轮（第 1 轮审查实测：总线真实走了 done → running → done）。这道判断
  // 放在**唯一出口**上而不是散在调用点：收尾路径有五条（过期 / 自己退出 / 被停 / 推满
  // 上限 / 重启后补读），逐条去加漏一条就等于没防。
  // 投影里**故意带上 id**（`row.taskId` 本来就在手上）：`monitorWakeGuard` 那一问是按
  // 「谁按 {status, archived} 两字段读 tasks」被回归精确注入的（test-monitor-races ㉒），
  // 这一处跟它撞同一个形状就会把那条注入骗走，让别人的用例静默变成空测。
  const task = (await db
    .select({ id: tasks.id, status: tasks.status, archived: tasks.archived })
    .from(tasks)
    .where(eq(tasks.id, row.taskId))).at(0);
  if (!task || await monitorWakeGate(task, {
    reviewRun: row.sourceReviewRun, reviewRound: row.sourceReviewRound,
  }) !== null) return false;

  const origin = monitorMessageOrigin(row.id);
  const existing = (await db
    .select()
    .from(scheduledMessages)
    .where(and(
      eq(scheduledMessages.taskId, row.taskId),
      eq(scheduledMessages.origin, origin),
      eq(scheduledMessages.status, "pending"),
      isNull(scheduledMessages.deliveringSince),
    ))).at(0) ?? null;
  await mergeOrEnqueueMonitorEvent(row, text, existing, handoffToken);
  flushPendingForTask(row.taskId);
  return true;
}

/**
 * 这一趟交接的结局。**调用方据此决定还要不要再负责**，所以四种必须分开（第 2 轮审查 N2：
 * 上一版返回 void、吞掉异常，调用方只能用「函数没抛」冒充「已补发」）。
 *
 *  · `delivered` 送进托盘了（凭证已销）
 *  · `already`   这一笔早就送过 / 压根没有凭证（凭证已销或本来就没有）—— 不是失败
 *  · `dropped`   任务已经终态/归档，这条通知再也没人收（凭证已销，出过声）
 *  · `failed`    这一趟没送出去，**凭证留着**，已排退避重试
 */
export type HandoffOutcome = "delivered" | "already" | "dropped" | "failed";

/**
 * **把「结局已写定、通知还没入队」那一笔交接做完**：按凭证入队，入队之后才销掉凭证。
 *
 * 凭证是跟终态同一条 UPDATE 落下的（见 schema-monitors.ts 的 `result_handoff_at`），所以这一
 * 刻完成闸已经能看见它了。顺序只能是「先入队、后销凭证」：反过来的话那条缝又回来了 —— 而且
 * 闸的那一条 UNION 语句正是**靠这个顺序**才做到「转移的每一刻至少有一类看得见」
 * （task-complete-monitors.ts 文件头）。
 *
 * **幂等靠消息侧的身份，不靠「凭证还在不在」**（第 2 轮审查 N1）：入队成功、销凭证失败（或者
 * 进程正好死在这两条语句之间）之后，凭证还在，下一趟重投会再送一次 —— 而上一条可能已经
 * `sent`，合并窗口对它不适用，于是同一条结束通知变成两条消息、把 agent 叫醒两次。身份
 * （`<monitorId>:<result_handoff_at>`）跟入队写在同一笔里，所以「送过没有」这一问有一个原子
 * 的答案。
 *
 * 入队被拒（`pushToTask` 返回 false）= 任务已经终态/归档，这条通知再也不会有人收：**凭证照样
 * 销掉**，否则它会永久拦着这个任务的完成，而拦着也救不回那条通知。那种情况出一行日志 —— 它
 * 正是 F1 要防的事故现场，静默销账等于把现场也擦掉。
 *
 * 不抛：调用点都在收尾路径上，往上抛会让一次已经落定的终态看起来像失败。**但也不再静默**：
 * 失败会排一次退避重试，而且照实返回 `failed`（见 monitor-handoff-retry.ts）。
 */
/**
 * 这个错是不是「唯一索引说这一笔已经有人送了」。
 *
 * 按索引名认而不是按「唯一约束」泛认：别的唯一约束失败（比如消息主键撞上）是真的出错了，当成
 * 「已经送过」会把一次没送出去的交接说成送到了。驱动把原始错包了一层，所以连 `cause` 一起看。
 */
function isHandoffTokenConflict(error: unknown): boolean {
  const text = [error, (error as { cause?: unknown })?.cause]
    .map((e) => (e instanceof Error ? e.message : String(e ?? "")))
    .join(" | ");
  return /UNIQUE constraint failed: scheduled_messages\.handoff_token/i.test(text)
    || (/unique/i.test(text) && /scheduled_messages_handoff_token/i.test(text));
}

export async function deliverResultHandoff(monitorId: string): Promise<HandoffOutcome> {
  try {
    if (dbClient.closed) return "failed";
    const row = (await db.select().from(monitors).where(eq(monitors.id, monitorId))).at(0);
    if (!row?.resultHandoffAt || !row.resultHandoffText) return "already";
    const token = handoffToken(row.id, row.resultHandoffAt);
    // 已经有一条消息认下了这一笔 ⇒ 送过了。凭证是上一趟没销掉的残留,补销就行。
    const sentAlready = (await db
      .select({ id: scheduledMessages.id })
      .from(scheduledMessages)
      .where(and(eq(scheduledMessages.taskId, row.taskId), eq(scheduledMessages.handoffToken, token)))).length > 0;
    // 入队撞上唯一索引 = 另一位发送者在这两步之间把同一笔送出去了（见 db/index.ts 的
    // `scheduled_messages_handoff_token`）。那是**已经送过**，不是失败：不该出声、不该排重试，
    // 凭证照样销掉。先查那一步留着只是省掉一次必然失败的写（第 3 轮审查 N1）。
    let duplicate = false;
    let delivered = false;
    if (!sentAlready) {
      try {
        delivered = await pushToTask(row, row.resultHandoffText, token);
      } catch (e) {
        if (!isHandoffTokenConflict(e)) throw e;
        duplicate = true;
      }
    }
    await db
      .update(monitors)
      .set({ resultHandoffAt: null, resultHandoffText: null })
      // CAS：只销掉自己这一趟处理的那一笔。重投器和收尾可能同时在送同一条,CAS 让后到的那一位
      // 不去空写(它那一趟会从身份那一问得到「送过了」)。
      .where(and(eq(monitors.id, monitorId), eq(monitors.resultHandoffAt, row.resultHandoffAt)));
    if (sentAlready || duplicate) return "already";
    if (!delivered) {
      console.error(
        `[ash] 哨兵结束通知无人可收 monitor=${monitorId} task=${row.taskId}：`
        + "任务已经是终态或已归档，这条通知作废（凭证已销，不再拦着完成）",
      );
      return "dropped";
    }
    return "delivered";
  } catch (e) {
    // 凭证还在 ⇒ 完成闸继续拦着。**而且这一趟必须留下一个还会再试的人**：上一版只打一行日志,
    // 唯一的补发入口在开机那一趟,于是一次瞬时写失败之后,结果要等到下次重启才送得出去,
    // agent 这期间反复 complete 只会一直吃 409(第 2 轮审查 F3 实测 `F3_NO_LIVE_RESULT_RETRY`)。
    console.error(`[ash] 哨兵结束通知这一趟没送出去 monitor=${monitorId}（凭证留着,已排重试）:`, e);
    const { scheduleResultHandoffRetry } = await import("./monitor-handoff-retry.js");
    scheduleResultHandoffRetry(monitorId);
    return "failed";
  }
}

/**
 * 「追加进那一行」还是「另起一条」。
 *
 * 合并那一发是一次 CAS（条件是「这一行还在等投递」），**它可以合法地落空**：上面查到这一行
 * 之后、这里改到它之前，投递方完全可能刚好抢走租约。落空就必须另起一条新消息，不能当成
 * 改成功了 —— 那一批行既没进任何一条消息、位置还会跟着前进，于是整批进展静默消失
 * （第 2 轮审查实测：events=2、read_offset 已越过第二条，而消息里只有第一条）。
 *
 * **判据是「状态 + 租约」两件,不是只看租约。** 租约空着有两种:还没开始送,以及**已经送完
 * 或已被取消**（`markSent`/取消都会把 `delivering_since` 清掉）。只看租约的话,迟到的那条
 * 事件会被追加进一条再也不会投递的消息里 —— 调用方还以为合并成功了,于是这批进展同样静默
 * 消失。这个判据在本任务开工基线（`0c6d7f3d` 的 `monitors.ts`）上就是只看租约的,第 4 轮
 * 审查把它作为基线风险挑出来（N4）;合并函数这一轮正好搬到这里,顺手把第二个条件补上。
 *
 * **单独成一个函数是为了让那个窗口能被测到**：`existing` 由调用方传进来，于是回归测试
 * 可以先查出这一行、再真的抢走租约、然后拿着那份**已经过期**的 `existing` 调它 —— 这正
 * 是竞态产生的那个现场，而且走的是生产代码本身，不需要往产线里埋测试钩子。
 */
export async function mergeOrEnqueueMonitorEvent(
  row: Row,
  text: string,
  existing: typeof scheduledMessages.$inferSelect | null,
  /** 结果交接的身份：合并和新建**两支都要落下它**，否则重投会把同一笔再送一次（N1）。 */
  handoffToken?: string,
): Promise<void> {
  const merged = existing
    ? await db
      .update(scheduledMessages)
      .set({
        text: mergeMonitorEventText(existing.text, text),
        ...(handoffToken ? { handoffToken } : {}),
      })
      .where(and(
        eq(scheduledMessages.id, existing.id),
        eq(scheduledMessages.status, "pending"),
        isNull(scheduledMessages.deliveringSince),
      ))
      .returning({ id: scheduledMessages.id })
    : [];
  if (merged.length > 0) {
    publishPendingMessages(row.taskId);
  } else {
    // **来源身份跟着哨兵行走,不在投递那一刻现查**:那时起它的那条会话早就不在跑了,查活
    // 进程只会得到下一代人(或者什么都没有)。记在行上,审查者挂的哨兵醒来时才叫得回审查
    // 会话 ——否则默认的 `single` 会把执行者叫起来跑一轮,而审查链还停在 reviewing 等它续跑。
    //
    // **角色之外还要带执行配置**:审查者可以是另一个执行器/模型(codex 审 claude 写的代码)。
    // 只带角色的话 `continueTask` 会按任务自己的 agentType 解析,新建一条 claude 的 reviewer
    // 会话,原审查上下文一个字都接不上(第 1 轮审查 F2 实测)。从哨兵记下的那次 run 上取,
    // 不猜「最新那条审查」。
    const executor = await monitorWakeExecutor(row.sourceReviewRun, row.sourceReviewRound);
    await enqueueMessage({
      taskId: row.taskId, text, origin: monitorMessageOrigin(row.id),
      ownerUserId: row.ownerUserId,
      ...(handoffToken ? { handoffToken } : {}),
      // **角色和「为哪一次审查的哪一轮」一起交出去**:两样都记在哨兵行上,所以投递那一刻
      // 不必现查。只带角色的那一版会让续起来的审查者挂不上下一条哨兵 —— 身份里 review=null,
      // 来源核验据此判「这次审查已经结束」(本轮审查 F2 实测 HTTP 409)。
      turnSource: monitorTurnSource(row),
      ...(executor
        ? {
          agent: executor.agent as AgentType,
          executorId: executor.executorId,
          model: executor.model,
          reasoningEffort: executor.reasoningEffort,
        }
        : {}),
    });
  }
}


/**
 * 作废这个任务名下还没送出去的哨兵事件。
 *
 * 只动 `origin` 是哨兵的那些。真人写的排队追问要原样留着——他排的时候就知道任务可能
 * 正要结束，那条消息的意思是「下次醒来处理」，替他取消等于把他的话吞了。
 *
 * **带着投递租约的那一行不碰，但「租约 ≠ 已送达」**：那一行归抢下它的那位投递者，由它在
 * 真正起这一轮的入口上按最新状态自己撤回并取消（`pending-messages.ts` 的 `monitorWakeGuard`
 * —— 第 4 轮审查指出的就是这个窗口：资格只在扫描那一层判过一次，租约抢下之后再没人问）。
 * 为什么不干脆在这里把它一起作废：`markSent` 的 CAS 条件是 `status='pending'`，这边先改成
 * canceled 的话，一条**已经进了会话**的事件会在时间线上留下一句「未发送，已取消」——比漏掉
 * 它更糟。所以这一行只有一个主人，就是正在送它的那位。
 */
export async function cancelPendingMonitorEvents(
  taskId: string,
  // `keep` = 这几条哨兵的事件留着（它们属于一次还在进行的审查）；`only` = 只作废这几条的。
  scope: { keep?: string[]; only?: string[] } = {},
): Promise<void> {
  if (dbClient.closed) return;
  // **显式给了空的 `only` = 没有要作废的**,不是「那就收全部」:下面 `only` 为空时会退回
  // 「这个任务名下所有哨兵事件」那条宽口径,调用方筛完一轮恰好筛空时就会误伤别人的。
  if (scope.only && scope.only.length === 0) return;
  const origins = {
    keep: (scope.keep ?? []).map(monitorMessageOrigin),
    only: (scope.only ?? []).map(monitorMessageOrigin),
  };
  await db
    .update(scheduledMessages)
    .set({ status: "canceled", sentAt: null, deliveringSince: null })
    .where(and(
      eq(scheduledMessages.taskId, taskId),
      eq(scheduledMessages.status, "pending"),
      isNull(scheduledMessages.deliveringSince),
      origins.only.length
        ? inArray(scheduledMessages.origin, origins.only)
        : like(scheduledMessages.origin, "monitor:%"),
      ...(origins.keep.length ? [notInArray(scheduledMessages.origin, origins.keep)] : []),
    ));
  publishPendingMessages(taskId);
}
