// Token 用量的统一口径。各家 CLI 报的形状不一样(claude 把缓存读写单列、codex 把
// 缓存算在 input 里面),归一化成这一份再往下传,展示端就不必知道是谁跑的。
//
// 运行时函数住在这里而不是 index.ts:服务端直接跑 shared 的 .ts 源码,index 里
// 转发运行时值会让进程起不来(见 index.ts 顶部注释),所以照 team / executors
// 的办法开一个子路径导出 "@ash/shared/usage"。

import { claudeCompactTrigger } from "./cli-overrides.ts";

export interface TokenUsage {
  /** 未命中缓存的输入 token。 */
  input: number;
  /** 输出 token(含下面的 reasoning)。 */
  output: number;
  /** 命中缓存的输入 token —— 计费便宜一个数量级,但确实被读进了上下文。 */
  cacheRead: number;
  /** 写入缓存的输入 token。claude 单列;codex 不报,恒 0。 */
  cacheWrite: number;
  /** output 里属于思考过程的部分。codex 单列;claude 不单列,恒 0。仅供展示。 */
  reasoning: number;
  /** CLI 自己算出来的花费。只有 claude 报;拿不到就是 null(不是 0)。 */
  costUsd: number | null;
  /** 这份用量覆盖了几个回合:单轮恒 1,会话/任务累计是 n。 */
  turns: number;
  /**
   * 计上时的那几次模型请求:输出 token 之和、每次「请求发出 → 最后一个 token」的耗时之和。
   * 输出速度 = output / ms(见 outputRate)。
   *
   * 只有执行器在原始流里亲眼看见起止的请求才算进来(server/src/executors/request-timing.ts),
   * 所以这里的 output 可以小于上面那个 output;缺省 = 这一轮一次都没计上时(那家 CLI 不给
   * 起止、接管重放、本字段上线之前的旧账),不是「速度为 0」。它是逐回合实测的,**不进会话
   * 累计的库表**,只随回合的 usage 事件走。
   */
  timed?: OutputTiming;
}

export interface OutputTiming {
  output: number;
  ms: number;
}

/**
 * 一条 usage 事件的数字**是怎么来的**。判口径只许读这个标记,不许看数值形状 ——
 * 「整串不下降就是累计」这种形状判据会骗人:同一串历史,续聊一轮就能改变判定结果
 * (审查实测:第 2 个气泡从正确的 81.9 万弹回 1726 万)。
 *
 * - **缺省**:标记出现之前落盘的旧 trace。codex 的旧账是线程累计快照(读侧要先求差),
 *   claude 的旧账是「那一次进程内的用量」。
 * - `incremental`:执行器报的本来就是单轮值,原样入账。**claude 2026-09-28 口径修正
 *   之前的旧 trace 也全都标着这个**(当时的代码认为 claude 本来就是增量,归一是空操作),
 *   所以它只能说明「不是 codex 那种没标记的旧累计」,不足以证明「已按累计口径结算过」。
 * - `delta`:累计口径下**有可用基线**时的入账值。正常是跟上一份线程快照求差的结果;
 *   计数器重置(值变小)和「待建基线那一轮记 0」也归这里 —— 共同点是运行期已经按累计
 *   口径结算过,这一份就是账上该记的那一份,谁都不该再动它。
 * - `snapshot`:累计口径但**当时没有基线**,入账值等于这条线程此刻的**整份累计值**。
 *   新线程第一轮本该如此;但若这条线程在口径修正之前就有历史,它就是把整条线程又记了
 *   一遍 —— 历史回填凭这个标记(而不是凭数值大小)把它改回真实增量。
 */
export type UsageAccountingMark = "incremental" | "delta" | "snapshot";

export const EMPTY_USAGE: Readonly<TokenUsage> = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  costUsd: null,
  turns: 0,
});

/** 累计口径:token 直接相加;费用只有两边都拿不到时才是 null(否则按已知的那部分求和)。 */
export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: a.reasoning + b.reasoning,
    costUsd: a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0),
    turns: a.turns + b.turns,
    ...(a.timed || b.timed ? { timed: addTiming(a.timed, b.timed) } : {}),
  };
}

function addTiming(a: OutputTiming | undefined, b: OutputTiming | undefined): OutputTiming {
  return { output: (a?.output ?? 0) + (b?.output ?? 0), ms: (a?.ms ?? 0) + (b?.ms ?? 0) };
}

/** 每秒输出多少 token;没计上时就是 null。 */
export function outputRate(u: TokenUsage | null | undefined): number | null {
  const timed = u?.timed;
  return timed && timed.output > 0 && timed.ms > 0 ? (timed.output * 1000) / timed.ms : null;
}

export function sumUsage(items: Iterable<TokenUsage | null | undefined>): TokenUsage | null {
  let total: TokenUsage | null = null;
  for (const item of items) {
    if (!item) continue;
    total = total ? addUsage(total, item) : item;
  }
  return total;
}

/**
 * 一份 usage 负载长得对不对。
 *
 * **落盘的 trace 是外部输入**：文件可能被写坏、被截断，而读端拿它直接做加法 ——
 * 缺字段算出来是 NaN，界面只会静默不显示本轮用量，没人知道那份数据已经坏了
 * （第 6 轮审查）。所以读进来之前就验到字段层，坏行由调用方判成读取失败。
 *
 * 计数字段一律要求**非负整数**（`EMPTY_USAGE` 的 `turns: 0` 也在其内）：正式库里
 * 2740 条 usage 全部如此，没有需要兼容的空对象或缺字段旧格式。`costUsd` 是 null
 * 或非负有限小数（实测 0 ~ 88.09）。
 */
export function isTokenUsage(value: unknown): value is TokenUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  const counted = (field: string): boolean => Number.isInteger(usage[field]) && (usage[field] as number) >= 0;
  if (!["input", "output", "cacheRead", "cacheWrite", "reasoning", "turns"].every(counted)) return false;
  if (usage.timed !== undefined && !isOutputTiming(usage.timed)) return false;
  return usage.costUsd === null
    || (typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) && usage.costUsd >= 0);
}

function isOutputTiming(value: unknown): value is OutputTiming {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { output, ms } = value as Record<string, unknown>;
  return Number.isInteger(output) && (output as number) >= 0
    && typeof ms === "number" && Number.isFinite(ms) && ms >= 0;
}

/** 认不出的 accounting 值一律按坏行丢掉 —— 判别联合加一支,这里就得跟着加一支。 */
export function isUsageAccountingMark(value: unknown): value is UsageAccountingMark {
  return value === "incremental" || value === "delta" || value === "snapshot";
}

/**
 * 「这一轮吃了多少 token」的那个数:**所有**进出模型的 token,缓存读也算。
 *
 * 缓存读便宜十倍但它确实被读进了上下文,漏掉它会让长会话看着像没花钱;费用另有
 * costUsd 一路,不必靠这个数去暗示价格。
 */
export function usageTotal(u: TokenUsage): number {
  return u.input + u.cacheRead + u.cacheWrite + u.output;
}

/** 有没有真数字。全 0 的用量(解析到了但都是空)不值得占一块界面。 */
export function hasUsage(u: TokenUsage | null | undefined): u is TokenUsage {
  return !!u && usageTotal(u) > 0;
}

/**
 * 1234 → "1,234";12345 → "12.3k";1234567 → "1.23M";1234567890 → "1.23B"。给一眼扫的场合用:
 * 一万以下照写,往上收成 k / M / B。舍入后够到下一档就进位(999,960 写 "1.00M",不写 "1000.0k")。
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 10_000) return Math.round(n).toLocaleString("en-US");
  const tiers = [
    { unit: "k", size: 1_000, digits: 1 },
    { unit: "M", size: 1_000_000, digits: 2 },
    { unit: "B", size: 1_000_000_000, digits: 2 },
  ];
  for (const [index, tier] of tiers.entries()) {
    const text = (n / tier.size).toFixed(tier.digits);
    if (Number(text) < 1_000 || index === tiers.length - 1) return `${text}${tier.unit}`;
  }
  return "0";
}

/** 精确值,给明细/无障碍标签用。 */
export function formatTokensExact(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/**
 * 费用。**界面上目前一处都不显示**（用户 2026-08-07：只看 token，不看钱）——
 * 账还照记（claude 的 result 行自带 total_cost_usd，白来的），以后要看时不用回头补采集。
 * 想显示的话记得：codex 不报价，null 得显示成「未知」而不是 $0。
 */
export function formatCost(usd: number | null): string | null {
  if (usd === null || !Number.isFinite(usd)) return null;
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

// ── 上下文水位 ───────────────────────────────────────────────────────────────
//
// **跟上面的 TokenUsage 是两个概念,别混成一个数**:
//
//   · TokenUsage 是**流水**——一轮里每次 API 调用的 token 全加起来,会话累计更是所有
//     轮次相加。长会话动辄几千万,因为缓存读每次调用都重算一遍。它可加(addUsage)。
//   · ContextUsage 是**水位**——最近一次 API 调用带进模型的输入有多大,也就是此刻上下
//     文窗口里装了多少。它**不可加,只能覆盖**。
//
// 一条流水 18.53M 的会话,水位可能才 12 万。拿流水去除以窗口会得出「早就爆了 90 倍」
// 这种荒谬结论 —— 这就是必须分成两个类型的原因,别图省事把 used 塞进 TokenUsage。

export interface ContextUsage {
  /** 最近一次 API 调用的输入 token(含缓存命中的那部分)= 此刻上下文水位。 */
  used: number;
  /** 上下文窗口。CLI 自报的优先;没人报就按模型名估;估不出是 null。 */
  window: number | null;
  /**
   * 执行器显式设置的自动压缩窗口。它不改变模型能力上限，但决定任务页上真正有意义的
   * “还剩多少”——达到这里就会开始压缩，所以显示比例和告警优先用它。
   */
  compactWindow?: number;
  /** 同一份启动快照里的压缩百分比与输出预留,见 CompactSnapshot。 */
  compactPercent?: number;
  compactMaxOutput?: number;
  /**
   * ash 证明不了那个进程最终用的是哪份压缩配置:额外参数里自带的 `--settings` 整份顶掉了 ash
   * 注入的那份(claude 只认最后一个),或者老行没留下能证明这一点的起跑证据 —— 判不出窗口与
   * 触发点。为 true 时上面三项一定缺省。
   */
  compactUnknown?: boolean;
  /**
   * window 是**估**出来的(按模型名猜),不是 CLI 自报。true 时界面必须说明白,
   * 别让人当准数用。claude 自报窗口时它是 false —— 分母准不准是数据本身的属性,
   * 界面那个 `~` 该跟着数据走,而不是靠改一处渲染逻辑记得取消。
   */
  windowEstimated: boolean;
}

/**
 * 报出这份水位的那个 CLI 进程**起跑时**被注入的压缩配置 —— 不可变的启动快照。
 *
 * 只能来自起跑那一刻真正写进去的 env(`compactSnapshotFromEnv`),由产出水位的那一层
 * 原样带在每条 context 事件上、随水位一起落库。**不许拿执行器的当前配置去补**:配置改了
 * 之后,正在跑的、被重启接管的、库里留着的那一轮都还是按旧值在压(第 1、2 轮审查)。
 * 三个字段都缺 = 那个进程没配自动压缩窗口,跟随 CLI 自己的判断。
 */
export type CompactSnapshot = Pick<ContextUsage, "compactWindow" | "compactPercent" | "compactMaxOutput" | "compactUnknown">;

/** 证明不了 CLI 最终用的是哪份压缩配置(另有 `--settings` 盖住 ash 那份,或老行缺起跑证据):如实标「不知道」。 */
export const UNKNOWN_COMPACT_SNAPSHOT: CompactSnapshot = Object.freeze({ compactUnknown: true });

const COMPACT_WINDOW_ENV = "CLAUDE_CODE_AUTO_COMPACT_WINDOW";
const COMPACT_PERCENT_ENV = "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE";
const MAX_OUTPUT_ENV = "CLAUDE_CODE_MAX_OUTPUT_TOKENS";
/** 启动快照只认这几个 env —— 读 `--settings` 文本的那一侧按这张表取值。 */
export const COMPACT_SNAPSHOT_ENV_KEYS = [COMPACT_WINDOW_ENV, COMPACT_PERCENT_ENV, MAX_OUTPUT_ENV] as const;

const positive = (raw: unknown): number | null => {
  const value = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  return Number.isFinite(value) && value > 0 ? value : null;
};

/** 起跑时注入给 CLI 的 env → 启动快照。所有产出点共用这一个解码,不各写一遍。 */
export function compactSnapshotFromEnv(env: Readonly<Record<string, string | undefined>>): CompactSnapshot {
  const window = positive(env[COMPACT_WINDOW_ENV]);
  // 百分比与输出预留只在配了窗口时才进 CLI 的算式(没窗口时 claude 整段跳过自动压缩)。
  if (window === null) return {};
  const percent = positive(env[COMPACT_PERCENT_ENV]);
  const maxOutput = positive(env[MAX_OUTPUT_ENV]);
  return {
    compactWindow: Math.round(window),
    ...(percent !== null ? { compactPercent: percent } : {}),
    ...(maxOutput !== null ? { compactMaxOutput: Math.round(maxOutput) } : {}),
  };
}

// 存下来的快照文本(库里两列、接力载荷)一律带这个来源标记:只有「起跑时按最终生效的参数判过」
// 那条写入路径会盖上它。没有标记的非空文本出自这一判定上线前的写入 —— 那时被额外参数盖掉的
// 配置照样当事实写了进去(第 4 轮审查 F1),所以「列非空」不等于「可信」,只有标记说了算。
// 标记带版本:判定口径每收紧一次就换一个,旧口径写下的一律当证明不了。
//   launch-final       只记 ash 注入的那几项,留空的百分比从下层继承时漏记(审查 SaouXWB_jEuw F1)
//   launch-final/v2    各层配置按那次起跑自己的配置目录读,但没看额外参数里的 `--setting-sources`,
//                      百分比也不是按 CLI 的 parseFloat 解的(审查 7pDLIAokZRHH F1)
//   launch-final/v3    改变 CLI 读哪些配置的额外参数一律判不知道,继承值按 CLI 同一种解码
const COMPACT_SNAPSHOT_PROVENANCE = "launch-final/v3";

/** 快照 → 落库/接力用的文本。所有写入点共用这一个,标记才不会漏盖。 */
export function serializeCompactSnapshot(snapshot: CompactSnapshot): string {
  return JSON.stringify({ provenance: COMPACT_SNAPSHOT_PROVENANCE, ...snapshot });
}

/**
 * 存下来的快照文本读回来。**null = 来源证明不了**(没有/不认识的标记、空值),调用方必须走
 * 老行的证据判定,不许把里面的数字当事实;连 JSON 都解不开同样证明不了;带标记但字段坏了按「没配」处理,不把垃圾数字递给界面。
 */
export function parseStoredCompactSnapshot(raw: string | null | undefined): CompactSnapshot | null {
  if (typeof raw !== "string") return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (!value || typeof value !== "object" || value.provenance !== COMPACT_SNAPSHOT_PROVENANCE) return null;
    if (value.compactUnknown === true) return UNKNOWN_COMPACT_SNAPSHOT;
    return compactSnapshotFromEnv({
      [COMPACT_WINDOW_ENV]: value.compactWindow === undefined ? undefined : String(value.compactWindow),
      [COMPACT_PERCENT_ENV]: value.compactPercent === undefined ? undefined : String(value.compactPercent),
      [MAX_OUTPUT_ENV]: value.compactMaxOutput === undefined ? undefined : String(value.compactMaxOutput),
    });
  } catch {
    return null;
  }
}

/** 从一份水位里拿出它的启动快照(落库用)。 */
export function compactSnapshotOf(c: ContextUsage): CompactSnapshot {
  if (c.compactUnknown) return UNKNOWN_COMPACT_SNAPSHOT;
  return {
    ...(c.compactWindow !== undefined ? { compactWindow: c.compactWindow } : {}),
    ...(c.compactPercent !== undefined ? { compactPercent: c.compactPercent } : {}),
    ...(c.compactMaxOutput !== undefined ? { compactMaxOutput: c.compactMaxOutput } : {}),
  };
}

/**
 * 任务实际会先撞到的窗口：自动压缩设置优先，否则才是模型窗口。
 * 压缩窗口比 CLI 自报的模型窗口大时按模型窗口算 —— CLI 自己就是这么截的（600k 配在
 * 没开 1M 的模型上，实际只有 200k，见 context-1m.ts）。估出来的窗口不拿来截：按名字猜
 * 认不出 1M，截了反而把真 1M 会话算成 200k。
 */
export function effectiveContextWindow(c: ContextUsage | null | undefined): number | null {
  const compact = c?.compactWindow;
  const model = c?.window && c.window > 0 ? c.window : null;
  if (typeof compact === "number" && Number.isFinite(compact) && compact > 0) {
    return model !== null && !c!.windowEstimated ? Math.min(compact, model) : compact;
  }
  return model;
}

/**
 * 这条会话实际会在多少 token 压缩:按启动快照里的百分比,套在 CLI 实际用的窗口上。
 * 没配压缩窗口(= 跟随 CLI 自己的判断)时不给数 —— 那一档的触发规则 ash 这边没有依据。
 */
export function contextCompactTrigger(c: ContextUsage | null | undefined): number | null {
  if (typeof c?.compactWindow !== "number" || !(c.compactWindow > 0)) return null;
  const window = effectiveContextWindow(c);
  if (window === null) return null;
  return claudeCompactTrigger(window, c.compactPercent ?? null, c.compactMaxOutput ?? null);
}

/** 水位占窗口的比例 0..1。没有窗口就 null —— 调用方据此决定显不显示百分比。 */
export function contextRatio(c: ContextUsage | null | undefined): number | null {
  const window = effectiveContextWindow(c);
  if (!c || window === null) return null;
  return Math.min(1, Math.max(0, c.used / window));
}

/** 有没有真水位。0 表示没采到,跟 hasUsage 同一条口径。 */
export function hasContext(c: ContextUsage | null | undefined): c is ContextUsage {
  return !!c && c.used > 0;
}

/**
 * 模型名 → 上下文窗口的**兜底估算**,只在 CLI 没自报时用(claude 自报在
 * `result.modelUsage.<model>.contextWindow`,见 server 的 claudeContextWindow)。
 *
 * 这张表**认不出 1M 窗口**,而且这不是「少写一条」能补的:开了 1M 的会话,事件流里
 * 的模型名跟 200k 会话逐字相同(`claude-opus-5`),区分它俩的 `[1m]` 后缀只出现在
 * 自报数据的 key 上。所以这里返回的 200k 对 1M 会话就是错的 —— 调用方必须先问自报,
 * 拿不到才退到这里,并把 windowEstimated 标成 true。
 *
 * 只放有把握的:宁可返回 null(界面退化成只显示绝对水位、不显示百分比),也不要编一个
 * 分母出来 —— 「还剩 60%」是拿来做决定的,错的分母比没有更坏。
 */
export function guessContextWindow(model: string | null | undefined): number | null {
  const m = (model ?? "").toLowerCase();
  if (!m) return null;
  // Claude 各代模型的标准窗口都是 20 万;1M 得看自报,名字里看不出来。
  if (m.includes("claude") || /^(opus|sonnet|haiku)\b/.test(m)) return 200_000;
  return null;
}
