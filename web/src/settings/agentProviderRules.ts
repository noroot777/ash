import type { AgentType, LlmProtocol, LlmProvider } from "@ash/shared";

// Mirrors the executor catalog until /agents/catalog exposes relay protocol support.
const PROVIDER_PROTOCOL: Record<AgentType, LlmProtocol | null> = {
  claude: "anthropic",
  codex: "openai",
  qwen: "openai",
  antigravity: null,
  gemini: null,
  opencode: null,
  trae: null,
  grok: null,
  kimi: null,
  cursor: null,
  qoder: null,
  copilot: null,
  kiro: null,
  kilo: null,
  pi: null,
};

export function providerProtocolForAgent(type: AgentType) {
  return PROVIDER_PROTOCOL[type];
}

export function providersForAgent(type: AgentType, providers: LlmProvider[]) {
  const protocol = providerProtocolForAgent(type);
  return protocol ? providers.filter((provider) => provider.protocol === protocol) : [];
}

export function protocolLabel(protocol: LlmProtocol) {
  return protocol === "anthropic" ? "Anthropic 兼容" : "OpenAI 兼容";
}

/**
 * 这个协议的供应商能挂给哪些执行器。
 *
 * 从 `PROVIDER_PROTOCOL` **反推**而不是另写一份名单:选协议这件事用户真正要回答的是
 * 「我这家供应商给谁用」,而答案就躺在上面那张表里。手抄一份的话,哪天多一个支持
 * relay 的 CLI,表单上写的和下拉里能选的就会各说一套。
 */
export function agentsForProtocol(protocol: LlmProtocol): AgentType[] {
  return (Object.keys(PROVIDER_PROTOCOL) as AgentType[])
    .filter((type) => PROVIDER_PROTOCOL[type] === protocol);
}
