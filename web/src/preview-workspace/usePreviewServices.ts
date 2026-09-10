import { useCallback, useEffect, useRef, useState } from "react";
import type { FreeWorkflowPreviewState } from "@ash/shared/free-workflow";
import { request } from "../lib/apiClient.ts";

export function usePreviewServices(taskId: string) {
  const [state, setState] = useState<FreeWorkflowPreviewState | null>(null);
  const [error, setError] = useState("");
  const version = useRef(0);
  const pending = useRef<Promise<void> | null>(null);
  const load = useCallback((force = false): Promise<void> => {
    if (!force && pending.current) return pending.current;
    const ticket = ++version.current;
    const operation = request<FreeWorkflowPreviewState>(`/tasks/${encodeURIComponent(taskId)}/preview`).then((next) => {
      if (ticket === version.current) { setState(next); setError(""); }
    }).catch((reason) => {
      if (ticket === version.current) setError(reason instanceof Error ? reason.message : "读取预览状态失败");
    }).finally(() => { if (pending.current === operation) pending.current = null; });
    pending.current = operation;
    return operation;
  }, [taskId]);
  const refresh = useCallback(() => load(true), [load]);
  useEffect(() => {
    setState(null); setError("");
    void load();
    const timer = window.setInterval(() => void load(), 2500);
    return () => { ++version.current; pending.current = null; window.clearInterval(timer); };
  }, [load]);
  return { state, error, refresh };
}
