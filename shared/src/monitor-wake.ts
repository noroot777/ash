import { MONITOR_MAX_MERGED_CHARS } from "./monitor.ts";

export type MonitorWakeEvent = {
  kind: "output" | "ended";
  monitorId: string;
  source: string;
  body: string;
  bodyTruncated?: true;
};

export type MonitorWakeData = {
  version: 1;
  events: MonitorWakeEvent[];
  omittedEvents: number;
  checkpoint?: string;
};

export function readMonitorWake(value: unknown): MonitorWakeData | null {
  if (!value || typeof value !== "object") return null;
  const data = value as MonitorWakeData;
  if (data.version !== 1 || !Array.isArray(data.events) || !data.events.length
    || !Number.isSafeInteger(data.omittedEvents) || data.omittedEvents < 0
    || (data.checkpoint !== undefined && typeof data.checkpoint !== "string")) return null;
  if (!data.events.every((event) => event && (event.kind === "output" || event.kind === "ended")
    && typeof event.monitorId === "string" && !!event.monitorId
    && typeof event.source === "string" && typeof event.body === "string"
    && (event.bodyTruncated === undefined || event.bodyTruncated === true))) return null;
  return data;
}

export function appendMonitorWake(previous: MonitorWakeData | null, event: MonitorWakeEvent): MonitorWakeData {
  const bodyTruncated = event.body.length > MONITOR_MAX_MERGED_CHARS;
  const events = [...(previous?.events ?? []), {
    ...event, body: event.body.slice(0, MONITOR_MAX_MERGED_CHARS), ...(bodyTruncated ? { bodyTruncated: true as const } : {}),
  }];
  let omittedEvents = previous?.omittedEvents ?? 0;
  const inputSize = (current: MonitorWakeEvent) => `【哨兵事件】${current.source}（monitorId=${current.monitorId}）\n${current.body}\n\n`.length;
  let size = events.reduce((sum, current) => sum + inputSize(current), 0);
  while (events.length > 1 && (size > MONITOR_MAX_MERGED_CHARS || events.length > 100)) {
    size -= inputSize(events.shift()!);
    omittedEvents += 1;
  }
  return { version: 1, events, omittedEvents };
}

export function monitorWakeForDelivery(
  data: MonitorWakeData | null | undefined,
  checkpoint?: string,
): MonitorWakeData | undefined {
  const input = readMonitorWake(data);
  return input ? { ...input, ...(checkpoint ? { checkpoint } : {}) } : undefined;
}
