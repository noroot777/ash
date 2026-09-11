import type { FreeWorkflowPreviewState } from "@ash/shared/free-workflow";
import { alive, hasPreviewLog, lastPreview, readAnyPreview, type PreviewRecord } from "./preview-store.js";
import { starting } from "./preview-start-state.js";

export function previewBase(record: PreviewRecord, serviceId: string): string {
  return `/preview/${record.taskId}/${record.proxyToken}/${serviceId}/`;
}

export function previewState(taskId: string): FreeWorkflowPreviewState {
  const current = readAnyPreview(taskId);
  const record = current ?? lastPreview(taskId);
  const launching = starting.has(taskId) || current?.state === "starting";
  const services = record?.services?.map((s) => ({
    id: s.id, name: s.name, command: s.cmd, port: s.port,
    status: current && s.status === "ready" && !alive(s.pid) ? "failed" as const : s.status,
    url: current && s.status === "ready" && alive(s.pid) && s.url
      ? record.proxyToken ? `/api/tasks/${record.taskId}/preview/open/${s.id}` : s.url
      : null,
  })) ?? [];
  const primary = services.find((s) => s.id === record?.primaryServiceId) ?? services[0];
  return {
    gen: current?.gen ?? null,
    running: !!current || launching, starting: launching && current?.state !== "ready", hasLog: hasPreviewLog(taskId),
    url: current?.state !== "starting" ? services.length ? primary?.url ?? null : current?.url ?? null : null,
    port: current?.port ?? null, command: record?.cmd ?? null, startedAt: current?.startedAt ?? null,
    services, proxied: !!current?.proxyToken,
  };
}
