// 直连大模型(HTTP fetch,不引 SDK)。仅用于把事项的自然语言解析成结构 —— 纯文本进
// 出,绝不用于执行(执行要工具、要进仓库,只能用 CLI 智能体)。连接是系统级的「中转站」
// 配置(LlmProvider):协议 + 网址(baseUrl)+ key + 模型,官方端点或中转都走同一套。
import type { LlmProtocol } from "@harness/shared";

export interface LlmCall {
  protocol: LlmProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
}

const TIMEOUT_MS = 30_000;

// 一次文本补全。失败(缺 key / 非 2xx / 超时)抛错 —— 调用方(parseIssue)catch 后降级。
export async function callModel(p: LlmCall, prompt: string): Promise<string> {
  if (!p.baseUrl) throw new Error("连接未配置网址(baseUrl)");
  if (!p.apiKey) throw new Error("连接未配置 API Key");
  if (!p.model) throw new Error("连接未配置模型");
  const base = p.baseUrl.replace(/\/+$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    if (p.protocol === "anthropic") {
      const r = await fetch(`${base}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": p.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: p.model, max_tokens: 1024, messages: [{ role: "user", content: prompt }] }),
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
      const j = (await r.json()) as { content?: { type: string; text?: string }[] };
      return (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    }
    // openai-compatible
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify({ model: p.model, messages: [{ role: "user", content: prompt }] }),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const j = (await r.json()) as { choices?: { message?: { content?: string } }[] };
    return j.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

// 列出某个中转站/端点可用的模型 id。OpenAI 兼容走 GET /models({data:[{id}]}),
// Anthropic 走 GET /models(同结构,需 x-api-key + anthropic-version)。失败抛错由调用方处理。
export async function listModels(p: Omit<LlmCall, "model">): Promise<string[]> {
  if (!p.baseUrl) throw new Error("连接未配置网址(baseUrl)");
  if (!p.apiKey) throw new Error("连接未配置 API Key");
  const base = p.baseUrl.replace(/\/+$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> =
      p.protocol === "anthropic"
        ? { "x-api-key": p.apiKey, "anthropic-version": "2023-06-01" }
        : { authorization: `Bearer ${p.apiKey}` };
    const r = await fetch(`${base}/models`, { headers, signal: ctrl.signal });
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
