// CLI 各自的模型别名与思考强度档位。**从 index.ts 拆出来**的理由有两条:
// ①它随「目录里有几个 CLI」线性增长,每个 type 一条带出处的注释,留在 index 里
//   会把它顶过 700 行硬上限(2026-07-30 就顶过一次);
// ②只有前端的两个选择器用它(web 的 ModelConfigPicker、mobile 的 ExecutionConfig),
//   服务端一处都不读 —— 没必要让每个 import shared 的地方都带上这一大坨。
//
// 走子路径导出 `@harness/shared/cli-presets`,**不从 index 转发**:服务端直接跑
// shared 的 .ts 源码,Node 的类型擦除不会把 "./x.js" 说明符映射回 "./x.ts",
// index 里转发运行时值会让 server 进程起不来(同 `@harness/shared/executors`)。
import type { AgentType } from "./index.ts";

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
  xhigh: "超高推理",
  ultra: "仅部分模型支持",
};

/**
 * 模型级思考强度能力。上面的 REASONING_EFFORT_VALUES 只是每个 CLI 的**并集**；
 * 真正能选什么还取决于 provider / 模型家族，而且不一定是连续的「最高到哪档」：
 * Anthropic 模型可能只有 high/max，Haiku 没有档位，Antigravity 的部分 model slug
 * 已经把 low/medium/high 编进名字里。用 ceiling 截数组表达不了这些情况。
 *
 * 为什么仍需要规则表：**没有通用接口给得出这个信息**。供应商的
 * `/v1/models` 只返回 id / owned_by / created（Anthropic 那版多一个 display_name），
 * 没有能力字段；各家 CLI 也没有「查某模型支持哪些 effort」的命令——非法组合要等
 * 真跑起来才被上游拒。所以内置已知规则按实测逐条积累，未知模型明确退回 CLI 并集。
 *
 * 匹配保留 `openai/xxx` 里的 provider（多 provider CLI 必须靠它区分），同时也提取
 * 裸模型 id；`:high` 这类 Pi 档位后缀只在它确实是已知 effort 名时才剥掉。多条命中
 * 按 exact > provider+pattern > 更长 pattern 的确定性规则选最具体的一条。
 *
 * 补规则的规矩：`efforts` 写**完整允许集合**，且只能是该 CLI 并集的子集；未知就不
 * 写规则，退回并集并让上游诚实报错，不能猜一个较窄集合把可用档位藏掉。
 */
export type ModelEffortMatchMode = "exact" | "prefix" | "suffix";

export interface ModelEffortRule {
  readonly id: string;
  readonly types: readonly AgentType[];
  readonly match: {
    readonly provider?: string;
    readonly model?: string;
    readonly mode?: ModelEffortMatchMode;
  };
  readonly efforts: readonly string[];
}

const CODEX_CLASSIC_EFFORTS = ["low", "medium", "high", "xhigh"] as const;
const CODEX_56_EFFORTS = ["low", "medium", "high", "xhigh", "ultra"] as const;

export const MODEL_EFFORT_RULES: readonly ModelEffortRule[] = [
  // Codex：每个模型家族写完整集合；5.6 已确认 ultra，max 未确认所以不列。
  { id: "codex:gpt-5.6", types: ["codex"], match: { model: "gpt-5.6", mode: "prefix" }, efforts: CODEX_56_EFFORTS },
  { id: "codex:gpt-5.5", types: ["codex"], match: { model: "gpt-5.5", mode: "prefix" }, efforts: CODEX_CLASSIC_EFFORTS },
  { id: "codex:gpt-5.4", types: ["codex"], match: { model: "gpt-5.4", mode: "prefix" }, efforts: CODEX_CLASSIC_EFFORTS },
  { id: "codex:gpt-5.3", types: ["codex"], match: { model: "gpt-5.3", mode: "prefix" }, efforts: CODEX_CLASSIC_EFFORTS },
  { id: "codex:gpt-5.2", types: ["codex"], match: { model: "gpt-5.2", mode: "prefix" }, efforts: CODEX_CLASSIC_EFFORTS },
  { id: "codex:gpt-5.1", types: ["codex"], match: { model: "gpt-5.1", mode: "prefix" }, efforts: CODEX_CLASSIC_EFFORTS },
  { id: "codex:gpt-5-codex", types: ["codex"], match: { model: "gpt-5-", mode: "prefix" }, efforts: CODEX_CLASSIC_EFFORTS },

  // Claude：Haiku 没有独立 effort；别名和供应商常见完整 id 都覆盖。
  { id: "claude:haiku-alias", types: ["claude"], match: { model: "haiku", mode: "prefix" }, efforts: [] },
  { id: "claude:haiku-id", types: ["claude"], match: { model: "claude-haiku", mode: "prefix" }, efforts: [] },

  // OpenCode/Kilo 的 variant 由模型 provider 决定，集合可能有洞，正是 ceiling 表达不了的情形。
  { id: "multimodel:anthropic", types: ["opencode", "kilo"], match: { provider: "anthropic" }, efforts: ["high", "max"] },
  { id: "multimodel:google", types: ["opencode", "kilo"], match: { provider: "google" }, efforts: ["low", "high"] },
  { id: "multimodel:openai", types: ["opencode", "kilo"], match: { provider: "openai" }, efforts: ["minimal", "low", "medium", "high", "xhigh"] },

  // Antigravity 这些 slug 已经把 effort 编进模型名，再叠 --effort 的行为未实测，故不再单列一步。
  { id: "antigravity:slug-low", types: ["antigravity"], match: { model: "-low", mode: "suffix" }, efforts: [] },
  { id: "antigravity:slug-medium", types: ["antigravity"], match: { model: "-medium", mode: "suffix" }, efforts: [] },
  { id: "antigravity:slug-high", types: ["antigravity"], match: { model: "-high", mode: "suffix" }, efforts: [] },
];

export interface ReasoningEffortResolution {
  readonly efforts: readonly string[];
  readonly source: "model-rule" | "cli-fallback";
  readonly ruleId: string | null;
}

const KNOWN_EFFORTS = new Set(Object.values(REASONING_EFFORT_VALUES).flat());

function modelRef(model: string): { provider: string | null; id: string } {
  let normalized = model.trim().toLowerCase();
  const colon = normalized.lastIndexOf(":");
  if (colon > normalized.lastIndexOf("/") && KNOWN_EFFORTS.has(normalized.slice(colon + 1))) {
    normalized = normalized.slice(0, colon);
  }
  const segments = normalized.split("/").filter(Boolean);
  return {
    provider: segments.length > 1 ? segments[0]! : null,
    id: segments.at(-1) ?? "",
  };
}

function matchesModel(value: string, pattern: string, mode: ModelEffortMatchMode): boolean {
  if (mode === "exact") return value === pattern;
  if (mode === "suffix") return value.endsWith(pattern);
  return value.startsWith(pattern);
}

function ruleScore(rule: ModelEffortRule): number {
  const mode = rule.match.mode ?? "exact";
  const modeScore = mode === "exact" ? 3_000 : mode === "prefix" ? 2_000 : 1_000;
  return (rule.match.provider ? 10_000 : 0) + (rule.match.model ? modeScore + rule.match.model.length : 0);
}

/**
 * 解析某个 CLI + 模型的思考强度能力，并保留来源供 UI / 校验层判断是否命中已知规则。
 *
 * 不传 model（或该模型没登记）就退回 CLI 并集：这是明确的 unknown fallback，不是
 * 对该模型能力的断言。
 */
export function resolveReasoningEfforts(type: AgentType, model?: string | null): ReasoningEffortResolution {
  const fallback = REASONING_EFFORT_VALUES[type] ?? [];
  if (!model?.trim()) return { efforts: fallback, source: "cli-fallback", ruleId: null };
  const ref = modelRef(model);
  let winner: ModelEffortRule | null = null;
  for (const rule of MODEL_EFFORT_RULES) {
    if (!rule.types.includes(type)) continue;
    if (rule.match.provider && rule.match.provider !== ref.provider) continue;
    if (rule.match.model && !matchesModel(ref.id, rule.match.model, rule.match.mode ?? "exact")) continue;
    if (!winner || ruleScore(rule) > ruleScore(winner)) winner = rule;
  }
  if (!winner) return { efforts: fallback, source: "cli-fallback", ruleId: null };
  return { efforts: winner.efforts, source: "model-rule", ruleId: winner.id };
}

/**
 * 连**哪个 CLI** 都还不知道时给的档位：各家都有的那四档。
 *
 * 这不是并集（并集会把 `ultra`/`off`/`minimal` 这些单家特产也端出来，选中了多半跑
 * 不起来），也不是断言——真正合法与否要等落到具体执行器时才裁得了。用在工作流的
 * 站点上：它可以「跟随任务的执行器」，那时这一站压根不知道自己会被谁执行。
 */
export const GENERIC_REASONING_EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh"];

/** 兼容选择器的简写：只取解析后的允许集合；不知道 CLI 就退到通用四档。 */
export function reasoningEffortsFor(type: AgentType | null | undefined, model?: string | null): readonly string[] {
  if (!type) return GENERIC_REASONING_EFFORTS;
  return resolveReasoningEfforts(type, model).efforts;
}

/** 空值 = 跟随 CLI，永远合法；非空必须落在该模型解析出的允许集合里。 */
export function isReasoningEffortSupported(
  type: AgentType | null | undefined,
  model: string | null | undefined,
  effort: string | null | undefined,
): boolean {
  const value = effort?.trim();
  return !value || reasoningEffortsFor(type, model).includes(value);
}

/** 模型改变时保留仍合法的档位，否则清回 null（跟随 CLI）。 */
export function normalizeReasoningEffort(
  type: AgentType,
  model: string | null | undefined,
  effort: string | null | undefined,
): string | null {
  const value = effort?.trim();
  return value && isReasoningEffortSupported(type, model, value) ? value : null;
}
