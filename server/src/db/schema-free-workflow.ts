// 自由工作流那一族表：工作流状态与事件、审查链(run/round)、以及一条驳回上开的辩论。
//
// 从 schema.ts 拆出来的理由和 schema-multiuser / schema-chat 一样——那份文件已越过 700 行
// 上限,而这一族是其中边界最清楚的一块:只被自由工作流那几个模块用到,其余表都不引用它。
// **整份仍由 schema.ts 原样再导出**:drizzle 的 `import * as schema` 必须看到全部表,
// 拆文件不能拆掉那个视图。
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { Client } from "./node-sqlite-client.js";

/**
 * 一条预约是**谁挂上的**。驳回要撤哪条、要留哪条，按它判，不按 runId 空不空猜：
 * - `follow_up`：审查未通过、还有轮数时结算自动挂的续轮（`armFollowUpFreeReview`，以及
 *   老库 repairing 状态迁移回填的那批）；
 * - `user`：用户在审查面板里保存的预约（`reserveFreeReview`）；
 * - `handoff`：接力导入、对端载荷没带来源的那条（老版本对端），来源说不清，按手存对待。
 * 启动失败回滚（`restoreFreeReviewReservation`）原样带回消费前的来源，不另起一类。
 */
export type FreeReviewReservationSource = "follow_up" | "user" | "handoff";

export const freeWorkflowStates = sqliteTable("free_workflow_states", {
  taskId: text("task_id").primaryKey(),
  selectedReviewerId: text("selected_reviewer_id"),
  reviewArmed: integer("review_armed", { mode: "boolean" }).notNull().default(false),
  reviewCheckMode: text("review_check_mode"),
  reviewRetryLimit: integer("review_retry_limit"),
  reviewNote: text("review_note"),
  // 预约要用的执行器覆盖（相对审查者配置，只作用于这一次）。四列一起写、一起清：
  // 智能体换了、模型/智能水平就得跟着重来，拆开写会拼出审查者从未有过的组合。
  // agent_type 为空 = 没有覆盖，照审查者自己的配置跑。
  reviewAgentType: text("review_agent_type"),
  reviewExecutorId: text("review_executor_id"),
  reviewModel: text("review_model"),
  reviewReasoningEffort: text("review_reasoning_effort"),
  // 非空 = 自动复审链的续轮预约：修复确认完成后在这条 run 上续下一轮，而不是开新 run。
  reviewRunId: text("review_run_id"),
  // 这条预约的来源（见 `FreeReviewReservationSource`）；只在 armed 时有意义，清槽时一并置空。
  reviewSource: text("review_source").$type<FreeReviewReservationSource>(),
  // 「这条预约的触发时刻已经到过、只是被裁定闸按住了」：一个**正常结束**的执行回合在结算时
  // 撞上未裁定的驳回，就把当时的槽版本（updated_at）记在这里。裁定放行只认它
  // （free-review-ruling-release.ts）——任务的 done/failed 证明不了上一回合正常结束，异常退出
  // 根本走不到闸上。等于 updated_at 才算数：槽被消费、取消、重挂都会推进版本，它随之作废；
  // 执行回合开跑与维持意见也会作废它（见 free-review-reservations.ts `forgetHeldTrigger`）。
  reviewHeldToken: text("review_held_token"),
  updatedAt: text("updated_at").notNull(),
});

export const freeWorkflowEvents = sqliteTable(
  "free_workflow_events",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    kind: text("kind").notNull(),
    source: text("source").notNull(),
    detail: text("detail"),
    occurredAt: text("occurred_at").notNull(),
  },
  (t) => ({ taskIdx: index("free_workflow_events_task_idx").on(t.taskId, t.occurredAt) }),
);

export const freeReviewRuns = sqliteTable(
  "free_review_runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    reviewerId: text("reviewer_id"),
    reviewerName: text("reviewer_name").notNull(),
    agentType: text("agent_type").notNull(),
    executorId: text("executor_id"),
    model: text("model"),
    reasoningEffort: text("reasoning_effort"),
    checkMode: text("check_mode").notNull(),
    note: text("note"),
    // workspace = 验收前任务工作区；accepted_merge = 验收时冻结的目标分支 commit 区间。
    targetKind: text("target_kind").notNull().default("workspace"),
    targetBranch: text("target_branch"),
    targetBaseCommit: text("target_base_commit"),
    targetCommit: text("target_commit"),
    // 合并结果审查未通过后创建的独立修复任务；非空即幂等返回同一任务。
    repairTaskId: text("repair_task_id"),
    retryLimit: integer("retry_limit").notNull().default(1),
    currentRound: integer("current_round").notNull().default(1),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (t) => ({ taskIdx: index("free_review_runs_task_idx").on(t.taskId, t.createdAt) }),
);

/**
 * 「这一轮的任务书已经交给回合锁,还没送进会话」—— 一次**尚未完成的派发意图**。
 *
 * 为什么不能靠现场推断:派发是个两段式动作。`launchReviewRound` 建好 run/round 行、写下
 * 「审查开始」,真正的投递却留在 `continueWhenIdle` 的异步回调里等回合锁空出来。那一刻之后
 * 这一行与「审查正在跑」长得一模一样 —— 两者的 run/round 都是 `reviewing`。
 *
 * 不落下来的代价实测过(2026-10-31,任务 IZk5yKUHpR2G):预约复审在释放点上输给另一条排队
 * 续跑,`claimOwnTurn` 失败 → 148ms 后 round 落 error、run 落 failed,预约早已被消费,自动链
 * 就地停住,要用户手动再开一轮。瞬时条件(别人正占着回合)变成了永久后果,而输赢纯属时序运气。
 *
 * 所以把意图本身落在这一行上:交出去就记,送进会话(或重试次数用尽)才清。非空 =
 * **这一轮还在等一个空闲窗口**,于是:
 *  · 重排不必重算 —— 同进程里消息还在闭包里,直接再排一次;
 *  · 跨重启能补办 —— `reconcileFreeReviews` 据它把「还没投递」和「跑着跑着死了」分开,后者
 *    照旧收尸,前者补投一次(本进程是否还armed 由内存那张表回答,见 free-review-dispatch.ts);
 *  · 放弃有交代 —— `attempts` 就是「输了几次」,写进时间线和终态说明。
 *
 * 为什么住在 round 行上而不是另起一张表(对比 `queue_advance_intents`):队列推进的意图讲的是
 * 一条队列,而队列没有自己的行可挂(请求写在候选任务身上),所以才要一张表。这里不一样 ——
 * 意图讲的正是**这一轮**,round 行就是它天然的主人:身份现成(`run_id`+`round` 唯一),生命周期
 * 现成(轮次一结束这几个字段自动失去意义)。
 *
 * 但**代次省不掉**(原先这里写的是「不需要代次」,第 3 轮审查 F2 证伪了它):同一个 round 行会被
 * 用户重跑(`reopenFailedFreeReview` 把它放回 reviewing 并换新的证据代次),于是「这一行」会先后
 * 代表同一轮的好几次派发。少了代次,上一次的收尾清掉的就是新一次刚写下的意图。
 */
export type FreeReviewDispatchIntent = {
  /** 已经把这一轮交给回合锁几次（含第一次）。有界重试的全部凭据,也是放弃时的交代。 */
  attempts: number;
  /** 第一次交出去的时刻（写给时间线;**不是**重试的时间上界,理由见 free-review-dispatch.ts）。 */
  since: string;
  /**
   * 重跑崩掉的那一轮时的两个入参。跨重启补办要原样重放它们:丢了 `resumeSessionId`,
   * 「让同一位审查者接着做」就会变成「换条空会话从头再来」(白烧一遍上下文)。
   */
  resumeSessionId?: string | null;
  retry?: boolean;
  /**
   * **这一轮的哪一次** —— 证据行(`regression_evidence.generation`)上那个值,用户重跑同一轮时
   * 换新。清意图、写意图的 CAS、失败收尾全按它认人(理由见 free-review-dispatch.ts 文件头 ⑨)。
   *
   * 老行(加这一位之前写下的意图)留 undefined:那时整条链只有一代,读写两端按版本放行。
   */
  generation?: string;
  /**
   * **原派发要的是一条新会话还是续旧的** —— 这一位也必须跟着落下来。
   *
   * 补办不是另一种派发,是**同一次派发的第二次投递**,所以会话策略只能照原样重放。漏了它
   * 那一次就只剩「没指名 resumeSessionId」这一个事实,而下游的默认动作是按 agentType+role
   * 挑**最近**的历史会话(`turn-session-pick.ts`,不按 run 隔离):新链第 1 轮、合并结果审查
   * 本该各开一条空会话,补办后却接进了上一条链的旧对话 —— 换了上下文的同一位审查者。
   *
   * 老行(加这一位之前写下的意图)留 undefined,读端按原公式回落(见 `launchReviewRound`)。
   */
  freshSession?: boolean;
  /**
   * 办到哪一步了 —— `preparing` = 还在算任务书(工作区、HEAD、MCP 预检),`queued` = 已经排进
   * 回合锁的等待队列。
   *
   * **两档都是「这一轮有人负责」**,这一位只决定措辞:补投时说得清上次中断在哪一段。为什么
   * 准备阶段也要落库,见 `preparingReviewDispatch`(没有它,一个活着的准备在对账眼里就是孤儿)。
   *
   * 老行(加这一位之前写下的意图)留 undefined,按 `queued` 读 —— 那时候只有排上队才会落意图。
   */
  phase?: "preparing" | "queued";
};

export const freeReviewRounds = sqliteTable(
  "free_review_rounds",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    round: integer("round").notNull(),
    status: text("status").notNull(),
    conclusion: text("conclusion"),
    // 本轮启动时任务工作区的 HEAD。结论新不新鲜靠锚点跟当前工作区比，不靠状态字段
    // （判据见 shared 的 `reviewAnchorMatches`）。
    reviewedCommit: text("reviewed_commit"),
    // 本轮启动时工作区的内容指纹（含未提交改动，workspace-fingerprint.ts）；null = 老数据，退回只比 HEAD；
    // `UNKNOWN_FINGERPRINT` = 这一轮采集失败，永远判未知（不许冒充老数据退回 HEAD）。
    reviewedFingerprint: text("reviewed_fingerprint"),
    // 执行者驳回这一轮那一刻的内容指纹：维持意见后修复对应的是这一版（理由同上）。
    disputedFingerprint: text("disputed_fingerprint"),
    // 写给用户的那一句人话（`PLAIN_SUMMARY_GUIDE`）：裁定屏的第一行字，时间线旁注也用它。
    // null = 加这列之前落的老驳回（界面降级成只显示正文，不编一句摘要糊上去）。
    disputeSummary: text("dispute_summary"),
    // 执行者对这一轮结论的驳回：理由正文 + 时刻。非空 = 这一轮没被执行者认下。
    disputeReason: text("dispute_reason"),
    // 同一次驳回里「我认可这几条，但它们超出本任务边界，建议转独立任务」那一段。
    // 与 dispute_reason 分开存：界面据它决定给不给「转为独立任务」那个出口，服务端
    // 据它拒绝凭空的 deferred 裁定——两段揉进一个字段就只能靠在文本里找关键词。
    // 两列**至少有一列非空** = 这一轮挂着一条驳回（CAS 与 openDisputeOf 都按这个判）。
    disputeDeferReason: text("dispute_defer_reason"),
    disputeAt: text("dispute_at"),
    // **用户**的裁定（upheld=维持审查意见 / withdrawn=采纳执行者 / deferred=转独立任务），
    // 与辩论里审查者自述的 verdict 分开存：让被驳回的一方替用户签字，等于绕过裁定这件事本身。
    disputeResolution: text("dispute_resolution"),
    disputeResolvedAt: text("dispute_resolved_at"),
    // 用户裁定时写给执行者的那段话。三档裁定表达不了「这条我认，但按辩论里达成的那个
    // 方案做」，这一列就是它的出口；upheld 时整段拼进修复提示，并在措辞里声明它压过
    // 报告——裁定人是用户，报告只是审查者的一份判断。
    disputeResolutionNote: text("dispute_resolution_note"),
    // deferred 裁定建出的那个 backlog 派生任务；非空即幂等返回同一任务（同 repair_task_id）。
    disputeDeferredTaskId: text("dispute_deferred_task_id"),
    // 非空 = 驳回还没裁定时，**用户自己**又派了一轮新的工作区审查（或重跑了一条更新的链），
    // 这条驳回不再等裁定。它不是裁定（resolution 仍为 null，不冒充用户签了哪一档），只记
    // 「被取代」这件事和时刻；派审那一刻同时写时间线。没有它时，更新的审查链会把旧驳回
    // 静默遮住：最近一轮看不到、任务级又算不清它还欠不欠一个裁定（第 1 轮审查问题 2）。
    disputeSupersededAt: text("dispute_superseded_at"),
    // 非空 = 这一轮的任务书还没送进会话,正在等一个空闲回合窗口（见 `FreeReviewDispatchIntent`）。
    dispatch: text("dispatch", { mode: "json" }).$type<FreeReviewDispatchIntent>(),
    // 这一轮任务书里「此前报过的发现」清单**实际内联了**哪几个编号（`review-recurrence.ts`）。
    // 审查者声明承接时只认这里面的：系统发过什么就认什么，不按「库里有这一条」放宽。
    historyRefs: text("history_refs", { mode: "json" }).$type<string[]>(),
    // 审查者在 report_stage 里声明、且**校验通过**的承接：本轮第 finding 条拦验收发现是清单里
    // `from` 那一条的复发。校验不过的一条都不落（失效向不触发，见 review-recurrence.ts）。
    carries: text("carries", { mode: "json" }).$type<{ finding: number; from: string }[]>(),
    /** 这一轮的熔断修复**正处在哪个方向世代**（`tasks.direction_epoch`）；提问格式闸只认这个世代（review-recurrence-gate.ts）。 */
    breakerEpoch: integer("breaker_epoch"),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
  },
  (t) => ({ runRoundIdx: uniqueIndex("free_review_rounds_run_round_idx").on(t.runId, t.round) }),
);

// 一条驳回上开的辩论。一轮审查至多一条（`round_id` 唯一）：用户再想让双方说一次，
// 得先裁定这一条 —— 否则同一份报告会挂着两条互相矛盾的辩论记录。
export const freeReviewDebates = sqliteTable(
  "free_review_debates",
  {
    id: text("id").primaryKey(),
    roundId: text("round_id").notNull(),
    taskId: text("task_id").notNull(),
    runId: text("run_id").notNull(),
    round: integer("round").notNull(),
    status: text("status").notNull(),
    /** 来回数；总发言段数 = exchanges * 2 + 1（末尾多一段审查者收尾）。 */
    exchanges: integer("exchanges").notNull().default(1),
    /** 正在发言的是第几段；结束后停在最后一段的序号。 */
    currentSeq: integer("current_seq").notNull().default(1),
    verdict: text("verdict"),
    startedAt: text("started_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (t) => ({
    // 一轮意见可以留多条辩论记录：辩完的那条挡着再辩，中断的允许重开（判据在
    // free-review-debate.ts，不靠唯一索引表达）。
    roundIdx: index("free_review_debates_round_idx").on(t.roundId, t.startedAt),
    taskIdx: index("free_review_debates_task_idx").on(t.taskId, t.startedAt),
  }),
);

export const freeReviewDebateTurns = sqliteTable(
  "free_review_debate_turns",
  {
    id: text("id").primaryKey(),
    debateId: text("debate_id").notNull(),
    seq: integer("seq").notNull(),
    side: text("side").notNull(),
    // 这一段发言的一句人话（`PLAIN_SUMMARY_GUIDE`）：七段加起来一万字，界面逐段先摆它。
    summary: text("summary"),
    // 发言正文由 `debate_reply` 直接落库（不走证据目录）：它是对话，不是证据文件，
    // 而且必须能在「这一段到底交卷没有」上给出确定答案 —— 文件存不存在答不了这个。
    statement: text("statement"),
    status: text("status").notNull(),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
  },
  (t) => ({ debateSeqIdx: uniqueIndex("free_review_debate_turns_seq_idx").on(t.debateId, t.seq) }),
);

/**
 * 这一族表的建表与补列。**和表定义放在同一个文件里**（`schema-chat` /
 * `schema-page-annotation` 就是这么做的）：列一加就是两处要改，隔着文件只会漏一边。
 *
 * 从 `db/index.ts` 搬出来的理由跟表定义当初搬出 `schema.ts` 一样——那份文件已经越过 700 行
 * 上限，而这一族的边界最清楚：这些表不被其它表引用，建表和补列都只碰 `free_*`，所以整段
 * 可以自成一个顺序无关的单元。`ensureSchema()` 只留一行调用。
 *
 * 内部顺序**不可换**：补列靠 CREATE TABLE 已经建好表才有意义（`CREATE TABLE IF NOT EXISTS`
 * 对已存在的老表什么都不做，补列正是给那些老表用的）。每条 ALTER 各自容错，缺哪一列补哪
 * 一列，老库漏了中间任意一条也能升上来。
 */
export async function ensureFreeWorkflowSchema(client: Client): Promise<void> {
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS free_workflow_states (
      task_id TEXT PRIMARY KEY, selected_reviewer_id TEXT,
      review_armed INTEGER NOT NULL DEFAULT 0, review_check_mode TEXT,
      review_retry_limit INTEGER, review_note TEXT, review_run_id TEXT,
      review_agent_type TEXT, review_executor_id TEXT,
      review_model TEXT, review_reasoning_effort TEXT, review_source TEXT, review_held_token TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS free_workflow_events (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL,
      source TEXT NOT NULL, detail TEXT, occurred_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS free_workflow_events_task_idx
      ON free_workflow_events (task_id, occurred_at);
    CREATE TABLE IF NOT EXISTS free_review_runs (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, reviewer_id TEXT,
      reviewer_name TEXT NOT NULL, agent_type TEXT NOT NULL, executor_id TEXT,
      model TEXT, reasoning_effort TEXT, check_mode TEXT NOT NULL, note TEXT,
      target_kind TEXT NOT NULL DEFAULT 'workspace', target_branch TEXT,
      target_base_commit TEXT, target_commit TEXT, repair_task_id TEXT,
      retry_limit INTEGER NOT NULL DEFAULT 1, current_round INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS free_review_runs_task_idx ON free_review_runs (task_id, created_at);
    CREATE TABLE IF NOT EXISTS free_review_rounds (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, round INTEGER NOT NULL,
      status TEXT NOT NULL, conclusion TEXT, reviewed_commit TEXT,
      reviewed_fingerprint TEXT, disputed_fingerprint TEXT, dispute_summary TEXT,
      dispute_reason TEXT, dispute_defer_reason TEXT, dispute_at TEXT,
      dispute_resolution TEXT, dispute_resolved_at TEXT, dispute_resolution_note TEXT,
      dispute_deferred_task_id TEXT, dispute_superseded_at TEXT, dispatch TEXT,
      history_refs TEXT, carries TEXT, breaker_epoch INTEGER,
      started_at TEXT NOT NULL, ended_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS free_review_rounds_run_round_idx
      ON free_review_rounds (run_id, round);
    CREATE TABLE IF NOT EXISTS free_review_debates (
      id TEXT PRIMARY KEY, round_id TEXT NOT NULL, task_id TEXT NOT NULL,
      run_id TEXT NOT NULL, round INTEGER NOT NULL, status TEXT NOT NULL,
      exchanges INTEGER NOT NULL DEFAULT 1, current_seq INTEGER NOT NULL DEFAULT 1,
      verdict TEXT, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS free_review_debates_round_idx
      ON free_review_debates (round_id, started_at);
    CREATE INDEX IF NOT EXISTS free_review_debates_task_idx
      ON free_review_debates (task_id, started_at);
    CREATE TABLE IF NOT EXISTS free_review_debate_turns (
      id TEXT PRIMARY KEY, debate_id TEXT NOT NULL, seq INTEGER NOT NULL,
      side TEXT NOT NULL, summary TEXT, statement TEXT, status TEXT NOT NULL,
      started_at TEXT NOT NULL, ended_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS free_review_debate_turns_seq_idx
      ON free_review_debate_turns (debate_id, seq);
  `);
  for (const sql of [
    // 自由工作流预约审查：只保存一份配置，confirmed done 后复用现有派审链。
    "ALTER TABLE free_workflow_states ADD COLUMN review_armed INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE free_workflow_states ADD COLUMN review_check_mode TEXT",
    "ALTER TABLE free_workflow_states ADD COLUMN review_retry_limit INTEGER",
    "ALTER TABLE free_workflow_states ADD COLUMN review_note TEXT",
    "ALTER TABLE free_workflow_states ADD COLUMN review_run_id TEXT",
    // 预约里「这次换个模型/智能水平跑」的覆盖（不改审查者配置本身）。
    "ALTER TABLE free_workflow_states ADD COLUMN review_agent_type TEXT",
    "ALTER TABLE free_workflow_states ADD COLUMN review_executor_id TEXT",
    "ALTER TABLE free_workflow_states ADD COLUMN review_model TEXT",
    "ALTER TABLE free_workflow_states ADD COLUMN review_reasoning_effort TEXT",
    // 预约来源（自动续轮 / 用户手存 / 接力导入）；老行由 migrations.ts 按当时的形态回填。
    "ALTER TABLE free_workflow_states ADD COLUMN review_source TEXT",
    // 被裁定闸按住的那次触发（正常结束的执行回合留下的槽版本），裁定放行只认它。
    "ALTER TABLE free_workflow_states ADD COLUMN review_held_token TEXT",
    "ALTER TABLE free_review_runs ADD COLUMN note TEXT",
    "ALTER TABLE free_review_runs ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'workspace'",
    "ALTER TABLE free_review_runs ADD COLUMN target_branch TEXT",
    "ALTER TABLE free_review_runs ADD COLUMN target_base_commit TEXT",
    "ALTER TABLE free_review_runs ADD COLUMN target_commit TEXT",
    "ALTER TABLE free_review_runs ADD COLUMN repair_task_id TEXT",
    "ALTER TABLE free_review_rounds ADD COLUMN reviewed_commit TEXT",
    // 执行者驳回审查结论那条支线（理由 + 用户裁定）；老库补列即可，空 = 没驳回过。
    "ALTER TABLE free_review_rounds ADD COLUMN dispute_reason TEXT",
    "ALTER TABLE free_review_rounds ADD COLUMN dispute_at TEXT",
    "ALTER TABLE free_review_rounds ADD COLUMN dispute_resolution TEXT",
    "ALTER TABLE free_review_rounds ADD COLUMN dispute_resolved_at TEXT",
    // 第三条出路：「意见成立但越界，建议转独立任务」的理由，以及裁定后建出的那个任务。
    "ALTER TABLE free_review_rounds ADD COLUMN dispute_defer_reason TEXT",
    "ALTER TABLE free_review_rounds ADD COLUMN dispute_deferred_task_id TEXT",
    // 裁定时用户写给执行者的要点（三档裁定表达不了的那部分结论，多半是辩论里达成的方案）。
    "ALTER TABLE free_review_rounds ADD COLUMN dispute_resolution_note TEXT",
    // 驳回与每段辩论发言的「人话摘要」：裁定屏第一行字。老行留 null，界面降级显示正文。
    "ALTER TABLE free_review_rounds ADD COLUMN dispute_summary TEXT",
    // 驳回未裁定时被用户新派的一轮审查取代的时刻。老行留 null = 没被取代过。
    "ALTER TABLE free_review_rounds ADD COLUMN dispute_superseded_at TEXT",
    // 「这一轮的任务书交出去了、还没送进会话」那份未完成的派发意图（见 `FreeReviewDispatchIntent`）。
    // 老行留 null = 没有在途派发,照旧按原路对账。
    "ALTER TABLE free_review_rounds ADD COLUMN dispatch TEXT",
    // 同类问题承接（review-recurrence.ts）：发过的清单编号 + 审查者声明的承接。老行留 null = 没有。
    "ALTER TABLE free_review_rounds ADD COLUMN history_refs TEXT",
    "ALTER TABLE free_review_rounds ADD COLUMN carries TEXT",
    "ALTER TABLE free_review_rounds ADD COLUMN breaker_epoch INTEGER",
    // 内容锚点（审查开始时 / 驳回时）；老行留 null = 退回只比 HEAD + 干净。
    "ALTER TABLE free_review_rounds ADD COLUMN reviewed_fingerprint TEXT",
    "ALTER TABLE free_review_rounds ADD COLUMN disputed_fingerprint TEXT",
    "ALTER TABLE free_review_debate_turns ADD COLUMN summary TEXT",
  ]) {
    try {
      await client.execute(sql);
    } catch {
      /* column already exists */
    }
  }
}
