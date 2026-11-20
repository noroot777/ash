import type { MiddlewareHandler } from "hono";

let deadline = 0;
let activeRequests = 0;
let lease: NodeJS.Timeout | undefined;
const cleanups = new Set<() => void>();
export const runtimeDraining = () => Date.now() < deadline;
export const beginRuntimeDrain = () => {
  deadline = Date.now() + 30_000;
  clearTimeout(lease);
  lease = setTimeout(endRuntimeDrain, 30_000);
  lease.unref();
};
export const endRuntimeDrain = () => {
  deadline = 0;
  clearTimeout(lease);
  for (const cleanup of cleanups) cleanup();
  cleanups.clear();
};
export const onRuntimeDrainEnd = (cleanup: () => void) => { cleanups.add(cleanup); };

export async function waitRuntimeRequests(): Promise<boolean> {
  const until = Date.now() + 8_000;
  while (activeRequests && Date.now() < until) await new Promise((done) => setTimeout(done, 25));
  return activeRequests === 0;
}

export function runtimeDrainGate(): MiddlewareHandler {
  return async (context, next) => {
    if (!context.req.path.startsWith("/api/") || ["/api/health", "/api/restart-impact", "/api/runtime-handoff"].includes(context.req.path)) {
      return next();
    }
    if (runtimeDraining()) {
      context.header("x-navi-undelivered", "runtime-handoff-v1");
      return context.json({ error: "服务正在切换运行时，请稍后重试；请求未执行" }, 503);
    }
    activeRequests++;
    try { await next(); } finally { activeRequests--; }
  };
}
