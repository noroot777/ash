import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// 一次运行的两张表:`sessions`(一条会话,跨回合复用)和 `session_turns`(一个回合一行)。
//
// 从 `schema.ts` 拆出来的原因只有一个:那份到了 725 行,过了单文件上限(根 CLAUDE.md),
// 而这两张表自成一件事——「谁在什么时候、在哪个目录里干过活」。它的写入端是
// `session-turns.ts`(回合的开始/收尾),读取端是 `task-artifact-windows.ts`(产物归属按
// 时间认人)。
//
// `schema.ts` 原样再导出这两张表,所以 `import { sessions } from "./db/schema.js"` 照旧能用,
// 跟 `schema-monitors.ts`、`schema-free-workflow.ts` 那几份一个办法。

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  role: text("role").notNull(),
  agentType: text("agent_type").notNull(),
  executor: text("executor").notNull(),
  // 这一轮真正跑的**执行器 profile 主键**，以及生效的 model/思考强度。上面那个
  // `executor` 只是展示名（agents.name 非唯一、可改名），拿它反查 profile 会选中
  // 同名的另一个人；要「按上一回合原样再跑一遍」只能认 id + 这一轮的覆盖值。
  // 全 null = 这条会话建在本功能之前，只能退回按任务当前配置跑。
  executorId: text("executor_id"),
  turnModel: text("turn_model"),
  turnReasoningEffort: text("turn_reasoning_effort"),
  // 那一刻这条 profile 的**执行环境指纹**（extraArgs / 供应商 / 配置覆盖…，
  // 算法见 executors/index.ts 的 fingerprintOf）。profile 是可编辑、可删除的，光有主键
  // 说不清「它当时长什么样」：换一次供应商就换了后端，重试会把旧配置下生成的 CLI
  // session id 发到新后端去（第 1 轮审查 finding 2）。所以重跑前先拿它跟当前 profile
  // 对一次，对不上就 409，让用户明确决定要不要按新配置另起一轮。null = 老会话行。
  executorFingerprint: text("executor_fingerprint"),
  worktreePath: text("worktree_path"),
  branch: text("branch"),
  cwd: text("cwd"),
  cliSessionId: text("cli_session_id"),
  // **这一轮实际跑在谁名下**。多人模式下它不等于 `tasks.owner_user_id`:共享项目里
  // B 回复 A 的任务时,`runOwner = actingUserId ?? task.ownerUserId` 是 B(orchestrator.ts),
  // 于是 CLI 带着 B 的 `CLAUDE_CONFIG_DIR` 起跑,`cli_session_id` 那份 transcript 也写在
  // B 的个人配置目录里。接力搬会话文件时必须按这一列找,按任务归属人找就会在 A 的目录下
  // 扑空(2026-08-29 事故的同源第二格,见 docs/incidents.md)。
  // null = 建在本列之前的老行,或这一轮本来就没有归属人(自用模式);两种都退回任务归属人。
  runOwnerUserId: text("run_owner_user_id"),
  // **这一轮的 CLI 配置目录**(CLAUDE_CONFIG_DIR / CODEX_HOME 实际注进去的那个值)。
  // `""` = 宿主机默认目录(自用模式、共用宿主 CLI 的实例、没有归属人的任务);
  // `null` = 建在本列之前的老行,读侧按**当时**那条规则解释:那时多人模式还没有「共用」
  // 这一档,所以 run_owner_user_id 非空 = 一定注了个人配置目录,为空 = 宿主机默认目录。
  // 不能按当前设置现算,否则改档之后老行会被判成「接得上」(第 1 轮审查 P1)。
  //
  // 有了 run_owner_user_id 为什么还要这一列:那一列只说得出「谁跑的」,而**同一个人的
  // 配置目录会挪位置** —— 实例管理员把「CLI 额度」从「每人自带 key」改成「共用宿主机
  // CLI」(app_settings.sharedHostCli,§八之二),现算的答案立刻从 data/user-cli/<uid>/…
  // 变成宿主默认目录,盘上的 transcript 却一个字节都没动。拿新答案去 --resume 旧会话就是
  // 2026-08-29 那句 "No conversation found with session ID"。把当时那个目录**记下来**,
  // 「接不接得上」才有一个不随设置漂移的判据(auth/run-env.ts sessionResumableHere)。
  cliConfigDir: text("cli_config_dir"),
  resumeCommand: text("resume_command"),
  // 恢复命令要带的 env 前缀:供应商那一截(token 已是占位符)。null = 没有。
  // 只用于展示,不含真 key。列名 relay_env 跟它现在装的东西正好对上。
  resumeEnv: text("relay_env"),
  // 恢复命令里跟在 CLI 后面的参数(claude 的 `--settings '{…}'`)。配置覆盖项走这一列:
  // env 前缀打不过用户自己的 settings.json,只有 --settings 这一层压得住(finding 2)。
  resumeArgs: text("resume_args"),
  commandLine: text("command_line"),
  startedAt: text("started_at").notNull(),
  endedAt: text("ended_at"), // when this run finished (set with exit_status)
  exitStatus: integer("exit_status"),
  // 这一轮**是被停下来的**（canceled = 手动停止 / paused = 分组暂停），不是它自己崩的。
  // 非空时 exit_status 多半也是非零：CLI 吃 SIGTERM 按 signal 退出。光看 exit_status
  // 区分不了「我停的」和「它崩了」，而这两件事的入口完全不同（运行 vs 重试），所以停止
  // 的口径只能在结算时落在这里。每回合开头清空。
  stoppedAs: text("stopped_as"),
  // 旁路回合：就地验证、审查、`/compact` 这类「不算任务执行」的回合（判据见
  // orchestrator.ts 的 sideTurn）。它们收尾后任务回到原状态，光看 status + exit_status
  // 分辨不出来——而重跑一个旁路回合要走它自己那条路，不能按普通回合重投。
  sideTurn: integer("side_turn", { mode: "boolean" }).notNull().default(false),
  // Execution-time accounting. active_ms accumulates each turn's active span
  // [prompt sent → turn done], so idle waits between turns are excluded;
  // turn_started_at marks the current/last turn's start (set when a turn begins,
  // ended_at cleared on resume). Both null on rows created before these columns
  // existed → that task reads as historical/unmeasured and surfaces show its
  // lifespan instead of a (wrong) execution time.
  activeMs: integer("active_ms"),
  turnStartedAt: text("turn_started_at"),
  /**
   * 这条会话**开过几个回合**（本列出现之后的那些；之前的历史在 `turns_base` 里）。
   *
   * 完整性的**第一手证据不是它**，而是 `session_turns` 里那一行：回合一开始就落行、收尾
   * 时按同一身份补上 `ended_at`，于是「开始了没收口」是一条**逐行事实**，后来成功的回合
   * 抵消不掉。这个计数是**第二道**，专管连那一行都没写进去的情形（库挂了、某个起跑入口
   * 漏了调 `openTurn`、或者有人绕过它直接改表）。
   *
   * **它跟那一行在同一个原子批里写**（`session-turns.ts` 的 `openTurn`），而且加数的条件
   * 就是「这个身份还不存在」——所以同一个回合身份被开两次（团队那边先 `openLead` 又用
   * 同一个起点 `beginTurn`）只会计一次。第 4 轮一度让它独立于那张表写，想的是「表写失败
   * 还有计数兜着」，结果换来两个更难看的毛病：重复调用凭空多一轮（于是永远报缺一个回合）、
   * 加数自己失败时无声无息（于是历史行数抵掉未来的真缺口，第 5 轮审查必须修 2）。整批写
   * 失败这件事改由 `turns_lost` 单独记——那比「两列各写各的」可靠：两列分开写一定会有
   * 一半先成功的中间态，而中间态在这里全是错的方向。
   *
   * null = 这条会话一个回合都还没记上（新建那一刻、或者开始那一批全失败了）。那种行
   * **不做计数对账**：拿 0 去减它名下的历史行数会得出负数、把真缺口抵扣掉。
   */
  turnsStarted: integer("turns_started"),
  /**
   * **开回合时整批（行 + 计数）都没写成**的次数。
   *
   * 为什么要这一列：对账只能发现「计数说开过 N 轮、表里只有 M 行」。行和计数同批写之后，
   * 两边要么都成要么都败——都败时两个数仍然相等，缺口在库里一点痕迹都不留。那一刻唯一
   * 还知道「刚才漏了一轮」的是写端自己，所以让它单独记一笔；读端把这个数直接算进缺口，
   * 面板上就会说「有 N 次运行连开始都没留下记录」（第 5 轮审查必须修 2.3）。
   *
   * 连这一列都写不进去（库彻底不可写）时只剩日志——那是物理极限，不装作记住了。
   */
  turnsLost: integer("turns_lost"),
  /**
   * 升级到逐回合记录之前，这条会话**已知**跑过几个回合（迁移那一刻数得出来的下界）。
   *
   * 为什么要单独一列而不是把历史行数并进 `turns_started`：那个数是**下界**不是真相——
   * 升级前写失败的回合没留下行，谁也数不出来。并进去就等于宣称「升级前的历史是完整的」。
   * 分开记，读端才能把「升级前可能还缺」单独说出来，同时又能让升级后的新回合照常对账
   * （expected = base + started）。
   */
  turnsBase: integer("turns_base"),
  /**
   * `turns_base` 是不是「下界」而不是准数。1 = 这条会话在逐回合记录升级之前就跑过，
   * 升级前缺没缺记录无从得知；0 = 升级之后才建的会话，没有未知历史。
   *
   * 为什么不能用「`turns_base` 大于 0」代替它：迁移那一刻一行回合记录都没有的老会话回填
   * 出来的下界正好是 0，跟「升级后新建、确定没有历史」长得一模一样，于是那种会话的未知
   * 历史被当成了「确定没有」（第 5 轮审查必须修 2.2）。这一列还兼作迁移的**幂等标记**：
   * 新建会话在 insert 时就把 base/approx 都写上，所以回填只认 `turns_base_approx IS NULL`，
   * 每次启动重跑都不会动到升级后的计数。（判据**不是** `turns_base IS NULL`——上一版的
   * `freshTurnFields` 已经会写 `turns_base: 0` 却没有这一列，理由见 `migrate-session-turns.ts`。）
   */
  turnsBaseApprox: integer("turns_base_approx", { mode: "boolean" }),
  // ── 解绑重启（executors/detached.ts）────────────────────────────────────
  // 单飞任务的 agent 输出走文件而不是匿名管道，所以它活得过 server 重启。
  // 下面这组是重启后接管它所需的全部线索；常驻会话（团队调度台）不走这条路，
  // 这几列对它恒为 null——它靠 cli_session_id 的 --resume 自动接回。
  agentPid: integer("agent_pid"),
  // ps 的 lstart 原文。**必须跟 pid 一起比**：pid 会被复用，光 kill(pid,0)
  // 只能证明「有个进程叫这个号」，不能证明还是当初那个 agent。
  agentStartedAt: text("agent_started_at"),
  agentOutPath: text("agent_out_path"),
  agentErrPath: text("agent_err_path"),
  agentRcPath: text("agent_rc_path"),
  // 已安全消费到的 stdout 字节位置，永远落在换行边界（见 detached.ts 的
  // tailFile）。重启后从这里接着读 → 不丢行也不重行。
  agentOffset: integer("agent_offset"),
  /**
   * **这一次运行独有的资源记号**(`ASH_MONITOR_UNIT`,种法见 executors/spawn.ts,判定见
   * proc.ts 的 `processUnitEvidence`)。
   *
   * 为什么 `agent_pid` 之外还要这一列:pid 只认得出**根**那一个进程,而漏停的从来不是根。
   * agent 起的长跑程序(dev server、watch)挂在 `sh → node → node` 这条链的末端,根一死它
   * 就被系统改挂到 1 号名下,从进程树上消失。继承的追踪 fd 也接不住它 —— libuv 起子进程时
   * 丢掉 ≥3 号 fd(实测:`sh` 那一层还握着,它再起的 node 孙子就不在 lsof 名单里)。环境
   * 记号是唯一跨得过 exec、跨得过根死亡、跨得过 server 重启的那条线索。
   *
   * null = 建在本列之前的老行,或这一轮没能种上记号 ⇒ 读侧退回「只有 pid」那条粗判据,
   * 不许据此声称整项已退出(proc.ts 四档里那是 `unprovable`)。
   */
  agentUnitToken: text("agent_unit_token"),
  // ── Token 用量（server/src/usage.ts）────────────────────────────────────
  // 这条会话行**跨回合累加**的账（同 active_ms 的模式：会话可复用，每回合结束
  // 时把执行器报的那笔加上去）。口径归一在 shared/src/usage.ts：input 不含缓存、
  // cache_read/cache_write 分列。全 null = 建在本功能之前或那家 CLI 不报账，
  // 展示端据此区分「没数据」与「0」。cost 只有 claude 报得出，codex 恒 null。
  usageInput: integer("usage_input"),
  usageOutput: integer("usage_output"),
  usageCacheRead: integer("usage_cache_read"),
  usageCacheWrite: integer("usage_cache_write"),
  usageReasoning: integer("usage_reasoning"),
  usageCostUsd: real("usage_cost_usd"),
  usageTurns: integer("usage_turns"),
  // ── 上下文水位（同一个文件里的 setSessionContext）────────────────────────
  // 上面那组是**累加**的流水，这三列是**覆盖**的水位：最近一次 API 调用带进模型
  // 的输入有多大。两者差着数量级（流水 18M / 水位 12 万），别拿流水去算「还剩
  // 多少上下文」。window 为 null = 谁也没报出窗口大小，界面只显示绝对水位。
  contextUsed: integer("context_used"),
  contextWindow: integer("context_window"),
  // window 是不是「估的」：claude 在 result.modelUsage 里自报窗口，读到了就是准数
  // （false）；自报缺失才按模型名估（true，估不出则 window 为 null）。codex 从私有
  // rollout best-effort 读取；格式变化或本轮取不到时清空为 null，胶囊自然不显示旧值。
  contextWindowEstimated: integer("context_window_estimated", { mode: "boolean" }),
});

/**
 * 一个**回合**真正在跑的那一段，以及它跑在哪个目录。
 *
 * `sessions` 行是跨回合复用的（续聊只刷新 `turn_started_at`、清 `ended_at`），所以它只说得
 * 出「这条会话第一次建立」和「最后一个回合什么时候结束」——中间空了四个钟头还是一秒没停，
 * 从那一行上分不出来。而产物归属要的恰恰是「它在写这个目录」的那几段：拿 session 寿命当
 * 运行区间，一个续过聊的任务会把两次运行之间**别的任务**做出来的东西全收进自己名下
 * （第 1 轮审查 F1）。`active_ms` 也救不了：它只给出各回合的总时长，给不出位置。
 *
 * 一个回合**两步**落账：开始那一刻插一行（`ended_at` 为空 = 开了还没收口），收尾那一刻按
 * 同一身份 `(session_id, started_at)` 把 `ended_at` 补上。只在收尾时追加一行是本表最早的做法,
 * 那等于「写失败 = 什么都没发生」,后来成功的一轮一落账就再也看不出中间少过东西。写端全在
 * `session-turns.ts`；写失败只记日志、绝不影响结算——归属精度降级并在面板上照实披露。
 *
 * `cwd` 记的是**那一回合实际的工作目录**：任务换过目录之后，旧目录上的区间不该再算进新
 * 目录的归属（第 1 轮审查 N4）。
 */
export const sessionTurns = sqliteTable(
  "session_turns",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    taskId: text("task_id").notNull(),
    /** 这一回合实际的工作目录；null = 当时取不到（极老的行）。 */
    cwd: text("cwd"),
    startedAt: text("started_at").notNull(),
    /**
     * 收尾时刻。**null = 这一回合开始了、还没收口**——是「正在跑」或者「收尾那一下没写
     * 成」，绝不是「没跑过」。
     *
     * 回合开始就落行、收尾再补这一列，是为了让「缺了一轮」变成一条**摆在库里的事实**：
     * 原先只在收尾时插行，写失败就什么都没有，后来成功的一轮一落账，读端再也看不出中间
     * 少过东西，那一轮做出来的图于是被静默滤掉（第 4 轮审查必须修 1）。
     */
    endedAt: text("ended_at"),
  },
  (t) => ({
    taskIdx: index("session_turns_task_idx").on(t.taskId, t.startedAt),
    sessionIdx: index("session_turns_session_idx").on(t.sessionId, t.startedAt),
    /**
     * **一个回合一行**：身份就是「哪条会话 + 哪一刻开的」。
     *
     * 收尾走的是「按这个身份补 ended_at」，所以重放一次收尾（接回、重试、旧调度台也来
     * 收一次）只会更新同一行，不会多出一行来；少了这道唯一性，重复行会被当成「多跑了
     * 一轮」，正好抵掉另一轮的真缺口（第 4 轮审查对 COUNT 口径的提醒）。
     */
    turnKey: uniqueIndex("session_turns_turn_key").on(t.sessionId, t.startedAt),
  }),
);

// ── 没收干净的 agent 后代:**清理责任** ────────────────────────────────────────
//
// 哨兵那边有一张同构的 `monitor_reclaim_debts`,理由在那份 schema 的注释里写全了。这里是
// agent 这一侧的同一件事,而它是本轮审查 F2 的落点:
//
// 一次运行的后代**可能收不干净**,而且那不一定是 bug —— macOS 上记号只给得出 `suspected`
// (`ps -E` 是展示文本,不是真实环境项),明确检测到残留却给不出可下刀的落点。那种时候
// 「不贸然下刀」本身没错,**错的是把它宣布成清理成功**:上一版清理完照样释放证据、删掉
// 追踪文件、从待收册上划掉,于是那个还在写用户文件的孤儿既查不回来也没人再管
// (实测:记号前后都明确指出那个号,心跳从 3 涨到 61,追踪文件被删)。
//
// 所以「还没收干净」必须是一条**摆在库里的事实**,而且活得比任何一个内存对象都久:
//  · 不随句柄注销走 —— WeakMap 和待收册都是进程内的;
//  · 不随回合结束走 —— 同一条会话下一轮会把 `sessions.agent_unit_token` 覆盖掉;
//  · 不随任务删除走 —— 任务行可能先没了,而那摊进程还在(同哨兵债表,删除批次里刻意没有它)。
//
// 行数有界:只有「这一轮没能证明清空」的运行进得来,确证清空(记号 `none` + 没有持有者)
// 就销账删行。
export const agentCleanupDebts = sqliteTable("agent_cleanup_debts", {
  /**
   * 这一次运行独有的资源记号(`executors/unit-token.ts`),**就是它的身份**。
   *
   * 为什么主键是记号而不是 `session_id`:一条会话跨回合复用,每个回合一个进程、一项资源;
   * 拿会话当键会让下一轮把上一轮还没收掉的那笔覆盖掉 —— 正是 F2 点名的那条
   * 「同一会话下一轮又会覆写这个单值」。记号每次创建重新随机,一笔一行。
   */
  unitToken: text("unit_token").primaryKey(),
  /** 只做记账和展示 —— 任务/会话行可能已经没了,这两列不保证指向存在的行。 */
  taskId: text("task_id").notNull().default(""),
  sessionId: text("session_id").notNull().default(""),
  /** 认人的那一对:号会被复用,少了启动时刻就可能杀掉同号的无辜进程。 */
  rootPid: integer("root_pid"),
  rootStartedAt: text("root_started_at"),
  /**
   * 两条**跨得过重启**的线索,清扫侧靠它们重新取证:
   *  · 追踪文件(继承 fd,按路径 `lsof` 反查持有者);
   *  · 这一次运行独有的输出文件(根的 stdout 就重定向在它上面)。
   * 内存里的 WeakMap 一重启就没了,所以这两条必须落在行上。
   */
  trackPath: text("track_path"),
  outPath: text("out_path"),
  /** `remaining` = 确证还有成员活着;`unknown` = 这一轮问不清楚。两档都不许放手。 */
  state: text("state").notNull().default("unknown"),
  /** 人话:还剩哪些号 / 哪一问没答出来。打日志和给用户看的就是这一句。 */
  detail: text("detail").notNull().default(""),
  /** 记号那一问当时停在哪一档(`ours`/`suspected`/`none`/`unprovable`),分流重试策略。 */
  unitVerdict: text("unit_verdict").notNull().default(""),
  attempts: integer("attempts").notNull().default(0),
  /**
   * **这一行现在是第几版证据**。每一次写(落账、推进、收档)都 +1。
   *
   * 销账是「按我读到的那一版证据删掉整行」,所以它只在**我判的那一版还没被人动过**时才成立。
   * 判定与下手之间隔着取证(清扫那一档还隔着 2 秒补刀窗口),中间要是有新证据落到同一个
   * 键上(清理路径又记了一笔新的路径线索、另一次清扫先推进过),那份快照就已经不是当前
   * 事实了 —— 照样按键删行就会把别人刚落下的证据一起删掉(第 3 轮审查 F2)。所以删/盖戳
   * 都带着版本当条件:版本对不上就一行都不动,如实说出来,下一轮重新取证。
   *
   * 进程内已经按键排队了,这一列是**数据里的交叉校验**:它让这条不变量不再只靠「所有写入
   * 都记得走那把锁」这个约定成立 —— 对不上就说明有人绕过去了,那一刻宁可不删。
   */
  version: integer("version").notNull().default(0),
  createdAt: text("created_at").notNull(),
  lastAttemptAt: text("last_attempt_at"),
  /**
   * **追到这里为止的时刻**(语义同哨兵债表的 `closed_at`)。空 = 还在追。
   *
   * 非空**不等于「已经收干净」**,只等于「能追的线索都答出来、都空了」:记号那一问确证
   * `none`,追踪文件也没有持有者。POSIX 上后代甩得掉记号(`env -i`)也甩得掉进程组
   * (`setsid`),所以「整项资源真的退了」这件事在当前平台证不出 —— 收过档的行**不删**,
   * 它是这次运行最后的可定位身份;只是不再重试、开机也不再报警。
   */
  closedAt: text("closed_at"),
  closedNote: text("closed_note"),
  /**
   * **这一刻还排除不掉的那几个号**(JSON:`{pid, gen, why}[]`,见 `executors/cleanup-result.ts`
   * 的 `CleanupOpen`)。空/NULL = 没有点名过谁。
   *
   * 为什么非得落在行上:即时清理那一侧**已经点名了**某个号排除不掉(父子关系问不出来、
   * 核验不了它那一代),可清扫侧手里是另一套设备(根身份 + 记号 + 两个文件),它压根不知道
   * 有号要核 —— 于是同一个故障一个字都没恢复,清扫按自己那几台设备的「没有」把行删了
   * (第 8 轮审查 F1-A 实测:settled=1、行 0 笔、那个后代仍在写,心跳 74→84)。
   *
   * 销账的条件因此多一条:这份名单上的号**逐个核过**(确证退了 / 号换了主人)才算覆盖了
   * 这份责任。`detail` 里那句人话解除不了它 —— 那是给人看的,不是给判据用的。
   */
  openMembers: text("open_members"),
});
