import { relayApi } from "../llm.js";
import { protocolConverterBaseUrl } from "../openai-converter/common.js";
import type { CliRelayWiring } from "./catalog/types.js";
import type { RelayConfig } from "./types.js";

// 供应商的 key 走环境变量,不进命令行 —— `-c` 参数会原样进 commandLine,而后者存进
// sessions.command_line 并在 UI 展示。codex 的 model_providers 正好支持 env_key
// 指向一个环境变量名,于是 TOML 里只出现变量名,真 key 只活在进程环境里。
const RELAY_ENV_KEY = "ASH_RELAY_KEY";
const RELAY_PROVIDER_ID = "ash_relay";

export function codexRelay(relay: RelayConfig): CliRelayWiring {
  const provider = `model_providers.${RELAY_PROVIDER_ID}`;
  const baseUrl = relayApi(relay.protocolConversionEnabled
    ? protocolConverterBaseUrl(relay.providerId)
    : relay.baseUrl);
  return {
    env: { [RELAY_ENV_KEY]: relay.apiKey },
    args: [
      "-c", `model_provider="${RELAY_PROVIDER_ID}"`,
      "-c", `${provider}.name="${relay.name.replace(/"/g, "")}"`,
      "-c", `${provider}.base_url="${baseUrl}"`,
      "-c", `${provider}.wire_api="responses"`,
      "-c", `${provider}.env_key="${RELAY_ENV_KEY}"`,
      "-c", `${provider}.http_headers.x-openai-actor-authorization="codex-imagegen-enabled"`,
    ],
    envHint: `${RELAY_ENV_KEY}=<你的key> `,
  };
}
