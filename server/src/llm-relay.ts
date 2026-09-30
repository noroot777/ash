import { randomUUID } from "node:crypto";
import { EnvHttpProxyAgent, type Dispatcher } from "undici";

type RelayOptions = { headersTimeoutMs?: number; connectTimeoutMs?: number; bodyTimeoutMs?: number };
const dispatchers = new Map<string, { configuration: string; dispatcher: EnvHttpProxyAgent }>();
const closingDispatchers = new Set<Promise<void>>();
type RelayPhase = "headers" | "stream";
type RelayDiagnostic = {
  requestId: string;
  upstream: string;
  method: string;
  phase: RelayPhase;
  status: number;
  elapsedMs: number;
  codes: string[];
};

export class RelayRequestError extends Error {
  constructor(readonly diagnostic: RelayDiagnostic, reason: string) {
    super(`无法连接供应商（${diagnostic.upstream}）：${reason}（${diagnostic.codes.join(", ")}；耗时 ${diagnostic.elapsedMs}ms；诊断号 ${diagnostic.requestId}）`);
    this.name = "RelayRequestError";
  }
}

function errorCodes(error: unknown): string[] {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  const codes = new Set<string>();
  for (let index = 0; index < pending.length && index < 16; index += 1) {
    const value = pending[index];
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    const entry = value as { code?: unknown; cause?: unknown; errors?: unknown };
    if (typeof entry.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(entry.code)) codes.add(entry.code);
    if (entry.cause) pending.push(entry.cause);
    if (Array.isArray(entry.errors)) pending.push(...entry.errors.slice(0, 8));
  }
  return [...codes];
}

function positiveTimeout(value: unknown, fallback: number): number {
  const configured = Number(value);
  return Number.isSafeInteger(configured) && configured > 0 && configured <= 2_147_483_647 ? configured : fallback;
}

function retireDispatcher(dispatcher: EnvHttpProxyAgent): Promise<void> {
  const closing = dispatcher.close().catch(() => {});
  closingDispatchers.add(closing);
  void closing.finally(() => closingDispatchers.delete(closing));
  return closing;
}

export async function closeRelayDispatchers(): Promise<void> {
  const current = [...dispatchers.values()];
  dispatchers.clear();
  await Promise.all([...closingDispatchers, ...current.map((entry) => retireDispatcher(entry.dispatcher))]);
}

function relayDispatcher(upstream: string, connectTimeoutMs: number, bodyTimeoutMs: number): Dispatcher {
  const httpProxy = process.env.http_proxy ?? process.env.HTTP_PROXY ?? "";
  const httpsProxy = process.env.https_proxy ?? process.env.HTTPS_PROXY ?? "";
  const configuredNoProxy = process.env.no_proxy ?? process.env.NO_PROXY ?? "";
  const noProxy = configuredNoProxy.trim() === "*" ? "*" : [configuredNoProxy, "localhost", "127.0.0.1", "[::1]"].join(",");
  const configuration = JSON.stringify([httpProxy, httpsProxy, noProxy, connectTimeoutMs, bodyTimeoutMs]);
  const existing = dispatchers.get(upstream);
  if (existing?.configuration === configuration) return existing.dispatcher;
  const dispatcher = new EnvHttpProxyAgent({
    allowH2: false,
    connect: { timeout: connectTimeoutMs },
    headersTimeout: 0,
    bodyTimeout: bodyTimeoutMs,
    httpProxy,
    httpsProxy,
    noProxy,
  });
  dispatchers.set(upstream, { configuration, dispatcher });
  if (existing) void retireDispatcher(existing.dispatcher);
  return dispatcher;
}

function upstreamOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return "无效地址"; }
}

function logDiagnostic(diagnostic: RelayDiagnostic): void {
  console.warn(`[ash][llm-relay] ${JSON.stringify(diagnostic)}`);
}

export function relayErrorResponse(error: unknown): Response {
  if (error instanceof RelayRequestError) {
    return Response.json({ error: { message: error.message, type: "upstream_connection_error" } }, {
      status: error.diagnostic.status,
      headers: { "x-ash-relay-request-id": error.diagnostic.requestId },
    });
  }
  return Response.json({ error: { message: "供应商转发失败", type: "upstream_connection_error" } }, { status: 502 });
}

export async function relayFetch(url: string, init: RequestInit, options: RelayOptions = {}): Promise<Response> {
  const startedAt = Date.now();
  const requestId = randomUUID();
  const upstream = upstreamOrigin(url);
  const method = (init.method ?? "GET").toUpperCase();
  const timeoutMs = positiveTimeout(options.headersTimeoutMs ?? process.env.ASH_LLM_RELAY_HEADERS_TIMEOUT_MS,
    method === "GET" || method === "HEAD" ? 15_000 : 300_000);
  const bodyTimeoutMs = positiveTimeout(options.bodyTimeoutMs ?? process.env.ASH_LLM_RELAY_BODY_TIMEOUT_MS, 300_000);
  const deadline = new AbortController();
  const signal = init.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
  let timedOut = false;
  const failure = (error: unknown, phase: RelayPhase): RelayRequestError => {
    const canceled = init.signal?.aborted === true;
    const codes = canceled ? ["ABORT_ERR"] : timedOut ? ["ASH_RELAY_HEADERS_TIMEOUT"] : errorCodes(error);
    if (!codes.length) codes.push("NETWORK_ERROR");
    const timeout = timedOut || codes.some((code) => code.includes("TIMEOUT") || code === "ETIMEDOUT");
    const status = canceled ? 499 : timeout ? 504 : 502;
    const reason = canceled ? "请求已取消" : timedOut ? `等待响应头超过 ${timeoutMs}ms`
      : codes.includes("UND_ERR_BODY_TIMEOUT") ? `响应流空闲超过 ${bodyTimeoutMs}ms`
      : timeout ? "连接超时" : phase === "stream" ? "响应流中断" : "连接失败";
    const diagnostic = { requestId, upstream, method, phase, status, elapsedMs: Date.now() - startedAt, codes };
    logDiagnostic(diagnostic);
    return new RelayRequestError(diagnostic, reason);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    deadline.abort();
  }, timeoutMs);
  timer.unref();
  let response: Response;
  try {
    const dispatcher = relayDispatcher(upstream, positiveTimeout(options.connectTimeoutMs, 10_000), bodyTimeoutMs);
    const requestInit: RequestInit & { dispatcher: Dispatcher } = { ...init, signal, dispatcher };
    response = await fetch(url, requestInit);
  } catch (error) {
    throw failure(error, "headers");
  } finally {
    clearTimeout(timer);
  }
  const headers = new Headers(response.headers);
  headers.set("x-ash-relay-request-id", requestId);
  if (response.status >= 500) {
    logDiagnostic({ requestId, upstream, method, phase: "headers", status: response.status, elapsedMs: Date.now() - startedAt, codes: [`HTTP_${response.status}`] });
  }
  if (!response.body) {
    return new Response(null, { status: response.status, statusText: response.statusText, headers });
  }
  const reader = response.body.getReader();
  let bodyCanceled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (bodyCanceled) return;
        if (next.done) {
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        if (bodyCanceled) return;
        controller.error(failure(error, "stream"));
      }
    },
    async cancel(reason) {
      bodyCanceled = true;
      await reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
