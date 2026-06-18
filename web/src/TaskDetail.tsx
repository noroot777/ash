import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Task, Group, Session, TaskStatus, Priority, AgentType } from "@harness/shared";
import { isUserSettableStatus, AGENT_TYPES } from "@harness/shared";
import { CaretDown, Play, Stop, Trash, ArrowsDownUp, Robot, X } from "@phosphor-icons/react";
import { api } from "./api";
import { STATUSES, PRIORITIES } from "./constants";
import { ToolCall, ThinkingBlock, ResumeButtons, CollapsibleText } from "./ui";
import { Markdown } from "./Markdown";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon, LabelAdder } from "./ui";
import { ScheduleControl } from "./ScheduleControl";
import { Menu } from "./Menu";
import { runAction, canStopTask } from "./taskActions";
import { groupLabel } from "./util";
import { TaskTimes, formatInstant } from "./time";
import { usePasteImages, ImageChips } from "./pasteImages";

export type LogLine = {
  kind: "text" | "thinking" | "tool" | "error" | "done" | "user";
  text: string;
  name?: string; // tool name (for kind "tool")
  agent?: AgentType; // which agent produced it (for @-mention multi-agent threads)
  sessionId?: string; // the run/session this line belongs to (groups lines into bubbles + finds the credential)
  at?: string; // ISO time the line was added (user replies show "你 · 时间")
};

export function TaskDetail({
  task,
  groups,
  allTasks,
  logs,
  sessionsBump,
  onRun,
  onStop,
  onReply,
  onPatch,
  onCreateGroup,
  onDelete,
}: {
  task: Task;
  groups: Group[];
  allTasks: Task[];
  logs: LogLine[];
  sessionsBump: number;
  onRun: () => void;
  onStop: () => void;
  onReply: (text: string, opts?: { images?: string[]; agent?: AgentType }) => void;
  onPatch: (patch: Partial<Task>) => void;
  onCreateGroup: () => void;
  onDelete: () => void;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [snapshot, setSnapshot] = useState<{ s: Session; out: string }[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.sessions(task.id).then(setSessions);
  }, [task.id, sessionsBump]);

  // Snapshot of prior output, taken once per task when there are no in-memory
  // live logs (i.e. a reload / fresh navigation). Per session, so each run
  // becomes its own bubble carrying its own resume credential. Sticky: a later
  // reply (which fills logs) must not wipe it, so prior context stays above the
  // new turns.
  useEffect(() => {
    setSnapshot([]);
    if (logs.length > 0) return;
    let alive = true;
    api.sessions(task.id).then(async (ss) => {
      const withOut = await Promise.all(
        ss.map(async (s) => ({ s, out: await api.sessionOutput(s.id).catch(() => "") })),
      );
      if (alive) setSnapshot(withOut.filter(({ out }) => out.trim()));
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [logs.length, snapshot.length]);

  const depOptions = allTasks.filter((t) => t.id !== task.id && !task.dependsOn.includes(t.id));

  return (
    <main className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line px-6 pb-3 pt-5">
        <div className="flex items-start gap-3">
          <EditableTitle title={task.title} onSave={(t) => onPatch({ title: t, autoTitle: false })} />
          {canStopTask(task.status) ? (
            <button
              onClick={onStop}
              className="inline-flex items-center gap-1.5 rounded-md border border-red-500/40 px-3 py-1.5 text-[13px] font-medium text-red-600 transition-colors hover:bg-red-500/10"
            >
              <Stop size={13} weight="fill" />
              停止
            </button>
          ) : (
            (() => {
              const a = runAction(task.status);
              return (
                <button
                  onClick={onRun}
                  disabled={!a.canClick}
                  className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-fg transition-colors hover:bg-accent-hover disabled:opacity-40 disabled:hover:bg-accent"
                >
                  <Play size={13} weight="fill" />
                  {a.label}
                </button>
              );
            })()
          )}
          <button
            onClick={onDelete}
            className="grid h-[30px] w-[30px] place-items-center rounded-md text-muted transition-colors hover:bg-raised hover:text-red-600"
            title="删除任务"
          >
            <Trash size={15} />
          </button>
        </div>

        {/* Task objective — shown right under the title (collapsed to 2 lines;
            click 展开 for the full text). */}
        {task.body && <CollapsibleText text={task.body} />}

        {/* All controls on one wrapping row: attributes | labels | deps·schedule | session */}
        <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-2 text-[12px]">
          <div className="flex flex-wrap items-center gap-1.5">
            <Prop
              value={task.status}
              onChange={(v) => onPatch({ status: v as TaskStatus })}
              options={STATUSES.filter((s) => isUserSettableStatus(s.key) || s.key === task.status).map((s) => ({ value: s.key, label: s.label }))}
              leading={(v) => <StatusIcon status={v as TaskStatus} size={13} />}
            />
            <Prop
              value={task.priority}
              onChange={(v) => onPatch({ priority: v as Priority })}
              options={PRIORITIES.map((p) => ({ value: p.key, label: p.label }))}
              leading={(v) => <PriorityIcon p={v as Priority} />}
            />
            <Prop
              value={task.groupId ?? ""}
              onChange={(v) => (v === "__new" ? onCreateGroup() : onPatch({ groupId: v || null }))}
              options={[
                { value: "", label: "无分组" },
                ...groups.map((g) => ({ value: g.id, label: groupLabel(g) })),
                { value: "__new", label: "+ 新建分组" },
              ]}
            />
          </div>

          <span className="h-4 w-px bg-line" />
          <div className="flex flex-wrap items-center gap-1.5">
            {task.labels.map((l) => (
              <button
                key={l}
                onClick={() => onPatch({ labels: task.labels.filter((x) => x !== l) })}
                className="rounded-full bg-overlay px-2 py-0.5 text-[11px] text-ink transition hover:bg-line2"
                title="点击移除"
              >
                {l}
              </button>
            ))}
            <LabelAdder onAdd={(l) => !task.labels.includes(l) && onPatch({ labels: [...task.labels, l] })} />
          </div>

          <span className="h-4 w-px bg-line" />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <ArrowsDownUp size={13} className="text-faint" />
              <span className="text-muted">依赖</span>
              {task.dependsOn.map((d) => {
                const dep = allTasks.find((t) => t.id === d);
                return (
                  <button
                    key={d}
                    onClick={() => onPatch({ dependsOn: task.dependsOn.filter((x) => x !== d) })}
                    className="rounded bg-overlay px-1.5 py-0.5 text-ink transition hover:bg-line2"
                    title="点击移除依赖"
                  >
                    {dep?.title ?? d}
                  </button>
                );
              })}
              {depOptions.length > 0 && (
                <Prop
                  value=""
                  onChange={(v) => v && onPatch({ dependsOn: [...task.dependsOn, v] })}
                  options={[{ value: "", label: "+ 添加" }, ...depOptions.map((t) => ({ value: t.id, label: t.title }))]}
                />
              )}
              {task.dependsOn.length === 0 && depOptions.length === 0 && <span className="text-faint">无</span>}
            </div>
            <ScheduleControl taskId={task.id} />
          </div>

          {/* Who will run this — shown only until the first run exists. The live
              run credentials (resume / id / time) now live per-bubble in the
              conversation below, not crammed into this header row. */}
          {sessions.length === 0 && (
            <>
              <span className="h-4 w-px bg-line" />
              <span className="text-faint">
                将由 <b className="text-muted">@{task.agentType ?? "claude"}</b> 执行
              </span>
            </>
          )}
        </div>

        <TaskTimes task={task} />
      </header>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto break-words px-6 py-4 text-[13px] leading-relaxed"
      >
        {/* The run as a conversation: prior output (snapshotted per session on
            load) and the live stream merge into one bubble per run, so a running
            task you reload doesn't split into a stale + live pair. */}
        <Conversation snapshot={snapshot} logs={logs} sessions={sessions} primaryAgent={task.agentType ?? "claude"} />
        {snapshot.length === 0 && logs.length === 0 && (
          <p className="font-sans text-faint">点击「运行」开始，输出会实时流式显示在这里。</p>
        )}
      </div>

      {task.mode === "single" && (sessions.length > 0 || snapshot.length > 0 || logs.length > 0) && (
        <ReplyBox onReply={onReply} disabled={task.status === "running" || task.status === "queued"} />
      )}
    </main>
  );
}

// Render the run as a conversation of bubbles (mirrors /pair). A contiguous run
// of one session's output is one left-aligned agent bubble — merged Markdown,
// collapsible tools/thinking, and a slim resume/id/time footer for that run.
// Human replies are right-aligned bubbles; an @-mention handoff just starts a new
// bubble carrying the new executor's label. The per-session snapshot (prior
// output at load) and the live stream are stitched into the SAME bubble when they
// belong to the same run, so reloading a running task never shows a stale + live
// duplicate.
type AgentItem = {
  kind: "agent";
  sessionId?: string;
  agent?: AgentType;
  session?: Session;
  label: string;
  time?: string | null;
  nodes: ReactNode[]; // pre-rendered snapshot content
  lines: LogLine[]; // live lines, rendered via groupContent
};
type ConvItem = AgentItem | { kind: "user"; text: string; at?: string } | { kind: "done"; text: string };

function Conversation({
  snapshot,
  logs,
  sessions,
  primaryAgent,
}: {
  snapshot: { s: Session; out: string }[];
  logs: LogLine[];
  sessions: Session[];
  primaryAgent: AgentType;
}) {
  const items: ConvItem[] = [];
  for (const { s, out } of snapshot) {
    items.push({ kind: "agent", sessionId: s.id, agent: s.agentType, session: s, label: s.executor, time: s.startedAt, nodes: [<Markdown key="snap" text={out} />], lines: [] });
  }
  // Continue into the last snapshot bubble if the live stream resumes that run.
  const last = items[items.length - 1];
  let cur: AgentItem | null = last && last.kind === "agent" ? last : null;
  for (const l of logs) {
    if (l.kind === "user") {
      items.push({ kind: "user", text: l.text, at: l.at });
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
      cur = { kind: "agent", sessionId: l.sessionId, agent: l.agent, session: sess, label: sess?.executor ?? `@${l.agent ?? primaryAgent}`, time: sess?.startedAt, nodes: [], lines: [] };
      items.push(cur);
    }
    cur.lines.push(l);
  }

  return (
    <>
      {items.map((it, i) => {
        if (it.kind === "user") return <UserBubble key={i} text={it.text} at={it.at} />;
        if (it.kind === "done") return <div key={i} className="my-2 text-center text-xs text-faint">{it.text}</div>;
        const content = [...it.nodes, ...groupContent(it.lines)];
        if (!content.length) return null;
        return (
          <AgentBubble key={i} label={it.label} time={it.time} session={it.session}>
            {content}
          </AgentBubble>
        );
      })}
    </>
  );
}

// Inner nodes of one agent bubble: consecutive text merges into a Markdown block,
// tools/thinking are collapsible, errors show inline red.
function groupContent(lines: LogLine[]): ReactNode[] {
  const nodes: ReactNode[] = [];
  let buf = "";
  let k = 0;
  const flush = () => {
    if (buf.trim()) nodes.push(<Markdown key={`t${k++}`} text={buf} />);
    buf = "";
  };
  for (const l of lines) {
    if (l.kind === "text") {
      buf += (buf ? "\n" : "") + l.text;
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

// One agent turn / run: left-aligned card with an executor·time header, the
// content, and a slim resume/id/time footer (the run's credential — its new home,
// out of the page header).
function AgentBubble({
  label,
  time,
  session,
  children,
}: {
  label?: string;
  time?: string | null;
  session?: Session;
  children: ReactNode;
}) {
  return (
    <div className="mb-3">
      <div className="rounded-lg border border-line bg-raised/40 px-3 py-2">
        <div className="mb-1 flex items-center gap-2 text-[11px] text-muted">
          <span className="font-medium text-ink/70">{label || "智能体"}</span>
          {time && (
            <>
              <span className="text-faint">·</span>
              <span className="text-faint">{formatInstant(time)}</span>
            </>
          )}
        </div>
        {children}
        {session && (session.resumeCommand || session.cliSessionId) && <ResumeButtons s={session} />}
      </div>
    </div>
  );
}

// A human reply / continuation: right-aligned bubble with "你 · 时间".
function UserBubble({ text, at }: { text: string; at?: string }) {
  return (
    <div className="mb-3 flex flex-col items-end">
      <div className="max-w-[88%] rounded-lg border border-accent/30 bg-accent/[0.08] px-3 py-2">
        <div className="mb-1 flex items-center gap-2 text-[11px] text-muted">
          <span className="font-medium text-ink/70">你</span>
          {at && (
            <>
              <span className="text-faint">·</span>
              <span className="text-faint">{formatInstant(at)}</span>
            </>
          )}
        </div>
        <div className="whitespace-pre-wrap break-words text-[13px] text-ink">{text}</div>
      </div>
    </div>
  );
}

// Reply-and-continue box. Answers the task's own agent by default; typing `@` and
// picking an agent assigns the reply to another agent, which is invited into the
// same task (same working directory). Images can be pasted in too.
function ReplyBox({ onReply, disabled }: { onReply: (text: string, opts?: { images?: string[]; agent?: AgentType }) => void; disabled: boolean }) {
  const [v, setV] = useState("");
  const [target, setTarget] = useState<AgentType | null>(null);
  const [mIdx, setMIdx] = useState(0);
  const { images, onPaste, remove, clear } = usePasteImages();

  // @-mention: when an "@word" token sits at the end of the text, offer the agent
  // list. Choosing one assigns the reply to that agent and strips the token.
  const mMatch = /(?:^|\s)@(\w*)$/.exec(v);
  const cands = mMatch ? AGENT_TYPES.filter((a) => a.startsWith((mMatch[1] ?? "").toLowerCase())) : [];
  const mentionOpen = !disabled && !!mMatch && cands.length > 0;

  const pick = (a: AgentType) => {
    setTarget(a);
    setV((s) => s.replace(/@\w*$/, "")); // drop the @token being typed
    setMIdx(0);
  };

  const send = () => {
    if ((v.trim() || images.length) && !disabled) {
      onReply(v.trim(), { images: images.map((i) => i.path), agent: target ?? undefined });
      setV("");
      clear();
      setTarget(null);
    }
  };

  return (
    <div className="relative flex flex-col gap-2 border-t border-line px-6 py-3">
      {mentionOpen && (
        <div className="absolute bottom-full left-6 z-10 mb-1 w-56 overflow-hidden rounded-lg border border-line2 bg-panel p-1 shadow-xl">
          <div className="px-2 py-1 text-[10px] text-faint">召唤智能体加入 · ↑↓ 选，回车确定</div>
          {cands.map((a, i) => (
            <button
              key={a}
              onMouseEnter={() => setMIdx(i)}
              onClick={() => pick(a)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-ink ${i === mIdx ? "bg-raised" : ""}`}
            >
              <Robot size={14} className="text-muted" /> @{a}
            </button>
          ))}
        </div>
      )}
      <ImageChips images={images} onRemove={remove} />
      {target && (
        <div className="flex items-center text-[12px]">
          <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-ink">
            <Robot size={12} /> 指派给 @{target}
            <button onClick={() => setTarget(null)} className="text-faint hover:text-ink" title="取消指派">
              <X size={11} weight="bold" />
            </button>
          </span>
        </div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          value={v}
          onChange={(e) => setV(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (mentionOpen) {
              if (e.key === "ArrowDown") { e.preventDefault(); setMIdx((i) => Math.min(cands.length - 1, i + 1)); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setMIdx((i) => Math.max(0, i - 1)); return; }
              if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); pick(cands[mIdx] ?? cands[0]); return; }
            }
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          disabled={disabled}
          placeholder={disabled ? "进行中…" : "回复并继续（⌘↵ 发送，可粘贴图片，@ 召唤其它智能体）…"}
          className="flex-1 resize-none rounded-md border border-line bg-panel px-2.5 py-1.5 text-[13px] text-ink outline-none placeholder:text-faint focus:border-accent disabled:opacity-50"
        />
        <button
          onClick={send}
          disabled={(!v.trim() && !images.length) || disabled}
          className="rounded-md bg-accent px-3 py-2 text-[13px] font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-40"
        >
          发送
        </button>
      </div>
    </div>
  );
}

// Linear-style property control built on the custom Menu (no native select).
function Prop({
  value,
  onChange,
  options,
  leading,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  leading?: (v: string) => ReactNode;
}) {
  const cur = options.find((o) => o.value === value);
  return (
    <Menu
      value={value}
      onChange={onChange}
      options={options.map((o) => ({ value: o.value, label: o.label, icon: leading?.(o.value) }))}
      triggerClassName="inline-flex items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-1 text-[12px] text-ink transition-colors hover:bg-raised"
    >
      {leading?.(value)}
      <span className="whitespace-nowrap">{cur?.label ?? ""}</span>
      <CaretDown size={11} weight="bold" className="text-faint" />
    </Menu>
  );
}

// Inline-editable task title (click in, type, Enter/blur saves; Esc reverts).
function EditableTitle({ title, onSave }: { title: string; onSave: (t: string) => void }) {
  const [v, setV] = useState(title);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setV(title);
  }, [title, editing]);
  return (
    <input
      value={v}
      onChange={(e) => setV(e.target.value)}
      onFocus={() => setEditing(true)}
      onBlur={() => {
        setEditing(false);
        const t = v.trim();
        if (t && t !== title) onSave(t);
        else setV(title);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setV(title);
          e.currentTarget.blur();
        }
      }}
      className="-mx-1 min-w-0 flex-1 rounded px-1 text-[15px] font-semibold leading-snug text-ink outline-none hover:bg-raised/40 focus:bg-raised/60"
      title="点击编辑标题"
    />
  );
}

