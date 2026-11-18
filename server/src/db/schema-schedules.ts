// 定时（`schedules`）与待发送消息（`scheduledMessages`）两张表。
//
// 为什么单独一个文件：schema.ts 已经贴着项目约定的 700 行上限（全局 CLAUDE.md），这两张表自成一块
// （到点重跑任务 / 到点或空闲时往会话里送一句），搬出来不牵扯别的表。`schema.ts` 原样转发，
// 所有 `from "./db/schema.js"` 的导入不受影响。
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { MonitorWakeData } from "@ash/shared/monitor-wake";

export const schedules = sqliteTable("schedules", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  kind: text("kind").notNull(), // once | cron
  at: text("at"), // ISO timestamp for one-shot
  cron: text("cron"), // 5-field expression for recurring
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  lastRunAt: text("last_run_at"),
  // 建这条日程的人。到点派出去的任务按它继承 ownerUserId(§八 三条继承规则之二),
  // 停用该用户时他建的日程一并暂停(§五)。
  ownerUserId: text("owner_user_id"),
  createdAt: text("created_at").notNull(),
});

// Scheduled replies: a message to send to a task's agent when it comes due
// (continueTask). Distinct from `schedules` (which re-runs a task): a task may
// have several pending messages; the scheduler fires each when due and the task
// is idle. `mode` decides what "due" means — timed=到点，queued=任务一空闲就发。
export const scheduledMessages = sqliteTable("scheduled_messages", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  text: text("text").notNull().default(""),
  attachments: text("attachments").notNull().default("[]"), // json string[]
  agent: text("agent"), // AgentType | null（@指派目标）
  // @指派时一并选定的执行器与模型：定时发送落地时要跑的还是用户当时选的那一个。
  executorId: text("executor_id"), // agents.id | null（null=按 agent 类型默认执行器）
  model: text("model"), // 模型覆盖 | null（跟随执行器）
  reasoningEffort: text("reasoning_effort"), // 思考强度覆盖 | null（跟随执行器）
  // 投递时恢复的回合身份（"reviewer" 等）。审查者提问回合还没 release turn、用户就答复
  // 时答案会落到这里排队——不存 role 的话投递会以 single 身份进实现会话，reviewer 永远
  // 收不到答案（审查实测复现）。null = 普通消息。
  sessionRole: text("session_role"),
  // **这条消息续起来的那一轮审查是哪一次、哪一轮。** 只跟 session_role='reviewer' 一起有意义。
  // 为什么要落库:投递可能发生在几分钟之后,那时「现在最新是哪一次审查」已经不一定是排它
  // 那一刻的那一次(派审交接期尤其),而现查会把旧请求绑到新审查上(第 10 轮审查 F1)。
  // 两列为空 = 这条消息没记下为哪一轮排的,它续起来的回合**不代表任何一轮审查**(显式的
  // `"unbound"`,不是「就按最新那一轮算」;本轮审查 F2)。
  reviewRun: text("review_run"),
  reviewRound: integer("review_round"),
  // 这条消息是**谁发的**(多人模式)。投递时按它解析执行器/供应商/CLI 环境与 git 署名
  // —— 排队消息可能几分钟后才送出去,那时不能退回「任务归属人」:在别人的任务上排的
  // 队,烧的仍该是排队那个人自己的 key(§八)。null = 自用模式或存量行。
  ownerUserId: text("owner_user_id"),
  // 这条消息是谁写的。null = 真人；"monitor:<id>" = 某个哨兵推来的事件。两件事靠它：
  // 同一个哨兵还没送出去的事件合并进同一行（一次唤醒看完全部，而不是一行一个回合），
  // 投递时标 byBackend，让它在会话里显示成系统代写的一回合而不是冒充用户发言。
  origin: text("origin"),
  monitorWake: text("monitor_wake", { mode: "json" }).$type<MonitorWakeData>(),
  mode: text("mode").notNull().default("timed"), // timed | queued | after
  // mode=after:等这个任务完成再发(见 shared/src/schedule.ts)。其余 mode 为 null。
  afterTaskId: text("after_task_id"),
  // mode=after 的前置任务落 done 的那一刻(锁存:之后前置再跑/失败/被删都撤不回,见 pending-after.ts)。
  afterDoneAt: text("after_done_at"),
  // mode=after 登记那一刻前置任务的完成基线:前置的 done_seq 超过它才算等到(pending-after.ts)。
  afterSeq: integer("after_seq"),
  // 执行意图:1 = 这条是任务**排队等轮次时**暂存的回复,投递它 = 开启任务的执行回合
  // —— 整队在跑守卫与分组暂停都挡它,重投也不丢(第 xNb655YqYzcA 链第 5 轮:起跑失败
  // 后的自动重投曾丢掉意图,借终态续聊豁免并行执行/穿透暂停)。0 = 普通消息(运行中
  // 暂存的追问、定时消息、终态续聊),沿用原投递语义。
  execution: integer("execution", { mode: "boolean" }).notNull().default(false),
  sendAt: text("send_at").notNull(), // timed=ISO 到期时间；queued=入队时刻（只用来排先后）
  status: text("status").notNull().default("pending"), // pending | sent | canceled
  createdAt: text("created_at").notNull(),
  sentAt: text("sent_at"),
  // 「有人正在把这条送进会话」的租约（ISO 时刻），行本身仍是 pending。sent 只在原话
  // 真的落进会话之后才写，所以 sent 永远意味着「用户刷新后看得见」。租约是内存态的
  // 持久投影：进程一换就作废（开机 reclaimStaleDeliveries 全清），那条消息回到待发送。
  deliveringSince: text("delivering_since"),
  // 这张**续跑凭证**此刻挂在谁名下(checkpoint-ownership.ts 的 token:pid + 代次 + 开机随机数
  // + 这一笔认领/接管独有的随机串)。只有续跑凭证用它。
  //
  // 为什么租约时刻不够:它既要当「这条租约多久了」又要当身份,于是同毫秒接管不保证换值,
  // 更证不出「原发送方还在不在」。多开实例(NAVI_ALLOW_MULTI)时后者是硬要求 —— 两个独立进程
  // 实测:接管方按「没送出去」把交代还给任务,而原发送方照旧送了出去,同一段话执行两遍
  // (第 2 轮自由审查 F1)。旧行 NULL = 那一代还没有身份,接管资格另按单例锁判(同上文件头)。
  deliveringOwner: text("delivering_owner"),
  // 这条消息已经把 `tasks.resume_prompt` 那段续跑交代**接走了**,值就是那一段原文,正文
  // 末尾带着它(见 monitor-session.ts 的 monitorWakeCheckpoint)。
  //
  // 为什么要这一列:哨兵叫醒的那一轮要把 agent 自己留下的交代一起喂回去,而「先从任务行
  // 取走、没送出去再回填」只把那段话留在一个内存闭包里 —— 取走成功、送达之前进程一换
  // (崩溃/重启),开机只清投递租约,重投的是原始事件正文,再去读任务行也已经空了:那段
  // 交代两边都不在(第 2 轮审查 F4)。写在这里 = 跟取走同一个批里落盘,于是重投认得出
  // 「正文里已经带着它了」(幂等)、回填失败也不丢(下一次投递照旧带着它走)、送达之后
  // 这一行就是那段交代被谁消费掉的记录。
  checkpointTaken: text("checkpoint_taken"),
  // 跟 `checkpoint_taken` 同一笔落库的**随身凭证**：那段交代的来源和它取走时的占用代次
  // （见 tasks.resume_prompt_generation）。少了这两样，持久重投只能靠任务行上的休眠值猜来源、
  // 靠「那一格空着」猜归属 —— 两样都会在期间有过别的占用时猜错（第 2 轮审查 F2）。
  checkpointAuto: integer("checkpoint_auto", { mode: "boolean" }),
  checkpointGeneration: integer("checkpoint_generation"),
  // 这条消息承载的是**哪一笔**结果交接(`<monitorId>:<result_handoff_at>`)。null = 不是交接,
  // 是普通消息/哨兵事件。
  //
  // 为什么要这一列(第 2 轮审查 N1):交接是「入队」+「销凭证」两条语句,第二条失败(或进程正好
  // 死在中间)时凭证留着,重投器下一趟还会按它再送一次 —— 而上一条可能已经 sent,合并窗口对它
  // 不适用,于是同一条结束通知变成两条消息、把 agent 叫醒两次。身份跟入队写在同一笔里,所以
  // 「送过没有」这一问有一个原子的答案:库里找得到这个 token ⇒ 已经送过,只补销凭证。
  handoffToken: text("handoff_token"),
  // 这条消息是哪一条问答的答复（tasks.question_history 里那条记录的 id）。投递时原样落进会话
  // 那条用户回合（answerIds），删除消息按它清问答历史。null = 不是答复。
  answerId: text("answer_id"),
  // 这张凭证**是在哪一代投递协议下开出来的**(delivery-crossing.ts 的 CROSSING_PROTOCOL)。
  //
  // 为什么非得落库:恢复侧用「越线记号不在」当否证,而那个否证只有在写记号是**硬前置**
  // (写不成就不 spawn)的那一代里才成立。`crossingRequired` 只活在当时那个调用栈里,
  // 旧凭证和新凭证在库里长得一模一样 —— 升级之后拿新代码的判据去读旧代开的凭证,等于
  // 把旧协议当时根本没给过的证明力追认给它(第 2 轮自由审查 F1 跨进程实测:同一段交代
  // 在升级后被执行了两遍)。null = 旧代开的,它的沉默什么都不证明,只能按交付不明处理。
  crossingProtocol: text("crossing_protocol"),
  // 哨兵结果**在回合里**交给了哪一轮（那一轮的 active_turn_token）。status='sent' 且非空 = 已交、
  // 等那一轮收口才算数；没有确认送到就退回 pending（monitor-turn-handoff.ts 文件头）。
  turnTakenBy: text("turn_taken_by"),
  // 那一次交付的交付号 + 时刻 + MCP 发回确认的时刻（monitor-turn-ack.ts）：没有 ackedAt 就不算送到。
  turnHandoff: text("turn_handoff", { mode: "json" }).$type<{ hand: string; at: string; ackedAt?: string }>(),
  // 回合里交过、那一轮没正常收口而退回来的时刻。非空的 pending 行熬得过终态连坐，等下一次起跑送达。
  turnReturnedAt: text("turn_returned_at"),
  // 哨兵输出那一批在这一刻之前不投递，等紧跟着的「结束」并进来（monitor-events.ts `pushToTask`）。
  mergeHoldUntil: text("merge_hold_until"),
});
