import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODE_DIR, DATA_DIR } from "./paths.js";
import { INSTANCE_ID } from "./instance-binding.js";
import { RuntimeGatewayController, type GatewayOptions } from "./runtime-channel-controller.js";

export { gatewayRequest } from "./runtime-channel-controller.js";
let controller: RuntimeGatewayController | undefined;
let fallbackCommand: string | undefined;

export const runtimeGateway = () => controller?.state;
export const runtimeGatewayOrigin = () => controller?.state ? `http://127.0.0.1:${controller.state.port}` : undefined;
export const runtimeMonitorFallback = () => fallbackCommand;

export async function initializeRuntimeGateway(options: GatewayOptions): Promise<RuntimeGatewayController> {
  const next = new RuntimeGatewayController(options);
  await next.start();
  controller?.close();
  controller = next;
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  fallbackCommand = `${quote(next.node)} ${quote(next.script)} --deny-monitor`;
  return next;
}

export async function startRuntimeGateway(port: number): Promise<void> {
  if (process.platform !== "darwin" || !existsSync(join(CODE_DIR, "runtime-manifest.json"))) return;
  const digest = createHash("sha256").update(DATA_DIR).digest("hex").slice(0, 24);
  await initializeRuntimeGateway({ home: join(DATA_DIR, ".agent-channel-v1"),
    socket: join(tmpdir(), `navi-channel-${process.getuid?.() ?? 0}-${digest}.sock`),
    entry: fileURLToPath(new URL("./runtime-channel-daemon.js", import.meta.url)), node: process.execPath,
    owner: INSTANCE_ID, port, hasConsumers: async (id) => {
      const { isNull } = await import("drizzle-orm");
      const { db } = await import("./db/index.js");
      const { sessions } = await import("./db/schema.js");
      const live = await db.select({ out: sessions.agentOutPath }).from(sessions).where(isNull(sessions.endedAt));
      return live.some(({ out }) => {
        try {
          if (!out) return true;
          const record = JSON.parse(readFileSync(out + ".runtime-channels.json", "utf8"));
          return ![1, 2].includes(record.version) || record.unknown || !Array.isArray(record.channels)
            || (record.version === 2 && (!Array.isArray(record.stable) || (record.stable.length > 0 && record.gateway === id)));
        } catch { return true; }
      });
    } });
}

export async function pauseRuntimeGateway(): Promise<void> { await controller?.pause(); }
export async function resumeRuntimeGateway(): Promise<void> { await controller?.resume(); }
export async function runtimeGatewayIdle(): Promise<boolean> { return controller ? controller.idle() : true; }
