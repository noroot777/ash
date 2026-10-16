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
import { mergeMonitorEventText, monitorMessageOrigin } from "@ash/shared/monitor";
import { db, dbClient } from "./db/index.js";
import { monitors, scheduledMessages, tasks } from "./db/schema.js";
import { monitorWakeExecutor, monitorWakeGate } from "./monitor-session.js";
import { enqueueMessage, flushPendingForTask, publishPendingMessages } from "./pending-messages.js";

type Row = typeof monitors.$inferSelect;

/**
 * 把一段事件文本送到任务头上。
 *
 * **先合并、再新建**：这个哨兵名下还有一条没送出去（也没人正在送）的消息时，直接往它后面
 * 追加。任务正忙的那几分钟里攒下的十几条事件于是只唤醒它一次；而不是排十几行、醒十几轮。
 * 带着投递租约的那一行不能碰 —— 它正在被送进会话，改它等于改一句已经出口的话。
 */
export async function pushToTask(row: Row, text: string): Promise<boolean> {
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
  await mergeOrEnqueueMonitorEvent(row, text, existing);
  flushPendingForTask(row.taskId);
  return true;
}

/**
 * 「追加进那一行」还是「另起一条」。
 *
 * 合并那一发是一次 CAS（条件就是「租约还空着」），**它可以合法地落空**：上面查到这一行
 * 之后、这里改到它之前，投递方完全可能刚好抢走租约。落空就必须另起一条新消息，不能当成
 * 改成功了 —— 那一批行既没进任何一条消息、位置还会跟着前进，于是整批进展静默消失
 * （第 2 轮审查实测：events=2、read_offset 已越过第二条，而消息里只有第一条）。
 *
 * **单独成一个函数是为了让那个窗口能被测到**：`existing` 由调用方传进来，于是回归测试
 * 可以先查出这一行、再真的抢走租约、然后拿着那份**已经过期**的 `existing` 调它 —— 这正
 * 是竞态产生的那个现场，而且走的是生产代码本身，不需要往产线里埋测试钩子。
 */
export async function mergeOrEnqueueMonitorEvent(
  row: Row,
  text: string,
  existing: typeof scheduledMessages.$inferSelect | null,
): Promise<void> {
  const merged = existing
    ? await db
      .update(scheduledMessages)
      .set({ text: mergeMonitorEventText(existing.text, text) })
      .where(and(eq(scheduledMessages.id, existing.id), isNull(scheduledMessages.deliveringSince)))
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
      ownerUserId: row.ownerUserId, sessionRole: row.sourceRole,
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
