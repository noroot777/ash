import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { currentListeningPort } from "./listening-port.js";
import { runtimeGateway, runtimeMonitorFallback } from "./runtime-channel-gateway.js";

export const MONITOR_HOOK_PATH = "/api/hooks/claude-monitor";
export const RUNTIME_CHANNEL_SUFFIX = ".runtime-channels.json";
const labels = {
  "context-1m": "模型 1M 中转",
  convert: "模型协议转换",
  monitor: "Claude Monitor HTTP 钩子",
};
type Channel = keyof typeof labels;
const active = new Map<Channel, number>();

export function runtimeAgentChannel(path: string): Channel | null {
  if (path === MONITOR_HOOK_PATH) return "monitor";
  const channel = path.match(/^\/api\/llm-providers\/[^/]+\/(context-1m|convert)(?:\/|$)/)?.[1];
  return channel === "context-1m" || channel === "convert" ? channel : null;
}

export function trackRuntimeChannel(channel: Channel): () => void {
  active.set(channel, (active.get(channel) ?? 0) + 1);
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    const remaining = (active.get(channel) ?? 1) - 1;
    if (remaining) active.set(channel, remaining); else active.delete(channel);
  };
}

export function activeRuntimeChannels(): string[] {
  return [...active.keys()].map((channel) => labels[channel]);
}

export function runtimeChannelFile(out: string): string { return out + RUNTIME_CHANNEL_SUFFIX; }

export function recordRuntimeChannels(cwd: string, args: string[], env: NodeJS.ProcessEnv, out: string): void {
  const channels = new Set<Channel>();
  const stable = new Set<Channel>();
  const gateway = runtimeGateway();
  let unknown = false;
  let monitorGuard = false;
  const scan = (text: string) => {
    for (const match of text.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/[^\s"'\\<>]*/g)) {
      const url = new URL(match[0]);
      const channel = runtimeAgentChannel(url.pathname);
      const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
      if (channel && port === gateway?.port) stable.add(channel);
      else if (channel && port === currentListeningPort()) channels.add(channel);
    }
  };
  for (const value of Object.values(env)) if (value) scan(value);
  let settings: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--settings") {
      settings = args[++index];
      if (settings === undefined) unknown = true;
    }
    else if (args[index].startsWith("--settings=")) settings = args[index].slice("--settings=".length);
    else scan(args[index]);
  }
  if (settings !== undefined) {
    try {
      const text = settings.trim().startsWith("{") ? settings : readFileSync(resolve(cwd, settings), "utf8");
      const parsed = JSON.parse(text);
      scan(JSON.stringify(parsed));
      monitorGuard = parsed.hooks?.PreToolUse?.some((entry: { matcher?: string; hooks?: { type: string; command?: string }[] }) =>
        entry.matcher === "Monitor" && entry.hooks?.some((hook) => hook.type === "command" && hook.command === runtimeMonitorFallback())) ?? false;
    } catch { unknown = true; }
  }
  if (stable.has("monitor") && !monitorGuard) unknown = true;
  writeFileSync(runtimeChannelFile(out), JSON.stringify({ version: 2, channels: [...channels], unknown,
    stable: [...stable], gateway: stable.size ? gateway?.id : undefined }), { mode: 0o600 });
}

export function runtimeChannelReasons(out: string): string[] {
  try {
    const record = JSON.parse(readFileSync(runtimeChannelFile(out), "utf8"));
    if (![1, 2].includes(record.version) || !Array.isArray(record.channels) || typeof record.unknown !== "boolean"
      || record.channels.some((channel: unknown) => typeof channel !== "string" || !Object.hasOwn(labels, channel))) throw new Error("invalid channel record");
    if (record.version === 2 && (!Array.isArray(record.stable)
      || record.stable.some((channel: unknown) => typeof channel !== "string" || !Object.hasOwn(labels, channel))
      || (record.stable.length && typeof record.gateway !== "string"))) throw new Error("invalid stable channels");
    return [...record.channels.map((channel: Channel) => `${labels[channel]}依赖旧服务，需等待本回合结束`),
      ...(record.stable?.length && record.gateway !== runtimeGateway()?.id ? ["稳定服务通道身份已改变，不能无损切换"] : []),
      ...(record.unknown ? ["无法确认启动配置中的服务通道依赖"] : [])];
  } catch { return ["服务通道依赖记录缺失或无效，需等待本回合结束"]; }
}
