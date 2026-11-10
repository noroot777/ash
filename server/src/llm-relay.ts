import { randomUUID } from "node:crypto";
import { Agent, ProxyAgent, type Dispatcher } from "undici";
import {
  describeRoute, explicitPortOf, redactProxy, relayProxyPlan, routeFor, routeTarget, type ProxyPlan, type ProxyRoute, type RouteTarget,
} from "./proxy-route.js";
import { refreshSystemProxy } from "./system-proxy.js";

type RelayOptions = { headersTimeoutMs?: number; connectTimeoutMs?: number; bodyTimeoutMs?: number };
type RelayPool = {
  configuration: string;
  direct: Agent;
  /** 按代理地址 + 认证头分（agentKey）；users = 用过它、还没结束的请求数 */
  proxies: Map<string, { agent: ProxyAgent; users: number }>;
  /** 最近一个请求拿到的方案里的代理：不在这里、又没人在用的 ProxyAgent 就关掉（系统代理换了地址/密码） */
  current: Set<string>;
  agentOptions: Agent.Options;
  /** 正在用这个池的请求数（从发出到重定向链走完、响应流结束） */
  users: number;
  /** 已被新池顶替：没人用了就关 */
  retired: boolean;
};
const dispatchers = new Map<string, RelayPool>();
/** 还没关的池，含已被顶替、但仍有在途请求的旧池 */
const openPools = new Set<RelayPool>();
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

function closeAgents(agents: Dispatcher[]): Promise<void> {
  const closing = Promise.all(agents.map((agent) => agent.close())).then(() => {}, () => {});
  closingDispatchers.add(closing);
  void closing.finally(() => closingDispatchers.delete(closing));
  return closing;
}

function retireDispatcher(pool: RelayPool): Promise<void> {
  openPools.delete(pool);
  const agents = [pool.direct, ...[...pool.proxies.values()].map((entry) => entry.agent)];
  pool.proxies.clear();
  return closeAgents(agents);
}

/** 关掉当前方案已经不用、也没有在途请求的 ProxyAgent。之后还有旧方案的请求要走它，会按地址重建一个 */
function pruneProxies(pool: RelayPool): void {
  for (const [proxy, entry] of pool.proxies) {
    if (entry.users > 0 || pool.current.has(proxy)) continue;
    pool.proxies.delete(proxy);
    void closeAgents([entry.agent]);
  }
}

export async function closeRelayDispatchers(): Promise<void> {
  const current = [...openPools];
  dispatchers.clear();
  await Promise.all([...closingDispatchers, ...current.map(retireDispatcher)]);
}

// 每个供应商 origin 一个独立连接池（不和全局 fetch 抢连接）。池只取决于连接参数：走不走代理、走哪个，
// 每一跳都按这个请求自己拿到的 plan 现判（routedDispatcher），所以代理/绕过配置变了不换池，
// 代理地址变了只是在池里多一个 ProxyAgent（旧的那个没人用了就关，见 pruneProxies）。连接参数变了才换池，而旧池要等用它的请求（含整条重定向链和
// 响应流）全部结束才关 —— 提前关，在途请求的下一跳会撞上已关闭的 agent（UND_ERR_CLOSED）。
function acquirePool(upstream: string, connectTimeoutMs: number, bodyTimeoutMs: number, plan: ProxyPlan): RelayPool {
  const configuration = JSON.stringify([connectTimeoutMs, bodyTimeoutMs]);
  let pool = dispatchers.get(upstream);
  if (pool?.configuration !== configuration) {
    const previous = pool;
    const agentOptions = { allowH2: false, connect: { timeout: connectTimeoutMs }, headersTimeout: 0, bodyTimeout: bodyTimeoutMs };
    const direct = new Agent(agentOptions);
    pool = { configuration, direct, proxies: new Map(), current: new Set(), agentOptions, users: 0, retired: false };
    dispatchers.set(upstream, pool);
    openPools.add(pool);
    if (previous) {
      previous.retired = true;
      if (previous.users === 0) void retireDispatcher(previous);
    }
  }
  pool.users += 1;
  if (!pool.retired) {
    pool.current = new Set((["http", "https"] as const).flatMap((scheme) => (plan[scheme] ? [agentKey(plan[scheme], plan.authorization[scheme])] : [])));
    pruneProxies(pool);
  }
  return pool;
}

/** 一个请求对池的占用：池本身，加上它这一路用过的代理 */
type PoolLease = { pool: RelayPool; proxies: Set<string> };

function releasePool({ pool, proxies }: PoolLease): void {
  pool.users -= 1;
  for (const proxy of proxies) {
    const entry = pool.proxies.get(proxy);
    if (entry) entry.users -= 1;
  }
  if (!openPools.has(pool)) return;
  if (pool.retired && pool.users === 0) void retireDispatcher(pool);
  else pruneProxies(pool);
}

/** 同一个代理地址换了凭据（或开关了认证）是另一个 agent：认证头是建 agent 时定下的 */
const agentKey = (proxy: string, authorization: string | undefined) => JSON.stringify([proxy, authorization ?? null]);

// 认证头由 proxy-route.ts 按「开没开认证」给出，显式交给 ProxyAgent（token）。不让 undici 从 URL 里取：它只在
// 用户名和密码都非空时才发，「开了认证、某项或两项留空」就漏了。
function proxyAgent(lease: PoolLease, proxy: string, authorization: string | undefined): ProxyAgent {
  const key = agentKey(proxy, authorization);
  let entry = lease.pool.proxies.get(key);
  if (!entry) {
    entry = { agent: new ProxyAgent({ ...lease.pool.agentOptions, uri: proxy, ...(authorization ? { token: authorization } : {}) }), users: 0 };
    lease.pool.proxies.set(key, entry);
  }
  if (!lease.proxies.has(key)) {
    lease.proxies.add(key);
    entry.users += 1;
  }
  return entry.agent;
}

/**
 * 重定向时记下 Location 原文里端口的写法，下一跳按它判（undici 交给 dispatcher 的 origin 已经规范化，
 * 显式的 `:80`/`:443` 没了）。相对地址沿用这一跳的写法；换了 origin 又没写主机部分的算没写端口。
 */
function recordRedirectPorts(handler: Dispatcher.DispatchHandler, hop: RouteTarget, ports: Map<string, number>): Dispatcher.DispatchHandler {
  return new Proxy(handler, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key !== "onResponseStart" || typeof value !== "function") return typeof value === "function" ? value.bind(target) : value;
      return (...args: Parameters<NonNullable<Dispatcher.DispatchHandler["onResponseStart"]>>) => {
        const [, statusCode, headers] = args;
        const location = headers.location;
        if (statusCode >= 300 && statusCode < 400 && typeof location === "string") {
          try {
            const next = new URL(location, hop.url);
            const written = explicitPortOf(location);
            ports.set(next.origin, written ?? (next.origin === hop.url.origin ? hop.explicitPort : 0));
          } catch { /* 解析不了的 Location 由 fetch 自己报错 */ }
        }
        return value.apply(target, args);
      };
    },
  });
}

// 走不走代理按**每一跳的 origin** 判（重定向到别的主机也照样判），并把实际走的那条路报给这个请求的诊断；
// 判成 blocked 的那一跳直接报错，不落到直连池上。代理池按地址懒建，连接在同一个 pool 里复用。
function routedDispatcher(lease: PoolLease, plan: ProxyPlan, first: RouteTarget, onRoute: (route: ProxyRoute) => void): Dispatcher {
  // 每个 origin 的端口写法：首跳取请求原文，之后取各次重定向的 Location 原文
  const ports = new Map([[first.url.origin, first.explicitPort]]);
  return lease.pool.direct.compose((dispatch) => (options, handler) => {
    const url = new URL(String(options.path ?? "/"), String(options.origin));
    const hop = { url, explicitPort: ports.get(url.origin) ?? 0 };
    const route = routeFor(plan, hop);
    onRoute(route);
    if (route.blocked) throw Object.assign(new Error("系统代理不可用，拒绝直连"), { code: "ASH_SYSTEM_PROXY_UNAVAILABLE" });
    const observed = recordRedirectPorts(handler, hop, ports);
    return route.proxy ? proxyAgent(lease, route.proxy, route.authorization).dispatch(options, observed) : dispatch(options, observed);
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
  let lease: PoolLease | null = null;
  const release = () => {
    if (lease) releasePool(lease);
    lease = null;
  };
  const routeFields = () => ({
    proxy: route?.blocked ? "blocked" : route?.proxy ? redactProxy(route.proxy, !!route.authorization) : "direct",
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
    const target = routeTarget(url);
    route = routeFor(plan, target);
    if (route?.blocked) throw Object.assign(new Error("系统代理不可用，拒绝直连"), { code: "ASH_SYSTEM_PROXY_UNAVAILABLE" });
    lease = { pool: acquirePool(upstream, positiveTimeout(options.connectTimeoutMs, 10_000), bodyTimeoutMs, plan), proxies: new Set() };
    const dispatcher = routedDispatcher(lease, plan, target, (actual) => { route = actual; });
    const requestInit: RequestInit & { dispatcher: Dispatcher } = { ...init, signal, dispatcher };
    response = await fetch(url, requestInit);
  } catch (error) {
    release();
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
    release();
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
          release();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        release();
        if (bodyCanceled) return;
        controller.error(failure(error, "stream"));
      }
    },
    async cancel(reason) {
      bodyCanceled = true;
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
