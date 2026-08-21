// 供应商(LlmProvider)的探测通道。ash 自己不再直连大模型跑推理 —— 所有 AI 调用
// 都走本地 CLI 执行器(见 executors/),供应商只是挂到执行器上的 base_url + key。
// 这里剩下的唯一职责是配置供应商时「拉取模型列表」,给下拉框填候选。
import type { LlmProtocol } from "@ash/shared";

export interface LlmCall {
  protocol: LlmProtocol;
  baseUrl: string;
  apiKey: string;
}

const TIMEOUT_MS = 30_000;

// 供应商地址归一(单点)。库里存的应当是根地址(不含 /v1),但历史数据和手滑都可能
// 带上,所以读取侧一律过这两个函数,而不是各处自己拼字符串:
//   relayRoot —— 剥到根地址。claude 的 ANTHROPIC_BASE_URL 要这个(SDK 自己补 /v1)。
//   relayApi  —— 保证带版本段。codex 的 model_providers.base_url 和下面的模型探测要这个。
// 已经是 /v2 之类的就原样保留,不强行改成 /v1。
export const relayRoot = (baseUrl: string): string => baseUrl.replace(/\/+$/, "").replace(/\/v\d+$/, "");
export const relayApi = (baseUrl: string): string => {
  const base = baseUrl.replace(/\/+$/, "");
  return /\/v\d+$/.test(base) ? base : `${base}/v1`;
};

// 列出某个供应商/端点可用的模型 id。OpenAI 兼容走 GET /v1/models({data:[{id}]}),
// Anthropic 走 GET /v1/models(同结构,需 x-api-key + anthropic-version)。失败抛错由调用方处理。
export async function listModels(p: LlmCall): Promise<string[]> {
  if (!p.baseUrl) throw new Error("连接未配置网址(baseUrl)");
  if (!p.apiKey) throw new Error("连接未配置 API Key");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> =
      p.protocol === "anthropic"
        ? { "x-api-key": p.apiKey, "anthropic-version": "2023-06-01" }
        : { authorization: `Bearer ${p.apiKey}` };
    const r = await fetch(`${relayApi(p.baseUrl)}/models`, { headers, signal: ctrl.signal });
    if (!r.ok) throw new Error(`${p.protocol} ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = (await r.json()) as { data?: { id?: string; name?: string }[]; models?: { id?: string; name?: string }[] };
    const ids = (j.data ?? j.models ?? [])
      .map((m) => m.id ?? m.name)
      .filter((x): x is string => !!x);
    return Array.from(new Set(ids)).sort();
  } finally {
    clearTimeout(timer);
  }
}
