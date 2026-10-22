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

// `matched` 是**第五种结束方式**,不是 `stopped` 的一个变种:它说的是「约定的那一行出现了,
// 这条哨兵就此收工」——人点停、推满上限、系统回收都叫 stopped,把这一种也塞进去,卡片上就会
// 写着「已停止」而真相是「它等到了」(四种结束方式不许说成同一种,第 4 轮审查 N1 同一条理由)。
export const MONITOR_STATUSES = ["running", "stopped", "expired", "exited", "matched", "lost"] as const;
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
 *
 * {@link TaskMonitor.startedAtExact} 的缺省方向**相反**:补 `false`。它不是「猜哪种更常见」
 * —— 旧后端根本答不出起点可不可信,而这一列的全部意义就是「答不出来时不许把那个时刻当成
 * 创建时刻说出口」。补 `true` 等于在混合部署的那段窗口里把这道闸整个关掉。
 */
export const normalizeMonitorDto = <T extends {
  kind?: MonitorKind; startedAtExact?: boolean; stopWhen?: string | null;
}>(row: T): T =>
  (row.kind && row.startedAtExact !== undefined && row.stopWhen !== undefined
    ? row
    : {
      ...row,
      kind: row.kind ?? ("ash" as const),
      startedAtExact: row.startedAtExact ?? false,
      // 老后端答不出这一列 ⇒ 没约定过,不是「有但读不出来」。
      stopWhen: row.stopWhen ?? null,
    });

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
  /**
   * **约定的结束条件**:哪一行一出现,这条哨兵就收工(`null` = 没约定过)。
   *
   * **不是正则**,是一串字面量候选:`|` 分隔、`^`/`$` 作行首行尾锚点,其余字符都当它本身,
   * 而正则元字符一律拒掉（为什么不是正则、为什么连「悄悄当字面量」都不行,见
   * shared/src/monitor-end-condition.ts 文件头 ①）。解析与措辞一律走那个模块,别在读取端
   * 自己拿 `new RegExp` 解释这一列。
   *
   * 它存在的理由是「命令自己永远不会结束」的那一类(`tail -F`、`while true`):那种命令只剩
   * 「盯满时长」一条出路,被盯的活早跑完了任务还得干等到期。创建闸因此要求这类命令必须二选一:
   * 给这个条件,或者显式声明「我本来就要盯到到期」(见 shared/src/monitor-end-condition.ts)。
   */
  stopWhen: string | null;
  /**
   * **结果还欠着**:结局已经写定、那条结束通知还没持久入队的那一瞬（`null` = 不欠）。
   *
   * 它是完成闸三类阻塞物里的第三类（server/src/task-complete-monitors.ts 文件头）。正常只闪
   * 一下就没了（入队紧跟其后），**入队那一笔失败时才会一直留着** —— 而那正是用户会撞上
   * 「完成被一条已经结束的哨兵堵住」的时刻。带出来是为了让界面给得出一个人点得到的出路
   * （第 2 轮审查 N3）:在这之前,这一类既不在待发送托盘里（还没入队）、也没有停止按钮
   * （卡片只给还在盯的那种渲染），只剩「调 stop_monitor」这一条，而人点不了 MCP 工具。
   */
  resultHandoffAt: string | null;
  /** 「它还没送到的结果我不要了」落下来的时刻（`null` = 没放弃过）。见 monitor-stop.ts。 */
  resultsAbandonedAt: string | null;
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
   * `startedAt` 这个时刻**算不算数**：false = 它只是个占位/边界值，**不许当成「这条哨兵是
   * 什么时候挂上的」说出口**。
   *
   * 为什么非得多这一列：`started_at` 在库里是 `NOT NULL`，而历史投影允许它退化 ——
   * `anchor.startedAt ?? startedAtLow ?? fileStartedAt ?? now()`（见
   * server/src/claude-monitor-commit.ts）。退到后两档时那个值仍然是一个**合法日期**，
   * 所以「能解析成日期就是真实时刻」这条判据一个字都挡不住它：第 1 轮审查用真实 backfill +
   * 真实 `listMonitors` 复现到的卡片，同一行上先写「起于 10/19 10:00」再写「总共盯 10 分钟
   * （起点不确定）」—— 前一个只是那一整轮执行开始的时刻，偏差可达该轮此前已经跑掉的时长。
   *
   * 判据与到期时刻那一半共用 {@link monitorStartTrusted}（档位 + 可重验的误差界）。
   *
   * **不能拿 `expiresAt === null` 代替它**：持续监听和期限未知本来就没有到期时刻，跟起点可不
   * 可信是两件独立的事 —— 一条 `persistent` 的哨兵完全可以有一个证据齐全的起点。
   */
  startedAtExact: boolean;
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
 * 上限与时长那一组（攒多久算一批、一批吃多少行、单行多长、一个哨兵总共推多少条、盯多久、
 * 回看多少、合并正文多长）搬到了 **monitor-limits.ts**（全局约定:单文件不超过 700 行）。
 *
 * 这里原样转发:十几个调用点都按「找 @ash/shared/monitor 要」在写，没必要为了一次拆分
 * 全都改一遍 import。（同级运行时转发在 shared 里必须写成 `./x.ts` —— Node 的类型擦除不会
 * 把 `./x.js` 映射回 `.ts`，见 server/CLAUDE.md 里那条。）
 */
export {
  MONITOR_DEFAULT_TIMEOUT_MS,
  MONITOR_MIN_TIMEOUT_MS,
  MONITOR_MAX_TIMEOUT_MS,
  monitorDurationOptions,
  MONITOR_BATCH_MS,
  MONITOR_RETRY_FLUSH_MS,
  MONITOR_MAX_LINES_PER_FLUSH,
  MONITOR_MAX_LINES_PER_PUSH,
  MONITOR_MAX_LINE_CHARS,
  MONITOR_MAX_EVENTS,
  MONITOR_MAX_PER_TASK,
  MONITOR_TAIL_DEFAULT_LINES,
  MONITOR_TAIL_MAX_LINES,
  MONITOR_TAIL_MAX_BYTES,
  normalizeMonitorTimeout,
  MONITOR_MAX_MERGED_CHARS,
  mergeMonitorEventText,
} from "./monitor-limits.ts";

/**
 * **哨兵醒来叫谁**:执行者那条会话(`single`),还是起它的那次审查(`reviewer`)。
 *
 * 两端共用一份:服务端据它判创建请求里显式指定的唤醒目标合不合法(`monitor-session.ts`),
 * 前端据它渲染「说不清叫谁」时那个二选一(`MonitorComposer`)。各写一份的话,前端能提交一个
 * 后端不认的值,而后端只会回一句「没说清」—— 用户看到的是一个点了没反应的选项。
 */
export type MonitorWakeTarget = "single" | "reviewer";
export const MONITOR_WAKE_TARGETS: readonly MonitorWakeTarget[] = ["single", "reviewer"];
/** 这两种在界面上怎么说。 */
export const MONITOR_WAKE_LABEL: Record<MonitorWakeTarget, string> = {
  single: "实现者",
  reviewer: "这次审查",
};

const MONITOR_BLOCKING_STATUSES = new Set(["done", "failed", "canceled"]);

/**
 * **落成这个状态 = 这个任务名下的哨兵会被一并收走**（服务端 `stopMonitorsForTask`）。
 *
 * 跟上面那两问同一个集合，刻意不另列一份：结算那一侧要判「我这一笔会不会毁掉哨兵」（见
 * `settle-status.ts` 的哨兵闸），而那恰恰是「哨兵还能不能唤醒它」的另一面。分开写两份，
 * 迟早出现「拦住了创建却照样把它收走」或者反过来（第 2 轮审查 R2-1：判据必须共用一份）。
 */
export function monitorSweepingStatus(status: string): boolean {
  return MONITOR_BLOCKING_STATUSES.has(status);
}

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
/**
 * **一笔结果交接的身份**:哪条哨兵的、哪一次凭证。写进承载它的那条消息
 * (`scheduled_messages.handoff_token`,跟入队同一笔落库),于是「这一笔送过没有」有一个原子的
 * 答案 —— 重投器据此不把同一条结束通知送成两条(第 2 轮审查 N1)。
 *
 * 用凭证时刻而不是哨兵 id 当后半截:同一条哨兵理论上可以先后有两笔交接(离线收尾补过一次),
 * 只按 id 去重会把第二笔当成已送过。
 */
export const handoffToken = (monitorId: string, handoffAt: string) => `${monitorId}:${handoffAt}`;
export const monitorIdFromOrigin = (origin: string | null | undefined): string | null =>
  origin?.startsWith("monitor:") ? origin.slice("monitor:".length) : null;
