import type { Context, Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { llmProviders } from "./db/schema.js";
import { relayApi } from "./llm.js";
import { bearerToken, errorResponse, responseHeaders, secretsEqual } from "./openai-converter/common.js";
import { currentListeningPort } from "./listening-port.js";

const CONTEXT_1M_SUFFIX = "[1m]";
const CONTEXT_1M_BETA = "context-1m-2025-08-07";

export function stripContext1mSuffix(model: string): string {
  const trimmed = model.trimEnd();
  return trimmed.toLowerCase().endsWith(CONTEXT_1M_SUFFIX)
    ? trimmed.slice(0, -CONTEXT_1M_SUFFIX.length).trimEnd()
    : model;
}

export function modelUsesContext1m(model: string | undefined, configured: readonly string[]): boolean {
  if (!model) return false;
  const base = stripContext1mSuffix(model).trim();
  return configured.some((candidate) => candidate.trim() === base);
}

export function withContext1mSuffix(model: string | undefined, configured: readonly string[]): string | undefined {
  if (!model || !modelUsesContext1m(model, configured)) return model;
  const base = stripContext1mSuffix(model).trim();
  return `${base}${CONTEXT_1M_SUFFIX}`;
}

export function anthropicContext1mBaseUrl(providerId: string): string {
  const configured = process.env.ASH_ANTHROPIC_1M_RELAY_URL?.trim()
    || process.env.ASH_PROTOCOL_CONVERTER_URL?.trim();
  const origin = (configured || `http://127.0.0.1:${currentListeningPort() ?? 4317}`).replace(/\/+$/, "");
  return `${origin}/api/llm-providers/${encodeURIComponent(providerId)}/context-1m`;
}

function appendContextBeta(value: string | null): string {
  const parts = (value ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  if (!parts.includes(CONTEXT_1M_BETA)) parts.push(CONTEXT_1M_BETA);
  return parts.join(",");
}

function hasConfiguredContext1mModels(raw: string): boolean {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) && value.some((item) => typeof item === "string" && !!item.trim());
  } catch {
    return false;
  }
}

function upstreamHeaders(source: Headers, apiKey: string, context1m: boolean): Headers {
  const headers = new Headers();
  for (const [key, value] of source) {
    const lower = key.toLowerCase();
    if (["authorization", "connection", "content-length", "host", "keep-alive", "transfer-encoding", "x-api-key"].includes(lower)) continue;
    headers.set(key, value);
  }
  if (source.has("x-api-key")) headers.set("x-api-key", apiKey);
  if (source.has("authorization") || !source.has("x-api-key")) headers.set("authorization", `Bearer ${apiKey}`);
  if (context1m) headers.set("anthropic-beta", appendContextBeta(source.get("anthropic-beta")));
  return headers;
}

async function transformedBody(request: Request): Promise<{ body: BodyInit | undefined; context1m: boolean }> {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD") return { body: undefined, context1m: false };
  const raw = await request.arrayBuffer();
  if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return { body: raw, context1m: false };
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw).toString("utf8"));
  } catch {
    throw new Error("请求体不是有效 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { body: raw, context1m: false };
  const body = value as Record<string, unknown>;
  if (typeof body.model !== "string") return { body: raw, context1m: false };
  const stripped = stripContext1mSuffix(body.model);
  if (stripped === body.model) return { body: raw, context1m: false };
  body.model = stripped;
  return { body: JSON.stringify(body), context1m: true };
}

async function proxyAnthropicContext1m(request: Request, provider: { baseUrl: string; apiKey: string }, path: string): Promise<Response> {
  let transformed: Awaited<ReturnType<typeof transformedBody>>;
  try {
    transformed = await transformedBody(request);
  } catch (error) {
    return errorResponse(400, error instanceof Error ? error.message : String(error));
  }
  const relative = path.replace(/^\/+/, "");
  let upstream: Response;
  try {
    upstream = await fetch(`${relayApi(provider.baseUrl)}/${relative}${new URL(request.url).search}`, {
      method: request.method,
      headers: upstreamHeaders(request.headers, provider.apiKey, transformed.context1m),
      body: transformed.body,
      redirect: "manual",
      signal: request.signal,
    });
  } catch (error) {
    return errorResponse(502, `无法连接供应商：${error instanceof Error ? error.message : String(error)}`);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders(upstream.headers, false),
  });
}

export function mountAnthropicContext1mRoutes(api: Hono) {
  const handle = async (c: Context) => {
    const providerId = c.req.param("id");
    if (!providerId) return errorResponse(404, "供应商不存在");
    const provider = (await db.select().from(llmProviders).where(eq(llmProviders.id, providerId))).at(0);
    if (!provider || provider.protocol !== "anthropic" || !hasConfiguredContext1mModels(provider.context1mModels)) {
      return errorResponse(404, "供应商未启用 1M 模型映射");
    }
    if (!provider.apiKey || !secretsEqual(bearerToken(c.req.raw.headers), provider.apiKey)) {
      return errorResponse(401, "供应商 API Key 无效");
    }
    const pathname = new URL(c.req.url).pathname;
    const marker = "/context-1m/v1";
    const markerIndex = pathname.indexOf(marker);
    const path = markerIndex >= 0 ? pathname.slice(markerIndex + marker.length) || "/" : "/";
    return proxyAnthropicContext1m(c.req.raw, provider, path);
  };

  api.all("/llm-providers/:id/context-1m/v1", handle);
  api.all("/llm-providers/:id/context-1m/v1/*", handle);
}
