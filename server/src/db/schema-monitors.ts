// monitors 表。
//
// 为什么单独一个文件：哨兵这块的实现本来就分了四份（claude-monitors / -scan / -backfill /
// -liveness），表定义跟着它们走比挤在 schema.ts 里更好找；而 schema.ts 加上这张表会超过
// 项目约定的 700 行上限（全局 CLAUDE.md），这次正好拆出来。
//
// `schema.ts` 原样转发 `monitors`，所有 `from "./db/schema.js"` 的导入不受影响。
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
