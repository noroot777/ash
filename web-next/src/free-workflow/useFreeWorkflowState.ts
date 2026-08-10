import { useCallback, useEffect, useState } from "react";
import { api, type FreeWorkflowApiState } from "../lib/api.ts";

export function useFreeWorkflowState(taskId: string, enabled = true) {
  const [state, setState] = useState<FreeWorkflowApiState | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (quiet = false) => {
    if (!enabled) return null;
    if (!quiet) setLoading(true);
    try {
      const next = await api.freeWorkflow(taskId);
      setState(next);
      setError(null);
      return next;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return null;
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [enabled, taskId]);

  useEffect(() => {
    if (!enabled) {
      setState(null);
      setLoading(false);
      return;
    }
    void reload();
    const timer = window.setInterval(() => void reload(true), 2500);
    return () => window.clearInterval(timer);
  }, [enabled, reload]);

  return { state, setState, loading, error, reload };
}
