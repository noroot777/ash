import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@harness/shared";
import { api } from "./api.ts";
import { useServerEvents } from "./events.ts";
import {
  buildConversationItems,
  type PersistedConversation,
  type TimelineEntry,
} from "../task-detail/conversationModel.ts";

const settledStatuses = new Set(["done", "failed", "canceled", "idle"]);

export function useConversation(taskId: string, revision = 0) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [persisted, setPersisted] = useState<PersistedConversation[]>([]);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const timelineRef = useRef<TimelineEntry[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const replaceTimeline = useCallback((next: TimelineEntry[]) => {
    timelineRef.current = next;
    setTimeline(next);
  }, []);

  const load = useCallback(async (preserveArrivals: boolean) => {
    const cutoff = timelineRef.current.length;
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
      if (preserveArrivals) {
        setTimeline((current) => {
          const next = current.slice(Math.min(cutoff, current.length));
          timelineRef.current = next;
          return next;
        });
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error("会话读取失败"));
    } finally {
      setRefreshing(false);
    }
  }, [taskId]);

  const refetch = useCallback(() => load(true), [load]);

  useEffect(() => {
    replaceTimeline([]);
    void load(false);
  }, [load, replaceTimeline, revision]);

  const connected = useServerEvents(
    useCallback((event) => {
      if (event.type === "agent.event" && event.taskId === taskId) {
        setTimeline((current) => {
          const next = [...current, { kind: "server", id: crypto.randomUUID(), event } as const];
          timelineRef.current = next;
          return next;
        });
        if (event.event.kind === "session") {
          void api.sessions(taskId).then(setSessions).catch(() => undefined);
        }
      }
      if (
        event.type === "task.status" &&
        event.taskId === taskId &&
        settledStatuses.has(event.status)
      ) {
        void load(true);
      }
    }, [load, taskId]),
  );

  const addUser = useCallback((
    text: string,
    attachments: string[] = [],
    options: { answer?: boolean } = {},
  ) => {
    const entry: TimelineEntry = {
      kind: "user",
      id: crypto.randomUUID(),
      text,
      attachments,
      at: new Date().toISOString(),
      isAnswer: options.answer,
    };
    setTimeline((current) => {
      const next = [...current, entry];
      timelineRef.current = next;
      return next;
    });
  }, []);

  const items = useMemo(
    () => buildConversationItems(persisted, sessions, timeline),
    [persisted, sessions, timeline],
  );

  return { sessions, persisted, items, connected, refreshing, error, refetch, addUser };
}
