import type { Hono } from "hono";
import { DESKTOP_APP } from "./local-only.js";
import { INSTANCE_ID } from "./instance-binding.js";
import { liveLockToken } from "./singleton.js";
import { isLocalDirect } from "./auth/remote-access.js";
import { secretsEqual } from "./openai-converter/common.js";
import { NAVI_HEADERS, requestHeader } from "./request-headers.js";
import { heldTurns } from "./turn-lock.js";
import { releaseRuntimeHandover, runtimeHandoverActive, runtimeHandoverMatches } from "./runtime-handover-state.js";
import { resumeRuntimeGateway } from "./runtime-channel-gateway.js";
import { acquireRuntimeHandover } from "./runtime-handover.js";
import { checkpointRuntimeHandover, sealRuntimeHandover } from "./runtime-handover-prepare.js";
import { runtimeCompatibility, type RuntimeCompatibility } from "./runtime-compatibility.js";

export function mountRuntimeHandoverRoutes(api: Hono) {
  api.post("/runtime-handover", async (context) => {
    const token = liveLockToken();
    if (process.platform !== "darwin" || !DESKTOP_APP || !isLocalDirect(context) || !token
      || !secretsEqual(requestHeader(context, NAVI_HEADERS.hostToken) ?? "", token)
      || requestHeader(context, NAVI_HEADERS.instance) !== INSTANCE_ID) {
      return context.json({ error: "没有接管这份服务的权限" }, 403);
    }
    const body = await context.req.json<Partial<RuntimeCompatibility> & { release?: string; check?: string }>().catch(() => ({} as Partial<RuntimeCompatibility> & { release?: string; check?: string }));
    if (body.release) {
      const released = releaseRuntimeHandover(body.release);
      if (!runtimeHandoverActive()) {
        try { await resumeRuntimeGateway(); }
        catch (error) { return context.json({ released, error: `旧服务已解封，但通道恢复失败：${String(error)}` }, 503); }
      }
      return context.json({ released });
    }
    if (body.check) return context.json({ valid: runtimeHandoverMatches(body.check) });
    const { restartImpact } = await import("./reattach.js");
    try {
      const current = runtimeCompatibility();
      const result = await acquireRuntimeHandover(() => restartImpact(body), heldTurns, {
        seal: sealRuntimeHandover,
        async checkpoint(impact, lease) {
          await checkpointRuntimeHandover(impact, lease);
        },
      });
      return context.json({ ...result, protocol: current.protocol }, result.lease ? 200 : 409);
    } catch (error) {
      return context.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });
}
