// CLI 各自的模型别名与思考强度档位。**从 index.ts 拆出来**的理由有两条:
// ①它随「目录里有几个 CLI」线性增长,每个 type 一条带出处的注释,留在 index 里
//   会把它顶过 700 行硬上限(2026-07-30 就顶过一次);
// ②只有前端的两个选择器用它(web 的 ModelConfigPicker、mobile 的 ExecutionConfig),
//   服务端一处都不读 —— 没必要让每个 import shared 的地方都带上这一大坨。
//
// 走子路径导出 `@harness/shared/cli-presets`,**不从 index 转发**:服务端直接跑
// shared 的 .ts 源码,Node 的类型擦除不会把 "./x.js" 说明符映射回 "./x.ts",
// index 里转发运行时值会让 server 进程起不来(同 `@harness/shared/executors`)。
import type { AgentType } from "./index.js";

// CLI-native model aliases used when an executor is on its official account.
// Provider-backed executors replace these with that provider's /v1/models list.
// 全键 Record 是刻意的:新类型不填就编译不过,免得漏登记后下拉框静默空着。
// 空数组 = 该 CLI 的模型别名还没实测(用户仍可在 profile 里手填任意模型名)。
export const CLI_MODEL_PRESETS: Record<AgentType, readonly string[]> = {
  claude: ["opus", "sonnet", "haiku", "fable"],
  codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"],
  // Antigravity(agy)的 model slug **自带 effort 后缀**:官方 docs/cli/headless 里
  // 唯一的实例是 `--model gemini-3.5-flash-medium`,其余按 docs/models 模型选择器的
  // 展示名(Gemini 3.6/3.5 Flash 各 Low/Medium/High、3.1 Pro 的 Low/High)照同一条
  // 构词规则推出,2026-07-30 核对。权威清单是 `agy models`;headless 下 --model 认不出
  // 的 slug 会**非 0 退出并列出可用模型**(刻意不静默降级),所以推错是响亮失败。
  // 选择器里还有 Claude Sonnet/Opus 4.6 (Thinking) 与 GPT-OSS 120B (Medium),
  // 但「(Thinking)」对应的 slug 拼法没有出处,不瞎填 —— 手填照样接受。
  antigravity: [
    "gemini-3.6-flash-low",
    "gemini-3.6-flash-medium",
    "gemini-3.6-flash-high",
    "gemini-3.5-flash-low",
    "gemini-3.5-flash-medium",
    "gemini-3.5-flash-high",
    "gemini-3.1-pro-low",
    "gemini-3.1-pro-high",
  ],
  // gemini 的 --model 别名(v0.53.0 docs/cli/cli-reference.md「Model aliases」):
  // 具体 id(gemini-3-pro-preview 之类)随版本换,别名才是稳定那层;手填照样接受。
  gemini: ["auto", "pro", "flash", "flash-lite"],
  // opencode 的模型是 `provider/model`(id 来自 models.dev),能不能用取决于你在
  // opencode 里认证了哪些 provider;`opencode models` 列本机可用的全集。
  opencode: [
    "anthropic/claude-opus-4-8",
    "anthropic/claude-sonnet-4-6",
    "openai/gpt-5.6",
    "openai/gpt-5.3-codex",
    "google/gemini-3.1-pro-preview",
    "opencode/claude-sonnet-4-6",
    "opencode/gpt-5.3-codex",
  ],
  // 2026-07-30 核对 docs.trae.cn:TRAE CLI 连 --model 参数都没有(换模型走 `-c model.name=`),
  // 也没公布内置模型 id 清单 —— 可选项 = 内置模型 + 企业管理员在控制台加的自定义模型,每家租户不一样。
  // 唯一有出处的取值是全局设置页的示例 `traecli -c model.name=kimi-k2`;手填照样接受。
  trae: [],
  grok: ["grok-4.5"], // 2026-07-30 登录态 `grok models` 的唯一可用模型(v0.2.114)
  kimi: ["kimi-code/k3", "kimi-code/kimi-for-coding", "kimi-code/kimi-for-coding-highspeed"],
  cursor: ["auto", "grok-4.5", "composer-2.5", "claude-sonnet-5", "claude-opus-5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gemini-3.1-pro", "gemini-3.6-flash"],
  // qwen-code 的 Coding Plan 可选模型(2026-07-30 官方 auth 文档);同一菜单里还有
  // glm-5 / kimi-k2.5 / MiniMax-M2.5 等第三方 id,要用直接手填。
  qwen: ["qwen3-coder-plus", "qwen3-coder-next", "qwen3.7-plus", "qwen3-max-2026-01-23"],
  // qodercli 的档位名(2026-07-30 核对 @qoder-ai/qodercli@1.1.8 bundle 里的枚举);
  // 前沿模型(qwen3.7-max 等)与 BYOK 自定义模型要先在 TUI 的 /model 里配,配好可手填。
  qoder: ["auto", "ultimate", "performance", "efficient", "lite"],
  copilot: ["auto", "claude-sonnet-4.6", "gpt-5.4", "claude-haiku-4.5", "gpt-5.3-codex", "gemini-3.1-pro-preview", "gemini-3.5-flash", "gemini-3.6-flash", "mai-code-1-flash"],
  kiro: ["auto", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "claude-opus-5", "claude-opus-4.8", "claude-opus-4.7", "claude-opus-4.6", "claude-opus-4.5", "claude-sonnet-5", "claude-sonnet-4.6", "claude-sonnet-4.5", "claude-sonnet-4", "claude-haiku-4.5", "deepseek-3.2", "minimax-m2.5", "glm-5", "minimax-m2.1", "qwen3-coder-next"],
  // kilo 是 opencode 的 fork,模型同样是 `provider/model`(源码 parseModel 按第一个 /
  // 切分,不带 / 会切出空 modelID)。前四条是 Kilo 网关的自动档、后四条取自网关的
  // 「Popular models」(2026-07-30 官方 gateway 文档);`kilo models` 列本机可用的全集。
  kilo: [
    "kilo-auto/frontier",
    "kilo-auto/balanced",
    "kilo-auto/efficient",
    "kilo-auto/free",
    "anthropic/claude-opus-4.7",
    "anthropic/claude-sonnet-4.6",
    "openai/gpt-5.4",
    "google/gemini-3.1-pro-preview",
  ],
  // pi(Earendil 的 Pi Coding Agent,**不是** Inflection 的 Pi —— 见 catalog/pi.ts 的开头注释)
  // 的 --model 收「provider/id」或模糊匹配(`sonnet`、`sonnet:high` 都行,后缀是思考强度),
  // 默认 provider 是 google。内置模型 id 是构建时从各家真实 catalog 刷进去的,所以就是各家
  // 官方 id;下面按 2026-07-30 各家现役 id 列几条常用的,权威清单是 `pi --list-models`。
  pi: [
    "anthropic/claude-opus-4-8",
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-haiku-4-5",
    "openai/gpt-5.6-sol",
    "openai/gpt-5.4",
    "google/gemini-3.1-pro-preview",
    "google/gemini-3.6-flash",
  ],
};

// CLI-specific reasoning levels. Unsupported model/effort combinations are
// rejected by the CLI/API at run time (for example gpt-5.5 tops out at xhigh).
// 同样是全键 Record;空数组 = 该 CLI 没有(或还没实测出)思考强度档位。
export const REASONING_EFFORT_VALUES: Record<AgentType, readonly string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh", "ultra", "max"],
  // 2026-07-30 核对 docs/cli/headless 与 changelog:`--effort` 在 CLI 1.1.5 加入,只有这三档。
  // 注意 model slug 本身也带 effort 后缀(gemini-3.5-flash-medium),两边同时给的行为未实测。
  antigravity: ["low", "medium", "high"],
  gemini: [], // 2026-07-30 核对 v0.53.0 的 yargs 定义:没有 effort 类 flag,思考预算只能写 settings.json 的 thinkingConfig
  // opencode 叫 variant(--variant),档位由 provider 决定:anthropic 只有 high/max、
  // google 只有 low/high、openai 大致 minimal→xhigh。这里是并集,不合法组合由上游拒。
  opencode: ["minimal", "low", "medium", "high", "xhigh", "max"],
  trae: [], // 2026-07-30 核对 docs.trae.cn 的 CLI 参数表与 trae_cli.yaml 字段:TRAE CLI 没有 reasoning/thinking effort 这个概念
  grok: ["low", "medium", "high"],
  kimi: [], // 2026-07-30:config/API 有 effort,但 Kimi Code CLI 没有对应命令行参数
  cursor: [], // 2026-07-30 核对 Cursor CLI 参数页:没有独立 reasoning-effort flag;effort/Fast 看起来通过模型变体或账号计划控制
  qwen: [], // 2026-07-30 核对 main 的 yargs 定义:qwen-code 没有 reasoning/thinking effort 参数
  qoder: ["low", "medium", "high", "xhigh", "max"], // 2026-07-30 核对 qodercli@1.1.8 bundle:`--reasoning-effort <level>`,另接 disabled/off/none 与正整数
  copilot: ["low", "medium", "high", "xhigh", "max"],
  kiro: ["low", "medium", "high", "xhigh", "max"],
  // kilo 沿用 opencode 的 --variant(源码 describe:"provider-specific reasoning
  // effort, e.g., high, max, minimal"),档位同样由 provider 决定,这里给并集。
  kilo: ["minimal", "low", "medium", "high", "xhigh", "max"],
  // pi 把它叫 thinking:2026-07-30 核对 v0.83.0 源码 cli/args.ts 的 VALID_THINKING_LEVELS
  // (docs/models.md 的 thinkingLevelMap 同一套键)。"off" 是显式关掉思考,是真档位不是缺省。
  // 单个模型可能只暴露其中几档(thinkingLevelMap 允许有洞),不支持的组合由 pi/上游拒绝。
  pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
};

export const REASONING_EFFORT_DETAIL: Record<string, string> = {
  xhigh: "gpt-5.5 支持的最高档",
  ultra: "仅 gpt-5.6-sol/terra 等新模型支持",
};

/**
 * 「这个**模型**顶到哪一档」——上面那张表是按 **CLI** 给的并集，同一个 CLI 下
 * 不同模型能吃的档位并不一样（codex 的 ultra/max 是随 gpt-5.6 系列才加的，
 * gpt-5.5 给 ultra 会被上游直接拒）。
 *
 * 为什么是写死的表而不是查接口：**没有任何接口给得出这个信息**。供应商的
 * `/v1/models` 只返回 id / owned_by / created（Anthropic 那版多一个 display_name），
 * 没有能力字段；各家 CLI 也没有「查某模型支持哪些 effort」的命令——非法组合要等
 * 真跑起来才被上游拒。所以只能按实测逐条积累。
 *
 * `match` 按模型 id 前缀匹配（会先剥掉 `openai/` 这类 provider 前缀和 `:high`
 * 这类档位后缀），多条命中取**最长**的那条。`ceiling` 是该模型能吃到的最高档，
 * 按所属 CLI 的档位数组顺序截断。
 *
 * 补表的规矩：**只写实测过的**。宁可多列一档让上游去拒（用户看得到报错），也别
 * 凭猜想少列一档——那会让人在界面上根本挑不到一个其实可用的档位，且无从察觉。
 */
export const MODEL_EFFORT_CEILINGS: readonly { readonly match: string; readonly ceiling: string }[] = [
  // gpt-5.5 及更早的 codex 模型：ultra/max 都会被拒（gpt-5.5 实测；更早的同系列
  // 按「ultra 仅 5.6 系列起支持」这条推的，若实测发现更严还要再补条目）。
  { match: "gpt-5.5", ceiling: "xhigh" },
  { match: "gpt-5.4", ceiling: "xhigh" },
  { match: "gpt-5.3", ceiling: "xhigh" },
  { match: "gpt-5.2", ceiling: "xhigh" },
  { match: "gpt-5.1", ceiling: "xhigh" },
  { match: "gpt-5-", ceiling: "xhigh" },
  // gpt-5.6 系列（sol/terra/luna）的 ultra 已实测可用；max 还没实测，先不设顶。
];

/** 剥掉 `openai/` 这类 provider 前缀与 `:high` 这类档位后缀，只留模型 id 本身。 */
function bareModelId(model: string): string {
  const withoutSuffix = model.trim().toLowerCase().split(":")[0] ?? "";
  const segments = withoutSuffix.split("/");
  return segments[segments.length - 1] ?? "";
}

/**
 * 某个 CLI 跑某个模型时，真正可挑的思考强度档位。
 *
 * 不传 model（或该模型没登记过顶）就退回 CLI 的并集——**没实测过就别假装知道**，
 * 少列一档比多列一档更难被发现。
 */
export function reasoningEffortsFor(type: AgentType, model?: string | null): readonly string[] {
  const values = REASONING_EFFORT_VALUES[type] ?? [];
  if (!model) return values;
  const id = bareModelId(model);
  if (!id) return values;
  let matched: { match: string; ceiling: string } | null = null;
  for (const entry of MODEL_EFFORT_CEILINGS) {
    if (!id.startsWith(entry.match)) continue;
    if (!matched || entry.match.length > matched.match.length) matched = { ...entry };
  }
  if (!matched) return values;
  const cut = values.indexOf(matched.ceiling);
  return cut < 0 ? values : values.slice(0, cut + 1);
}
