import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ANSWER_PREFIX, type Session } from "@harness/shared";
import { api } from "./api.ts";
import { useServerEvents } from "./events.ts";
import {
  buildConversationItems,
  type PersistedConversation,
  type TimelineEntry,
} from "../task-detail/conversationModel.ts";
import { parseAttachmentText } from "../task-detail/utils.ts";

const settledStatuses = new Set(["done", "failed", "canceled", "idle"]);
const SAME_TURN_WINDOW_MS = 30_000;

function userTurnSignature(entry: Extract<TimelineEntry, { kind: "user" }>): string {
  const parsed = parseAttachmentText(entry.text);
  const paths = [...parsed.paths, ...entry.attachments].map((path) => path.trim()).filter(Boolean).sort();
  return `${parsed.body.replace(/\s+/g, "")}\0${paths.join("\0")}`;
}

function sameUserTurn(
  left: Extract<TimelineEntry, { kind: "user" }>,
  right: Extract<TimelineEntry, { kind: "user" }>,
): boolean {
  if (!!left.bySystem !== !!right.bySystem || userTurnSignature(left) !== userTurnSignature(right)) return false;
  const delta = Math.abs(Date.parse(left.at) - Date.parse(right.at));
  return Number.isFinite(delta) && delta <= SAME_TURN_WINDOW_MS;
}

export function mergeUserTimeline(
  current: TimelineEntry[],
  entry: Extract<TimelineEntry, { kind: "user" }>,
): TimelineEntry[] {
  let match = -1;
  for (let index = current.length - 1; index >= 0; index -= 1) {
    const candidate = current[index];
    if (candidate?.kind === "user" && candidate.source !== entry.source && sameUserTurn(candidate, entry)) {
      match = index;
      break;
    }
  }
  if (match < 0) return [...current, entry];
  if (entry.source !== "server") return current;
  const next = [...current];
  next[match] = entry;
  return next;
}

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

  const appendUserTurn = useCallback((entry: Extract<TimelineEntry, { kind: "user" }>) => {
    replaceTimeline(mergeUserTimeline(timelineRef.current, entry));
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
      if (event.type === "conversation.turn" && event.taskId === taskId) {
        appendUserTurn({
          kind: "user",
          id: `server:${event.sessionId}:${event.at}`,
          text: event.text,
          attachments: [],
          at: event.at,
          isAnswer: event.text.startsWith(ANSWER_PREFIX),
          bySystem: event.bySystem,
          source: "server",
        });
        void api.sessions(taskId).then(setSessions).catch(() => undefined);
      }
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
    }, [appendTimeline, appendUserTurn, load, taskId]),
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
      source: "optimistic",
    };
    appendUserTurn(entry);
  }, [appendUserTurn]);

  const items = useMemo(
    () => buildConversationItems(persisted, sessions, timeline),
    [persisted, sessions, timeline],
  );

  return { sessions, persisted, items, connected, refreshing, error, refetch, addUser };
}
