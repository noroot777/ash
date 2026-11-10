import { randomUUID } from "node:crypto";
import { Agent, ProxyAgent, type Dispatcher } from "undici";
import { describeRoute, redactProxy, relayProxyPlan, routeFor, type ProxyPlan, type ProxyRoute } from "./proxy-route.js";
import { refreshSystemProxy } from "./system-proxy.js";

type RelayOptions = { headersTimeoutMs?: number; connectTimeoutMs?: number; bodyTimeoutMs?: number };
type RelayPool = { configuration: string; direct: Agent; proxies: Map<string, ProxyAgent>; agents: Dispatcher[]; agentOptions: Agent.Options };
const dispatchers = new Map<string, RelayPool>();
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
  /** 走的哪条路：`direct` 或脱敏后的代理地址 */
  proxy: string;
  proxySource: string;
  bypass?: ProxyRoute["bypass"];
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

function retireDispatcher(pool: RelayPool): Promise<void> {
  const closing = Promise.all(pool.agents.map((agent) => agent.close())).then(() => {}, () => {});
  closingDispatchers.add(closing);
  void closing.finally(() => closingDispatchers.delete(closing));
  return closing;
}

export async function closeRelayDispatchers(): Promise<void> {
  const current = [...dispatchers.values()];
  dispatchers.clear();
  await Promise.all([...closingDispatchers, ...current.map(retireDispatcher)]);
}

// 每个供应商 origin 一个独立连接池（不和全局 fetch 抢连接），代理方案一变就整池换掉。
function relayPool(upstream: string, plan: ProxyPlan, connectTimeoutMs: number, bodyTimeoutMs: number): RelayPool {
  const configuration = JSON.stringify([plan.key, connectTimeoutMs, bodyTimeoutMs]);
  const existing = dispatchers.get(upstream);
  if (existing?.configuration === configuration) return existing;
  const agentOptions = { allowH2: false, connect: { timeout: connectTimeoutMs }, headersTimeout: 0, bodyTimeout: bodyTimeoutMs };
  const direct = new Agent(agentOptions);
  const pool: RelayPool = { configuration, direct, proxies: new Map(), agents: [direct], agentOptions };
  dispatchers.set(upstream, pool);
  if (existing) void retireDispatcher(existing);
  return pool;
}

function proxyAgent(pool: RelayPool, proxy: string): ProxyAgent {
  let agent = pool.proxies.get(proxy);
  if (!agent) {
    agent = new ProxyAgent({ ...pool.agentOptions, uri: proxy });
    pool.proxies.set(proxy, agent);
    pool.agents.push(agent);
  }
  return agent;
}

// 走不走代理按**每一跳的 origin** 判（重定向到别的主机也照样判），并把实际走的那条路报给这个请求的诊断；
// 判成 blocked 的那一跳直接报错，不落到直连池上。代理池按地址懒建，连接在同一个 pool 里复用。
function routedDispatcher(pool: RelayPool, plan: ProxyPlan, onRoute: (route: ProxyRoute) => void): Dispatcher {
  return pool.direct.compose((dispatch) => (options, handler) => {
    const route = routeFor(plan, new URL(String(options.origin)));
    onRoute(route);
    if (route.blocked) throw Object.assign(new Error("系统代理不可用，拒绝直连"), { code: "ASH_SYSTEM_PROXY_UNAVAILABLE" });
    return route.proxy ? proxyAgent(pool, route.proxy).dispatch(options, handler) : dispatch(options, handler);
  });
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
  let plan: ProxyPlan | null = null;
  let route: ProxyRoute | null = null;
  const routeFields = () => ({
    proxy: route?.proxy ? redactProxy(route.proxy) : "direct",
    proxySource: plan?.label ?? "未解析",
    ...(route?.bypass ? { bypass: route.bypass } : {}),
  });
  const failure = (error: unknown, phase: RelayPhase): RelayRequestError => {
    const canceled = init.signal?.aborted === true;
    const codes = canceled ? ["ABORT_ERR"] : timedOut ? ["ASH_RELAY_HEADERS_TIMEOUT"] : errorCodes(error);
    if (!codes.length) codes.push("NETWORK_ERROR");
    const timeout = timedOut || codes.some((code) => code.includes("TIMEOUT") || code === "ETIMEDOUT");
    const status = canceled ? 499 : timeout ? 504 : 502;
    const reason = canceled ? "请求已取消" : timedOut ? `等待响应头超过 ${timeoutMs}ms`
      : codes.includes("UND_ERR_BODY_TIMEOUT") ? `响应流空闲超过 ${bodyTimeoutMs}ms`
      : codes.includes("ASH_SYSTEM_PROXY_UNAVAILABLE") ? "系统代理不可用"
      : timeout ? "连接超时" : phase === "stream" ? "响应流中断" : "连接失败";
    const diagnostic = { requestId, upstream, method, phase, status, elapsedMs: Date.now() - startedAt, codes, ...routeFields() };
    logDiagnostic(diagnostic);
    // 系统代理可能刚被关掉/换了端口：后台重读一次，下一个请求就按新配置走（这一个不重发，也不改直连）
    if (!canceled && plan?.source === "system") void refreshSystemProxy();
    return new RelayRequestError(diagnostic, plan && route && !canceled ? `${reason}，${describeRoute(plan, route)}` : reason);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    deadline.abort();
  }, timeoutMs);
  timer.unref();
  let response: Response;
  try {
    plan = await relayProxyPlan();
    try { route = routeFor(plan, new URL(url)); } catch { route = null; }
    if (route?.blocked) throw Object.assign(new Error("系统代理不可用，拒绝直连"), { code: "ASH_SYSTEM_PROXY_UNAVAILABLE" });
    const pool = relayPool(upstream, plan, positiveTimeout(options.connectTimeoutMs, 10_000), bodyTimeoutMs);
    const dispatcher = routedDispatcher(pool, plan, (actual) => { route = actual; });
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
    logDiagnostic({ requestId, upstream, method, phase: "headers", status: response.status, elapsedMs: Date.now() - startedAt, codes: [`HTTP_${response.status}`], ...routeFields() });
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
