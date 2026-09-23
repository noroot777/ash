import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ANSWER_PREFIX, type Session } from "@ash/shared";
import { api } from "./api.ts";
import { useServerEvents } from "./events.ts";
import {
  buildConversationItems,
  type PersistedConversation,
  type TimelineEntry,
} from "../task-detail/conversationModel.ts";
import { parseAttachmentText } from "../task-detail/utils.ts";
import { createClientId } from "./clientId.ts";

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
  // 已经读完、且读的就是当前这个任务的正文。切任务时 state 还留着上一个任务的
  // sessions/persisted，重置要等 effect 跑完——那之间渲染出来的会话是**别人的**。
  // 判据放在渲染期而不是 effect 里，上一任务的正文一帧都不会漏出去。
  const [loadedTaskId, setLoadedTaskId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [forkBlockedReason, setForkBlockedReason] = useState<string | null>(null);
  const [traceError, setTraceError] = useState<Error | null>(null);
  const loadToken = useRef(0);

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
    const token = ++loadToken.current;
    setRefreshing(true);
    setError(null);
    setTraceError(null);
    setForkBlockedReason(null);
    try {
      const nextSessions = await api.sessions(taskId);
      let traceFailures = 0;
      let outputFailures = 0;
      const outputs = await Promise.all(
        nextSessions.map(async (session) => {
          const [output, trace] = await Promise.all([
            api.sessionOutput(session.id).catch(() => { outputFailures += 1; return ""; }),
            api.sessionTrace(session.id).catch(() => { traceFailures += 1; return []; }),
          ]);
          return { session, output, trace };
        }),
      );
      // 切任务后旧任务的这一发才回来：全部丢掉，否则它会盖掉新任务已经读好的正文。
      if (token !== loadToken.current) return;
      setSessions(nextSessions);
      if (outputFailures) setForkBlockedReason(`${outputFailures} 个会话的正文暂未读全，派生功能暂不可用；刷新会话可重试。`);
      if (traceFailures) setTraceError(new Error(`${traceFailures} 个会话的执行过程读取失败，子智能体与内部任务记录可能不完整。`));
      setPersisted(outputs.filter((entry) => entry.output.trim() || entry.trace.length));
      setLoadedTaskId(taskId);
      if (preserveArrivals) {
        const current = timelineRef.current;
        replaceTimeline(current.slice(Math.min(cutoff, current.length)));
      }
    } catch (reason) {
      if (token !== loadToken.current) return;
      setError(reason instanceof Error ? reason : new Error("会话读取失败"));
      setLoadedTaskId(taskId);
    } finally {
      if (token === loadToken.current) setRefreshing(false);
    }
  }, [replaceTimeline, taskId]);

  const refetch = useCallback(() => load(true), [load]);

  useEffect(() => {
    setSessions([]);
    setPersisted([]);
    setLoadedTaskId(null);
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
          id: createClientId(),
          event,
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
      id: createClientId(),
      text,
      attachments,
      at: new Date().toISOString(),
      isAnswer: options.answer,
      source: "optimistic",
    };
    appendUserTurn(entry);
  }, [appendUserTurn]);

  const ready = loadedTaskId === taskId;
  const items = useMemo(
    () => ready ? buildConversationItems(persisted, sessions, timeline) : [],
    [persisted, ready, sessions, timeline],
  );

  return {
    sessions: ready ? sessions : [],
    persisted: ready ? persisted : [],
    items,
    connected,
    // 没读完就是没读完:切任务后的第一帧 refreshing 还是上一次读完时的 false,
    // 只看它会让空态提示("点击运行开始")闪一下。
    refreshing: refreshing || !ready,
    ready,
    error: ready ? error : null,
    traceError: ready ? traceError : null,
    forkBlockedReason: ready ? forkBlockedReason : null,
    refetch,
    addUser,
  };
}
