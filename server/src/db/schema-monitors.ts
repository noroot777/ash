// monitors 表。
//
// 为什么单独一个文件：哨兵这块的实现本来就分了四份（claude-monitors / -scan / -backfill /
// -liveness），表定义跟着它们走比挤在 schema.ts 里更好找；而 schema.ts 加上这张表会超过
// 项目约定的 700 行上限（全局 CLAUDE.md），这次正好拆出来。
//
// `schema.ts` 原样转发 `monitors`，所有 `from "./db/schema.js"` 的导入不受影响。
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// 哨兵（Monitor）：一条绑在任务上的长跑命令，由 **ash server** 起、不在 agent 进程树里，
// stdout 每一行就是一条事件（语义与上限见 shared/src/monitor.ts）。
//
// 为什么必须落库而不是只放内存:它的全部意义就是「活得比一个回合久」。进程脱离了 ash
// (detached + 输出落文件,跟 executors/detached.ts 同一招),所以 server 重启后要靠
// 库里这几列把它认回来 —— pid 会被复用,认人的判据是 pid + 进程启动时刻一起对上
// (proc.ts 的 isSameProcess),读到哪一字节则靠 `offset`,重启期间产出的行一条不漏。
export const monitors = sqliteTable("monitors", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  command: text("command").notNull(),
  description: text("description").notNull().default(""),
  cwd: text("cwd").notNull(),
  status: text("status").notNull().default("running"), // MonitorStatus
  pid: integer("pid"),
  // ps 的 lstart 原文。只有 pid 对上**而且**这个也对上,才算还是当初那个进程。
  pidStartedAt: text("pid_started_at"),
  /**
   * **这一次创建独有的资源记号**(`ASH_MONITOR_UNIT`,见 monitor-unit-scan.ts 的 `MONITOR_UNIT_ENV`)。
   *
   * 它是「这些进程属于这一次创建」的凭证:起进程之前就随意图行落库(所以跨重启认得回来),
   * 并且作为环境变量种进那个壳 —— 环境随 exec 继承、后代各自带一份,所以组长死了之后留在
   * 后台的后代仍然自证身份。
   *
   * 为什么不是命令原文(第 12 轮审查 F1-A):命令是「要干的活」,不是凭证。同一条命令可以合法
   * 地被创建两次,前缀也会撞(记录 `sleep 1`、现存 `sleep 120`,包含判断照样认作自己的后代
   * —— 实测里一条历史行据此杀掉了审查自己起的测试组)。存量行一律 NULL ⇒ 对孤儿组一律只能
   * 落「证不出」。
   */
  unitToken: text("unit_token"),
  logPath: text("log_path").notNull(),
  // 已经读进来并推送过的字节位置。重启后从这里接着读。
  offset: integer("read_offset").notNull().default(0),
  events: integer("events").notNull().default(0),
  exitCode: integer("exit_code"),
  startedAt: text("started_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  endedAt: text("ended_at"),
  endedReason: text("ended_reason"),
  /**
   * **谁让它停的**：`actor`=人点停或 agent 调 stop_monitor；`limit`=推满事件上限自动停；
   * `system`=任务终态/归档/重启后没有出口被回收。null = 来源不详（存量行，或自己退出/到期
   * 这类本来就不是「被停」的结局）。
   *
   * 单独一列而不是从 `status` 推：`stopped` 这一个状态下三种来由都会写（第 1 轮审查 N1
   * 实测把「推够了 200 条事件自动停」说成了「本回合撤掉哨兵，撤的理由『推够了…』」）。
   * 从 `ended_reason` 的文案反推同样不行 —— 那是一句随时会改的人话。
   */
  endedBy: text("ended_by"),
  /**
   * **「它还没送到的结果,我不要了」这句话本身**(ISO 时刻 + 理由)。
   *
   * 跟 `ended_by` 是两件事,第 2 轮审查 R2-3 把它们混成一件:`ended_by` 回答「谁让这个**进程**
   * 结束的」,而一条已经 `exited` 的哨兵根本不是被谁停的 —— 对它调 `stop_monitor` 走的是
   * 非 running 分支,一个字都写不进 `ended_by`,于是闸继续拦着「先把结果收下来」,而工具说明
   * 和拒绝文案都承诺「stop_monitor 就能放弃」。实测:停完仍是 exited / ended_by=system /
   * pending=1 / 再次 complete 仍 409,文案还在重复推荐同一个动作。
   *
   * 所以这一对列只记**动作与理由**,对所有结束状态幂等,且**不动**原来的结束事实(状态、
   * ended_at、ended_reason 一律原样保留 —— 它们是已经发生的事)。放弃的是「必须先收下它」
   * 这件事,不是那几行本身:已经排进待发送的事件照旧会送(任务还活着就收得下)。
   */
  resultsAbandonedAt: text("results_abandoned_at"),
  resultsAbandonedReason: text("results_abandoned_reason"),
  /**
   * **「它的结局已经写定、那条结束通知还没入队」这一瞬的责任凭证**(时刻 + 要送的原文)。
   *
   * 为什么非要落库:结束是两件事 —— 把行写成终态,和把「【哨兵结束】…」排进待发送。中间隔着
   * 时间线那一笔 await。那一瞬库里的样子是「没有 running 的哨兵、也没有排着的消息」,而完成闸
   * 的两类判据恰好就是这两样,于是它放行、任务落 done,紧接着的那次入队被终态挡回 —— 一条
   * 没有 stdout 的命令(`sleep 0.15`)唯一能告诉执行者「等到了」的通知就此蒸发(第 1 轮审查
   * F1 实测 `F1_END_RESULT_HANDOFF`:statusAtSeam=exited、pendingBefore=0、complete 200、
   * settlement=done、messagesAfter=[])。
   *
   * 所以凭证跟终态**同一条 UPDATE 落库**(一条语句,没有缝),入队成功之后才清。于是从结果产出
   * 到持久入队,任何一刻完成闸都至少看得见一样东西。进程这中间死掉也不丢:原文就在这一列上,
   * 启动时按它重投(monitor-reattach.ts 的 `redeliverResultHandoffs`)。
   *
   * 跟 `results_abandoned_at` 的关系:那一列是「我不要这份结果了」—— 它一旦落下,这一列照旧
   * 留着(通知该送还是会送),只是不再拦着完成。
   */
  resultHandoffAt: text("result_handoff_at"),
  resultHandoffText: text("result_handoff_text"),
  // 谁起的这个哨兵(多人模式)。停它、看它都按任务归属判权,这一列只做记账。
  ownerUserId: text("owner_user_id"),
  // 出身:'ash' = ash server 自己起的进程(全功能);'claude' = claude CLI 内置 Monitor 的
  // **只读投影**(停不掉、无日志、随 agent 进程消失)。语义见 shared/src/monitor.ts 文件头。
  // 所有「接管进程/杀进程/读日志」的查询都必须按它过滤,否则会拿 pid=null 的投影行去认进程。
  kind: text("kind").notNull().default("ash"),
  // 来源侧的原生 id(claude 的后台任务 id,形如 b69ym4qzv)。'ash' 那种恒为 null。
  nativeId: text("native_id"),
  // 这条投影是哪条 CLI 会话报上来的('ash' 那种恒为 null)。**它是重启后认领关系的唯一凭据**:
  // agent 进程活得过 ash 重启(detached),重启后新建的解析器必须靠它把这些行认回来,否则
  // 来源侧后续的终态通知会因为「没认领过」被丢掉,卡片永远停在旧状态。
  cliSessionId: text("cli_session_id"),
  // 起它的那个 tool_use 的 id。**这是「检查点」的另一半**:内存里的配对状态(tool_use_id →
  // native_id)在内存上限下会被丢掉,丢了之后后缀里的起手回执就配不上任何东西;记在行上,
  // 它就能按 tool_use_id 回到这一行(见 server/src/claude-monitor-commit.ts 的文件头)。
  // 'ash' 那种恒为 null;存量 claude 行也是 null,下一次读到它的回执时顺手补上。
  toolUseId: text("tool_use_id"),
  // 盯到什么时候:bounded(expires_at 可信) / persistent(持续,无到期) / unknown(还没拿到
  // 来源回执)。'ash' 那种恒为 bounded。语义见 shared/src/monitor.ts 的 MonitorLifetime。
  // expires_at 本身保持 NOT NULL(SQLite 改约束要重建表),非 bounded 时存占位值,由
  // toTaskMonitor 按这一列决定对外给不给 —— 对外契约里它是可空的。
  sourceLifetime: text("source_lifetime").notNull().default("bounded"),
  // **期限是怎么来的** —— 不是「它是不是 bounded」,而是「凭什么说它 bounded」。
  // 'receipt' = 来源回执明说的（唯一可信来源）;NULL = 旧版本算法推出来的,不可信。
  // 为什么必须单独记而不能靠别的列推断:`cli_session_id` 从本功能第一个提交(579e58dc)
  // 就有,`source_lifetime` 到第 2 轮(af4ea0e2)才加,两者不同批 —— 拿「有没有归属」当
  // 「期限可不可信」的版本依据是错的(第 4 轮审查用 git show 核出这处事实错误)。这一列
  // 是新加的,所以旧行必然 NULL,这才是可靠的版本判据。
  lifetimeEvidence: text("lifetime_evidence"),
  // **起这个 Monitor 的那一代 agent 进程**。`sessions` 的 agent_pid/agent_started_at 每
  // 回合都被下一轮覆盖,所以「这条会话现在有活进程」不等于「起它的那一代还活着」:上一轮
  // 的进程早死了、同一 CLI 会话的新进程还在跑时,历史投影会被判成 running(第 4 轮审查
  // 实测 reusedSession)。存下当代身份,存活判断才问得准。NULL = 代次不明(历史回填时
  // sessions 那两列已被覆盖),判死活退回会话/任务那一层。
  //   这两列由**流的来源绑定层**在流开始那一刻抄下来(claude-monitor-origin.ts):落库那一刻
  // 再去问 `sessions` 读到的已经可能是下一代(写库是排队的),那样写出来的代次凭据会反过来
  // 给旧监听续命(新一轮第 1 轮审查 F1 实测)。
  sourcePid: integer("source_pid"),
  sourcePidStartedAt: text("source_pid_started_at"),
  // **起它的那个 run 文件**(绝对路径)。代次结论的持久化依据:每个 run 文件对应一次 agent
  // 进程启动(executors/detached.ts 的 runPaths),所以「这一行的 run 不是这条会话最新的那个」
  // = 起它的那一代进程必然已经退出。
  //   为什么不能只靠内存里重算:扫描状态会被内存上限丢掉,那时 found 是空的,「后来又起过
  // 新一轮」这件事就没人算得出来 —— 新回合的空 run 文件一出现,旧监听反而会被当前会话的
  // 新进程证明成「还在盯着」(第 10 轮审查用生产服务 + 真页面实测)。NULL = 存量行,退回
  // source_pid / 会话那一层。
  sourceRun: text("source_run"),
  // 起点区间的**下界**:发起它的那条 assistant 事件(tool_use)的时刻。
  //   起点是个区间 [tool_use, 起手回执](见 claude-monitor-scan.ts 的 Found.startedAtLow)。
  // 上界由回执给出,而回执可能落在后缀里、等配对状态被挤掉之后才读到 —— 那时若没存下界,
  // 就只能放弃精确到期时刻(第 10 轮审查不拦项 1)。存下它,迟到回执仍能重建出那个窄区间。
  startLowAt: text("start_low_at"),
  // **起点**的证据,跟 lifetime_evidence(时长的证据)是两件独立的事:知道「盯 90 秒」不等于
  // 知道「从哪一刻开始数」。这一列只说**锚点是哪来的**:'observed' = 实时看着 task_started
  // 到达;'receipt-window' = 历史重建,起点落在 [tool_use, 回执] 区间内;NULL = 起点不明。
  // 语义见 shared/src/monitor.ts 的 MonitorStartEvidence。
  startEvidence: text("start_evidence"),
  // 那个锚点离真实起点**最远可能差多少毫秒** —— 起点可信与否的另一半,缺了它上面那一列
  // 只是个无法重验的结论字符串(第 7 轮审查:旧实时投影在写库队列积压 2.2 秒之后取的时刻
  // 同样标着 'observed',光看字符串分不出它和新代码写的那种)。
  //   实时 = [来源盖的上一个时刻, 事件到达时刻] 的宽度;历史 = [tool_use, 回执] 的宽度;
  //   ash 自己起的 = 0(进程就是它 spawn 的);NULL = 无法重验 ⇒ **不给精确到期时刻**。
  // 判定在 shared 的 monitorStartTrusted(容差随时长放宽,所以在**读**的时候算)。
  startAnchorWidthMs: integer("start_anchor_width_ms"),
  // 来源确认的时长(毫秒),与起点无关。用来表达「知道盯多久、但起点不确定」——那时
  // expires_at 不可信,但这一列仍然能告诉用户「盯 90 秒」。
  timeoutMs: integer("timeout_ms"),
  /**
   * **这个哨兵是哪条会话起的**(`sessions.role`:`single`=执行者 / `reviewer`=审查者)。
   *
   * 哨兵唯一的出口是「唤醒这个任务」,而一个任务同时可以有两条会话 —— 审查是**旁路回合**,
   * 跑在自己那条 `reviewer` 会话上。少了这一列,事件入队时填不出 `scheduled_messages
   * .session_role`,投递就按默认的 `single` 走:**审查者挂的哨兵醒来时叫的是执行者**。
   * 那一轮既续不上审查(审查链还停在 reviewing 等它续跑),又凭空让执行者跑了一轮。
   *
   * NULL = 当初没记的存量行,或者起它的那一刻认不出活跃会话 —— 退回默认的 `single`,
   * 也就是这一列加上之前的老行为。
   */
  sourceRole: text("source_role"),
  /**
   * **起它的那次自由工作流审查**(`free_review_runs.id`)。非空 = 这个哨兵是某一次审查
   * 等待外部结果用的,它的命跟着**那一次审查**走,而不是跟着任务的状态走。
   *
   * 为什么角色那一列不够:自由工作流的审查是**旁路回合**,跑在一个已经 done 的任务上。
   * 于是「任务终态」与「审查已结束」是两件事,而三个地方都必须按后者判断 ——
   * - 任务终态连坐清理(status.ts → stopMonitorsForTask):审查回合退出时会把任务状态
   *   恢复成 done,照着终态一刀切就会把审查者刚挂好的哨兵立刻停掉、待发事件一并作废,
   *   审查从此等不到唤醒(第 1 轮审查实测 F1:pause 成功、monitorStatus=stopped、
   *   run 仍 reviewing、resumePrompt 还留着 —— 一个没人能叫醒的等待)。
   * - 事件出口与唤醒前最后一道闸:判据必须是「**这一次**审查还在不在」。只问「这个任务
   *   上有没有任意一条 reviewing」的话,上一轮遗留的事件会被重新解释成新一轮审查的输入。
   * - 唤醒时的执行配置:审查者可以是另一个执行器/模型(典型:codex 审 claude 写的代码)。
   *   只按角色续跑会落回任务自己的配置,新建一条 claude 的 reviewer 会话,原审查上下文
   *   接不上(第 1 轮审查实测 F2)。配置从**这一行指着的那次 run** 上取。
   *
   * NULL = 不是审查挂的(执行者自己挂的),或存量行 —— 一律按任务状态走老规矩。
   */
  sourceReviewRun: text("source_review_run"),
  /**
   * 起它的是**那次审查的第几轮**(`free_review_runs.current_round`)。
   *
   * `run.id` 不够:一次审查未通过时链会自动续轮 —— `nextRound` 把**同一个** run 的
   * current_round 加 1、status 从 stopped 推回 reviewing。于是第 1 轮挂的哨兵、它那条
   * 还没送出去的结果,会在第 2 轮被判成「来源仍有效」而送进新一轮的会话:新一轮的审查
   * 者收到的是上一轮等的那件事的结果(第 2 轮审查 F5 指出的轮次身份)。
   *
   * NULL = 存量行 —— 只按 run 判,也就是这一列加上之前的行为。
   */
  sourceReviewRound: integer("source_review_round"),
});

// ── 还没配上 `task_started` 的 Monitor 调用 ────────────────────────────────────
//
// 一条内置 Monitor 的**入参只存在于 `tool_use` 那一行**（命令、说明），而它的身份
// (`task_id`) 要等下一行 `task_started` 才有 —— 中间这段「悬着」的状态必须活过：
//
// ① **读取窗口切在两行之间**（单次 128 MiB 上限），下一轮才读到 `task_started`；
// ② **扫描快照被内存上限挤掉**（claude-monitor-backfill.ts 的 `SNAPSHOT_HARD_CAP`）。
//
// 上一版把它放在内存里，靠「读取位置绝不越过一条还悬着的调用」来保证能重放那一行。那个
// 办法在**调用根本不会有 `task_started`** 时失效：启动被拒（`is_error` 回执）、进程在回合
// 中途被杀（连回执都没有），于是位置被永久钉在那一行之前，每轮重读同一个窗口、末尾的
// Monitor 永远读不到（第 12 轮审查实测 12 轮停滞；第 8～10 轮是同一类的前几个实例）。
//
// 所以改成**落盘**：位置只管单调往前，悬着的调用由这张表独立恢复。配上 `task_started`
// （成了 `monitors` 里的一行）或者确证起不来（回执配不上 `task_started`）就删掉。
//
// 行数天然有界：每条 Monitor 调用在同一回合内必有 `task_started` 或回执，真正长期悬着的
// 只有「进程在那一行之后被杀」这一种，每个 run 文件至多一条。
export const monitorPendingCalls = sqliteTable("monitor_pending_calls", {
  taskId: text("task_id").notNull(),
  /** 读到它的那条 **ash 会话** id（`pending` 按会话分区，见 shared/monitor.ts 的身份作用域）。 */
  sessionKey: text("session_key").notNull(),
  toolUseId: text("tool_use_id").notNull(),
  command: text("command").notNull(),
  description: text("description").notNull().default(""),
  /** 那条 assistant 事件的时刻 = 起点区间的下界（见 monitors.start_low_at）。 */
  at: text("at"),
  /**
   * **在哪个 run 文件里读到的 —— 来源凭据本体，不是诊断字段。**
   *
   * 一个 run 文件 = 一次 agent 进程启动 = 一个 CLI 会话，所以它是「这条调用属于哪个来源」
   * 唯一能自证的东西（`claude-monitor-identity.ts`）。NOT NULL：它是唯一键的一维，而
   * SQLite 的 PRIMARY KEY 列允许 NULL —— 允许了就等于两条「来源不明」又挤在同一个键上。
   * 迁移上来的存量行填空串 = 来源不明，那种行谁也证明不了，于是永远不会被销账。
   */
  sourceRun: text("source_run").notNull().default(""),
  /**
   * 调用发生时那一行报的 CLI 身份（认不出来就 NULL，**不是通配符**）。
   *
   * 为什么不用当前 `sessions.cli_session_id` 反推：那一列只记得**当前**那个会话号，resume
   * 之后旧 run 文件里的调用会跟着改姓，于是新一轮成行就把旧一轮还悬着的那条销了账 —— 那是
   * 它入参的唯一出处（新一轮第 1 轮审查 F1 实测旧卡永久消失）。
   */
  cliSessionId: text("cli_session_id"),
}, (t) => ({
  // **唯一键要跟 bootstrap 那条 DDL 一模一样**（db/index.ts 的 `CREATE TABLE IF NOT EXISTS`）。
  // 声明式路径（`npm -w server run db:push`）只认这里：少了它，push 建出来的表没有任何唯一
  // 约束，`syncPendingCalls` 的 `onConflictDoNothing` 于是防不住重复 —— 每轮同步都能再插一条
  // 一样的（第 12 轮审查 N4，用构建产物 drizzle-kit export 实测该表没有主键）。
  //
  // **来源在键里**：两个 run 文件里的同号调用必须各占一行。少了那一维，第二条被
  // `onConflictDoNothing` 吞掉，它的入参就只剩别人那一份；旧库的键由
  // `db/migrations.ts` 的 `repairPendingCallKey` 重建上来（SQLite 改不了主键）。
  pk: primaryKey({ columns: [t.taskId, t.sessionKey, t.sourceRun, t.toolUseId] }),
}));

// ── 历史扫描读到哪儿了 ────────────────────────────────────────────────────────
//
// **这是检查点本体，不是缓存。** 「这个文件读到第几字节」决定了下一轮从哪儿接着读，而
// 它之前那段内容的归宿是「已经成行落库」+「悬着的调用落在上面那张表里」——位置一丢就得
// 从零重读，单次只读 128 MiB，于是「历史很长、Monitor 在末尾」的任务永远读不到它。
//
// 为什么非落盘不可：位置原先住在进程内的两张表里（扫描快照 LRU、再后面兜底的位置表），
// 两张都有容量上限。上限一到，**还没读完的那个任务**的位置就被别的任务挤掉，固定输入在
// 持续压力下永远停在同一个前缀（第 11、12、13 轮审查连续三次都栽在同一个判据上，只是
// 丢位置的出口每轮换一个）。落了盘就没有「哪张内存表还记得它」这回事了，顺带连 server
// 重启也不必从零重读。
//
// 行数有界：每个任务 × 每个 run 文件一行，任务删除时一起收（task-delete-routes.ts）。
export const monitorScanCursors = sqliteTable("monitor_scan_cursors", {
  taskId: text("task_id").notNull(),
  /** run 文件的绝对路径（`<sessionId>-<时间戳>.agent-out.jsonl`）。 */
  path: text("path").notNull(),
  /** 上一次读到它时它有多大。比这还小 = 文件被重写过，位置作废从头读（见 scanSession）。 */
  fileSize: integer("file_size").notNull().default(0),
  readOffset: integer("read_offset").notNull().default(0),
  /** 找「下一个换行」找到哪一字节了(绝对位置,0=没有在找)。见 claude-monitor-read.ts 的预算。 */
  probe: integer("probe").notNull().default(0),
  /**
   * 永久缺口**全集**:`[{from,need},…]` 的 JSON(默认 `[]`)。被跳过的每一条超长记录各占
   * 一项:它从哪一字节起、补上它需要多大的读取窗口。
   *
   * **不能是单槽**:一个文件里跳过第二条记录时,单槽会把第一条的证据顶掉 —— 窗口后来变大
   * 只补回第二条,第一张卡永远停在 lost,而账面已经干净(第 5 轮审查 N1 实测)。
   */
  gaps: text("gaps").notNull().default("[]"),
  /**
   * 这个文件里报的 CLI 会话身份（`session_id`，没读到过就 NULL）。
   *
   * 一个 run 文件只由一次 agent 进程启动写出，所以它就是「这一段事实属于哪个来源」的可重验
   * 证据。记在这里是为了让**全集**活过内存淘汰：`sessions.cli_session_id` 只记得当前那一个，
   * resume 换号之后旧号就没了，拿它当「这个任务只有一个来源」的依据是错的（第 6 轮审查 N2）。
   */
  source: text("source"),
  /**
   * 这份位置是**哪一代消费语义**下确认的（`MONITOR_CHECKPOINT_SEMANTICS`，旧行 NULL=第一代）。
   *
   * 「位置之前的事实都已落库」这句承诺依赖当时那一代的认行判据、唯一键**和合并/消费规则**：
   * 任何一样改了，旧位置就不再可信（实测后果：被挤掉的卡、没合并进去的终态，升级后刷新也
   * 不自愈 —— 第 8/9/10 轮审查）。只有带当代戳的位置才接着用，其余的那个文件重放一遍。
   */
  semantics: integer("semantics"),
}, (t) => ({
  // 跟 bootstrap DDL 一模一样（db/index.ts）；两条建库路径的唯一性契约必须同一个。
  pk: primaryKey({ columns: [t.taskId, t.path] }),
}));

// ── 没停掉的进程:**回收责任** ─────────────────────────────────────────────────
//
// 「已撤销的生命周期不许再有资源在跑」这条不变量,只靠 `stopMonitorsForTask` 那一刀是立不住
// 的:那一刀可能落不下去(库忙、kill 被拒、pid 已经不是当初那个但命令其实还活着),而紧接着
// 的删除批次会把 `monitors` 整个任务的行一起带走 —— **pid 这个唯一线索从此消失**,重启也认
// 领不回来(第 3 轮审查 F1;归档那条路同样只记了日志)。
//
// 所以停不掉的那一条必须在**别的地方**留下身份和责任,而且这张表**不随任务一起删**:它的
// 全部意义就是活得比那个任务久(所以 task-delete-routes.ts 的删除批次里刻意没有它,那边
// 留了一条反向注释,别顺手补上)。
//
// 行数有界:只有「停止没能确认」的那几条进得来,销账(进程确认没了)就删行。
export const monitorReclaimDebts = sqliteTable("monitor_reclaim_debts", {
  /** 就用那条哨兵自己的 id:同一条反复欠账只占一行(ON CONFLICT 覆盖)。 */
  monitorId: text("monitor_id").primaryKey(),
  /** 只做记账和展示 —— 任务行可能已经没了,这一列不保证指向存在的任务。 */
  taskId: text("task_id").notNull(),
  /** 认人的那一对:pid 会被复用,少了启动时刻就可能杀掉同号的无辜进程。 */
  pid: integer("pid").notNull(),
  pidStartedAt: text("pid_started_at"),
  /**
   * `pid_started_at` 还空着时,**把身份补全所需要的那个时间锚**留在这一笔上
   * (`spawn` 返回 pid 的那一刻,见 monitor-spawn 的身份边条)。
   *
   * 为什么债上也要留一份:哨兵行和它的身份边条都可能先没了(任务被删、正常收尾清掉边条),
   * 而那之后这笔债就是这个进程唯一的线索。缺了锚,「这一刻 ps 答不出来」会被永久固化成
   * 「这条永远证不出身份」—— 既不敢下刀,也销不掉账(第 10 轮审查 F2-B)。
   */
  spawnAnchorMs: integer("spawn_anchor_ms"),
  /** 命令原文:清扫时打在日志里,否则没人看得出那个 pid 当初在干什么。**不作归属凭证**。 */
  command: text("command").notNull().default(""),
  /**
   * 那条资源记号(见 monitors.unit_token)。**债上必须自己留一份**:哨兵行可能先没了
   * (任务被删),而清扫这一侧要证明「这一项资源退没退」只能靠它 —— 缺了它,孤儿后代既不敢
   * 收、也销不掉账(第 12 轮审查 F1)。
   */
  unitToken: text("unit_token"),
  /** 当初为什么要停它(删除/归档/审查结束/任务终态)。 */
  reason: text("reason").notNull().default(""),
  /**
   * **追到这里为止的时刻**(第 13 轮审查 F1-B)。空 = 还在追。
   *
   * 非空**不等于「整项资源退出已证明」**,只等于「能追的线索都答出来、都空了」:根的代次
   * 已经不在,带着记号的进程一个都找不着,原进程组也空了。POSIX 上后代甩得掉记号(`env -i`)
   * 也甩得掉进程组(`setsid`),所以那件事当前平台证不出 —— 这一行因此**不删**,只盖戳:
   * 它是这次创建最后的可定位身份(命令、pid、记号、追不下去的理由都在行上)。
   *
   * 收过档的行不再重试、不再发信号、开机也不再报警(见 `sweepMonitorReclaimDebts`)。
   */
  closedAt: text("closed_at"),
  /** 收档那一刻,线索停在哪一档(`stateNote` 那句话)。 */
  closedNote: text("closed_note"),
  /**
   * **这个号已经被反证过的时刻**(第 17 轮审查 F1)。空 = 还没有过反证。
   *
   * 反证 = 记号那一问明确答出「这个号不是(或已经不是)这条记录的那个进程」:`none`、`ours`
   * 名单里没有它、代次 `changed`。它跟「这一刻问不出来」是两件事,而**只有后者**可以退回
   * 时间锚 + 命令包含那条弱判据。
   *
   * 为什么要落盘:反证只活在一次函数调用的返回值里时,下一次尝试、另一个消费者、重启清扫
   * 都会把它退化成「未知」再走弱判据 —— 实测后果是同号新进程的真实启动时刻被写成旧哨兵的
   * 身份、随后按这条身份收到真实 SIGKILL(`round-7/refutation-auto.log`)。
   *
   * 非空**只收走弱判据,不封死强凭证**:真实带着这次记号的后代落到同一个号上时,记号那一问
   * 仍然把它判成已证明 —— 那是它自己的独立证据(见 monitor-identity-authz.ts)。
   */
  identityDisprovedAt: text("identity_disproved_at"),
  /** 停不掉的那次报了什么。 */
  lastError: text("last_error"),
  attempts: integer("attempts").notNull().default(0),
  createdAt: text("created_at").notNull(),
  lastAttemptAt: text("last_attempt_at"),
});
