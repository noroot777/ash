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
import { mergeSessions } from "./sessionMerge.ts";

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
  // 正文不但读完了，而且**整份都读到了**。「哪些问答记录没在正文里出现过」这个判断
  // 只有这时候才算得准：sessions 请求挂了、或者某条会话的正文没读下来，正文里就必然
  // 认不出那几条答复，补渲染会把整段历史当成「没出现过」铺满屏幕——正是这次要消除的形态。
  const [transcriptTaskId, setTranscriptTaskId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [forkBlockedReason, setForkBlockedReason] = useState<string | null>(null);
  const [traceError, setTraceError] = useState<Error | null>(null);
  const loadToken = useRef(0);

  // sessions 有两个写者：load() 的全量重读，和直播事件顺手补的那一发轻量刷新。
  //
  // 它们一旦**同时在途**，客户端就再也分不出谁读得更晚：服务端没给会话行发版本号，
  // context 这类覆盖值更没法靠大小判新旧（它会合法地降下来、甚至变成 null）。所以这里
  // 不去猜，而是干脆不让它们并发——每一发都排在上一发落地之后才出门。于是「后出门的
  // 必然读得更晚」成立，「迟到的旧响应」这种情况根本不存在。
  //
  // 代价只有一点点延迟，而且排队期间挤进来的刷新会被折叠成一发：它们要的是同一份最新
  // 状态，连发 N 次没有意义。
  const sessionsChain = useRef<Promise<unknown>>(Promise.resolve());
  const refreshQueued = useRef(false);
  // 出门顺序 = 读取顺序（上面那条链保证的），所以这个号大的那份一定更新。
  const sessionsSeq = useRef(0);
  const appliedSeq = useRef(0);

  const fetchSessions = useCallback((onStart?: () => void) => {
    const run = () => {
      onStart?.();
      const seq = ++sessionsSeq.current;
      return api.sessions(taskId).then((list) => ({ seq, sessions: list }));
    };
    // 前一发**不论成败**都要把链往下传，否则一次失败就把后面所有刷新卡死。
    const next = sessionsChain.current.then(run, run);
    sessionsChain.current = next.then(() => undefined, () => undefined);
    return next;
  }, [taskId]);

  // 链上排在后面的那份已经写进去了，就别再拿更早读到的这份往回盖。同一个任务内的两份
  // 快照仍按数据合并（服务端的 usage / context 分两步落库，读到中间态是常事），规则在
  // sessionMerge.ts。
  const applySessions = useCallback((seq: number, next: Session[]) => {
    if (seq <= appliedSeq.current) return;
    appliedSeq.current = seq;
    setSessions((current) => mergeSessions(current, next));
  }, []);

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
      const { seq, sessions: nextSessions } = await fetchSessions();
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
      // 正文那份（persisted）只有 load() 一个写者，token 已经保证它是最新的一轮；
      // sessions 另有直播刷新这个写者——正文读得慢的时候，它那一发可能已经带着更新的
      // 快照写进去了，所以这里要按出门顺序让位。
      applySessions(seq, nextSessions);
      if (outputFailures) setForkBlockedReason(`${outputFailures} 个会话的正文暂未读全，派生功能暂不可用；刷新会话可重试。`);
      if (traceFailures) setTraceError(new Error(`${traceFailures} 个会话的执行过程读取失败，子智能体与内部任务记录可能不完整。`));
      setPersisted(outputs.filter((entry) => entry.output.trim() || entry.trace.length));
      setLoadedTaskId(taskId);
      // 正文缺了一块就不算读全。trace 读失败不影响：那是执行过程，不是会话正文。
      if (outputFailures) setTranscriptTaskId((current) => current === taskId ? null : current);
      else setTranscriptTaskId(taskId);
      if (preserveArrivals) {
        const current = timelineRef.current;
        replaceTimeline(current.slice(Math.min(cutoff, current.length)));
      }
    } catch (reason) {
      if (token !== loadToken.current) return;
      setError(reason instanceof Error ? reason : new Error("会话读取失败"));
      // 读失败也是「这一轮结束了」：错误要显示、空态提示不能再冒出来。但正文没到手，
      // 去重算不了，transcriptTaskId 保持不动。
      setLoadedTaskId(taskId);
      setTranscriptTaskId((current) => current === taskId ? null : current);
    } finally {
      if (token === loadToken.current) setRefreshing(false);
    }
  }, [applySessions, fetchSessions, replaceTimeline, taskId]);

  const refetch = useCallback(() => load(true), [load]);

  // 直播事件也会顺手补一发 sessions。跨任务仍由代号兜住：切走之后才回来的那一发直接
  // 丢掉，否则它会把上一个任务的会话盖到当前任务上——那时 ready 已经是 true，页面不会
  // 有任何「还在读」的迹象。同一个任务之内按出门顺序排队，见 fetchSessions。
  const refreshSessions = useCallback(() => {
    // 已经有一发排着了：它出门时读到的就是此刻之后的状态，再排一发没有意义。
    if (refreshQueued.current) return;
    refreshQueued.current = true;
    const token = loadToken.current;
    void fetchSessions(() => { refreshQueued.current = false; }).then(
      ({ seq, sessions: next }) => { if (token === loadToken.current) applySessions(seq, next); },
      () => undefined,
    );
  }, [applySessions, fetchSessions]);

  useEffect(() => {
    // 换任务先清空：合并只在同一个任务内做，跨任务的在途请求由代号挡在外面。
    // 排队也不跨任务——旧任务那几发的结果反正会被代号丢掉，没必要让新任务等它们。
    sessionsChain.current = Promise.resolve();
    refreshQueued.current = false;
    appliedSeq.current = 0;
    setSessions([]);
    setPersisted([]);
    setLoadedTaskId(null);
    setTranscriptTaskId(null);
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
        refreshSessions();
      }
      if (event.type === "agent.event" && event.taskId === taskId) {
        appendTimeline({
          kind: "server",
          id: createClientId(),
          event,
        });
        if (event.event.kind === "session") {
          refreshSessions();
        }
      }
      if (
        event.type === "task.status" &&
        event.taskId === taskId &&
        settledStatuses.has(event.status)
      ) {
        void load(true);
      }
    }, [appendTimeline, appendUserTurn, load, refreshSessions, taskId]),
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
  // 读全了才谈得上「哪些问答没出现在正文里」：ready 只说明这一轮读完了，可能是读失败结束的。
  const transcriptReady = ready && transcriptTaskId === taskId;
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
    transcriptReady,
    error: ready ? error : null,
    traceError: ready ? traceError : null,
    forkBlockedReason: ready ? forkBlockedReason : null,
    refetch,
    addUser,
  };
}
