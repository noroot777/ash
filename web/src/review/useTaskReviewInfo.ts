import { useCallback, useEffect, useState } from "react";
import type { TaskReviewInfo } from "@ash/shared";
import { api } from "../lib/api.ts";
import { useServerEvents } from "../lib/events.ts";

export function useTaskReviewInfo(taskId: string) {
  const [info, setInfo] = useState<TaskReviewInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      setInfo(await api.taskReview(taskId));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    setInfo(null);
    setError(null);
    void load();
  }, [load]);

  useServerEvents(useCallback((event) => {
    if ((event.type === "task.review" || event.type === "task.stage") && event.taskId === taskId) {
      void load(true);
    }
  }, [load, taskId]));

  return { info, loading, error, load };
}
