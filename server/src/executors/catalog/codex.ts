import { CodexExecutor } from "../codex.js";
import { resumeInner } from "../spawn.js";
import { relayApi } from "../../llm.js";
import { protocolConverterBaseUrl } from "../../openai-converter/common.js";
import { modelEffortKey } from "@ash/shared/cli-presets";
import type { CliSpec } from "./types.js";

// codex 的 key 走 env_key 间接引用(TOML 里只出现变量名),真 key 只活在进程环境里 ——
// `-c` 参数会原样进 commandLine,而 commandLine 存进 sessions.command_line 并在 UI 展示。
const RELAY_ENV_KEY = "ASH_RELAY_KEY";
const RELAY_PROVIDER_ID = "ash_relay";

// `codex debug models` 的输出(0.153.4 实测):一整个 JSON,`{"models":[{slug,display_name,
// visibility,priority,supported_reasoning_levels,…}]}`。它是**本机 CLI 内置的目录**,
// 读盘即得(实测 15ms,没有网络往返),所以比 grok 那条清单命令还便宜。
//
// 只取 `visibility !== "hide"` 的:hide 那批(gpt-daybreak-*、codex-auto-review、退役的
// gpt-5.4-mini)codex 自己的模型选择器也不列,把它们端上来等于让用户在一堆内部代号里挑。
// 仍然可用 —— ash 的下拉框允许手填,profile 里已经钉着的值也会被选择器自己补回候选。
//
// `supported_reasoning_levels` 是**每个模型自己的完整允许集合**(0.153.4 实测形状是
// `[{effort,description},…]`),顺手一起带出来:它和模型清单同住一份输出,白给。接了它
// 之后 codex 这一家的档位就不再依赖 `MODEL_EFFORT_RULES` 那张手写表 —— 后者仍留着给
// 探不到(没装 CLI / 旧版本没这个字段)的情况兜底。
//
// 排序按 `priority` 升序(codex 自己就是这么排的:旗舰在前、退役的在后),同号保持原序。
// 没有「默认模型」字段可读,于是 defaultModel 返回 null —— 宁可不标,也不拿 priority
// 最小的那个冒充「不选就是它」(codex 的实际默认还受 ~/.codex/config.toml 影响)。
export function parseCodexModels(stdout: string): {
  models: string[];
  defaultModel?: string | null;
  modelEfforts?: Record<string, readonly string[]>;
} {
  // CLI 偶尔会在 JSON 前面印一行升级提示之类,所以从第一个 `{` 截起再解析。
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end <= start) return { models: [], defaultModel: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    // 解析不出来就是空数组 —— 由上层如实降级到快照,别硬凑。
    return { models: [], defaultModel: null };
  }
  const list = (parsed as { models?: unknown } | null)?.models;
  if (!Array.isArray(list)) return { models: [], defaultModel: null };
  const rows: { slug: string; priority: number; index: number }[] = [];
  const modelEfforts: Record<string, readonly string[]> = {};
  for (const [index, raw] of list.entries()) {
    const entry = raw as {
      slug?: unknown;
      visibility?: unknown;
      priority?: unknown;
      supported_reasoning_levels?: unknown;
    } | null;
    const slug = typeof entry?.slug === "string" ? entry.slug.trim() : "";
    if (!slug) continue;
    // 档位登记在 visibility 之前:下拉框不列隐藏模型,但 profile 里钉着它的老配置
    // (gpt-5.4 这种已被 codex 标 hide 的)仍要判得对,而 CLI 的原话比规则表更权威。
    const efforts = parseCodexEfforts(entry?.supported_reasoning_levels);
    if (efforts) modelEfforts[modelEffortKey(slug)] = efforts;
    // 字段缺失(老版本 CLI 还没有 visibility)时按可见处理:少列一个真实模型
    // 比多列一个内部代号更糟。
    if (entry?.visibility === "hide") continue;
    rows.push({
      slug,
      priority: typeof entry?.priority === "number" ? entry.priority : Number.MAX_SAFE_INTEGER,
      index,
    });
  }
  rows.sort((a, b) => a.priority - b.priority || a.index - b.index);
  return {
    models: rows.map((row) => row.slug),
    defaultModel: null,
    ...(Object.keys(modelEfforts).length ? { modelEfforts } : {}),
  };
}

/**
 * `supported_reasoning_levels` → 档位名数组。
 *
 * 形状是 `[{effort,description},…]`,但只认 `effort` 这个键而不按下标取值:字段将来
 * 变成裸字符串数组(`["low","high"]`)也照样解析得出,两种都接。
 *
 * **字段缺失与空数组必须分开**:老版本 CLI 没有这个字段 → 返回 null,让上层「缺 key」,
 * 退回规则表;CLI 明确报了一个空数组 → 原样返回空数组,那是「这个模型没有档位」。
 */
function parseCodexEfforts(raw: unknown): readonly string[] | null {
  if (!Array.isArray(raw)) return null;
  const efforts: string[] = [];
  for (const item of raw) {
    const value = typeof item === "string"
      ? item
      : typeof (item as { effort?: unknown } | null)?.effort === "string"
        ? (item as { effort: string }).effort
        : "";
    const effort = value.trim().toLowerCase();
    if (effort && !efforts.includes(effort)) efforts.push(effort);
  }
  // 非空输入一个都没解析出来 = 形状完全变了,按「不知道」处理而不是「没有档位」。
  return raw.length && !efforts.length ? null : efforts;
}

// 检测字段原样来自旧 detect.ts 的 KNOWN_CLIS。执行部分由 CodexExecutor 接管(它还带
// 每回合的失败证据链 diagnostics),下面的 exec 是同一套参数的声明式副本。
export const codexSpec: CliSpec = {
  key: "codex",
  name: "Codex CLI",
  description: "OpenAI 官方 CLI",
  bins: ["codex"],
  docsUrl: "https://developers.openai.com/codex/cli/",
  installCommand: "npm install -g @openai/codex",
  factory: (opts) => new CodexExecutor(opts),
  // `codex debug models` 是纯本地只读(读 CLI 内置目录,不联网、不起会话、不烧 token)。
  // 超时给默认的 10s 绰绰有余;输出含每个模型的 prompt 模板,整份 500KB 上下,由
  // model-probe 的 4MB maxBuffer 兜住。
  models: { args: ["debug", "models"], parse: (stdout) => parseCodexModels(stdout) },
  exec: {
    // codex exec --json --skip-git-repo-check -C <cwd>
    //      --dangerously-bypass-approvals-and-sandbox [-m model] [resume <id>] -
    subcommand: ["exec"],
    baseArgs: ["--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox"],
    // 位置参数 `-` = 从 stdin 读 prompt。
    prompt: { via: "stdin", stdinArg: "-" },
    model: { flag: "-m" },
    // 结构化档位:`-c` 的值按 TOML 解析,字符串须带引号。
    reasoningEffort: (v) => ["-c", `model_reasoning_effort="${v}"`],
    fastArgs: ["-c", 'service_tier="priority"'],
    session: {
      // 注意:codex 的 exec 选项必须排在 `resume` 子命令之前,generic 的装配顺序
      // 凑不出来(它把会话参数插在 baseArgs 之后)—— 所以 codex 走专用 factory。
      resumeArgs: (id) => ["resume", id],
      interactive: resumeInner.codex,
    },
    relay: (r) => ({
      env: { [RELAY_ENV_KEY]: r.apiKey },
      // wire_api 必须是 responses:codex 0.14x 起废弃了 chat(启动直接报错退出)。
      args: [
        "-c", `model_provider="${RELAY_PROVIDER_ID}"`,
        "-c", `model_providers.${RELAY_PROVIDER_ID}.name="${r.name.replace(/"/g, "")}"`,
        "-c", `model_providers.${RELAY_PROVIDER_ID}.base_url="${relayApi(r.protocolConversionEnabled ? protocolConverterBaseUrl(r.providerId) : r.baseUrl)}"`,
        "-c", `model_providers.${RELAY_PROVIDER_ID}.wire_api="responses"`,
        "-c", `model_providers.${RELAY_PROVIDER_ID}.env_key="${RELAY_ENV_KEY}"`,
      ],
      envHint: `${RELAY_ENV_KEY}=<你的key> `,
    }),
  },
};
