// 哨兵的**上限与时长**:攒多久算一批、一批吃多少行、单行多长、一个哨兵总共推多少条事件、
// 盯多久、回看多少、合并正文多长。
//
// 从 monitor.ts 拆出来的（全局约定:单文件不超过 700 行），那边原样转发，调用点不用改。
// 语义、来历、以及「这是花钱的闸而不是防御性冗余」那些取舍都留在各自的注释里。
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
/**
 * 一批行没写成、放回缓冲之后隔多久再试（见 server 的 `returnToBuffer`）。
 *
 * 比批量窗口大一截：会让那一笔写失败的东西（库一瞬不可用、盘满）多半不会在 300ms 内好转，
 * 贴着窗口重试只是在同一个故障上空转；而它又必须远小于任何期限，因为**那一批行里可能正
 * 躺着结束条件要等的那一行**，重试太慢等于把「命中就收工」拖成「等到期」。
 */
export const MONITOR_RETRY_FLUSH_MS = 2_000;
/**
 * **一批最多吃多少行**。超出的留在缓冲里，下一批接着来（见 server 的 `flushBuffer`）。
 *
 * 这是个**上界**而不是调优参数（第 2 轮审查 F1）：一次 tail 回调能带回几万行（一条
 * 命令把大文件倒进 stdout 就是这个量级），而「一批」这个东西要被整体放回缓冲、整体渲染成
 * 一条消息、整体在失败时重放。没有上界时那几步各自按行数线性涨，而放回那一步上一版还是
 * 展开传参（`unshift(...lines)`）—— 18 万行就是一次 `RangeError`，连重试都排不上。
 */
export const MONITOR_MAX_LINES_PER_FLUSH = 2_000;
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
