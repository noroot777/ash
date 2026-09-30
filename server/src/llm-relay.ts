import { randomUUID } from "node:crypto";
import { EnvHttpProxyAgent, type Dispatcher } from "undici";

type RelayOptions = { headersTimeoutMs?: number; connectTimeoutMs?: number };
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

function headersTimeout(method: string, override?: number): number {
  const configured = override ?? Number(process.env.ASH_LLM_RELAY_HEADERS_TIMEOUT_MS);
  if (Number.isSafeInteger(configured) && configured > 0 && configured <= 2_147_483_647) return configured;
  return method === "GET" || method === "HEAD" ? 15_000 : 300_000;
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
  const timeoutMs = headersTimeout(method, options.headersTimeoutMs);
  const deadline = new AbortController();
  const signal = init.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal;
  let timedOut = false;
  let dispatcher: Dispatcher | undefined;
  let disposed = false;
  let abortListener: (() => void) | undefined;
  const dispose = async (destroy: boolean): Promise<void> => {
    if (disposed) return;
    disposed = true;
    if (abortListener) init.signal?.removeEventListener("abort", abortListener);
    if (dispatcher) await (destroy ? dispatcher.destroy() : dispatcher.close()).catch(() => {});
  };
  const failure = (error: unknown, phase: RelayPhase): RelayRequestError => {
    const canceled = init.signal?.aborted === true;
    const codes = canceled ? ["ABORT_ERR"] : timedOut ? ["ASH_RELAY_HEADERS_TIMEOUT"] : errorCodes(error);
    if (!codes.length) codes.push("NETWORK_ERROR");
    const timeout = timedOut || codes.some((code) => code.includes("TIMEOUT") || code === "ETIMEDOUT");
    const status = canceled ? 499 : timeout ? 504 : 502;
    const reason = canceled ? "请求已取消" : timedOut ? `等待响应头超过 ${timeoutMs}ms`
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
    const noProxy = process.env.no_proxy ?? process.env.NO_PROXY ?? "";
    dispatcher = new EnvHttpProxyAgent({
      allowH2: false,
      connections: 1,
      connect: { timeout: options.connectTimeoutMs ?? 10_000 },
      headersTimeout: 0,
      bodyTimeout: 0,
      noProxy: noProxy.trim() === "*" ? "*" : [noProxy, "localhost", "127.0.0.1", "[::1]"].join(","),
    });
    const requestInit: RequestInit & { dispatcher: Dispatcher } = { ...init, signal, dispatcher };
    response = await fetch(url, requestInit);
  } catch (error) {
    clearTimeout(timer);
    await dispose(true);
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
    await dispose(false);
    return new Response(null, { status: response.status, statusText: response.statusText, headers });
  }
  const reader = response.body.getReader();
  let bodyCanceled = false;
  abortListener = () => { void dispose(true); };
  init.signal?.addEventListener("abort", abortListener, { once: true });
  if (init.signal?.aborted) abortListener();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (bodyCanceled) return;
        if (next.done) {
          await dispose(false);
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        await dispose(true);
        if (bodyCanceled) return;
        controller.error(failure(error, "stream"));
      }
    },
    async cancel(reason) {
      bodyCanceled = true;
      try { await reader.cancel(reason); } finally { await dispose(true); }
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
