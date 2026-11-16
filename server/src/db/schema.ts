import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { ProjectPreviewConfig } from "@ash/shared/preview";
import type { ProjectCommandsConfig } from "@ash/shared/project-commands";
import type { TaskWaitOwnership } from "./schema-task-wait.js";

// JSON columns are stored as text and parsed in the repository layer.
// Schema mirrors shared/src/index.ts.

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  repoPath: text("repo_path").notNull(),
  apiKeys: text("api_keys"), // legacy project-level credentials, kept for compatibility
  // 本项目新建任务默认用哪条起手式（workflows.id 或内置 key）。空 = 跟随全局默认。
  workflowId: text("workflow_id"),
  // 本项目新建任务默认开不开独立 worktree。没有「跟随全局」这一档 —— 这颗开关只住在
  // 项目这一层（曾经是 app_settings.worktreeDefault，2026-09-14 搬下来，迁移见
  // db/migrations.ts `migrateWorktreeDefaultToProjects`）。
  useWorktreeDefault: integer("use_worktree_default", { mode: "boolean" }).notNull().default(true),
  // 「打开预览」跑哪条命令。空 = 按各语言惯例自动识别（见 preview-command.ts），
  // 认出恰好一个才自动用；命令本身在任务工作区根目录用用户自己的 shell 执行。
  previewCommand: text("preview_command"),
  previewConfig: text("preview_config", { mode: "json" }).$type<ProjectPreviewConfig>(),
  // 常用命令（全局状态栏启停的常驻服务）。跟预览的分界见 shared/src/project-commands.ts。
  // 列里可能躺着旧一代的数组形状,读侧一律过 normalizeProjectCommands,这里的类型只描述新写入。
  commandsConfig: text("commands_config", { mode: "json" }).$type<ProjectCommandsConfig>(),
  // 验收合并完要不要落提交。true（默认，也是老行为）= 合并产生提交；false = 只把改动
  // 合进目标分支的工作区并暂存，目标分支的 ref 一个字节都不动，由人自己提交或丢弃。
  // 单次验收可以覆盖它（POST /tasks/:id/accept 的 commit 参数），这里只是默认值。
  acceptCommit: integer("accept_commit", { mode: "boolean" }).notNull().default(true),
  acceptAutoCommit: integer("accept_auto_commit", { mode: "boolean" }).notNull().default(false),
  // 「验收前置命令」：点下验收通过之后、动 git 之前跑的那条命令，rc=0 才合并。
  // null/空 = 这个项目不设门禁（默认，也是老行为）。为什么钉在验收那一刻，见
  // shared/src/accept-gate.ts 顶部；执行与判定在 server/src/accept-gate.ts。
  acceptGateCommand: text("accept_gate_command"),
  // 门禁的「准备命令」：快照里先跑它把依赖装出来，再跑 accept_gate_command。null = 不配，
  // 依赖照旧从工作区借用（accept-gate-deps.ts）。语义见 shared/src/project.ts 同名字段。
  acceptGatePrepare: text("accept_gate_prepare"),
  // 门禁测哪一棵树(branch / contains_target / merge_preview),语义见 shared/src/accept-gate.ts 的
  // AcceptGateBaseline。读侧一律过 normalizeAcceptGateBaseline:认不出的值回到 branch(老行为)。
  acceptGateBaseline: text("accept_gate_baseline").notNull().default("branch"),
  // 本项目的任务可以用用户已登录的 Chrome **只读**哪些站点（JSON 字符串数组，裸主机名）。
  // null/空 = 不授权，也是默认。读侧一律过 normalizeBrowserCdpDomains:这一列能被手改,
  // 而一条脏数据混进来就可能把别的站点也当成已授权(见 shared/src/project.ts)。
  browserCdpDomains: text("browser_cdp_domains", { mode: "json" }).$type<string[]>(),
  // 建这个项目的人(多人模式)。null = 自用模式建的、或转换前的存量项目。
  // 创建者自动是项目管理员,但成员关系的真源是 project_members —— 这一列只记出身。
  ownerUserId: text("owner_user_id"),
  createdAt: text("created_at").notNull(),
});

// ── 多人模式────────────────────────────────────────
// users / user_sessions / user_invites / project_members / project_invites /
// user_handoff_targets / user_settings 在 `schema-multiuser.ts`。整份原样再导出:
// drizzle 的 `import * as schema` 要看到全部表,拆文件不能拆掉那个视图。
export * from "./schema-multiuser.js";
export * from "./schema-chat.js";



// 项目走 HTTPS 远端时用的用户名 + 令牌。**一个项目一组**，故意不做成「一个项目多个
// host」：需求是「这个项目用哪个账号推」，多 host 那层复杂度还没有人要过。
//
// 这份东西不写进仓库的 .git/config（那是明文、所有 worktree 和 agent 都读得到），也不
// 回传给前端 —— 读侧只报 username 和「配没配」，见 git-credentials.ts 顶部。
export const projectGitCredentials = sqliteTable("project_git_credentials", {
  projectId: text("project_id").primaryKey(),
  username: text("username").notNull(),
  secret: text("secret").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// Generic global settings store. Values are JSON-encoded text; the typed
// read/write boundary lives in app-settings.ts so future settings can reuse the
// same table without another schema change.
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// 外部 CLI 报“会话累计值”时的最后一份原始快照。它独立于 sessions：同一个 CLI
// 会话可能跨多个 ash 行（例如讨论模式），按 source_id 才能正确算本轮差值。
export const usageCumulativeSnapshots = sqliteTable("usage_cumulative_snapshots", {
  sourceId: text("source_id").primaryKey(),
  input: integer("input_tokens").notNull(),
  output: integer("output_tokens").notNull(),
  cacheRead: integer("cache_read_tokens").notNull(),
  cacheWrite: integer("cache_write_tokens").notNull(),
  reasoning: integer("reasoning_tokens").notNull(),
  costUsd: real("cost_usd"),
  // false = 旧 trace 不完整，拿不到上一份累计值。下一次上报只建立基线、不入 token 账。
  baselineReady: integer("baseline_ready", { mode: "boolean" }).notNull().default(true),
  updatedAt: text("updated_at").notNull(),
});

export const notes = sqliteTable("notes", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  body: text("body").notNull(),
  attachments: text("attachments"), // json string[]
  // 随手记在多人模式下是**私有**的(§八),所以归属列是可见性判据本身,不只是统计。
  ownerUserId: text("owner_user_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// 一条随手记可以反复转成多个任务。独立关联表既保留完整历史，也让同一任务幂等去重；
// created_at 是转换发生时间，详情页按它倒序展示。
export const noteTasks = sqliteTable(
  "note_tasks",
  {
    noteId: text("note_id").notNull(),
    taskId: text("task_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    noteTaskIdx: uniqueIndex("note_tasks_note_task_idx").on(t.noteId, t.taskId),
    taskIdx: index("note_tasks_task_idx").on(t.taskId),
  }),
);

// 任务备忘(shared/src/task-memo.ts 写了它跟随手记、跟追问各自的分界)。挂在任务上、
// 不进任何 prompt,所以能改能删。时间戳用 TEXT ISO(跟 tasks 一致,不是 notes 那种 epoch
// 毫秒)——侧边栏那一列要拿它跟追问的 `at` 比新旧,两边同一种形状才不用在读侧转来转去。
export const taskMemos = sqliteTable(
  "task_memos",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    body: text("body").notNull(),
    attachments: text("attachments"), // json string[],跟 notes 同一种存法;NULL = 没有
    // 跟随手记同一条:备忘是**私有**的个人批注(§八),归属列是可见性判据本身。
    ownerUserId: text("owner_user_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    taskIdx: index("task_memos_task_idx").on(t.taskId),
  }),
);

export const groups = sqliteTable("groups", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  name: text("name").notNull(),
  mode: text("mode").notNull().default("parallel"), // parallel | serial
  paused: integer("paused", { mode: "boolean" }).notNull().default(false),
  // 内部组：非空 = 这个组由某个团队任务(mode:"team")派活时自动创建，成员都是它的
  // 执行者。分组管理界面按此过滤掉（见 §Team）。
  ownerTaskId: text("owner_task_id"),
  createdAt: text("created_at").notNull(),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  projectId: text("project_id").notNull(),
  groupId: text("group_id"),
  parentId: text("parent_id"),
  title: text("title").notNull(),
  body: text("body").notNull().default(""),
  mode: text("mode").notNull().default("single"), // single | duet | team
  status: text("status").notNull().default("backlog"),
  stage: text("stage"), // 正交验收阶段；不参与 status 调度/结算语义
  pinnedAt: integer("pinned_at"), // null=未置顶；多个置顶任务按时间戳排序
  starredAt: integer("starred_at"), // 星标（用户手动软记号）；null=未标
  reviewOf: text("review_of"), // 审查任务 → 被审任务 id；普通任务为 null
  reviewRound: integer("review_round"), // 审查任务针对该目标的轮次（从 1 开始）
  // 就地验证：验证轮不再另起一个任务，而是在这个任务自己身上多跑一个旁路回合。
  // verify_round 非空 = 此刻正在跑第几轮验证（结算时清空）；verify_rounds = 已经跑完几轮。
  verifyRound: integer("verify_round"),
  verifyRounds: integer("verify_rounds").notNull().default(0),
  // 已执行的验证站 id；换站后仍保留，验收据此逐站检查遗漏。
  verifyCompletedSteps: text("verify_completed_steps").notNull().default("[]"),
  // 这一站（review_step）已经就地验过几轮。轮数上限按站算，而就地验证轮没有独立任务
  // 行可数，所以自己记一个：开新一轮时发现换站了就归零。
  verifyStationRounds: integer("verify_station_rounds").notNull().default(0),
  // 验的是线上**哪一站**「自动验证」（WorkflowStep.id）。一条线可以写不止一站，
  // 轮数上限得按站分开数，否则第一站用掉的轮次会算到第二站头上。老数据为 null =
  // 线上第一站。历史那批独立审查任务把它记在自己身上，就地验证轮记在被验任务身上。
  reviewStep: text("review_step"),
  reviewRequested: integer("review_requested", { mode: "boolean" }).notNull().default(false),
  labels: text("labels").notNull().default("[]"), // json
  dependsOn: text("depends_on").notNull().default("[]"), // json
  resumeDependsOn: text("resume_depends_on").notNull().default("[]"), // json
  agentType: text("agent_type"),
  executorId: text("executor_id"), // agents.id；非空时优先使用具体执行器，空则按 agentType 默认降级
  model: text("model"), // null=跟随执行器 profile；非空=任务级覆盖
  reasoningEffort: text("reasoning_effort"), // null=跟随执行器 profile；非空=任务级覆盖
  autoTitle: integer("auto_title", { mode: "boolean" }).notNull().default(false),
  duet: text("duet"), // json DuetConfig
  team: text("team"), // json TeamConfig（mode:"team" 的调度者/默认执行者类型）
  // 执行者旗标：done 时是否汇报给调度者（dispatch 时逐个指定）。
  reportBack: integer("report_back", { mode: "boolean" }).notNull().default(false),
  scheduleId: text("schedule_id"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  startedAt: text("started_at"), // first time the task entered `running`
  endedAt: text("ended_at"), // last terminal transition (cleared while running)
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  archivedAt: text("archived_at"), // when it was archived (orders the archive view)
  // Opt-in per-task worktree. true → orchestrator builds <repoPath>/.worktrees/<id>
  // on branch `ash/<id8>` based off `worktreeBase` (null = current HEAD) before
  // running. False / missing repo → behaves like before (runs in repoPath).
  useWorktree: integer("use_worktree", { mode: "boolean" }).notNull().default(false),
  // 这个任务当初挑的那条线，**创建时拷进来的快照**（json WorkflowDef）。之后改起手式
  // 库不会追着改它 —— 「起手式」不是「模板引用」。空 = 老任务，走旧的写死流程。
  workflow: text("workflow"),
  workflowMode: text("workflow_mode").notNull().default("preset"), // preset | free
  // 这条线此刻停在哪一站（WorkflowStep.id，只会是锚点站：干活 / 自动验证 / 等我点头）。
  // 执行链靠它把「某一轮审查有了结论」「用户点了头」落回**具体那一站**，于是同一类站
  // 可以在一条线上出现多次。空 = 还没走到任何锚点，或者老任务——调用方一律回落到线上
  // 第一个同类锚点（shared 的 anchorAt），所以它丢了也只是退化成老行为，不会卡死。
  workflowAt: text("workflow_at"),
  worktreeBase: text("worktree_base"),
  worktreeStartCommit: text("worktree_start_commit"),
  // 开工起点所在的分支名（只给人看，见 shared Task.worktreeBaseBranch）。
  worktreeBaseBranch: text("worktree_base_branch"),
  mergeTargetBranch: text("merge_target_branch"),
  baseTaskId: text("base_task_id"),
  acceptedSourceCommit: text("accepted_source_commit"),
  /**
   * **这一次验收**拿什么当凭据放的行:`passed` / `skipped` / `unset`(语义见
   * shared/src/accept-gate.ts 的 AcceptGateBasisMode)。空 = 还没验收过,或者是没留凭据
   * 的老数据 —— 读侧如实显示「没留下凭据」,不拿「最近一次门禁」冒充(第 1 轮审查 F1)。
   *
   * 为什么是 tasks 上的两列而不是 accept_gate_runs 里的一个标记:它记的是**那一按**的
   * 事实(一次验收最多一份),而那一按也可能根本没有对应的 run(跳过 / 没设门禁)。
   */
  acceptedGateMode: text("accepted_gate_mode"),
  /** `passed` 时指着真的跑绿的那一次(accept_gate_runs.id)。**不是**最近那一次。 */
  acceptedGateRunId: text("accepted_gate_run_id"),
  /**
   * **这是哪一次验收**:每次真落下验收章(从没盖章的状态进 merged / accepted)生成一个,merged → accepted
   * 是同一次、沿用;摘牌清空,原样挂回时随快照一起回来(task-stage.ts)。上面那几列合并事实当不了这个身份
   * —— 就地验收、只标记、不合并的那几档,前后两次真验收落下的事实一模一样(飞书「完成也推」据此分辨是不是
   * 新的一次,审查第 2 轮实测)。老数据为空:加列之前的验收,读侧回落到合并事实。
   */
  acceptanceId: text("acceptance_id"),
  /** duet 闸口最近发出去的版本号(第几次开门),开门之前在这里领号,理由见 duet/gate-version.ts。空 = 加列之后没开过门。 */
  duetGateVersion: integer("duet_gate_version"),
  /** 上面那扇门开门时摆给人看的方案(JSON,duet/gate-version.ts 的 GateShown),和版本号同一条语句写。 */
  duetGateShown: text("duet_gate_shown"),
  /** 这条线最近一次走到「等我点头」时领的关口身份，和游标同一条语句写，理由见 task-human-gate.ts。空 = 加列之后没走到过关口。 */
  humanGateId: text("human_gate_id"),
  baseUpdateIntent: text("base_update_intent"),
  originTaskId: text("origin_task_id"), // 回链来源任务(null = 直接创建)
  creationOrigin: text("creation_origin"),
  // 派它的那条任务：普通任务里（智能体经 MCP、或用户从回复框）派出去的独立任务。只管「收在谁名下」，
  // 不是 parentId —— 那一列是团队执行者，带着共用目录、跟团队一起验收的整套语义（见 task-dispatch.ts）。
  dispatchedBy: text("dispatched_by"),
  // 摆在回复框上等用户过目的派活单（JSON，shared/src/dispatch-plan.ts）。跟 question 同一笔写下，
  // 只在 question 还是它绑的那一问时算数，所以清提问的各处不必另清它。
  dispatchPlan: text("dispatch_plan"),
  // 「派出去的活交给谁」（JSON 的 DispatchRunTarget）；NULL = 同这里。
  dispatchTarget: text("dispatch_target"),
  // 这一条名下（dispatchedBy 整棵往下）全部停着：用户在「派出的任务」格头按了「全部停下」的那一刻。
  // 空 = 没停。判据与停/续的手法见 dispatch-hold.ts。
  dispatchHoldAt: text("dispatch_hold_at"),
  // 「全部停下」按了、名下还没停完：标记先落（拦住新的起跑），清点名下、逐条停掉做完才清。中途出错
  // 留着它，调度 tick 接着把没停完的停完；页面据它说「正在停下」，不说「已全部停下」（dispatch-hold.ts）。
  dispatchHoldPendingAt: text("dispatch_hold_pending_at"),
  // 这一条欠一次起跑，记的是按住它的那条任务：被「全部停下」停掉的、停着期间轮到却被拦下的。
  // 「接着跑」只兑现这些，停之前就停着的不碰（dispatch-hold.ts）。
  holdOwedBy: text("hold_owed_by"),
  // 检查点续跑：agent 调 pause_task 时填进来；下次 resume 时取出喂给 CLI 会话并清空。
  resumePrompt: text("resume_prompt"),
  /**
   * **上面那段是系统自己写的**(1),还是人/agent 用 pause_task 写的(0/null)。
   *
   * 只有「系统自动写的」那种才允许在阻塞物消失后被自动清掉 —— 第 2 轮审查 R2-2 实测:
   * 确认完成 → 挂哨兵(自动写下这段)→ 把哨兵停掉 → 再确认完成,结算照旧落 paused,因为
   * 那段自动指令没人撤;而任务这时既没有哨兵也没有待送结果,再没有任何东西会来叫醒它。
   * 反过来**不能无差别抹掉**:agent 自己 pause_task 写的那段是它的本意,完成确认不该把它
   * 吞掉(所以要分来源,不能只看「有没有一段」)。
   */
  resumePromptAuto: integer("resume_prompt_auto", { mode: "boolean" }).notNull().default(false),
  /**
   * **这一格被占用的第几次**（第 2 轮审查 F2）。写入一段新文字 +1，作废一段等待也 +1；取走和
   * 原样退回不动它。
   *
   * 为什么光有来源列不够：来源列只在 `resume_prompt` 非空时有意义，于是「取走之后那一格休眠
   * 着、等文字回来」这个口径**只在中间没有别的写入时**成立。槽可以被另一段文字占用、再被取走，
   * 又变成空的 —— 这时一个在途的旧退回（持久账本重投、改派回滚）填回来，就会继承到不属于它的
   * 来源：系统等待被洗成「agent 自己写的」(此后永不自动清理、任务卡在 paused)，或者反过来，
   * agent 自己写的主动暂停被当成系统等待清掉。实测两个方向都成立
   * （`F2_DORMANT_SCALAR_IS_NOT_PROVENANCE`）。
   *
   * 所以凭证随身：取走的那一位拿到 `{text, auto, generation}`，退回时三样一起带回来，并且
   * **只在代次没变时**才填得进去。代次变了 = 这一格已经被别人占用过，那段文字就此过期，不许
   * 复活（见 task-resume-prompt.ts 的 `ResumePromptReceipt`）。
   */
  resumePromptGeneration: integer("resume_prompt_generation").notNull().default(0),
  waitOwnership: text("wait_ownership", { mode: "json" }).$type<TaskWaitOwnership>(),
  queueSeatToken: text("queue_seat_token"),
  queueAdvanceRequest: text("queue_advance_request", { mode: "json" }).$type<{
    id: string; queueId: string; resumePromptGeneration: number; prevStatus: string;
  }>(),
  // 这一段暂停在等哨兵(落 paused 那一笔同时写下,真正开跑执行回合时清掉)。哨兵了结后没结果
  // 可送时,队列凭它补推一次 —— 语义与写入口见 queue-monitor-hold.ts。
  monitorHoldAt: text("monitor_hold_at"),
  // 提问：agent 调 ask_question 时填进来。结算落 paused 且队列不自动续跑，
  // 等 answer_question 清空并带答复 resume（见 scheduler.pickNextLaunchable 的挡板）。
  question: text("question"),
  // 提问的候选答案（json string[]）：ask_question 可选地附几个候选，网页在问题下方
  // 渲染成可点按钮（点一下 = 以该选项原文当答复送出，走的还是同一个 /answer）。
  // null/[] = 纯自由作答。答复时与 question 一起清空。
  questionOptions: text("question_options"),
  // 多问题提问（json {question, options?}[]）：question 字段保留为引言/背景，
  // 每个 item 在网页上有独立输入框和候选快捷填充。null/[] = 老式单问题。
  questionItems: text("question_items"),
  questionHistory: text("question_history"),
  // 续聊（follow-up）：任务已经到终态后用户又发消息，这一轮不是「任务的执行」而是
  // 任务之后的对话。开跑时把续聊前的终态记在这里（done/failed/canceled），队列一律
  // 按它看待该成员（既不挡后面的，也不会被当 backlog 拉起），结算后清空。
  followUpFrom: text("follow_up_from"),
  // 续聊被哨兵隔开、落成 paused 期间,「续聊前是哪个状态」记在这里(follow_up_from 此时是空的,
  // 队列照常把它看成在等哨兵的暂停)。下一个非旁路回合起跑时接回 follow_up_from —— 见 follow-up-held.ts。
  followUpHeldFrom: text("follow_up_held_from"),
  // 完成确认（严格 done 协议）：agent 调 complete_task 时盖时间戳，settle 消费后清空。
  // 落库而不只放内存 —— 确认与结算若不在同一个进程里（历史事故：僵尸实例跑任务、
  // HTTP 打到监听进程），内存标记会静默丢掉，agent 明明确认了却记 failed。
  completeConfirmedAt: text("complete_confirmed_at"),
  // 当前一次性回合的身份。MCP complete_task 必须带同一 token，旧回合被引导后即使
  // 迟到也不能把完成票写进新方向；null 只给升级前已经在跑的老回合兼容。
  activeTurnToken: text("active_turn_token"),
  // 同一原生回合里的方向身份。引导会话会旋转它，旧方向迟到的完成/暂停/提问因此被拒。
  activeDirectionToken: text("active_direction_token"),
  // 当前回合已经进入第几个方向。1=尚未引导；>1=发生过引导，用于断线补录判定省略 token
  // 的普通首方向调用可以恢复，而引导后的无身份调用不能被冒充成当前方向。
  activeDirectionVersion: integer("active_direction_version").notNull().default(0),
  /**
   * **这条任务到目前为止一共进过第几个方向** —— 永不归零的持久世代（第 4 轮审查 F1-B）。
   *
   * 上面那三列都是**回合内**的身份：`status.ts` 一离开运行态就把 token 置 null、版本归零。于是
   * 「这几列现在空着」同时意味着两件事 ——「我清掉的那一轮已经结束」和「我清掉的那一轮结束了、
   * 后来又跑完了另一轮」。改派失败后迟到的那次回滚只看得到空值，就把后者当成前者，把旧提问和
   * 旧完成确认写回一个已经跑完新回合的任务（实测
   * `F1_B_LATE_ROLLBACK_AFTER_NEW_DIRECTION_DONE`）。
   *
   * 这一列补上那条分不清的边：**回合起跑和方向轮换时各 +1，任何状态落位都不许把它归零**。
   * 回滚的备用分支于是问得出「我离开之后有没有新方向开过工」。写入口只有
   * `task-direction-epoch.ts`（那边有唯一写入口的理由和结构锁）。
   */
  directionEpoch: integer("direction_epoch").notNull().default(0),
  // 这个任务落过几次 done。只增不减,跟 status=done **同一条 UPDATE** 写(status.ts):「等它完成
  // 后发送」的消息记下登记那一刻的值,完成就是「它变大了」—— 事件与状态同一笔,崩溃漏不掉,
  // 迟到的钩子也分不清新旧(见 pending-after.ts)。
  doneSeq: integer("done_seq").notNull().default(0),
  // 这一轮是 CLI 原生命令（`/compact`）：整条消息由 CLI 本地执行，不进模型 —— 既不是
  // 任务的执行，也不是一轮验证。结算钩子（派验证 / 收验证轮 / 推工作流）必须整段跳过，
  // 否则「压一下上下文」会被记成一轮验证跑完，还白吃一轮配额。开跑时写，结算后清空；
  // 落库而不只放内存，理由同上一条（结算可能发生在另一个进程里）。
  nativeTurn: integer("native_turn", { mode: "boolean" }).notNull().default(false),
  goalTurn: integer("goal_turn", { mode: "boolean" }).notNull().default(false),
  cliState: text("cli_state"),
  // 统一验收合并的结构化落账：目标分支 + 合并前后它的 commit。合并后基线审查（对
  // base@before..after 派新任务）靠它，时间线文本反解不可靠。无合并动作（in_place /
  // marked_only / 打标签）时保持 null 或 before==after。
  acceptedTargetBranch: text("accepted_target_branch"),
  acceptedBaseCommit: text("accepted_base_commit"),
  acceptedMergeCommit: text("accepted_merge_commit"),
  // 这次验收**到底怎么合的**（TaskMergeMethod：already_merged / fast_forward /
  // merge_commit / squash / tagged / no_commit）。
  //
  // 为什么非要单独一列：`accepted_merge_commit` 为 null 有**两种**完全不同的含义 ——
  // 「合了，但按你的选择没落提交」（no_commit）和「合并早已发生、本生命周期没留下快照」
  // （already_merged 的「不可知」，见 task-accept.ts 那段注释）。同一个 null 让 UI 只能
  // 靠猜，现场后果是：用户选了「合并后不提交」，界面给了一句和正常验收一模一样的
  // 「验收完成」，他看不出还欠一步提交（2026-09-15）。事实列不让 UI 猜。
  acceptedMergeMethod: text("accepted_merge_method"),
  // 「合并后不提交」那一档合完那一刻，目标分支索引的内容指纹（`git write-tree`）。
  // 事后要回答「索引里现在躺着的还是不是当初合进来的那份」只有内容证据算得上证据：
  // 一致才敢替用户 `git commit`，否则就是把他后来自己 `git add` 的东西一起裹进这次
  // 合并。也是「改动被 reset --hard 丢了」与「用户自己提交了」的判据（见
  // task-accept-pending.ts）。其它档为 null。
  acceptedPendingTree: text("accepted_pending_tree"),
  // 验收尾段（点头之后的发布/命令步骤）的 durable 进度：finalize 时线上真有尾段就置 1，
  // 尾段跑完（无论成败，结果已报告）清 0。进程死在两者之间时，重启后的重复验收会发现
  // 它还挂着并补跑——否则发布步骤被 already_accepted 快路静默永久漏掉（审查实测复现）。
  acceptedTailPending: integer("accepted_tail_pending", { mode: "boolean" }).notNull().default(false),
  // 尾段的**逐站** durable 进度（JSON string[]：已完成的 step id）。只有 pending 一个
  // 布尔位时，崩溃重试会整段重跑——已经执行过的发布/部署命令再来一遍（at-least-once
  // 变 at-least-twice，审查实测复现）。补跑按这份清单跳过已完成的站；随 pending 一起清。
  acceptedTailDone: text("accepted_tail_done").notNull().default("[]"),
  // 任务接力（json TaskHandoff）：direction:"out" = 已交给另一台 ash 续跑（本地这份
  // 是历史），"in" = 从别的机器接过来的。持久落库,刷新后的横幅靠它,不靠 toast。
  handoff: text("handoff"),
  // 强制恢复会清掉 handoff；风险审计另存，确保无会话任务刷新后也仍能看见双任务警告。
  handoffAudit: text("handoff_audit"),
  // ── 多人模式(§八)────────────────────────────────────────────────────────
  // 这个任务「用谁的执行器/供应商/CLI 环境跑」以及统计归属。可见性仍跟项目走。
  // 三条继承规则:派生任务(团队执行者/审查任务/就地验证轮)继承父任务;日程/定时
  // 消息触发的继承日程创建者;接力导入的记对端用户。
  ownerUserId: text("owner_user_id"),
  // 派任务那一刻执行器长什么样的快照(json {name,type,model,reasoningEffort})。
  // 共享项目里别人来重跑/回复时,原执行器多半是**私有资源**解析不到 —— 有这份快照
  // 才能在降级弹窗里如实说出「原执行器属于 A 的 xxx」(§八 B5)。
  executorSnapshot: text("executor_snapshot"),
});

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  model: text("model"),
  extraArgs: text("extra_args").notNull().default("[]"), // json
  reasoningEffort: text("reasoning_effort"), // null=跟随 CLI 默认
  speed: text("speed"), // null=标准；"fast"=1.5x 加速档
  // 挂载的供应商(llm_providers.id)。null=用 CLI 自己的官方登录账号。
  // 非空时启动 CLI 前注入 base_url + key(claude: env;codex: -c model_providers)。
  providerId: text("provider_id"),
  // 覆盖 CLI 自己配置文件里的设置(json Record<string, number>,以 env 注入)。
  // 声明表在 @ash/shared/cli-overrides —— 没在那儿声明过的 key 一律不落库。
  configOverrides: text("config_overrides").notNull().default("{}"),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  // 多人模式:执行器是**个人面**资源(§八),各人各一套,互不可见。
  // null = 自用模式建的,或转多人时归了初始管理员之前的存量行。
  ownerUserId: text("owner_user_id"),
});

// Global team-creation shortcuts. config stores only the configurable TeamConfig
// fields; executor labels are resolved at read time so stale ids degrade cleanly.
export const teamPresets = sqliteTable("team_presets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  config: text("config").notNull(), // json TeamPresetConfig (without display labels)
  ownerUserId: text("owner_user_id"), // 个人面资源(§八)
  createdAt: text("created_at").notNull(),
});

// 起手式库。系统自带的那几条**没有种子行**：builtin_key 非空的行 = 用户对某条
// 自带起手式的覆写，删掉这行就回到 shared/workflow-presets.ts 里的出厂定义。
// 用户自建的行 builtin_key 为空。disabled 只对自带的有意义（自带的删不掉，只能停用）。
export const workflows = sqliteTable(
  "workflows",
  {
    id: text("id").primaryKey(),
    builtinKey: text("builtin_key"), // 非空 = 覆写某条系统自带的
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    def: text("def").notNull(), // json WorkflowDef
    disabled: integer("disabled", { mode: "boolean" }).notNull().default(false),
    ownerUserId: text("owner_user_id"), // 个人面资源(§八)
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  // builtin_key 的唯一约束必须**带上归属**：每个人都可以覆写同一条系统自带起手式,
  // 全局唯一会让第二个人存不进去。
  (t) => ({ builtinIdx: uniqueIndex("workflows_builtin_idx").on(t.builtinKey, t.ownerUserId) }),
);

export const reviewerProfiles = sqliteTable("reviewer_profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  agentType: text("agent_type").notNull(),
  executorId: text("executor_id"),
  model: text("model"),
  reasoningEffort: text("reasoning_effort"),
  ownerUserId: text("owner_user_id"), // 个人面资源(§八)
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// 自由工作流与它的审查链(free_workflow_states / free_workflow_events / free_review_runs /
// free_review_rounds / free_review_debates / free_review_debate_turns)在
// `schema-free-workflow.ts`。整份原样再导出,理由同上面多人模式那条。
export * from "./schema-free-workflow.js";

// 被挡回的用户操作(不依赖 agent 会话的任务通知),表定义 + 建表都在
// `schema-task-notice.ts`。整份原样再导出,理由同上。
export * from "./schema-task-notice.js";

// 任务「看过没有」(task_reads,侧栏绿点的已读记录),表定义 + 建表在 `schema-task-reads.ts`。
export * from "./schema-task-reads.js";

// 验收确认层「运行」那一勾上次的样子(accept_memory,按人按项目),表定义 + 建表在 `schema-accept-memory.ts`。
export * from "./schema-accept-memory.js";

// 任务写过的位置(task_writes,生成物面板的并发裁决用),表定义 + 建表在 `schema-task-writes.ts`。
export * from "./schema-task-writes.js";

// 验收前置命令的执行记录(accept_gate_runs)在 `schema-accept-gate.ts`。同上,原样再导出。
export * from "./schema-accept-gate.js";

// 一次运行的 `sessions` / `session_turns` 两张表在 `schema-sessions.ts`。整份原样再导出,
// 理由同上面几条:调用处照旧 `import { sessions } from "./db/schema.js"`。
export * from "./schema-sessions.js";

// 定时（`schedules`：到点重跑任务）与待发送消息（`scheduledMessages`）两张表在 `schema-schedules.ts`，
// 原样再导出,调用处照旧 `import { schedules } from "./db/schema.js"`。
export * from "./schema-schedules.js";

// Queue items: ordered list of tasks where each task waits for the one
// immediately before it in the queue. Replaces the legacy depends_on /
// resume_depends_on pointer model.
//
// Invariants (enforced at application layer, NOT DB constraints):
//   - All tasks in one queue belong to the same group (or all have null group_id)
//   - Position is dense (0..N-1) within a queue; reorder repacks
//
// task_id is PRIMARY KEY because a task is in at most one queue at a time.
export const queueItems = sqliteTable(
  "queue_items",
  {
    taskId: text("task_id").primaryKey(),
    queueId: text("queue_id").notNull(),
    position: integer("position").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    queuePosIdx: uniqueIndex("queue_items_queue_pos_idx").on(t.queueId, t.position),
  }),
);

// 团队调度台**还没送进 CLI**的入站消息(执行者汇报/提问、ash 的唤醒语)。
//
// 调度台忙着的时候这些消息只能等它这一回合说完再合并送进去(见 team/session.ts 头注),
// 而「等着」这段时间横跨换台、关台和 server 重启 —— 全放内存里的话,进程一换就什么都
// 不剩:落回 idle 的团队任务开机时不会被唤醒(task-reconcile.ts 只叫醒还在跑的),那份
// 执行结果、失败说明或待回答的提问就永久消失了(2026-08-26 第 12 轮审查)。
//
// 删行的唯一条件是 ResidentHandle.send() 明确回执「收下了」——拒收、抛错、换台、重启
// 一律留着,由下一台调度台认领。写入/认领/销账都在 team/inbound-queue.ts。
export const teamInbound = sqliteTable(
  "team_inbound",
  {
    // 自增整数就是到达序号。执行者汇报必须按到达顺序合并送出,而同一毫秒来两条是常态
    // (一批执行者同时收工),靠时间戳 + nanoid 排不出确定的先后。
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    taskId: text("task_id").notNull(),
    text: text("text").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({ taskIdx: index("team_inbound_task_idx").on(t.taskId, t.seq) }),
);

// 上传附件的**归属登记**(§八)。文件本身躺在 `data/uploads` 里 —— 那是个扁平目录,
// 文件名就是全部信息,所以「谁能读它」只能靠这张表回答(判据在 `uploads.ts`)。
export const uploads = sqliteTable("uploads", {
  // UPLOADS_DIR 下的文件名,单个路径段。URL 上的 `:file` 与文本里的绝对路径都归一到它。
  file: text("file").primaryKey(),
  // 上传的人。agent 产出的图没有上传者(恒 null),转换前的存量文件由 conversion 认领。
  ownerUserId: text("owner_user_id"),
  // 附到了哪个任务:有它就走项目轴(同项目的人在会话里看得见这张图)。随手记的附件
  // 恒 null —— 随手记是个人面,它的附件不该因为挂在共享项目里就人人可读。
  taskId: text("task_id"),
  // 这行的 owner 是怎么来的。'conversion' = 转多人时对存量文件的**统一认领**(不是本人
  // 上传),这种行的 taskId 允许由可信产物清单(backfillArtifactUploads)事后补 —— owner
  // 非空区分不了「真私有」与「迁移代管」,没有这个标记,老任务里 agent 后来生成的图在
  // 转换后对项目成员永远 404(审查第 8 轮 R3)。NULL = 本人上传或 agent 产出,照旧只认人。
  claimOrigin: text("claim_origin"),
  createdAt: text("created_at").notNull(),
});


export const taskBranchReceipts = sqliteTable("task_branch_receipts", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  sourceCommit: text("source_commit").notNull(),
  mergeCommit: text("merge_commit").notNull(),
  targetBranch: text("target_branch").notNull(),
});

// 供应商表住在 schema-llm-providers.ts（本文件 700 行闸）。这里转发，导入路径不变。
export { llmProviders } from "./schema-llm-providers.js";
// 推进意图表住在 schema-queue-advance.ts(本文件 700 行闸)。这里转发,导入路径不变。
export { queueAdvanceIntents } from "./schema-queue-advance.js";

// 接力的三张表住在 schema-handoff.ts（见那份的说明）。这里转发，导入路径不变。
export { handoffPeers, handoffLocalPeerKeys, handoffLocalKeyRevisions } from "./schema-handoff.js";
// 哨兵表住在隔壁（见 schema-monitors.ts 的说明）。这里转发，导入路径不变。
export { monitors, monitorReclaimDebts } from "./schema-monitors.js";
export { taskBackgroundRevisions } from "./schema-task-background.js";
export { taskPrerequisites, taskPrerequisiteLaunches } from "./schema-prerequisites.js";
export { taskDiskCleanups } from "./schema-run-disk.js";
export { regressionChecks } from "./schema-regression-checks.js";
export { regressionEvidence } from "./schema-regression-evidence.js";
