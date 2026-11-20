import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CODE_DIR, DATA_DIR } from "./paths.js";
import { INSTANCE_ID } from "./instance-binding.js";
import { RuntimeGatewayController, type GatewayOptions } from "./runtime-channel-controller.js";
import { hasGatewayConsumers } from "./runtime-channel-consumers.js";

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
  fallbackCommand = `/usr/bin/printf '%s\\n' ${quote(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny",
    permissionDecisionReason: "内置 Monitor 已拒绝；若没有明确代办回执，请先用 Navi list_monitors 核对，避免重复创建哨兵" } }))}`;
  return next;
}

export async function startRuntimeGateway(port: number): Promise<void> {
  if (process.platform !== "darwin" || !existsSync(join(CODE_DIR, "runtime-manifest.json"))) return;
  const digest = createHash("sha256").update(DATA_DIR).digest("hex").slice(0, 24);
  const { resolveNaviDbFile } = await import("./db/path.js");
  const dbFile = resolveNaviDbFile();
  await initializeRuntimeGateway({ home: join(DATA_DIR, ".agent-channel-v1"),
    socket: join(tmpdir(), `navi-channel-${process.getuid?.() ?? 0}-${digest}.sock`),
    entry: fileURLToPath(new URL("./runtime-channel-daemon.js", import.meta.url)), node: process.execPath,
    owner: INSTANCE_ID, port, dbFile, hasConsumers: async (id) => hasGatewayConsumers(dbFile, id) });
}

export async function pauseRuntimeGateway(): Promise<void> { await controller?.pause(); }
export async function resumeRuntimeGateway(): Promise<void> { await controller?.resume(); }
export async function runtimeGatewayIdle(): Promise<boolean> { return controller ? controller.idle() : true; }
