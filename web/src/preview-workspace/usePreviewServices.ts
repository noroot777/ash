import { useEffect, useState } from "react";
import type { FreeWorkflowPreviewState } from "@ash/shared/free-workflow";
import { request } from "../lib/apiClient.ts";

export function usePreviewServices(taskId: string) {
  const [state, setState] = useState<FreeWorkflowPreviewState | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let pending = false;
    setState(null); setError("");
    const load = async () => {
      if (pending) return;
      pending = true;
      try {
        const next = await request<FreeWorkflowPreviewState>(`/tasks/${encodeURIComponent(taskId)}/preview`);
        if (active) { setState(next); setError(""); }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : "读取预览状态失败");
      } finally { pending = false; }
    };
    void load();
    const timer = window.setInterval(() => void load(), 2500);
    return () => { active = false; window.clearInterval(timer); };
  }, [taskId]);
  return { state, error };
}
