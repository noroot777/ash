import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AnnotationBatchRecord } from "@ash/shared/page-annotation-batch";
import type { AnnotationReviewStatus, AnnotationVerdict } from "@ash/shared/page-annotation-review";
import { createReviewStatusReader } from "./reviewStatusReader.ts";
import { api } from "../lib/api.ts";
import { json, request } from "../lib/apiClient.ts";
import { useServerEvents } from "../lib/events.ts";
import { reopenDismissed, reopenPreferenceEvent, setReopenDismissed } from "./reopenPreference.ts";

export function useAnnotationReview(taskId: string) {
  const [status, setStatus] = useState<AnnotationReviewStatus | null>(null);
  const [dismissed, setDismissed] = useState(() => reopenDismissed(taskId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const reader = useMemo(() => createReviewStatusReader(() => request<AnnotationReviewStatus>(`/tasks/${encodeURIComponent(taskId)}/annotation-review-status`)), [taskId]);
  const inFlight = useRef(false);
  const refresh = useCallback(async () => {
    try {
      const next = await reader.read();
      if (!alive.current || !next) return null;
      setStatus(next); return next;
    } catch (reason) {
      if (alive.current) { setStatus(null); setError(String(reason)); }
      return null;
    }
  }, [reader]);
  const connected = useServerEvents((event) => {
    if ("taskId" in event && event.taskId === taskId && ["task.pendingMessages", "task.status", "task.review"].includes(event.type)) {
      reader.invalidate(); setStatus(null); void refresh();
    }
  });
  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2500);
    const preference = () => setDismissed(reopenDismissed(taskId));
    window.addEventListener(reopenPreferenceEvent, preference);
    window.addEventListener("storage", preference);
    return () => {
      alive.current = false; reader.invalidate(); window.clearInterval(timer);
      window.removeEventListener(reopenPreferenceEvent, preference); window.removeEventListener("storage", preference);
    };
  }, [taskId, refresh, reader]);
  const dismiss = (value = true) => { setDismissed(value); setReopenDismissed(taskId, value); };
  const reopen = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const current = await refresh();
      if (!current?.canReopen || !alive.current) { if (alive.current) setError(current?.reason || "无法确认回合状态，请稍后重试"); return; }
      // Both existing entry points retain their lifecycle, free-workflow lock and rerun gate.
      if (current.previewKind === "free") await api.startFreePreview(taskId);
      else await request(`/tasks/${encodeURIComponent(taskId)}/preview/restart`, json("POST", {}));
      if (alive.current) await refresh();
    } catch (reason) { if (alive.current) setError(String(reason)); }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  };
  const decide = async (record: AnnotationBatchRecord, itemId: string, verdict: AnnotationVerdict, gen: string) => {
    if (inFlight.current) return null;
    inFlight.current = true; setBusy(true); setError("");
    try {
      const next = await request<AnnotationBatchRecord>(`/tasks/${encodeURIComponent(taskId)}/annotation-batches/${encodeURIComponent(record.batch.id)}/review/${encodeURIComponent(itemId)}`,
        json("PUT", { verdict, gen }));
      return alive.current ? next : null;
    } catch (reason) { if (alive.current) setError(`复看结果未保存：${String(reason)}`); return null; }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  };
  return { status, busy, error, dismissed, dismiss, reopen, decide, canPrompt: connected && !!status?.canReopen && !dismissed };
}
