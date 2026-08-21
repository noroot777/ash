import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskStatus } from "@ash/shared";
import { api } from "../lib/api.ts";
import { useServerEvents } from "../lib/events.ts";
import {
  applyDuetEvent,
  emptyDuet,
  rebuildDuetState,
  type DuetState,
  type PersistedDuetEntry,
} from "./duetState.ts";

const REFRESH_STATUSES = new Set<TaskStatus>(["awaiting_review", "done", "failed", "canceled"]);

function mergePersisted(persisted: DuetState, live: DuetState): DuetState {
  const liveKeys = new Set(live.turns.map((turn) => `${turn.round}:${turn.speaker}`));
  return {
    turns: [...persisted.turns.filter((turn) => !liveKeys.has(`${turn.round}:${turn.speaker}`)), ...live.turns],
    gate: live.gate ?? persisted.gate,
  };
}

export function useDuet(taskId: string, status: TaskStatus) {
  const [state, setState] = useState<DuetState>(emptyDuet);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(async (preserveLive = true) => {
    const requestGeneration = generation.current;
    try {
      const entries = await api.duetTranscript(taskId) as PersistedDuetEntry[];
      if (requestGeneration !== generation.current) return;
      const persisted = rebuildDuetState(entries);
      setState((current) => preserveLive && current.turns.some((turn) => !turn.done)
        ? mergePersisted(persisted, current)
        : persisted);
      setError(null);
    } catch (reason) {
      if (requestGeneration === generation.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (requestGeneration === generation.current) setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    generation.current += 1;
    setState(emptyDuet());
    setLoading(true);
    setError(null);
    void load(false);
  }, [load, taskId]);

  useEffect(() => {
    if (REFRESH_STATUSES.has(status)) void load(true);
  }, [load, status]);

  useServerEvents(useCallback((event) => {
    if (
      event.type !== "duet.progress" &&
      event.type !== "duet.gate" &&
      event.type !== "duet.user" &&
      event.type !== "agent.event"
    ) return;
    if (event.taskId !== taskId) return;
    setState((current) => applyDuetEvent(current, event));
  }, [taskId]));

  return { state, loading, error, refetch: load };
}
