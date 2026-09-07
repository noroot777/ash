import type { TokenUsage } from "@ash/shared";

export function claudeEffortUnsupportedMessage(version?: string | null, effort?: string | null): string {
  const parsedVersion = version?.match(/\d+\.\d+\.\d+/)?.[0] ?? version?.trim() ?? "";
  const installed = parsedVersion ? `当前 Claude Code ${parsedVersion}` : "当前 Claude Code";
  const selected = effort ? `，无法使用智能水平 ${effort}` : "";
  return `${installed} 不支持 --effort${selected}。请先执行 claude update，或把智能水平改为“跟随执行器”后重试。`;
}

/**
 * root 身份下 claude 拒绝跳过权限确认时的中文说明。
 *
 * CLI 那侧的判定是 `getuid() === 0 && IS_SANDBOX !== "1" && !CLAUDE_CODE_BUBBLEWRAP`
 * （2.1.220 二进制里的 `isRootOutsideDeliberateSandbox`），报出来只有一行英文，用户
 * 看到的是「0s 用时 + 1 异常」，看不出跟部署身份有关。ash 派活一律带
 * `--dangerously-skip-permissions`（无人值守，没有终端能点确认），所以在 root 下跑
 * ash 就是必然撞上这条，跟模型、网络、任务内容都无关。
 *
 * 三条出路里，②等于告诉 claude「这里就是沙箱」——它会以 root 无确认地执行 agent 的
 * 一切命令，是不可逆且会外溢到整台机器的选择，所以只说明怎么做、由用户自己去设，
 * ash 不替他注入。
 */
export function claudeRootBypassMessage(): string {
  return "Claude Code 拒绝以 root 身份跳过权限确认（ash 无人值守派活，必须带 "
    + "--dangerously-skip-permissions）。三条出路选一条：\n"
    + "① 换个非 root 用户跑 ash（最干净，推荐）；\n"
    + "② 确认这台机器是可丢弃的容器/沙箱，就在**启动 ash 的环境**里设 IS_SANDBOX=1"
    + "（agent 子进程继承 ash 的环境变量），代价是 agent 从此能以 root 无确认地动整台机器；\n"
    + "③ 把 ash 跑在 bubblewrap 沙箱里（CLAUDE_CODE_BUBBLEWRAP）。";
}

/** 远端目标或 help 探测失败时，仍把 CLI 的生硬参数错误翻成可操作提示。 */
export function normalizeClaudeCliError(stderr: string): string {
  const message = stderr.trim();
  const lower = message.toLowerCase();
  // 只认 CLI 真的报了这句才翻译：复用这份 parser 的第三方 CLI 未必有同一条检查。
  if (lower.includes("dangerously-skip-permissions") && lower.includes("root/sudo")) {
    return claudeRootBypassMessage();
  }
  const unsupported = lower.includes("--effort") && (
    lower.includes("unknown option")
    || lower.includes("unrecognized option")
    || lower.includes("unexpected argument")
    || lower.includes("wasn't expected")
  );
  return unsupported ? claudeEffortUnsupportedMessage() : message;
}

export const shortJson = (v: unknown) => {
  try {
    const s = JSON.stringify(v);
    return s && s.length > 1500 ? s.slice(0, 1497) + "…" : s;
  } catch {
    return undefined;
  }
};

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * 单次 API 调用的**上下文水位**：这一次请求带进模型的输入有多大。
 *
 * 三项都要算：`input_tokens` 是没命中缓存的部分，`cache_read` 是命中缓存的部分，
 * `cache_creation` 是这次新写进缓存的部分 —— 三者合起来才是这一次请求的完整
 * prompt。漏掉缓存那两项，水位会显示成几百 token（实测一次真实调用：input=2、
 * cacheRead=115762、cacheWrite=668，只看 input 就等于什么都没测）。
 */
export function claudeContextUsed(u: any): number {
  if (!u || typeof u !== "object") return 0;
  return num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
}

/**
 * 上下文窗口有多大 —— claude **自报**在 `result.modelUsage.<model>.contextWindow`,
 * 拿到就用,这是唯一准确的分母。
 *
 * 为什么非从这里读、不能按模型名猜:两处模型名**看起来一样但含义不同** ——
 * `assistant` 事件里是 `claude-opus-5`,`modelUsage` 的 key 是 `claude-opus-5[1m]`,
 * 那个 `[1m]` 后缀是 1M 窗口的**唯一线索**,而它只存在于 key 上。也就是说 200k 会话
 * 和 1M 会话的 `message.model` 逐字相同,按名字猜从原理上分不开(实测库里 1M 记录 7 条
 * 也是这个形状)。猜错的后果不是差一点:94% 剩余会显示成 72%,水位过 20 万还会提前
 * 变红报「快满了」。
 *
 * 匹配两步:先精确,再拿 key 剥掉 `[...]` 后缀比。都对不上时**只有 modelUsage 里
 * 恰好只有一项**才敢用它 —— 多项时小模型(跑标题/压缩的 haiku)也在里面,它的 200k
 * 会把主模型的 1M 冒充掉。
 */
export function claudeContextWindow(ev: any, model: string | null): number | null {
  const mu = ev?.modelUsage;
  if (!mu || typeof mu !== "object") return null;
  const pick = (key: string): number | null => {
    const w = mu[key]?.contextWindow;
    return typeof w === "number" && Number.isFinite(w) && w > 0 ? Math.trunc(w) : null;
  };
  if (model) {
    const exact = pick(model);
    if (exact) return exact;
    for (const key of Object.keys(mu)) {
      if (key.replace(/\[[^\]]*\]$/, "") === model) {
        const w = pick(key);
        if (w) return w;
      }
    }
  }
  const keys = Object.keys(mu);
  return keys.length === 1 ? pick(keys[0]!) : null;
}

// `result` 行自带这一回合的账单。两处数据来源,取 **modelUsage** 优先:
//   • `usage`      —— 本回合累加,但只有主模型那一份;
//   • `modelUsage` —— 按模型分组的完整账(小模型跑标题/压缩也在里面),且 costUSD
//                     跟 total_cost_usd 同源。
// 一个都没有(旧版 CLI / 复用这份 parser 的第三方 CLI 不报账)就返回 null ——
// **不要退化成全 0**,那会让界面把「没报账」显示成「没花钱」。
export function claudeUsage(ev: any): TokenUsage | null {
  const models = ev?.modelUsage && typeof ev.modelUsage === "object" ? Object.values<any>(ev.modelUsage) : [];
  const cost = typeof ev?.total_cost_usd === "number" && Number.isFinite(ev.total_cost_usd)
    ? ev.total_cost_usd
    : models.length
      ? models.reduce((sum, m) => sum + num(m?.costUSD), 0)
      : null;
  if (models.length) {
    return {
      input: models.reduce((s, m) => s + num(m?.inputTokens), 0),
      output: models.reduce((s, m) => s + num(m?.outputTokens), 0),
      cacheRead: models.reduce((s, m) => s + num(m?.cacheReadInputTokens), 0),
      cacheWrite: models.reduce((s, m) => s + num(m?.cacheCreationInputTokens), 0),
      reasoning: 0, // claude 不单列思考 token(已含在 output 里)
      costUsd: cost,
      turns: 1,
    };
  }
  const u = ev?.usage;
  if (!u || typeof u !== "object") return null;
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
    reasoning: 0,
    costUsd: cost,
    turns: 1,
  };
}
