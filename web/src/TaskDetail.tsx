import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Task, Group, Session, TaskStatus, Priority } from "@harness/shared";
import { isUserSettableStatus } from "@harness/shared";
import { CaretDown, Play, Trash, ArrowsDownUp } from "@phosphor-icons/react";
import { api } from "./api";
import { STATUSES, PRIORITIES } from "./constants";
import { Credential, ToolCall, ThinkingBlock } from "./ui";
import { Markdown } from "./Markdown";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon, LabelAdder } from "./ui";
import { ScheduleControl } from "./ScheduleControl";
import { Menu } from "./Menu";
import { runAction } from "./taskActions";
import { groupLabel } from "./util";
import { usePasteImages, ImageChips } from "./pasteImages";

export type LogLine = {
  kind: "text" | "thinking" | "tool" | "error" | "done" | "user";
  text: string;
  name?: string; // tool name (for kind "tool")
};

export function TaskDetail({
  task,
  groups,
  allTasks,
  logs,
  sessionsBump,
  onRun,
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
  onReply: (text: string, opts?: { images?: string[] }) => void;
  onPatch: (patch: Partial<Task>) => void;
  onCreateGroup: () => void;
  onDelete: () => void;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [history, setHistory] = useState<string>("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.sessions(task.id).then(setSessions);
  }, [task.id, sessionsBump]);

  // Prior output, fetched once per task when there are no in-memory logs (i.e. a
  // reload). Sticky: a later reply (which fills logs) must not wipe it, so prior
  // context stays above the new turns.
  useEffect(() => {
    if (logs.length > 0) {
      setHistory("");
      return;
    }
    let alive = true;
    api.sessions(task.id).then(async (ss) => {
      if (alive && ss.length) setHistory(await api.sessionOutput(ss[ss.length - 1].id).catch(() => ""));
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [logs.length, history]);

  const depOptions = allTasks.filter((t) => t.id !== task.id && !task.dependsOn.includes(t.id));

  return (
    <main className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line px-6 pb-3 pt-5">
        <div className="flex items-start gap-3">
          <EditableTitle title={task.title} onSave={(t) => onPatch({ title: t, autoTitle: false })} />
          {(() => {
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
          })()}
          <button
            onClick={onDelete}
            className="grid h-[30px] w-[30px] place-items-center rounded-md text-muted transition-colors hover:bg-raised hover:text-red-600"
            title="删除任务"
          >
            <Trash size={15} />
          </button>
        </div>

        {/* Task objective — shown right under the title (not buried in the log). */}
        {task.body && (
          <p className="mt-2 max-h-28 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-raised/60 px-3 py-2 text-[13px] text-muted">
            {task.body}
          </p>
        )}

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

          {/* session / agent — one place for who runs this + the live credentials */}
          <span className="h-4 w-px bg-line" />
          {sessions.length > 0 ? (
            sessions.map((s) => <Credential key={s.id} s={s} />)
          ) : (
            <span className="text-faint">
              将由 <b className="text-muted">@{task.agentType ?? "claude"}</b> 执行
            </span>
          )}
        </div>
      </header>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto break-words px-6 py-4 text-[13px] leading-relaxed"
      >
        {history && <Markdown text={history} />}
        <LogBlocks logs={logs} />
        {!history && logs.length === 0 && (
          <p className="font-sans text-faint">点击「运行」开始，输出会实时流式显示在这里。</p>
        )}
      </div>

      {task.mode === "single" && (sessions.length > 0 || !!history || logs.length > 0) && (
        <ReplyBox onReply={onReply} disabled={task.status === "running" || task.status === "queued"} />
      )}
    </main>
  );
}

// Render the live log as a chat-like stream: consecutive agent text is merged
// into one Markdown block; tools/thinking are collapsible; the human's replies
// show as right-aligned bubbles.
function LogBlocks({ logs }: { logs: LogLine[] }) {
  const blocks: ReactNode[] = [];
  let buf = "";
  let k = 0;
  const flush = () => {
    if (buf.trim()) blocks.push(<Markdown key={k++} text={buf} />);
    buf = "";
  };
  for (const l of logs) {
    if (l.kind === "text") {
      buf += (buf ? "\n" : "") + l.text;
      continue;
    }
    flush();
    if (l.kind === "tool") blocks.push(<ToolCall key={k++} name={l.name ?? "tool"} detail={l.text} />);
    else if (l.kind === "thinking") blocks.push(<ThinkingBlock key={k++} text={l.text} />);
    else if (l.kind === "error") blocks.push(<div key={k++} className="my-1 break-words text-xs text-red-600">✕ {l.text}</div>);
    else if (l.kind === "done") blocks.push(<div key={k++} className="my-2 text-center text-xs text-faint">{l.text}</div>);
    else if (l.kind === "user")
      blocks.push(
        <div key={k++} className="my-2 flex justify-end">
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-lg bg-accent/10 px-3 py-1.5 text-[13px] text-ink">{l.text}</div>
        </div>,
      );
  }
  flush();
  return <>{blocks}</>;
}

// Reply-and-continue box: answer an agent that stopped to ask; resumes its session.
function ReplyBox({ onReply, disabled }: { onReply: (text: string, opts?: { images?: string[] }) => void; disabled: boolean }) {
  const [v, setV] = useState("");
  const { images, onPaste, remove, clear } = usePasteImages();
  const send = () => {
    if ((v.trim() || images.length) && !disabled) {
      onReply(v.trim(), { images: images.map((i) => i.path) });
      setV("");
      clear();
    }
  };
  return (
    <div className="flex flex-col gap-2 border-t border-line px-6 py-3">
      <ImageChips images={images} onRemove={remove} />
      <div className="flex items-end gap-2">
        <textarea
          value={v}
          onChange={(e) => setV(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          disabled={disabled}
          placeholder={disabled ? "进行中…" : "回复并继续（同一会话，⌘↵ 发送，可粘贴图片）…"}
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

