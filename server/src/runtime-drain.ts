import type { MiddlewareHandler } from "hono";
import { activeRuntimeChannels, runtimeAgentChannel, trackRuntimeChannel } from "./runtime-agent-channels.js";

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

export async function waitRuntimeRequests(timeout = 8_000): Promise<boolean> {
  const until = Date.now() + timeout;
  while ((activeRequests || activeRuntimeChannels().length) && Date.now() < until) await new Promise((done) => setTimeout(done, 25));
  return activeRequests === 0 && activeRuntimeChannels().length === 0;
}

export function runtimeDrainGate(): MiddlewareHandler {
  return async (context, next) => {
    if (!context.req.path.startsWith("/api/") || ["/api/health", "/api/restart-impact", "/api/runtime-handoff"].includes(context.req.path)) {
      return next();
    }
    const channel = runtimeAgentChannel(context.req.path);
    if (runtimeDraining() && !channel) {
      context.header("x-navi-undelivered", "runtime-handoff-v1");
      return context.json({ error: "服务正在切换运行时，请稍后重试；请求未执行" }, 503);
    }
    if (!channel) {
      activeRequests++;
      try { await next(); } finally { activeRequests--; }
      return;
    }
    const finish = trackRuntimeChannel(channel);
    let streaming = false;
    try {
      await next();
      const response = context.res;
      if (!response.body) return;
      const reader = response.body.getReader();
      context.res = new Response(new ReadableStream({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) { finish(); controller.close(); }
            else controller.enqueue(chunk.value);
          } catch (error) { finish(); controller.error(error); }
        },
        async cancel(reason) { try { await reader.cancel(reason); } finally { finish(); } },
      }), { status: response.status, statusText: response.statusText, headers: response.headers });
      streaming = true;
    } finally { if (!streaming) finish(); }
  };
}
