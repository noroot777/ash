import type { RestartImpact } from "./reattach.js";
import { assertRuntimeCompatibility, runtimeCompatibility, type RuntimeCompatibility } from "./runtime-compatibility.js";
import { runtimeGatewayUnavailable } from "./runtime-channel-gateway.js";

export async function preflightRuntimeHandover(impact: RestartImpact, next?: Partial<RuntimeCompatibility>): Promise<void> {
  const eligibility = impact.runtimeHandover;
  if (!eligibility) return;
  if (next) {
    if (next.protocol === 1 && typeof next.schema === "string" && /^[a-f0-9]{64}$/.test(next.schema)) {
      eligibility.target = { protocol: next.protocol, schema: next.schema };
    }
    try { assertRuntimeCompatibility(runtimeCompatibility(), next, impact.survives.length > 0); }
    catch (error) {
      eligibility.blocked.push({ id: "runtime-compatibility", title: "新版兼容性",
        reason: error instanceof Error ? error.message : String(error) });
    }
  }
  const unavailable = await runtimeGatewayUnavailable();
  if (unavailable) eligibility.blocked.push({ id: "runtime-gateway", title: "稳定通道", reason: unavailable });
}
