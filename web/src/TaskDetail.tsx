import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Task, Group, Session, TaskStatus, Priority } from "@harness/shared";
import { CaretDown, Play, Trash, ArrowsDownUp } from "@phosphor-icons/react";
import { api } from "./api";
import { STATUSES, PRIORITIES } from "./constants";
import { Credential } from "./ui";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon, LabelAdder } from "./ui";
import { ScheduleControl } from "./ScheduleControl";
import { Menu } from "./Menu";

export type LogLine = {
  kind: "text" | "thinking" | "tool" | "error" | "done";
  text: string;
};

export function TaskDetail({
  task,
  groups,
  allTasks,
  logs,
  sessionsBump,
  onRun,
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
  onPatch: (patch: Partial<Task>) => void;
  onCreateGroup: () => void;
  onDelete: () => void;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [history, setHistory] = useState<string>("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.sessions(task.id).then(async (ss) => {
      setSessions(ss);
      if (ss.length && logs.length === 0) {
        setHistory(await api.sessionOutput(ss[ss.length - 1].id).catch(() => ""));
      } else {
        setHistory("");
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, sessionsBump]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [logs.length, history]);

  const busy = task.status === "running" || task.status === "queued";

  const depOptions = allTasks.filter((t) => t.id !== task.id && !task.dependsOn.includes(t.id));

  return (
    <main className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line px-6 pb-3 pt-5">
        <div className="flex items-start gap-3">
          <EditableTitle title={task.title} onSave={(t) => onPatch({ title: t, autoTitle: false })} />
          <button
            onClick={onRun}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-fg transition-colors hover:bg-accent-hover disabled:opacity-40"
          >
            <Play size={13} weight="fill" />
            {busy ? "运行中" : "运行"}
          </button>
          <button
            onClick={onDelete}
            className="grid h-[30px] w-[30px] place-items-center rounded-md text-muted transition-colors hover:bg-raised hover:text-red-600"
            title="删除任务"
          >
            <Trash size={15} />
          </button>
        </div>

        {/* Property bar */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Prop
            value={task.status}
            onChange={(v) => onPatch({ status: v as TaskStatus })}
            options={STATUSES.map((s) => ({ value: s.key, label: s.label }))}
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
              ...groups.map((g) => ({ value: g.id, label: `${g.name} · ${g.mode === "parallel" ? "并行" : "串行"}` })),
              { value: "__new", label: "+ 新建分组" },
            ]}
          />
          <span className="mx-1 h-4 w-px bg-line" />
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
          <span className="ml-auto text-[12px] text-faint">
            {task.mode === "single" ? `@${task.agentType ?? "—"}` : "debate"}
          </span>
        </div>

        {/* Secondary: dependencies + schedule */}
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-2.5 text-[12px]">
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
      </header>

      {sessions.length > 0 && (
        <div className="flex flex-wrap gap-2 border-b border-line px-6 py-3">
          {sessions.map((s) => (
            <Credential key={s.id} s={s} />
          ))}
        </div>
      )}

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto break-words px-6 py-4 font-mono text-[13px] leading-relaxed"
      >
        {task.body && (
          <p className="mb-4 whitespace-pre-wrap break-words rounded-md bg-raised/60 px-3 py-2 font-sans text-[13px] text-muted">
            {task.body}
          </p>
        )}
        {history && logs.length === 0 && <pre className="whitespace-pre-wrap break-words text-ink">{history}</pre>}
        {logs.map((l, i) => (
          <Line key={i} l={l} />
        ))}
        {!history && logs.length === 0 && (
          <p className="font-sans text-faint">点击「运行」开始，输出会实时流式显示在这里。</p>
        )}
      </div>
    </main>
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

function Line({ l }: { l: LogLine }) {
  if (l.kind === "tool") return <div className="my-0.5 break-words text-amber-700/80">⚙ {l.text}</div>;
  if (l.kind === "error") return <div className="my-0.5 break-words text-red-600">✕ {l.text}</div>;
  if (l.kind === "done") return <div className="my-2 text-center text-xs text-faint">{l.text}</div>;
  if (l.kind === "thinking")
    return <div className="my-0.5 whitespace-pre-wrap break-words italic text-faint">{l.text}</div>;
  return <div className="my-0.5 whitespace-pre-wrap break-words text-ink">{l.text}</div>;
}
