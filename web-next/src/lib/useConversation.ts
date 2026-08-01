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

  // EventSource callbacks can deliver agent.event + task.status in one React
  // batch. Advance the cursor synchronously so the status-triggered snapshot
  // refresh never captures a stale length and keeps an already persisted event.
  const appendTimeline = useCallback((entry: TimelineEntry) => {
    replaceTimeline([...timelineRef.current, entry]);
  }, [replaceTimeline]);

  const load = useCallback(async (preserveArrivals: boolean) => {
    const cutoff = timelineRef.current.length;
    setRefreshing(true);
    setError(null);
    try {
      const nextSessions = await api.sessions(taskId);
      const outputs = await Promise.all(
        nextSessions.map(async (session) => {
          const [output, trace] = await Promise.all([
            api.sessionOutput(session.id).catch(() => ""),
            api.sessionTrace(session.id).catch(() => []),
          ]);
          return { session, output, trace };
        }),
      );
      setSessions(nextSessions);
      setPersisted(outputs.filter((entry) => entry.output.trim() || entry.trace.length));
      if (preserveArrivals) {
        const current = timelineRef.current;
        replaceTimeline(current.slice(Math.min(cutoff, current.length)));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason : new Error("会话读取失败"));
    } finally {
      setRefreshing(false);
    }
  }, [replaceTimeline, taskId]);

  const refetch = useCallback(() => load(true), [load]);

  useEffect(() => {
    replaceTimeline([]);
    void load(false);
  }, [load, replaceTimeline, revision]);

  const connected = useServerEvents(
    useCallback((event) => {
      if (event.type === "agent.event" && event.taskId === taskId) {
        appendTimeline({
          kind: "server",
          id: crypto.randomUUID(),
          event,
          receivedAt: new Date().toISOString(),
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
    }, [appendTimeline, load, taskId]),
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
    appendTimeline(entry);
  }, [appendTimeline]);

  const items = useMemo(
    () => buildConversationItems(persisted, sessions, timeline),
    [persisted, sessions, timeline],
  );

  return { sessions, persisted, items, connected, refreshing, error, refetch, addUser };
}
