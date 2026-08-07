// Token 用量的统一口径。各家 CLI 报的形状不一样(claude 把缓存读写单列、codex 把
// 缓存算在 input 里面),归一化成这一份再往下传,展示端就不必知道是谁跑的。
//
// 运行时函数住在这里而不是 index.ts:服务端直接跑 shared 的 .ts 源码,index 里
// 转发运行时值会让进程起不来(见 index.ts 顶部注释),所以照 team / executors
// 的办法开一个子路径导出 "@harness/shared/usage"。

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
}

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
  };
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

/** 1234 → "1,234";12345 → "12.3k";1234567 → "1.23M"。给一眼扫的场合用。 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 10_000) return n.toLocaleString("en-US");
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
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
  /** window 是估出来的(不是 CLI 自报)。true 时界面必须说明白,别让人当准数用。 */
  windowEstimated: boolean;
}

/** 水位占窗口的比例 0..1。没有窗口就 null —— 调用方据此决定显不显示百分比。 */
export function contextRatio(c: ContextUsage | null | undefined): number | null {
  if (!c || !c.window || c.window <= 0) return null;
  return Math.min(1, Math.max(0, c.used / c.window));
}

/** 有没有真水位。0 表示没采到,跟 hasUsage 同一条口径。 */
export function hasContext(c: ContextUsage | null | undefined): c is ContextUsage {
  return !!c && c.used > 0;
}

/**
 * 模型名 → 上下文窗口的**兜底估算**。CLI 自报的永远优先(codex 的 token_count 事件
 * 自带 `model_context_window`),这张表只服务不报的那些(claude CLI 就不报)。
 *
 * 只放有把握的:宁可返回 null(界面退化成只显示绝对水位、不显示百分比),也不要编一个
 * 分母出来 —— 「还剩 60%」是拿来做决定的,错的分母比没有更坏。
 */
export function guessContextWindow(model: string | null | undefined): number | null {
  const m = (model ?? "").toLowerCase();
  if (!m) return null;
  // Claude 各代模型的标准窗口都是 20 万;1M 要显式开 beta,不默认假设。
  if (m.includes("claude") || /^(opus|sonnet|haiku)\b/.test(m)) return 200_000;
  return null;
}

