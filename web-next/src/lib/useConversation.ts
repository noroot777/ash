import { useCallback, useEffect, useState } from "react";
import type { ServerEvent, Session } from "@harness/shared";
import { api } from "./api.ts";
import { useServerEvents } from "./events.ts";

export type PersistedConversation = {
  session: Session;
  output: string;
};

export type LiveAgentEvent = Extract<ServerEvent, { type: "agent.event" }>;

const settledStatuses = new Set(["done", "failed", "canceled", "idle"]);

export function useConversation(taskId: string, revision = 0) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [persisted, setPersisted] = useState<PersistedConversation[]>([]);
  const [liveEvents, setLiveEvents] = useState<LiveAgentEvent[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const nextSessions = await api.sessions(taskId);
      const outputs = await Promise.all(
        nextSessions.map(async (session) => ({
          session,
          output: await api.sessionOutput(session.id).catch(() => ""),
        })),
      );
      setSessions(nextSessions);
      setPersisted(outputs.filter((entry) => entry.output.trim()));
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error("会话读取失败"));
    } finally {
      setRefreshing(false);
    }
  }, [taskId]);

  useEffect(() => {
    setLiveEvents([]);
    void refetch();
  }, [refetch, revision]);

  const connected = useServerEvents(
    useCallback((event) => {
      if (event.type === "agent.event" && event.taskId === taskId) {
        setLiveEvents((current) => [...current, event]);
      }
      if (
        event.type === "task.status" &&
        event.taskId === taskId &&
        settledStatuses.has(event.status)
      ) {
        void refetch();
      }
    }, [refetch, taskId]),
  );

  return { sessions, persisted, liveEvents, connected, refreshing, error, refetch };
}
