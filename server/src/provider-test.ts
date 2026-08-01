import type { Hono } from "hono";
import type { LlmProtocol } from "@harness/shared";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { llmProviders } from "./db/schema.js";
import { relayApi, relayRoot } from "./llm.js";
import { proxyConvertedOpenAiRequest } from "./openai-converter/proxy.js";

const TEST_TIMEOUT_MS = 60_000;
const TEST_PROMPT = "Reply with exactly OK.";

export type ProviderTestConfig = {
  protocol: LlmProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  protocolConversionEnabled: boolean;
};

export type ProviderTestResult = {
  ok: true;
  model: string;
  reply: string;
  elapsedMs: number;
  endpoint: string;
};

function responseError(status: number, body: string): Error {
  const compact = body.replace(/\s+/g, " ").trim().slice(0, 500);
  return new Error(`模型测试失败 (${status})${compact ? `：${compact}` : ""}`);
}

function extractResponsesText(response: unknown): string {
  if (!response || typeof response !== "object") return "";
  const output = (response as { output?: unknown }).output;
  if (!Array.isArray(output)) return "";
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "message") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const value = part as { type?: unknown; text?: unknown; refusal?: unknown };
      if (value.type === "output_text" && typeof value.text === "string") parts.push(value.text);
      if (value.type === "refusal" && typeof value.refusal === "string") parts.push(value.refusal);
    }
  }
  return parts.join("");
}

async function readResponsesStream(response: Response): Promise<string> {
  const raw = await response.text();
  if (!raw.trim()) return "";
  if (!raw.includes("data:")) {
    try {
      return extractResponsesText(JSON.parse(raw));
    } catch {
      return raw.trim().slice(0, 300);
    }
  }
  let reply = "";
  let completed: unknown;
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    let event: any;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event?.type === "response.output_text.delta" && typeof event.delta === "string") reply += event.delta;
    if (event?.type === "response.refusal.delta" && typeof event.delta === "string") reply += event.delta;
    if (event?.type === "response.completed") completed = event.response;
    if (event?.type === "response.failed") {
      throw new Error(`模型测试失败：${JSON.stringify(event.response?.error ?? event.error ?? event).slice(0, 500)}`);
    }
  }
  return reply || extractResponsesText(completed);
}

async function testAnthropic(config: ProviderTestConfig, signal: AbortSignal): Promise<{ reply: string; endpoint: string }> {
  const response = await fetch(`${relayRoot(config.baseUrl)}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: config.model,
      max_tokens: 256,
      messages: [{ role: "user", content: TEST_PROMPT }],
    }),
    signal,
  });
  if (!response.ok) throw responseError(response.status, await response.text());
  const body = await response.json() as { content?: { type?: string; text?: string }[] };
  const reply = (body.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
  return { reply, endpoint: "Anthropic Messages API" };
}

async function testOpenAi(config: ProviderTestConfig, signal: AbortSignal): Promise<{ reply: string; endpoint: string }> {
  const body = JSON.stringify({
    model: config.model,
    input: TEST_PROMPT,
    // 推理模型可能先消耗几十个 reasoning tokens；过小会“连接成功但没有正文”。
    max_output_tokens: 256,
    stream: true,
  });
  const request = new Request("http://harness.local/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
    body,
    signal,
  });
  const response = config.protocolConversionEnabled
    ? await proxyConvertedOpenAiRequest(request, config, "/responses")
    : await fetch(`${relayApi(config.baseUrl)}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
        body,
        signal,
      });
  if (!response.ok) throw responseError(response.status, await response.text());
  return {
    reply: await readResponsesStream(response),
    endpoint: config.protocolConversionEnabled ? "Responses → Chat Completions" : "OpenAI Responses API",
  };
}

// 诊断专用的最小推理调用，不参与任务执行链路。它只回答“这组供应商配置和模型
// 此刻能不能真实返回内容”，避免把 CLI 参数错误与供应商错误混在一起盲测。
export async function testProviderModel(config: ProviderTestConfig): Promise<ProviderTestResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
  try {
    const result = config.protocol === "anthropic"
      ? await testAnthropic(config, controller.signal)
      : await testOpenAi(config, controller.signal);
    const reply = result.reply.trim();
    if (!reply) throw new Error("模型测试成功连接，但供应商没有返回文本内容");
    return {
      ok: true,
      model: config.model,
      reply: reply.slice(0, 300),
      elapsedMs: Date.now() - started,
      endpoint: result.endpoint,
    };
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`模型测试超时（${TEST_TIMEOUT_MS / 1000} 秒）`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function mountProviderTestRoutes(api: Hono) {
  api.post("/llm-providers/test", async (c) => {
    const body = await c.req.json<Partial<ProviderTestConfig> & { id?: string }>();
    const stored = body.id
      ? (await db.select().from(llmProviders).where(eq(llmProviders.id, body.id))).at(0)
      : undefined;
    const protocol = body.protocol ?? (stored?.protocol as LlmProtocol | undefined) ?? "openai";
    const config: ProviderTestConfig = {
      protocol,
      baseUrl: body.baseUrl?.trim() || stored?.baseUrl || "",
      apiKey: body.apiKey?.trim() || stored?.apiKey || "",
      model: body.model?.trim() || stored?.model || "",
      protocolConversionEnabled: protocol === "openai"
        && (body.protocolConversionEnabled ?? stored?.protocolConversionEnabled ?? false),
    };
    if (!config.baseUrl || !config.apiKey || !config.model) {
      return c.json({ error: "Base URL、API Key 和测试模型都必须填写" }, 400);
    }
    try {
      return c.json(await testProviderModel(config));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 502);
    }
  });
}
