// 会话渲染层：把「快照(.md) + 实时流(SSE)」拼成一串会话条目，再画成气泡。
//
// 从 TaskDetail.tsx 拆出来的，因为 /team 的调度台流(web/src/team/TeamFeed.tsx)要
// 复用同一套渲染 —— 调度者的回合、用户插话、系统提示在两个界面里必须长得一模一样。
// 纯展示 + 纯数据装配，不碰 api，也不知道自己被谁用。
import { useCallback, useEffect, useState, type ReactNode, type RefObject } from "react";
import type { Task, Session, AgentType } from "@harness/shared";
import { parseSessionOutput as parseSnapshot } from "@harness/shared";
import { ArrowDown, ArrowUp, ArrowsClockwise } from "@phosphor-icons/react";
import { ToolCall, ThinkingBlock, ResumeCopyButtons, CopyButton } from "./ui";
import { Markdown } from "./Markdown";
import { formatInstant, Duration } from "./time";
import { executorLabel } from "./executorLabel";
import { AttachmentDisplay, parseAttachmentText } from "./messageAttachments";
import { liveLogsAfterSnapshot } from "./conversationDedup";

export type LogLine = {
  kind: "text" | "thinking" | "tool" | "error" | "done" | "user" | "system";
  text: string;
  name?: string; // tool name (for kind "tool")
  agent?: AgentType; // which agent produced it (for @-mention multi-agent threads)
  sessionId?: string; // the run/session this line belongs to (groups lines into bubbles + finds the credential)
  at?: string; // ISO time the line was added (user replies show "你 · 时间")
  attachments?: string[]; // optimistic user turn; snapshots carry these inside text
};

// Render the run as a conversation of bubbles (mirrors the debate view). A contiguous run
// of one session's output is one left-aligned agent bubble — merged Markdown,
// collapsible tools/thinking, and a slim resume/id/time footer for that run.
// Human replies are right-aligned bubbles; an @-mention handoff just starts a new
// bubble carrying the new executor's label. The per-session snapshot (prior
// output at load) and the live stream are stitched into the SAME bubble when they
// belong to the same run, so reloading a running task never shows a stale + live
// duplicate.
export type AgentItem = {
  kind: "agent";
  sessionId?: string;
  agent?: AgentType;
  session?: Session;
  showResume?: boolean; // only the run's LAST bubble carries the resume credential
  label: string;
  time?: string | null; // run start (header shows 开始时刻 · 用时)
  endedAt?: string | null; // run end (real, or estimated from the next run's start) for a static 用时
  markerEndedAt?: string | null; // exec end stamped by the .md agentEnd marker — preferred over the wall-clock estimate when present (excludes the idle wait until the next reply)
  snapshotText?: string; // raw snapshot markdown (rendered + serialized for copy)
  lines: LogLine[]; // live lines, rendered via groupContent
};
export type ConvItem =
  | AgentItem
  | { kind: "user"; text: string; at?: string; attachments?: string[] }
  | { kind: "system"; text: string; at?: string }
  | { kind: "done"; text: string; at?: string };

// parseSnapshot / Seg / LEGACY_SYS_MARKER 已上移到 @harness/shared
// （parseSessionOutput, ConvSeg），web 与 mobile 共用同一份解析逻辑，避免漂移。

// Assemble the run into a flat list of conversation items (snapshot + live stream
// stitched per session) with per-turn timing. Pure data — no JSX — so the same
// list drives both rendering and copy/export serialization.
export function buildConversation({
  task,
  snapshot,
  logs,
  snapshotLogCutoff = 0,
  snapshotDedupeThrough = snapshotLogCutoff,
  sessions,
  primaryAgent,
}: {
  task: Task;
  snapshot: { s: Session; out: string }[];
  logs: LogLine[];
  snapshotLogCutoff?: number;
  snapshotDedupeThrough?: number;
  sessions: Session[];
  primaryAgent: AgentType;
}): ConvItem[] {
  // The end fallback for a run's LAST turn, when the session itself recorded none:
  // the next run's start (it was superseded then), else the task's own end. The
  // per-turn ends below come from the interjection markers; this is only the tail.
  // Never "now", so nothing ticks in a finished, historical view.
  const byStart = [...sessions].sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
  const runEnd = new Map<string, string | null>();
  byStart.forEach((s, i) => runEnd.set(s.id, s.endedAt ?? byStart[i + 1]?.startedAt ?? task.endedAt ?? null));

  const items: ConvItem[] = [];
  for (const { s, out } of snapshot) {
    // One session can yield several bubbles — agent turns split by 你→/〔系统〕
    // interjections. Each turn is its own bubble; per-turn 用时 is assigned in the
    // timing pass below. The run's credential (resume/id) rides only its LAST turn.
    const segs = parseSnapshot(out);
    const lastAgent = segs.reduce((acc, seg, i) => (seg.kind === "agent" ? i : acc), -1);
    segs.forEach((seg, i) => {
      if (seg.kind === "user") return void items.push({ kind: "user", text: seg.text, at: seg.at });
      if (seg.kind === "system") return void items.push({ kind: "system", text: seg.text, at: seg.at });
      items.push({
        kind: "agent",
        sessionId: s.id,
        agent: s.agentType,
        session: s,
        showResume: i === lastAgent,
        label: s.executor,
        snapshotText: seg.text,
        markerEndedAt: seg.endedAt ?? null, // real exec end (agentEnd marker), when present
        lines: [],
      });
    });
  }
  // A manual refresh replaces the live prefix with a newer persisted snapshot.
  // Text that arrived while the request was in flight may already be in that
  // snapshot too, so trim the covered tail before continuing the live stream.
  const liveLogs = liveLogsAfterSnapshot(snapshot, logs, snapshotLogCutoff, snapshotDedupeThrough);

  // Continue into the last snapshot bubble if the live stream resumes that run.
  const last = items[items.length - 1];
  let cur: AgentItem | null = last && last.kind === "agent" ? last : null;
  for (const l of liveLogs) {
    if (l.kind === "user") {
      items.push({ kind: "user", text: l.text, at: l.at, attachments: l.attachments });
      cur = null;
      continue;
    }
    if (l.kind === "system") {
      items.push({ kind: "system", text: l.text, at: l.at });
      cur = null;
      continue;
    }
    if (l.kind === "done") {
      items.push({ kind: "done", text: l.text });
      cur = null;
      continue;
    }
    // text / thinking / tool / error → part of the current run's bubble
    if (!cur || cur.sessionId !== l.sessionId || cur.agent !== l.agent) {
      const sess = l.sessionId ? sessions.find((s) => s.id === l.sessionId) : undefined;
      cur = { kind: "agent", sessionId: l.sessionId, agent: l.agent, session: sess, showResume: true, label: executorLabel({ session: sess, agentType: l.agent ?? primaryAgent }), lines: [] };
      items.push(cur);
    }
    cur.lines.push(l);
  }

  // Per-turn timing. A resumed session shows as several bubbles, and each must
  // carry ITS OWN 用时 — not the whole session's span (which would print the same
  // total on every bubble). A turn (re)starts at the 你→/〔系统〕 interjection just
  // before it (or its session's start, for the first turn) and ends at the
  // interjection/exit marker just after it (or runEnd, for the last). Two ordered
  // passes over the assembled items so it covers snapshot + live alike; a session
  // change with no marker between (a new run, an @-invited agent) resets the
  // bracket so one run's clock never bleeds into the next.
  let prevAt: string | null = null; // 'at' of the interjection before the current turn
  const seen = new Set<string>();
  for (const it of items) {
    if (it.kind === "user" || it.kind === "system") prevAt = it.at ?? prevAt;
    if (it.kind !== "agent") continue;
    const firstOfRun = !it.sessionId || !seen.has(it.sessionId);
    if (it.sessionId) seen.add(it.sessionId);
    it.time = firstOfRun ? it.session?.startedAt ?? null : prevAt ?? it.session?.startedAt ?? null;
  }
  let nextAt: string | null = null; // 'at' of the interjection/exit after the current turn
  let rightRun: string | undefined; // sessionId of the run to the right (detect run changes)
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "user" || it.kind === "system" || it.kind === "done") nextAt = it.at ?? nextAt;
    if (it.kind !== "agent") continue;
    if (it.sessionId !== rightRun) (nextAt = null), (rightRun = it.sessionId); // new run → fresh bracket
    // Prefer the agentEnd marker (real exec end, idle excluded); fall back to the
    // wall-clock estimate (next interjection / runEnd) for historical turns that
    // predate the marker.
    it.endedAt = it.markerEndedAt ?? nextAt ?? (it.sessionId ? runEnd.get(it.sessionId) ?? null : null);
  }

  return items;
}

// One item's plain body text — the agent's markdown + only its live `text` lines,
// the user's reply, or a 〔系统〕 marker. Folded 思考/工具/错误 are intentionally
// omitted (用户选「仅对话正文」). Shared by per-bubble copy and full export.
export function itemBodyText(it: ConvItem): string {
  if (it.kind === "user") return parseAttachmentText(it.text).body;
  if (it.kind === "system") return `〔系统〕${it.text}`;
  if (it.kind === "done") return "";
  const live = it.lines.filter((l) => l.kind === "text").map((l) => l.text).join("");
  return [it.snapshotText ?? "", live].filter(Boolean).join("\n\n");
}

// The whole conversation as Markdown: title (+ objective), then one section per
// turn carrying its speaker and time. Empty turns and 结束 markers are dropped.
export function conversationToText(items: ConvItem[], task: Task): string {
  const parts: string[] = [`# ${task.title}`];
  if (task.body?.trim()) parts.push(`> ${task.body.trim().replace(/\n/g, "\n> ")}`);
  for (const it of items) {
    if (it.kind === "system") {
      parts.push(`_〔系统〕${it.text}${it.at ? ` · ${formatInstant(it.at)}` : ""}_`);
      continue;
    }
    if (it.kind === "done") continue;
    const body = itemBodyText(it).trim();
    if (!body) continue;
    const who = it.kind === "user" ? "你" : it.label;
    const when = (it.kind === "user" ? it.at : it.time) ?? null;
    parts.push(`## ${who}${when ? ` · ${formatInstant(when)}` : ""}\n\n${body}`);
  }
  return parts.join("\n\n") + "\n";
}

// Export the conversation as a downloaded .md file (client-side Blob, no server).
export function downloadConversation(items: ConvItem[], task: Task) {
  const name = (task.title || task.id).replace(/[\\/:*?"<>|]/g, "_").slice(0, 80).trim() || "conversation";
  const blob = new Blob([conversationToText(items, task)], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Render the assembled conversation: agent runs as left bubbles, human replies as
// right bubbles, interjections as centered markers. Each agent/user bubble gets a
// hover copy affordance (copies that turn's plain body).
export function Conversation({ items }: { items: ConvItem[] }) {
  return (
    <>
      {items.map((it, i) => (
        <ConvBubble key={i} item={it} />
      ))}
    </>
  );
}

// Floating shortcuts shared by every conversation-shaped scroll container.
// Scroll events drive the edge state; DOM/size observers keep it correct while
// streaming content grows without requiring each caller to thread a content key.
export function ConversationScrollButtons({
  scrollRef,
  threshold = 80,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  threshold?: number;
}) {
  const [edges, setEdges] = useState({ atTop: true, atBottom: true });
  const updateEdges = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const next = {
      atTop: el.scrollTop <= threshold,
      atBottom: el.scrollHeight - el.scrollTop - el.clientHeight <= threshold,
    };
    setEdges((prev) => (prev.atTop === next.atTop && prev.atBottom === next.atBottom ? prev : next));
  }, [scrollRef, threshold]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const scheduleUpdate = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateEdges();
      });
    };
    const resizeObserver = new ResizeObserver(scheduleUpdate);
    const mutationObserver = new MutationObserver(scheduleUpdate);
    el.addEventListener("scroll", scheduleUpdate, { passive: true });
    resizeObserver.observe(el);
    mutationObserver.observe(el, { childList: true, characterData: true, subtree: true });
    scheduleUpdate();
    return () => {
      el.removeEventListener("scroll", scheduleUpdate);
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scrollRef, updateEdges]);

  const scrollTo = (top: number) => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scrollRef.current?.scrollTo({ top, behavior: reducedMotion ? "auto" : "smooth" });
  };
  const buttonClass =
    "absolute left-1/2 z-10 grid h-8 w-8 -translate-x-1/2 place-items-center rounded-full border border-line bg-panel/70 text-muted shadow-sm backdrop-blur-sm transition-[opacity,transform,background-color,color] duration-200 hover:bg-panel/95 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 motion-reduce:transition-none";

  return (
    <>
      <button
        type="button"
        onClick={() => scrollTo(0)}
        tabIndex={edges.atTop ? -1 : 0}
        aria-hidden={edges.atTop}
        aria-label="滚动到会话顶部"
        title="滚动到顶部"
        className={`${buttonClass} top-3 ${edges.atTop ? "pointer-events-none -translate-y-1 opacity-0" : "opacity-80 hover:opacity-100"}`}
      >
        <ArrowUp size={16} weight="bold" />
      </button>
      <button
        type="button"
        onClick={() => scrollTo(scrollRef.current?.scrollHeight ?? 0)}
        tabIndex={edges.atBottom ? -1 : 0}
        aria-hidden={edges.atBottom}
        aria-label="滚动到会话底部"
        title="滚动到底部"
        className={`${buttonClass} bottom-3 ${edges.atBottom ? "pointer-events-none translate-y-1 opacity-0" : "opacity-80 hover:opacity-100"}`}
      >
        <ArrowDown size={16} weight="bold" />
      </button>
    </>
  );
}

// 单个会话条目 → 气泡。抽成组件是因为 /team 的流(web/src/team/TeamFeed.tsx)要在
// 同一串条目里插自己的东西(派活卡、入站气泡),没法整段交给 <Conversation>,但气泡
// 长相必须一模一样。
export function ConvBubble({ item: it }: { item: ConvItem }) {
  if (it.kind === "user") return <UserBubble text={it.text} at={it.at} attachments={it.attachments} />;
  if (it.kind === "system") return <SystemNote text={it.text} at={it.at} />;
  if (it.kind === "done") return <div className="my-2 text-center text-xs text-faint">{it.text}</div>;
  const nodes = [
    ...(it.snapshotText ? [<Markdown key="snap" text={it.snapshotText} />] : []),
    ...groupContent(it.lines),
  ];
  if (!nodes.length) return null;
  return (
    <AgentBubble label={it.label} time={it.time} endedAt={it.endedAt} session={it.session} showResume={it.showResume} copyText={itemBodyText(it)}>
      {nodes}
    </AgentBubble>
  );
}

// Inner nodes of one agent bubble: consecutive text merges into a Markdown block,
// tools/thinking are collapsible, errors show inline red.
export function groupContent(lines: LogLine[]): ReactNode[] {
  const nodes: ReactNode[] = [];
  let buf = "";
  let k = 0;
  const flush = () => {
    if (buf.trim()) nodes.push(<Markdown key={`t${k++}`} text={buf} />);
    buf = "";
  };
  for (const l of lines) {
    if (l.kind === "text") {
      buf += l.text; // pieces already carry their own breaks; concat verbatim (matches mobile + delta streaming)
      continue;
    }
    flush();
    if (l.kind === "tool") nodes.push(<ToolCall key={`x${k++}`} name={l.name ?? "tool"} detail={l.text} />);
    else if (l.kind === "thinking") nodes.push(<ThinkingBlock key={`x${k++}`} text={l.text} />);
    else if (l.kind === "error") nodes.push(<div key={`x${k++}`} className="my-1 break-words text-xs text-red-600">✕ {l.text}</div>);
  }
  flush();
  return nodes;
}

// One agent turn / run: left-aligned card whose header carries the run's
// executor · 开始时刻 · 用时 (static — a finished run never ticks; an interrupted
// run's 用时 is bounded by the next run's start), the content, and — on the run's
// LAST bubble only — the resume/id credential.
export function AgentBubble({
  label,
  time,
  endedAt,
  session,
  showResume,
  copyText,
  children,
}: {
  label?: string;
  time?: string | null;
  endedAt?: string | null;
  session?: Session;
  showResume?: boolean;
  copyText?: string;
  children: ReactNode;
}) {
  return (
    <div className="group mb-3">
      <div className="rounded-lg border border-line bg-raised/40 px-3 py-2">
        <div className="mb-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted">
          <span className="font-medium text-ink/70">{label || "智能体"}</span>
          {time && (
            <>
              <span className="text-faint">·</span>
              <span className="text-faint">{formatInstant(time)}</span>
            </>
          )}
          {time && endedAt && (
            <>
              <span className="text-faint">·</span>
              <span className="inline-flex items-center gap-0.5 text-faint" title={`开始 ${formatInstant(time)} · 结束 ${formatInstant(endedAt)}`}>
                ⏱ <Duration from={time} to={endedAt} /> 用时
              </span>
            </>
          )}
          {copyText && (
            <CopyButton
              text={copyText}
              title="复制这条"
              className="ml-auto h-6 w-6 opacity-0 hover:bg-raised group-hover:opacity-100"
            />
          )}
        </div>
        {children}
        {showResume && session && (session.resumeCommand || session.cliSessionId) && (
          <div className="mt-1.5 flex items-center gap-1.5 text-[10px]">
            <ResumeCopyButtons s={session} />
          </div>
        )}
      </div>
    </div>
  );
}

// A backend interjection (e.g. 〔系统〕继续) — a centered, divider-flanked note so
// it reads as a timeline marker between turns, not as agent or human speech.
export function SystemNote({ text, at }: { text: string; at?: string }) {
  return (
    <div className="my-3 flex min-w-0 items-center gap-2 text-[11px] text-faint">
      <span className="h-px min-w-3 flex-1 bg-line" />
      <span className="inline-flex min-w-0 max-w-[85%] flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 rounded-lg border border-line bg-raised/40 px-2.5 py-1">
        <ArrowsClockwise size={11} className="shrink-0" />
        <span className="min-w-0 break-words text-center">{text}</span>
        {at && (
          <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap">
            <span className="text-line2">·</span>
            <span>{formatInstant(at)}</span>
          </span>
        )}
      </span>
      <span className="h-px min-w-3 flex-1 bg-line" />
    </div>
  );
}

// A human reply / continuation: right-aligned bubble with "你 · 时间".
export function UserBubble({ text, at, attachments = [] }: { text: string; at?: string; attachments?: string[] }) {
  const parsed = parseAttachmentText(text);
  const paths = [...parsed.paths, ...attachments];
  return (
    <div className="group mb-3 flex flex-col items-end">
      <div className="max-w-[88%] rounded-lg border border-accent/30 bg-accent/[0.08] px-3 py-2">
        <div className="mb-1 flex items-center gap-2 text-[11px] text-muted">
          <span className="font-medium text-ink/70">你</span>
          {at && (
            <>
              <span className="text-faint">·</span>
              <span className="text-faint">{formatInstant(at)}</span>
            </>
          )}
          {parsed.body && (
            <CopyButton
              text={parsed.body}
              title="复制这条"
              className="ml-auto h-6 w-6 opacity-0 hover:bg-overlay group-hover:opacity-100"
            />
          )}
        </div>
        {parsed.body && <div className="whitespace-pre-wrap break-words text-[13px] text-ink">{parsed.body}</div>}
        <AttachmentDisplay paths={paths} className={parsed.body ? "mt-2" : ""} />
      </div>
    </div>
  );
}
