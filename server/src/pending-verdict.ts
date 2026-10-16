// ── 待发送消息的投递判定与投递参数(无状态部分)─────────────────────────────────
// 从 pending-messages.ts 拆出(那边顶到 700 行上限):这里只放**不碰投递账本**的
// 纯判定与参数拼装 —— 判定何时发(deliveryVerdict / isDueForDelivery)、发的时候带
// 什么(deliveryOptions)、哨兵唤醒的最后一道闸(monitorWakeGuard)。租约、冷却、
// 重投、扫描那些带共享状态的机器仍在 pending-messages.ts。
import { eq } from "drizzle-orm";
import type { AgentType } from "@ash/shared";
import { isGoalExecution, isGoalRecovery, parseCliCommand } from "@ash/shared/cli-commands";
import { monitorBlockedReason, monitorIdFromOrigin } from "@ash/shared/monitor";
import { monitorEventSource, monitorWakeGate, type MonitorSourceState } from "./monitor-session.js";
import { db } from "./db/index.js";
import { scheduledMessages, tasks } from "./db/schema.js";

type Row = typeof scheduledMessages.$inferSelect;

export function pendingExecutionIntent(
  message: Pick<Row, "agent" | "text" | "execution">,
  task: Pick<typeof tasks.$inferSelect, "mode" | "status" | "agentType"> | null,
): boolean {
  const command = task?.mode === "single" ? parseCliCommand(message.agent ?? task.agentType ?? "claude", message.text) : null;
  return isGoalExecution(command)
    ? isGoalRecovery(command) || !["done", "failed", "canceled"].includes(task!.status)
    : message.execution;
}

// 判定所需的最小任务形状,写成结构类型,单测就能直接喂字面量。
// queueBlocked = 这个任务在队列里且还没轮到(queueBlockers 非空)。只对 paused/
// backlog 生效:对它们投递 = 开启真实执行回合,必须守「同队至多一个在跑」;终态
// 任务的投递是续聊旁路(followUpFrom),队列按原终态看待,不受队列挡(审查:
// 「保留已完成任务正常续聊的语义」)。
export type DeliveryTaskView = {
  mode: string | null;
  status: string;
  archived: boolean;
  queueBlocked?: boolean;
  /** 所在分组已被用户暂停(groups.paused,持久事实)。 */
  groupPaused?: boolean;
  /**
   * **这条哨兵事件的来源审查**现在是什么状态(由调用方查好填进来,纯函数本身不碰库)。
   *
   * - `live` = 起它的那次审查、那一轮还在进行。终态任务上也要放行 —— 审查是旁路回合,
   *   跑在一个已经 done 的任务上,不认这一条就等于把审查者好不容易挂上的哨兵的结果按
   *   「任务都结束了还醒什么」取消掉(见 shared 的 `activeReview`)。
   * - `stale` = 有来源审查,但它已经收尾(或已经续到下一轮)。**无条件取消**,与任务此刻
   *   什么状态无关:那是这条消息自己的资格,paused 任务上派的审查收了尾同样要作废它的
   *   遗留结果(第 2 轮审查 F5 实测路径)。
   * - `none` = 执行者自己挂的哨兵,照任务状态老规矩。
   */
  monitorSource?: MonitorSourceState;
};
export type DeliveryMessageView = { mode: string; sendAt: string; execution?: boolean; origin?: string | null };
export type DeliveryVerdict =
  | { action: "deliver" }
  | { action: "wait" }
  | { action: "cancel"; reason: string };

// 「这条消息到点了没」的单点判据:定时消息看钟点,排队消息压根不看(它要的就是
// 「一空闲就发」)。抽出来是因为结算那边也要问同一句话(hasDeliverablePendingMessages),
// 各写一份迟早漂移——真漂了的后果是一条定在明天的消息把预约审查挡一整天。
export function isDueForDelivery(message: DeliveryMessageView, at: Date): boolean {
  return message.mode === "queued" || new Date(message.sendAt) <= at;
}

// 投递判定的纯函数核心(回归在 test-side-chat.ts / test-scheduled-messages.ts 里直喂字面量)。
// 三档:发、等、取消。取消只给「永远等不到了」的情形——任务没了/归档/类型不支持
// 回复;「任务在忙」永远是等,不是取消。
export function deliveryVerdict(
  message: DeliveryMessageView,
  task: DeliveryTaskView | null,
  at: Date,
): DeliveryVerdict {
  if (!task) return { action: "cancel", reason: "任务不存在" };
  if (task.archived) return { action: "cancel", reason: "任务已归档" };
  if (task.mode !== "single" && task.mode !== "team")
    return { action: "cancel", reason: `任务类型 ${task.mode} 不支持回复` };
  // 哨兵事件只有一个出口——「唤醒这个任务」。任务都结束了它再醒来也只是花钱，所以这一条
  // 必须在**消费端**也拦一道：生产端那个闸永远留着一个窗口（读到任务还在跑之后、消息写
  // 进库之前，任务刚好收尾），而这里是所有生产路径的共同出口（第 3 轮审查实测：总线真的
  // 走了 done → running → done，正文就是那条迟到的进展）。
  //
  // 真人排的队列消息恰恰相反：终态正是它该发的时候（「下次醒来处理」就是他排它的意思）。
  // 所以只认 `origin` 是哨兵的那些，判据与创建入口同一份（`monitorBlockedReason`）。
  if (monitorIdFromOrigin(message.origin) !== null) {
    // 来源失效先判,且不看任务状态(见 `monitorSource` 的注释)。
    if (task.monitorSource === "stale")
      return { action: "cancel", reason: "起这个哨兵的那次审查已经结束，它的事件不再唤醒任务" };
    if (monitorBlockedReason(task, { activeReview: task.monitorSource === "live" }) !== null)
      return { action: "cancel", reason: "任务已经结束，这条哨兵事件不再唤醒它" };
  }
  if (!isDueForDelivery(message, at)) return { action: "wait" };
  // 常驻调度台(team)正在说话时也接得住,所以只有单任务需要等它闲下来。
  if (task.mode === "single" && (task.status === "running" || task.status === "queued"))
    return { action: "wait" };
  // 排队没轮到的 paused/backlog:投递会 continueTask 开真实执行回合,等让位
  // (第 xNb655YqYzcA 链第 2 轮:reply 只在入口暂存不够,30s tick 会从这里穿透)。
  if (
    task.mode === "single" &&
    (task.status === "paused" || task.status === "backlog") &&
    task.queueBlocked
  )
    return { action: "wait" };
  // 执行型消息(排队等轮次时暂存的回复,execution=1):它的投递**就是任务的执行回合**,
  // 不论任务此刻处于什么状态都要守两件事 —— 整队至多一个在跑、分组暂停。关键是失败
  // 重试:起跑失败后任务落 failed,上面按状态的检查管不到它,丢了这条就会借终态续聊
  // 的豁免并行执行 / 穿透暂停(第 5 轮审查两条拦验收)。真正的终态续聊(execution=0)
  // 不受影响。
  if (task.mode === "single" && message.execution && (task.queueBlocked || task.groupPaused))
    return { action: "wait" };
  return { action: "deliver" };
}

export function deliveryOptions(m: Row) {
  return {
    attachments: JSON.parse(m.attachments) as string[],
    agent: (m.agent as AgentType) ?? undefined,
    // 要跑的还是用户当时选的那一套执行器/模型/思考强度（没选就是 null=按默认解析）。
    executorId: m.executorId ?? null,
    model: m.model ?? null,
    reasoningEffort: m.reasoningEffort ?? null,
    // **回合身份照原样还原**:角色 + 它当初绑的那一次审查(见 schema 的 review_run 注释)。
    // 两列为空的 reviewer 行(存量消息、排队时压根不在审查里的回复)还原成显式的
    // `"unbound"` —— 不许在这里现查「现在是哪一次审查」补上去:投递离排队可能隔着几分钟,
    // 那一查会把旧消息绑到新一轮审查上(第 10 轮审查 F1 的错投来源)。
    ...(m.sessionRole === "reviewer"
      ? {
        turnSource: {
          role: "reviewer" as const,
          review: m.reviewRun ? { run: m.reviewRun, round: m.reviewRound ?? 1 } : ("unbound" as const),
        },
      }
      : m.sessionRole
        ? { turnSource: { role: "single" as const } }
        : {}),
    // 排队/定时消息落地时,烧的仍是**当时排队那个人**的 key,不退回任务归属人。
    ...(m.ownerUserId ? { actingUserId: m.ownerUserId } : {}),
    // 执行型消息的意图跟着行走,重投也不丢(第 5 轮审查:首次交接传了 executionTurn,
    // 失败后经扫描重投却按终态续聊启动,绕过整队守卫)。freezeGuard 让 spawn 前再核一次
    // 分组暂停/删除归档的持久事实 —— 自动投递离 spawn 很远,中途用户可能刚按下暂停。
    ...(m.execution ? { executionTurn: true, freezeGuard: true } : {}),
    // 带来源的消息不是真人打的字(眼下只有哨兵事件)。标 byBackend 之后它在会话里显示
    // 成「系统代写的一回合」,而不是冒充用户说过这句话 —— 读端据此分开(见 orchestrator
    // 的 byBackend 注释)。它仍然占一个真实回合,因为 agent 确实要为它跑一轮。
    ...(m.origin ? { byBackend: true } : {}),
  };
}

/**
 * 哨兵事件的**最后一道闸**：带着来源身份走到真正起这一轮的那个入口，在那儿按最新状态
 * 再问一次「这个任务还能不能被叫醒」。`undefined` = 这条消息不是哨兵推的，不挂闸。
 *
 * 为什么扫描那一层的判定不够：`beginDelivery` 抢下的是**租约**，不是送达。从抢到租约到
 * 真正续跑中间还要等当前这一轮退干净，那段时间里用户完全可以把任务标成完成 —— 于是一条
 * 压根没进会话的事件把一个已经 done 的任务拉回 running，多出一轮会话（第 4 轮审查实测：
 * `paused → done → running → done`）。
 *
 * 判据与创建入口、扫描出口同一份（`monitorBlockedReason`），三处分家就等于没防。
 *
 * **导出是给回归测试用的**（同 `beginDelivery`）：这个窗口的前提是「租约已经抢下」，而
 * 租约一旦落下，扫描那条路就会跳过这一行 —— 现场只能由「拿着抢到的那一行，去走真正的
 * 运行入口」摆出来。于是测试拿生产的 `beginDelivery` + `deliveryOptions` + 这一个闸去调
 * 生产的 `continueTask`，跟 `deliverWhenIdle` 的装法逐字一致。投递逻辑之外不要调它。
 */
export function monitorWakeGuard(message: Row): (() => Promise<string | null>) | undefined {
  if (monitorIdFromOrigin(message.origin) === null) return undefined;
  return async () => {
    // 投影**故意只有这两个字段**：回归用「谁按 {status, archived} 两字段读 tasks」来精确
    // 认出这一问并只拒它一次（test-monitor-races ㉒ 的注入）。taskId 本来就在手上，没必要
    // 从库里再读一遍 —— 多带一个 id 就会让那条注入静默落空，变成一段空测。
    const task = (await db
      .select({ status: tasks.status, archived: tasks.archived })
      .from(tasks)
      .where(eq(tasks.id, message.taskId))).at(0);
    if (!task) return "任务不存在";
    // 审查进行中的豁免跟别处同一份（`monitorWakeGate`）：这一道闸守的是「租约抢下之后、
    // 真正续跑之前」那个窗口，判据跟创建入口分家就等于没防。**按这条哨兵自己记下的那次
    // 审查与那一轮问**，所以要多读一次哨兵行 —— 排在 tasks 那一问之后，上面那条注入
    // 才照旧命中。
    return monitorWakeGate({ id: message.taskId, ...task }, await monitorEventSource(message.origin));
  };
}
