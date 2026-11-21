import type { MiddlewareHandler } from "hono";
import { activeRuntimeChannels, runtimeAgentChannel, trackRuntimeChannel } from "./runtime-agent-channels.js";
import { runtimeGatewayIdle } from "./runtime-channel-gateway.js";
import { runtimeHandoverActive } from "./runtime-handover-state.js";

let activeRequests = 0;

export async function waitRuntimeRequests(timeout = 8_000): Promise<boolean> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (activeRequests === 0 && activeRuntimeChannels().length === 0 && await runtimeGatewayIdle()) return true;
    await new Promise((done) => setTimeout(done, 25));
  }
  return false;
}

export function runtimeHandoverGate(): MiddlewareHandler {
  return async (context, next) => {
    if (!context.req.path.startsWith("/api/") || ["/api/health", "/api/restart-impact", "/api/runtime-handover"].includes(context.req.path)) return next();
    const channel = runtimeAgentChannel(context.req.path);
    if (runtimeHandoverActive()) {
      if (channel === "monitor") return context.json({ hookSpecificOutput: { hookEventName: "PreToolUse",
        permissionDecision: "deny", permissionDecisionReason: "服务正在切换，Monitor 未执行，请用 Navi start_monitor" } });
      context.header("x-navi-undelivered", "runtime-handoff-v1");
      return context.json({ error: "服务正在切换，请求未执行" }, 503);
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
