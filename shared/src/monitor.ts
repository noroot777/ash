// 哨兵（Monitor）：一条绑在任务上的长跑命令，stdout 每一行就是一条事件。
//
// 它要解决的是 agent 侧「盯着一件慢事」的老问题：轮询要反复烧回合去 cat 日志，
// 挂在会话上的后台进程又会随会话一起被回收（claude 自带的 Monitor 就死在这一点上：
// 会话一结束，它和被它盯着的活一起没了）。ash 版把进程的归属上移一层——进程由 **ash
// server** 起，不在 agent 进程树里，于是 agent 回合结束、会话结束、server 重启都动
// 不到它；有事件时再按既有的待发送消息链路把任务唤醒。
//
// 一条事件 = 唤醒任务一次 = 真金白银的一个模型回合。所以这里的上限不是防御性冗余，
// 而是功能的一部分：批量合并、单批行数上限、总事件上限，三道都写在下面。
//
// ── 两种来源（`kind`）─────────────────────────────────────────────────────────
//
// 面板上并排显示的哨兵有两种出身，能力**不对等**，所以 `kind` 不是装饰性标签，是读这份
// 结构时必须先看的一列：
//
// - `ash`：上面说的那种，ash server 自己起的进程。全套都有——停得掉、看得到日志尾巴、
//   跨回合/会话/重启都活着。
// - `claude`：claude CLI 自带的 `Monitor` 工具起的，**进程在 agent 自己的进程树里**。
//   ash 只是从 stream-json 里把它认出来并记账，是一份**只读投影**：停不掉（`TaskStop`
//   是 claude 进程内的工具，ash 没有手柄）、没有日志文件、agent 进程一死它就跟着没了。
//
// 为什么还要记它：不记的话，agent 在对话里说一句「已挂 Monitor，等通知」，而哨兵面板
// 空空如也——用户翻遍界面也对不上账，只能得出「这功能坏了」。2026-10-14 实测的那个任务
// 挂了 12 个内置 Monitor、ash 一个都不知道，用户的第一反应正是「为什么 inspector 里没
// 东西」。只读也比没有强，前提是**界面必须如实说明它只读**（见 MonitorCard）。
//
// **两种都要能看见，但界面上不许混在一起**（用户 2026-10-16 拍板）：它们的能力不对等到
// 了「同一个词指两件事」的地步——混排时用户会对着一张 claude 的卡去找停止按钮，或者把
// 「这个哨兵会叫醒任务」的预期套到一个只在那一轮里有效的监听上。所以面板按来源分段
// （见 MonitorInspector），会话区那张「在等哨兵」只数 ash 那种、另起一行交代内置那几个
// （见 MonitorWaitCard）。
//
// **`claude` 这一种今后只从两处来**：2026-10-16 起，一次性回合（`claude -p`，单飞任务和
// 团队执行者都是）里 agent 调内置 Monitor 会被 PreToolUse hook 当场改道成一条 ash 哨兵
// （见 server/src/claude-monitor-hook.ts），所以那条路上不再产生新的只读投影。仍会产生
// 的是**常驻会话**（团队调度台，`--input-format stream-json`——那种模式下 CLI 进程一直
// 活着，内置 Monitor 真能唤醒它自己，拦它才是错的），以及**历史**：改道之前跑过的任务，
// 会话文件里还躺着它们，面板得答得出「那 12 个 Monitor 后来怎么了」。

export const MONITOR_STATUSES = ["running", "stopped", "expired", "exited", "lost"] as const;
export type MonitorStatus = (typeof MONITOR_STATUSES)[number];

/** 哨兵的出身。能力差异见文件头那一段——`claude` 那种是只读投影。 */
export const MONITOR_KINDS = ["ash", "claude"] as const;
export type MonitorKind = (typeof MONITOR_KINDS)[number];

/**
 * 这个哨兵**盯到什么时候**——三态，不是一个「到期时刻」就能表达的。
 *
 * ash 自己起的恒为 `bounded`：期限是它自己定的，当然知道。但 claude 内置 Monitor 的期限
 * 是**来源侧说了算**，而 ash 只是转述：
 * - `bounded`：来源明确回执了有效期（`expiresAt` 可信）。
 * - `persistent`：来源说它不设会话内超时（持续盯着），没有到期时刻。
 * - `unknown`：还没拿到回执，或者回执里没提期限。
 *
 * 为什么必须有 `unknown` 这一档：claude 的回执（tool_result 里那句 `expires in 20m`）
 * **在 `task_started` 之后才到**（实测顺序 tool_use → task_started → tool_result），所以
 * 投影刚落库那一刻我们确实不知道。更要命的是来源侧会**自己钳**——请求 1 小时、实际可能
 * 只给 30 分钟或 10 分钟（第 2 轮审查从本机 claude 2.1.283 的归一化函数实测到两个分支）。
 * 拿请求参数冒充生效期限，卡片上那句「盯到 X」就是编的。不知道就说不知道。
 */
export const MONITOR_LIFETIMES = ["bounded", "persistent", "unknown"] as const;
export type MonitorLifetime = (typeof MONITOR_LIFETIMES)[number];

/**
 * 从 claude 起 Monitor 的回执里读**实际生效**的期限。
 *
 * 回执由来源侧这段代码拼出来（本机 claude 2.1.283 的 `mapToolResultToToolResultBlockParam`
 * 原文，三个分支互斥）：
 *
 * ```js
 * let r = e.persistent ? "persistent — runs until TaskStop or session end"
 *   : eX() ? `expires in ${Zt(e.timeoutMs,{hideTrailingZeros:!0})} unless the source ends first; …`
 *   : `timeout ${e.timeoutMs}ms`;
 * ```
 *
 * 三个分支都得认，而且 `e.timeoutMs` 已经是**钳过的生效值**（`Math.min(请求值, 10 或 30
 * 分钟)`，哪一档由账号 feature flag 决定），所以回执才是事实，入参那个 `timeout_ms` 只是
 * 我们请求了什么。认不出来一律 `unknown` 而不是退回请求值：两者不同的那种情况（来源钳了）
 * 恰恰是这个函数存在的全部理由。
 *
 * ── 为什么不能只取第一个「值+单位」────────────────────────────────────────────
 *
 * `expires in` 那段走的是 `Zt()`，一个**多段**时长 formatter：
 *
 * ```js
 * if(o>0){ if(c&&s===0) return`${o}m`; return`${o}m ${s}s` }   // c = hideTrailingZeros
 * ```
 *
 * 也就是说 90 秒印成 `1m 30s`、1790 秒印成 `29m 50s`。只匹配首个数值单位对会把它们读成
 * 1 分钟和 29 分钟——卡片上少掉的那几十秒正好落在用户最关心的「还剩多久」上（第 3 轮审查
 * 实测三组：90s→少 30s、1790s→少 50s、3599s→少 59s）。所以这里**把整串求和**。
 *
 * 求和的范围必须锚在 `expires in` 之后那一串连续的「值+单位」上，不能对全文做全局匹配：
 * 后台任务 id 形如 `b12m34`，全局扫会把里面的 `12m` 当成时长吃进来。
 */
export function parseMonitorStartReceipt(text: string): { lifetime: MonitorLifetime; ms: number | null } {
  if (!/Monitor started/i.test(text)) return { lifetime: "unknown", ms: null };
  // ① 不设会话内超时，盯到 TaskStop 或会话结束。
  if (/\bpersistent\b/i.test(text) && !/expires in/i.test(text)) return { lifetime: "persistent", ms: null };
  // ② `expires in 29m 50s unless …`：一串空格分隔的值+单位，遇到散文自然终止。
  const span = /expires in\s+((?:\d+(?:\.\d+)?\s*(?:ms|s|m|h|d)\b[\s,]*)+)/i.exec(text);
  if (span) {
    let total = 0;
    for (const part of span[1]!.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)\b/gi)) {
      const value = Number(part[1]);
      if (!Number.isFinite(value)) return { lifetime: "unknown", ms: null };
      total += value * MONITOR_UNIT_MS[part[2]!.toLowerCase() as keyof typeof MONITOR_UNIT_MS];
    }
    return total > 0 ? { lifetime: "bounded", ms: Math.round(total) } : { lifetime: "unknown", ms: null };
  }
  // ③ `timeout 90000ms`：feature flag 关掉时的那一支。原始毫秒，同样是生效值。
  const plain = /\btimeout\s+(\d+)\s*ms\b/i.exec(text);
  if (plain) {
    const ms = Number(plain[1]);
    if (Number.isFinite(ms) && ms > 0) return { lifetime: "bounded", ms };
  }
  return { lifetime: "unknown", ms: null };
}

/** `Zt()` 印得出的单位。小时/天在 Monitor 的量级上用不到，认它们是零成本的鲁棒性。 */
const MONITOR_UNIT_MS = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/**
 * 期限的**证据**：凭什么说这个 `expiresAt` 是真的。
 *
 * 这不是 `MonitorLifetime` 的重复——那一列说「是不是有限期」，这一列说「这个判断立不立得住」。
 * 两者必须分开记，因为**纠正旧数据时唯一可用的判据是证据，不是结论**：一行写着 `bounded`
 * 可能来自来源回执（对），也可能来自某个旧版本拿请求值算的（错），结论本身分不开它们。
 *
 * - `receipt`：来源回执明说的（`parseMonitorStartReceipt` 读出来的）。claude 投影唯一的可信档。
 * - `self`：ash 自己起的哨兵——期限是 ash 定的，进程也是 ash 起的，不存在"来源说了算"的问题。
 * - `null`：旧版本算法推出来的，或还没拿到回执。不可信，对外不给到期时刻。
 *
 * 为什么不能用别的列代替：`cli_session_id` 从本功能第一个提交就有，`source_lifetime` 要晚
 * 两轮才加——拿「有没有会话归属」当版本依据会把一批带归属的错期限漏掉（第 4 轮审查实测
 * legacyLifetimes：60 秒和假 5 分钟两行，迁移两次 + 完整回填后仍原样）。
 *
 * **这一列只说时长，不说起点。** 上一版把两者当成同一件事（「能算到期时刻的前提是收到回执，
 * 而回执自带可信时刻」），那是错的：回执能证明**配置了多长**，不能证明**消息上的 timestamp
 * 就是计时器起点**——计时器在工具返回前就起了，而回执消息要等 PostToolUse hooks 跑完才构建
 * （第 5 轮审查从 claude 2.1.283 二进制提取源码证实）。起点另有一列，见
 * {@link MonitorStartEvidence}。
 */
export const MONITOR_LIFETIME_EVIDENCE = ["receipt", "self"] as const;
export type MonitorLifetimeEvidence = (typeof MONITOR_LIFETIME_EVIDENCE)[number];

/**
 * **起点**的证据：凭什么说这个到期时刻的「起算点」是对的。
 *
 * 跟 {@link MONITOR_LIFETIME_EVIDENCE} 是两件独立的事——知道「盯 90 秒」不等于知道「从哪一刻
 * 开始数」。到期时刻 = 起点 + 时长，两个都得有依据才能给出一个精确时刻。
 *
 * - `observed`：**实时**投影。ash 自己看着 `task_started` 事件到达并立刻落库，起点就是那一刻，
 *   不确定度只有流传输那几毫秒。
 * - `receipt-window`：**历史**重建。起点落在 `[tool_use, 回执]` 区间内（两端都是日志里真实
 *   存在的时刻），而且区间窄到不影响显示。实测本机 60 个真实回执区间宽 22~59ms。
 * - `null`：起点不明，或区间宽到不能忽略（例如 PostToolUse hooks 跑了很久）。这时**不给精确
 *   到期时刻**，只报时长（`timeoutMs`）。
 *
 * 实时和历史的证据档位不同是因为**可用的证据本来就不同**，但两者作的承诺是同一个：只有起点
 * 有依据时才给精确 `expiresAt`。
 */
export const MONITOR_START_EVIDENCE = ["observed", "receipt-window"] as const;
export type MonitorStartEvidence = (typeof MONITOR_START_EVIDENCE)[number];

/**
 * 投影账本里「观察到了、还没确认落地」的那些事实 —— 对外契约。
 *
 * 这份投影的每一条事实都是**一次性**的（来源侧不会重发、游标读过就往前走），所以
 * 「没确认落地」必须是一个能看见、能继续推进的状态，而不是一行日志。判据与自动推进在
 * `server/src/claude-monitor-recovery.ts`，界面照 `MONITOR_RECOVERY_LABEL` 说人话。
 *
 * 为什么要让用户看见：面板为空有两种完全不同的含义——「这个任务确实没用过哨兵」和「还没
 * 读完，先给你看这些」。混成同一句话时，第二种会被当成第一种（而这正是整个功能的起点
 * 那一幕：面板说没有，agent 说在等 Monitor 通知）。
 */
export const MONITOR_RECOVERY_REASONS = [
  "scan-unfinished",  // 扫描没读到 EOF（单次字节上限）
  "scan-failed",      // 会话文件读失败
  "write-failed",     // 事实已消费，落库失败
  "update-missed",    // 条件更新 0 行（并发改了状态）
  "liveness-failed",  // 死活裁决失败（扫描读完了不等于纠正做完了）
  "orphan-overflow",  // 这一轮要裁决的迟到事实顶到单轮上限，剩下的分到后面几轮
  // 读过的事实既配不上内存状态、也配不上库里已提交的行，而这一轮的读取位置跳过了那段
  // 前缀（见 server/src/claude-monitor-commit.ts 的「检查点的两半」）。不许当成读完了：
  // 回到一个确定可重放的位置重读一遍。
  "checkpoint-incomplete",
  // 文件末尾有半行(没有换行符)。多半是正在被追加,下一轮就完整了;但**已经结束的文件**里
  // 这半行是永久的,而它可能正是最后一条完成通知。不许当成读完了:留账、按退避再读。
  "tail-incomplete",
  // 有一条记录比单次读取窗口还长,已经整条跳过(见 claude-monitor-read.ts)。那一条里要是
  // 带着 Monitor 的入参或回执,这一轮的事实就是缺的——缺口要说出来,不能静悄悄销账。
  "record-skipped",
  // 库的持久身份键还没核验成当代形状(换键的迁移失败了,见 server/src/db/schema-readiness.ts)。
  // 事实照常读、照常显示,但「这一段读完了」不许落盘——旧键会吞掉同号不同来源的调用。
  "schema-unready",
] as const;
export type MonitorRecoveryReason = (typeof MONITOR_RECOVERY_REASONS)[number];

export const MONITOR_RECOVERY_LABEL: Record<MonitorRecoveryReason, string> = {
  "scan-unfinished": "还有历史没读完",
  "scan-failed": "有会话文件读失败",
  "write-failed": "有记录没写进库",
  "update-missed": "有状态更新被并发改动挡下",
  "liveness-failed": "有存活状态没核对完",
  "orphan-overflow": "迟到的事实较多，正在分批补",
  "checkpoint-incomplete": "有回执还配不上，正在回头重读",
  "tail-incomplete": "最后一行还没写完，稍后再读",
  "record-skipped": "有一条记录过长已跳过，事实可能不全",
  "schema-unready": "数据库还没升级完，进度先不记",
};

export type MonitorRecovery = {
  /**
   * 还有没确认落地的事实。
   *
   * **注意第三态**：前端拿不到这份状态时（暂态读失败）既不是 true 也不是 false，而是
   * 「不知道」——把它当 false 就又把「未确认」说成了「没有」。那一档在前端用 `null`
   * 表示（见 web/src/monitors/useTaskMonitors.ts 的 recovery）。
   */
  pending: boolean;
  reasons: MonitorRecoveryReason[];
  /** 已经自动重试了几次。 */
  attempts: number;
  /** 退避预算用完了：定时器停了，等下一次真实请求再推。 */
  exhausted: boolean;
};

/**
 * 这个字符串是不是**已知的那两档来源**。白名单判定，不是 `!= null`——库里存着别的字符串
 * 时那是脏数据。
 *
 * **注意它只回答「这个锚点是哪来的」，不回答「它准不准」。** 判「准不准」要用
 * {@link monitorStartTrusted}：那需要一个能重验的误差界，而这个字符串给不出来（第 7 轮
 * 审查：旧实时投影把队列延迟后的落库时刻也写成 `observed`，实测偏 2205ms，而光看字符串
 * 分不出它和新代码写的那种）。
 */
export const isMonitorStartEvidence = (value: unknown): value is MonitorStartEvidence =>
  MONITOR_START_EVIDENCE.includes(value as MonitorStartEvidence);

/**
 * 起点区间宽到什么程度就不能忽略。
 *
 * 规则：`max(1 秒, 期限 × 1%)`。两条都要——
 * - 绝对下限 1 秒：实测真实区间 22~59ms，1 秒已经很宽松，够吸收正常的调度抖动。
 * - 相对 1%：60 分钟的哨兵差几秒无感，拿 1 秒的绝对尺子去卡它过于严苛。
 *
 * 判据写在 shared 是因为**实时和历史必须用同一把尺子**（审查的要求）。
 */
export const startAnchorTolerance = (timeoutMs: number | null): number =>
  Math.max(1_000, Math.round((timeoutMs ?? 0) * 0.01));

/**
 * 这一行的**起点算不算可信** —— 全系统唯一的判据。
 *
 * 要两样东西，缺一不可：
 * - **来源档位**（`start_evidence`）：这个锚点是实时看着事件到达取的，还是从历史区间裁的。
 * - **误差界**（`start_anchor_width_ms`）：那个锚点离真实起点最远可能差多少毫秒。
 *
 * 为什么光有档位不够：那是一个**结论字符串**，存进去之后谁也无法重验。第 6 轮之前的实时
 * 投影在写库队列积压 2.2 秒之后才取时刻，照样标 `observed`——第 6 轮把取点提前了，但库里
 * 已经躺着的那些旧行还是同一个字符串，于是「修好了新写入、修不到旧数据」（第 7 轮审查用
 * 第 6 轮真实注入得到的旧行形状复现：对外到期时刻仍晚 2205ms）。
 *
 * 改成「档位 + 误差界」之后两类自动分开，不需要拿版本号去猜，也不需要每次启动无区别地把
 * 正确的观测一起清掉：
 * - 新代码写的行一律带宽度（实时是 `[来源时刻, 到达时刻]`，历史是 `[tool_use, 回执]`），
 *   宽度在容差内就照常给精确时刻；
 * - 旧行这一列是 `null`——**没有误差界 = 无法重验 = 不可信**，于是只报时长。
 * - ash 自己起的哨兵宽度是 0（进程就是它 spawn 的，起点没有不确定性），一条不受影响。
 *
 * 容差随时长放宽（见 {@link startAnchorTolerance}），所以同一行在拿到真实时长之后可能从
 * 「不可信」升级成「可信」——判定放在**读的时候**算，就不必在写入侧为此留一张内存表。
 */
export function monitorStartTrusted(row: {
  startEvidence: string | null;
  startAnchorWidthMs: number | null;
  timeoutMs: number | null;
}): boolean {
  if (!isMonitorStartEvidence(row.startEvidence)) return false;
  const width = row.startAnchorWidthMs;
  if (width === null || !Number.isFinite(width) || width < 0) return false;
  return width <= startAnchorTolerance(row.timeoutMs);
}

/**
 * 一条投影行能不能给出**精确到期时刻** —— 全系统唯一的出口。
 *
 * 不变量：**对外有精确到期时刻 ⇔ 生效时长和起点各有自己的可信证据，而且这个值确实是由
 * 这两样算出来的。**
 *
 * 为什么必须「算」而不是「读那一列」：`expires_at` 在库里是 `NOT NULL`，所以期限还不知道
 * 的那些行只能先存一个**占位值**（`started_at`）。只要对外这一步是「读列 + 几个开关判断」，
 * 任何一条忘了同步的路径都会把占位值当成真到期时刻漏出去——第 6 轮审查实测到两条：
 *
 * - **升级前写的行**：时长由回执证明过（`lifetime_evidence='receipt'`），但起点用的是回执
 *   时刻，比真实起点晚了整整一分钟，而旧判据凭「时长可信」就把它放出去了（误差 60 秒）。
 * - **期限从 unknown 升级那一刻**：时长刚补上、`expires_at` 还是占位值，于是卡片上画出
 *   「开始即到期」（实测跨度 0ms，本该是 90 秒）。
 *
 * 改成现算之后这两类都不可能发生：少任何一半证据就只报时长（`timeoutMs`），卡片说「总共
 * 盯 X（起点不确定）」；两半都在时算出来的值一定自洽。占位列从此只是 ash 自己那半的
 * 内部计时依据（`monitors.ts` 的到期定时器），再也不是对外契约的一部分。
 *
 * 「起点有证据」这一半由 {@link monitorStartTrusted} 判——它要的是**可重验的误差界**，不是
 * 一个结论字符串（第 7 轮审查：旧行的 `observed` 无法重验）。
 */
export function monitorExactExpiry(row: {
  sourceLifetime: string | null;
  startEvidence: string | null;
  startAnchorWidthMs: number | null;
  startedAt: string;
  timeoutMs: number | null;
}): string | null {
  // 持续监听与未知期限本来就没有「到期时刻」可言；空串/null 是升级前的存量值，同样不算。
  if (row.sourceLifetime !== "bounded") return null;
  if (row.timeoutMs === null || !Number.isFinite(row.timeoutMs) || row.timeoutMs <= 0) return null;
  // 起点要「来源档位 + 可重验的误差界」都在，且误差在容差之内。
  if (!monitorStartTrusted(row)) return null;
  const started = Date.parse(row.startedAt);
  if (!Number.isFinite(started)) return null;
  return new Date(started + row.timeoutMs).toISOString();
}

/**
 * 来源侧那个原生后台任务 id 的作用域契约 —— **解析时按会话分区，落库按任务去重**。
 *
 * 两层不同，所以分别说清楚（上一版只声明了 `per-cli-session`，而持久层的唯一索引、回填的
 * existing 表、查行都是按 `(task_id, native_id)`，声明和实现不一致；第 5 轮审查列为不拦项）：
 *
 * - **解析层按会话 + 来源分区**（`per-cli-session`）：`pending`/`byToolUse` 的键来自来源事件，
 *   不同 ash 会话各自一套；而一条 ash 会话跨好几个 run 文件，所以桶里还按**来源**（CLI 会话
 *   号，认不出来时是那个 run 文件）再分一层 —— 不同来源的同号调用各占一条，不互相覆盖
 *   （判据在 server/src/claude-monitor-identity.ts，未决调用的落盘键同一维）。
 * - **持久层按任务 + 来源去重**（`per-task`）：唯一索引
 *   `(task_id, COALESCE(cli_session_id,'run:'||source_run), native_id)`。原先是
 *   `(task_id, native_id)`，它的前提是同一个 ash 任务里来源 id 不撞 —— 那一点**实测成立但
 *   不是来源侧的承诺**：2026-10-14 扫过本机全部 `agent-out.jsonl`，1017 条 `task_started` 里
 *   `local_bash` 的 id 形如 `b` + 8 位随机 base36（`blu5n05kp`），跨会话重复 0 个；但来源侧
 *   只承诺会话内唯一，所以现在来源那一维进了键（第 13 轮审查 N1）。
 *
 * 反例记一笔：`local_agent` 那种（`a` 前缀，子代理）同一个 id 出现过两次、挂在两个不同的
 * `tool_use_id` 上。我们只认 Monitor 起的 `local_bash`，碰不到它——但它正好说明「来源 id 全局
 * 唯一」不能当普适假设，这也是解析层坚持按会话分区的理由。
 *
 * 这也是为什么**不能拿「号撞了」当成「是同一条」**：持久事实（卡片、调用入参）一旦按更粗的
 * 身份合并或销账，丢掉的东西没有任何重建路径。
 */
export const NATIVE_MONITOR_ID_PARSE_SCOPE = "per-cli-session" as const;
export const NATIVE_MONITOR_ID_PERSIST_SCOPE = "per-task" as const;
/** @deprecated 用上面两个分别说清解析层和持久层——它们的作用域本来就不同。 */
export const NATIVE_MONITOR_ID_SCOPE = "per-cli-session" as const;

/**
 * 这一行当前的状态，**能不能被来源侧后到的事实改写**。
 *
 * 投影里的状态有两种出身，优先级不对等：
 * - **来源事实**：`stopped` / `exited` / `expired` 都是来源侧的 `task_notification` 说出来
 *   的。它们不该被改写——流被重放、resume 后 CLI 重发，都不该把已成定局的结局翻过来。
 * - **ash 推断**：`lost` 是**我们猜的**（流断了、ash 重启后判来源进程已不在）。猜错很正常：
 *   agent 活得过 ash 重启，一次误判之后来源侧可能照常送来 `completed`。
 *
 * 所以 `lost` 必须对纠正开放。原来 `close` 只认 `running`，于是「先被误判 lost、来源后来报
 * 完成」的那条路上，错误被永久固化（第 3 轮审查实测：来源还活着的卡片写着 lost，真 completed
 * 到了仍是 lost）。`running` 当然也开放——那是还没有结局。
 */
export const monitorStatusCorrectable = (status: string): boolean =>
  status === "running" || status === "lost";

/**
 * 旧后端发来的 DTO 归一：`kind` 这一列是跟着「两种来源」一起加的,之前的 ash 哨兵没有它。
 *
 * 为什么要在入口补:下面两个能力判据都写的 `=== "ash"`,字段缺失时两个都是 false ——
 * **本来能停、能看日志的那张卡会变成只读且没有输出入口**(第 12/13 轮审查 N5)。前端先更新、
 * 后端还没更新的那段混合部署里只会出这一种 DTO:旧后端只有 ash 哨兵,所以缺省补 "ash" 是
 * 确定的,不是猜。恢复端点那边已有 404 兼容,这份 DTO 的同类兼容就在这里。
 */
export const normalizeMonitorDto = <T extends { kind?: MonitorKind }>(row: T): T =>
  (row.kind ? row : { ...row, kind: "ash" as const });

/** 能不能从 ash 这边停掉它。`claude` 那种的进程在 agent 进程树里，ash 够不着。 */
export const canStopMonitor = (kind: MonitorKind) => kind === "ash";
/** 有没有日志文件可以回看尾巴。只有 ash 自己起的才有。 */
export const hasMonitorLog = (kind: MonitorKind) => kind === "ash";

export interface TaskMonitor {
  id: string;
  taskId: string;
  /** 出身。读这份结构的任何一处都要先看它——两种的能力不对等。 */
  kind: MonitorKind;
  /**
   * 来源侧的原生 id（`claude` 那种是 claude 的后台任务 id，形如 `b69ym4qzv`）。
   * `ash` 那种恒为 null：它的 `id` 就是唯一那一个。
   */
  nativeId: string | null;
  /** 盯到什么时候：有限期 / 持续 / 还不知道。见 {@link MonitorLifetime}。 */
  lifetime: MonitorLifetime;
  /** 原样交给用户 shell 执行的命令行。 */
  command: string;
  /** 一句话说明，会出现在每条事件的抬头和界面上。 */
  description: string;
  /**
   * **起它的那条会话是谁**（`single`=执行者 / `reviewer`=审查者）；null = 认不出来或存量行。
   *
   * 界面要用它分辨「这是审查者在等一件事」还是「执行者在等」—— 同样一条「在等哨兵」，
   * 落在哪条会话上决定了醒来之后会发生什么（续审查 vs 续实现）。投递侧用的是库里那一列
   * （`monitors.source_role` → `scheduled_messages.session_role`），这里只是把它说给用户听。
   */
  sourceRole: "single" | "reviewer" | null;
  cwd: string;
  status: MonitorStatus;
  /** 进程组组长的 pid；重启后靠 pid + 启动时刻一起认人（pid 会被复用）。 */
  pid: number | null;
  /** 已推送出去的事件（行）条数。 */
  events: number;
  /** 命令自己退出时的退出码；跨 server 重启接回来的那种拿不到，记 null。 */
  exitCode: number | null;
  startedAt: string;
  /**
   * 到期时刻。**只有「期限有限」且「起点有依据」时才非空**。
   *
   * 持续监听没有到期时刻；期限未知时编一个出来就是假的；而「知道盯多久、但不知道从哪一刻
   * 起算」这第三种情况同样不能给——那会让卡片上的「盯到 X」跟着 PostToolUse hooks 的耗时
   * 漂移（见 {@link MonitorStartEvidence}）。这种情况下 `timeoutMs` 仍然有值，界面改说时长。
   */
  expiresAt: string | null;
  /**
   * 来源确认的**时长**（毫秒），与起点无关。
   *
   * 存在它是为了表达「知道盯多久，但起点不确定」：这时 `expiresAt` 为 null 而这一列有值，
   * 界面说「时长 90 秒」而不是编一个时刻。`persistent`/`unknown` 恒为 null。
   */
  timeoutMs: number | null;
  endedAt: string | null;
  endedReason: string | null;
}

/** 还在盯着的那几种状态。 */
export function isMonitorLive(status: MonitorStatus): boolean {
  return status === "running";
}

/**
 * 时长：**与 claude 内置 `Monitor` 对齐**（用户 2026-10-14 指定）。
 *
 * 两种哨兵并排显示在同一个面板里，时长语义就不该各说各话——一个缺省 2 小时、另一个缺省
 * 5 分钟，用户看两张卡上的「还剩多久」会得出互相矛盾的预期。
 *
 * ── 对齐到哪一层：claude 的上限是**两层**，这里对齐的是 schema 那层 ──────────────
 *
 * 本机 claude 2.1.283 的 Monitor 常量原文：
 *
 * ```js
 * var Bat=300000, QHt=3600000, o=1800000, r=600000;
 * function xLe(){ return PUe() ? r : o }                      // 运行时软钳
 * timeout_ms: C().min(1000).max(QHt, `timeout_ms must be ≤ ${QHt}`).optional().default(Bat)
 * ```
 *
 * - **schema 硬上限 `QHt` = 60 分钟**：超过它参数校验直接报错，这个工具**接受**的最大值。
 *   静态常量，不随账号变。
 * - **运行时软钳 `xLe()` = 10 或 30 分钟**：由 `PUe()` 这个 feature flag 决定哪一档，
 *   在 `Math.min(请求值, xLe())` 里生效。**因账号而异**，而且来源侧钳完会在回执里如实说。
 *
 * 对齐取前者。取软钳是错的（前两轮我取了 30 分钟 = `o` 那一档，第 3 轮审查三次指出）：
 * 那个值跟着别人的 feature flag 变，ash 这边没有可靠的探测手段，拿它当自己的硬边界等于
 * 把一个猜测写进契约。「claude 支持多长」问的是它**肯接受**多长，那就是 60 分钟。
 *
 * 软钳不跟还有一层理由：ash 哨兵的进程不在 agent 进程树里，本来就撑得住，钳不钳是来源侧
 * 的服务端策略，不是能力边界。来源侧真钳了，`parseMonitorStartReceipt` 会从回执里读到生效
 * 值，投影卡显示的仍是事实——两种卡的读数照样能相互比较。
 *
 * 取舍仍要说清：ash 哨兵原本能盯 24 小时，对齐之后缩到 60 分钟，更长的活得靠「到期续挂」。
 * 要改回去只动下面这三个常量。
 *
 * 下限同样对齐到 1 秒（`min(1000)`）。一开始留的 60 秒是「ash 要 spawn 进程 + 起 tail，
 * 1 秒的哨兵没意义」——但那是**建议**不是**边界**，拿它当硬下限会让 ash 连「claude 挂得
 * 出来的那种哨兵」都挂不了，而用户要的就是两边能力一致。
 */
export const MONITOR_DEFAULT_TIMEOUT_MS = 5 * 60_000;
export const MONITOR_MIN_TIMEOUT_MS = 1_000;
export const MONITOR_MAX_TIMEOUT_MS = 60 * 60_000;

/**
 * 手动表单的时长选项。**从上面那几个常量推导，不另列一张硬编码表**。
 *
 * 这是一处类问题的根因：原来那张表把「2 小时 / 8 小时 / 24 小时」写死在前端，常量一改就
 * 整张表失真——用户选「2 小时」实际只盯 5 分钟，而且因为提交值恰好等于缺省值，连「已钳到
 * 边界」的回执都不会有，完全无从察觉（第 1 轮审查实测三个选项错两个、第三个靠巧合对上）。
 * 推导出来之后，改上面的常量这里自动跟着走。
 *
 * 取值规则：缺省必须在列、上限必须在列，中间按常用档位取那些落在 [min, max] 区间内的。
 */
export function monitorDurationOptions(): { label: string; ms: number }[] {
  const label = (ms: number): string => {
    if (ms % 3_600_000 === 0) return `${ms / 3_600_000} 小时`;
    if (ms % 60_000 === 0) return `${ms / 60_000} 分钟`;
    return `${Math.round(ms / 1000)} 秒`;
  };
  const candidates = [
    60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000,
    60 * 60_000, 2 * 60 * 60_000, 8 * 60 * 60_000, 24 * 60 * 60_000,
    MONITOR_DEFAULT_TIMEOUT_MS, MONITOR_MAX_TIMEOUT_MS,
  ];
  const seen = new Set<number>();
  return candidates
    .filter((ms) => ms >= MONITOR_MIN_TIMEOUT_MS && ms <= MONITOR_MAX_TIMEOUT_MS)
    .filter((ms) => (seen.has(ms) ? false : (seen.add(ms), true)))
    .sort((a, b) => a - b)
    .map((ms) => ({ label: label(ms), ms }));
}

/** 攒多久算一批。tail 轮询本身就是这个量级，再大就拖慢「有事马上知道」的手感。 */
export const MONITOR_BATCH_MS = 300;
/** 单批最多列多少行，超出的只报条数——一次刷屏不该把整个回合的上下文吃光。 */
export const MONITOR_MAX_LINES_PER_PUSH = 40;
/** 单行最长字符数，超了截断。 */
export const MONITOR_MAX_LINE_CHARS = 2000;
/** 一个哨兵总共最多推多少条事件，到顶自动停——这是花钱的闸，不是防御性冗余。 */
export const MONITOR_MAX_EVENTS = 200;
/** 一个任务同时最多挂几个哨兵。 */
export const MONITOR_MAX_PER_TASK = 4;

/** 面板上回看哨兵输出的尾巴：默认多少行、最多多少行、以及回读多少字节封顶。 */
export const MONITOR_TAIL_DEFAULT_LINES = 80;
export const MONITOR_TAIL_MAX_LINES = 500;
export const MONITOR_TAIL_MAX_BYTES = 256 * 1024;

export function normalizeMonitorTimeout(ms: unknown): number {
  const n = typeof ms === "number" && Number.isFinite(ms) ? Math.round(ms) : MONITOR_DEFAULT_TIMEOUT_MS;
  return Math.min(MONITOR_MAX_TIMEOUT_MS, Math.max(MONITOR_MIN_TIMEOUT_MS, n));
}

/**
 * 合并进同一条待发送消息的正文上限。任务忙上几个钟头时，攒下的事件会一直往同一行后面
 * 追加；不封顶的话，它醒来读到的第一样东西就是一份几十万字的流水账，把整轮上下文吃光。
 * 超了从**最早的那头**丢，并如实说明丢了多少——刚发生的才是它醒来要处理的那件事。
 */
export const MONITOR_MAX_MERGED_CHARS = 20_000;

export function mergeMonitorEventText(existing: string, incoming: string): string {
  const merged = existing ? `${existing}\n\n${incoming}` : incoming;
  if (merged.length <= MONITOR_MAX_MERGED_CHARS) return merged;
  // 永远保住最新这一段：它比任何历史都重要，哪怕它自己就超了上限（此时前面不留历史）。
  const room = Math.max(0, MONITOR_MAX_MERGED_CHARS - incoming.length);
  const kept = room > 0 ? merged.slice(merged.length - incoming.length - room, merged.length - incoming.length) : "";
  const dropped = merged.length - kept.length - incoming.length;
  return `（更早的 ${dropped} 个字符已略去，完整输出在哨兵的日志文件里）\n${kept}${kept ? "\n\n" : ""}${incoming}`;
}

/**
 * 「这个任务现在能不能挂哨兵」——**创建入口与投递出口共用的那一份判据**。
 *
 * 两边不同源就会长出这样一个洞：界面允许在一个已完成的任务上起哨兵，命令真的跑起来、
 * 卡片上事件数还在涨，而投递那一侧按终态把每一条都拒了，任务永远不醒（第 2 轮审查实测：
 * 待发送消息数 0、任务一直 done，用户只会以为通知已经处理过了）。所以判据只留这一份，
 * server 的 `startMonitor` 和界面的「+」按钮都读它。
 *
 * 终态的那三种和归档分开说：归档是「这个任务收进柜子了」，终态是「它跑完了」——后者
 * 重新跑起来就又能挂，措辞得给出这条出路。
 *
 * ── `activeReview`：任务跑完了，但**审查这件事还没完** ────────────────────────
 *
 * 自由工作流的审查是在一个**已经 done 的任务**上跑的旁路回合（终态原样不动）。所以光看
 * `status` 的话，审查者连一个哨兵都挂不上：它要等的那件事（跑一遍全量测试）恰恰是最需要
 * 哨兵的那种。实测后果是它退而求其次用了 claude 内置的 `Monitor`——那个活不过这一回合，
 * 于是说完「套件结束会叫我」就再也没有下文（Bp2LkwfRO37A 第 2 轮审查）。
 *
 * 判据给的是「有没有一条正在进行的审查」，而不是「这一刻是不是审查回合」：哨兵的事件要在
 * **下一个**回合才送达，那时审查者已经 pause 住了、没有任何回合在跑——按后者判会在最关键
 * 的那一刻拒掉它。归档不吃这条豁免：那是「收进柜子了」，跟做没做完无关。
 */
const MONITOR_BLOCKING_STATUSES = new Set(["done", "failed", "canceled"]);

/**
 * 「这个任务现在能不能挂哨兵 / 哨兵的事件还能不能唤醒它」——创建入口、事件出口、唤醒前
 * 最后一道闸共用这一份判据（三处分家就等于没防）。
 *
 * `activeReview` = 这个任务上有一条**正在进行**的审查。自由工作流的审查是旁路回合，跑在
 * 一个已经 done 的任务上，而它要等的那件事恰恰最需要哨兵；只看 status 的话审查者一个都挂
 * 不上（2026-10-16 实测：于是它退而求其次用了活不过这一回合的内置 Monitor）。服务端由
 * `monitorTaskGate` 在被状态拦下来时才查一次库填进来。**归档不吃这条豁免**：任务都被收走
 * 了，审查链也没有续下去的地方。
 */
export function monitorBlockedReason(
  task: { status: string; archived?: boolean | null },
  opts?: { activeReview?: boolean },
): string | null {
  if (task.archived) return "任务已归档，不能再挂哨兵";
  if (MONITOR_BLOCKING_STATUSES.has(task.status) && !opts?.activeReview)
    return "任务已经结束，哨兵的输出不会再唤醒它——要盯新的活，先让这个任务重新跑起来";
  return null;
}

/** 待发送消息上的来源标记（`scheduled_messages.origin`）。同一个哨兵的事件按它合并。 */
export const monitorMessageOrigin = (monitorId: string) => `monitor:${monitorId}`;
export const monitorIdFromOrigin = (origin: string | null | undefined): string | null =>
  origin?.startsWith("monitor:") ? origin.slice("monitor:".length) : null;

/**
 * claude 后台任务的状态 → 哨兵状态。
 *
 * claude 侧的取值来自 `system/task_notification` 的 `status`，实测见过 `completed`
 * （命令自己跑完）和 `stopped`（被 `TaskStop` 停掉）。拿不准的一律当 `exited` 收口而不是
 * 留在 `running`：面板上一个永远「正在盯着」的僵尸条目，比一个状态说得略粗的存档更误导人。
 */
export function claudeMonitorStatus(status: unknown): MonitorStatus {
  switch (String(status ?? "").toLowerCase()) {
    case "stopped":
    case "canceled":
    case "cancelled":
    case "killed":
      return "stopped";
    case "timeout":
    case "timed_out":
    case "expired":
      return "expired";
    case "running":
    case "in_progress":
    case "pending":
      return "running";
    default:
      return "exited";
  }
}

/** claude 内置 Monitor 的结束原因文案，按状态给。 */
export const CLAUDE_MONITOR_ENDED_REASON: Partial<Record<MonitorStatus, string>> = {
  exited: "命令自己跑完了（claude 侧报的完成）",
  // **不能只写 TaskStop**：实测绝大多数 `stopped` 根本不是智能体主动停的，而是那一轮回合
  // 结束时被 CLI 成批收走的（见 CLAUDE_MONITOR_REAPED_REASON 那段实测记录）。只说 TaskStop
  // 会让用户以为「它自己决定不等了」，而真相是「它还在等，但已经没命等了」。
  stopped: "claude 那边把它停了——要么智能体 TaskStop，要么那一轮回合结束时一并收走",
  expired: "盯满了 claude 侧约定的时长",
  lost: "agent 进程已经不在了，它跟着一起没了",
};

/**
 * 来源侧**补报孤儿**时的原话。claude 2.1.283 在新进程启动时，会对上一代进程遗留的后台
 * 任务成批补报一次 `stopped`，summary 固定是这一句（实测原文）：
 *
 * ```
 * Orphaned by a previous Claude Code process exit and reported in an aggregate summary.
 * ```
 *
 * 这是来源侧唯一一处**明说**「它是被进程退出收走的、不是等到了」的地方，所以单独认。
 */
const CLAUDE_ORPHAN_SUMMARY_RE = /orphaned by a previous claude code process exit/i;

/**
 * 「随回合结束被收走」——内置 Monitor 最常见、也最容易被误读的那个结局。
 *
 * 实测的因果链（Bp2LkwfRO37A 第 2 轮审查，run 文件原始行序）：
 *
 * ```
 * system task_started      ← 智能体挂上监听
 * assistant "监听已挂上，套件结束会叫我。"
 * result   success         ← 回合结束
 * system task_notification status=stopped   ← 紧接着就被收走，summary 原样是那条描述
 * ```
 *
 * 也就是说那句「套件结束会叫我」在说出口的那一刻就已经不成立了：内置 Monitor 的进程在
 * 智能体自己的进程树里，回合一结束 CLI 就把名下的后台任务成批收走，它盯的那件事还在跑。
 * 卡片若只写「已停止」，用户读到的是「等到了然后停了」——**意思正好相反**。
 */
export const CLAUDE_MONITOR_REAPED_REASON =
  "随那一轮智能体进程退出被一并收走——不是等到了，它盯的那件事当时还没有结果";

/**
 * 一条内置 Monitor 终态该对外说的那句话。
 *
 * 三条来源侧的 summary，三种处理：
 * - 孤儿补报那句英文原话 → 翻成上面那句，这是**明示**的「被收走」。
 * - 跟描述一字不差 → 不复读。CLI 在回合收尾成批停止时，summary 填的就是那条描述本身，
 *   于是卡片会变成「已停止 / 等待全量 unittest 跑完」——两行都没说出发生了什么。
 * - 其余 → 原样转述，那是来源侧真正多说的话。
 */
export function claudeMonitorEndedReason(
  status: MonitorStatus,
  summary: string | null | undefined,
  description: string | null | undefined,
): string | null {
  const text = (summary ?? "").trim();
  if (CLAUDE_ORPHAN_SUMMARY_RE.test(text)) return CLAUDE_MONITOR_REAPED_REASON;
  const byStatus = CLAUDE_MONITOR_ENDED_REASON[status] ?? null;
  if (!text || text === (description ?? "").trim()) return byStatus;
  return text;
}

/**
 * **来源侧**报的时长 → 投影的有效期。
 *
 * 和 `normalizeMonitorTimeout` 的区别是这份代码里最容易搞错的一处：那一个是「ash 自己要
 * 起一个哨兵，允许多久」——是一条**创建策略**；这一个是「claude 那边说它要盯多久」——是
 * 一条**既成事实**。拿创建策略去钳来源事实，卡片上就会显示一个与来源侧不符的到期时刻
 * （claude 盯 5 秒，ash 按自己的下限写成 60 秒后到期）。投影的职责是如实转述，不是裁决。
 *
 * 所以这里只做「是不是个正数」这一道校验，不钳到 ash 的区间里。拿不到就返回 null，由调用
 * 方决定怎么表示「来源没说」，而不是替它编一个。
 */
export function sourceMonitorTimeout(ms: unknown): number | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  return Math.round(ms);
}
