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
