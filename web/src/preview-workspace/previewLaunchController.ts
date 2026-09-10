import type { WorkspacePreviewInput, WorkspacePreviewLaunch } from "@ash/shared/preview";
import { json, request } from "../lib/apiClient.ts";

export interface PreviewLaunchState {
  info: WorkspacePreviewLaunch | null;
  loading: boolean;
  action: "opening" | "canceling" | null;
  error: string;
  notice: string;
}

export function createPreviewLaunchController(taskId: string, refresh: () => Promise<void>, send = request) {
  const path = `/tasks/${encodeURIComponent(taskId)}`;
  let state: PreviewLaunchState = { info: null, loading: true, action: null, error: "", notice: "" };
  let active = false;
  let operation = 0;
  let reading = 0;
  let pendingLoad: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const patch = (values: Partial<PreviewLaunchState>) => {
    if (!active) return;
    state = { ...state, ...values }; listeners.forEach((listener) => listener());
  };
  const message = (error: unknown) => error instanceof Error ? error.message : String(error);
  const load = (): Promise<void> => {
    if (pendingLoad) return pendingLoad;
    const ticket = ++reading;
    const operation = send<WorkspacePreviewLaunch>(`${path}/preview?launch=1`).then((info) => {
      if (ticket === reading) patch({ info, loading: false });
    }).catch((error) => { if (ticket === reading) patch({ error: message(error), loading: false }); })
      .finally(() => { if (pendingLoad === operation) pendingLoad = null; });
    pendingLoad = operation;
    return operation;
  };
  const owns = (ticket: number) => active && operation === ticket;
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    snapshot: () => state,
    activate() { active = true; void load(); },
    dispose() { active = false; ++operation; ++reading; pendingLoad = null; },
    load,
    async start(input: Omit<WorkspacePreviewInput, "workspace">, starting: boolean) {
      if (!active || starting || state.action || !state.info || state.info.reason) return;
      const ticket = ++operation;
      patch({ action: "opening", error: "", notice: "" });
      try {
        const endpoint = state.info.kind === "free" ? "free-workflow/preview" : "preview/restart";
        await send(`${path}/${endpoint}`, json("POST", { ...input, workspace: true }));
        if (owns(ticket)) { patch({ notice: "预览已就绪，正在接入页面…" }); await refresh(); }
      } catch (error) { if (owns(ticket)) patch({ error: message(error) }); }
      finally {
        if (owns(ticket)) { patch({ action: null }); await refresh(); await load(); }
      }
    },
    async cancel() {
      if (!active || state.action === "canceling") return;
      const ticket = ++operation;
      patch({ action: "canceling", error: "", notice: "" });
      try {
        await send(`${path}/preview`, json("DELETE"));
        if (owns(ticket)) patch({ notice: "预览启动已取消，可重新选择候选。" });
      } catch (error) { if (owns(ticket)) patch({ error: message(error) }); }
      finally {
        if (owns(ticket)) { patch({ action: null }); await refresh(); await load(); }
      }
    },
  };
}
