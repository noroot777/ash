import { CodexExecutor } from "../codex.js";
import { resumeInner } from "../spawn.js";
import { relayApi } from "../../llm.js";
import { protocolConverterBaseUrl } from "../../openai-converter/common.js";
import type { CliSpec } from "./types.js";

// codex 的 key 走 env_key 间接引用(TOML 里只出现变量名),真 key 只活在进程环境里 ——
// `-c` 参数会原样进 commandLine,而 commandLine 存进 sessions.command_line 并在 UI 展示。
const RELAY_ENV_KEY = "ASH_RELAY_KEY";
const RELAY_PROVIDER_ID = "ash_relay";

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
