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
  logPath: text("log_path").notNull(),
  // 已经读进来并推送过的字节位置。重启后从这里接着读。
  offset: integer("read_offset").notNull().default(0),
  events: integer("events").notNull().default(0),
  exitCode: integer("exit_code"),
  startedAt: text("started_at").notNull(),
  expiresAt: text("expires_at").notNull(),
  endedAt: text("ended_at"),
  endedReason: text("ended_reason"),
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
// Monitor 永远读不到（第 11 轮审查实测 12 轮停滞；第 8～10 轮是同一类的前几个实例）。
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
  /** 在哪个 run 文件里读到的。只作诊断。 */
  sourceRun: text("source_run"),
}, (t) => ({
  // **唯一键要跟 bootstrap 那条 DDL 一模一样**（db/index.ts 的 `CREATE TABLE IF NOT EXISTS`）。
  // 声明式路径（`npm -w server run db:push`）只认这里：少了它，push 建出来的表没有任何唯一
  // 约束，`syncPendingCalls` 的 `onConflictDoNothing` 于是防不住重复 —— 每轮同步都能再插一条
  // 一样的（第 12 轮审查 N4，用构建产物 drizzle-kit export 实测该表没有主键）。
  pk: primaryKey({ columns: [t.taskId, t.sessionKey, t.toolUseId] }),
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
}, (t) => ({
  // 跟 bootstrap DDL 一模一样（db/index.ts）；两条建库路径的唯一性契约必须同一个。
  pk: primaryKey({ columns: [t.taskId, t.path] }),
}));
