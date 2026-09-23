// 直连 LLM 供应商的端点。跟任务/会话那一摊没有交集（它只服务设置页里那张供应商表），
// 所以从 `api.ts` 的端点清单里单独拎出来一份 —— 那份已经顶到单文件 700 行上限。
// 调用点仍然只写 `api.llmProviders(...)`：下面这组会被 `api.ts` 原样展开进去。
import { id, json, request } from "./apiClient.ts";
import type { LlmProtocol, LlmProvider, ProviderModelListMode } from "@ash/shared";

export const llmApi = {
  llmProviders: (): Promise<LlmProvider[]> => request("/llm-providers"),
  probeModels: (body: {
    protocol: LlmProtocol;
    baseUrl: string;
    apiKey?: string;
    id?: string;
  }): Promise<{ models: string[] }> => request("/llm-providers/models", json("POST", body)),
  testLlmProvider: (body: {
    id?: string;
    protocol?: LlmProtocol;
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    protocolConversionEnabled?: boolean;
    context1m?: boolean;
  }): Promise<{ ok: true; model: string; reply: string; elapsedMs: number; endpoint: string }> =>
    request("/llm-providers/test", json("POST", body)),
  createLlmProvider: (provider: {
    name: string;
    protocol: LlmProtocol;
    baseUrl: string;
    apiKey: string;
    model: string;
    protocolConversionEnabled: boolean;
    modelListMode?: ProviderModelListMode;
    pinnedModels?: string[];
    context1mModels?: string[];
  }): Promise<LlmProvider> => request("/llm-providers", json("POST", provider)),
  patchLlmProvider: (
    providerId: string,
    patch: Partial<{
      name: string;
      protocol: LlmProtocol;
      baseUrl: string;
      apiKey: string;
      model: string;
      protocolConversionEnabled: boolean;
      modelListMode: ProviderModelListMode;
      pinnedModels: string[];
      context1mModels: string[];
    }>,
  ): Promise<LlmProvider> => request(`/llm-providers/${id(providerId)}`, json("PATCH", patch)),
  deleteLlmProvider: (providerId: string): Promise<{ deleted: true }> =>
    request(`/llm-providers/${id(providerId)}`, { method: "DELETE" }),
};
