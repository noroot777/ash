import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Task, Group, Session, TaskStatus, Priority } from "@harness/shared";
import { CaretDown, Play, Trash, Plus, ArrowsDownUp } from "@phosphor-icons/react";
import { api } from "./api";
import { STATUSES, PRIORITIES } from "./constants";
import { Credential } from "./ui";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon } from "./ui";
import { ScheduleControl } from "./ScheduleControl";

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

  const addLabel = () => {
    const l = prompt("标签？")?.trim();
    if (l && !task.labels.includes(l)) onPatch({ labels: [...task.labels, l] });
  };

  const depOptions = allTasks.filter((t) => t.id !== task.id && !task.dependsOn.includes(t.id));

  return (
    <main className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line px-6 pb-3 pt-5">
        <div className="flex items-start gap-3">
          <h1 className="min-w-0 flex-1 text-[15px] font-semibold leading-snug text-ink">{task.title}</h1>
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
          <button
            onClick={addLabel}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-muted hover:bg-raised hover:text-ink"
          >
            <Plus size={12} weight="bold" /> 标签
          </button>
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

// Linear-style property control: leading icon + value + caret, with an invisible
// native <select> overlaid for accessibility + zero-dependency behavior.
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
    <label className="relative inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line bg-panel px-2 py-1 text-[12px] text-ink transition-colors hover:bg-raised">
      {leading?.(value)}
      <span className="whitespace-nowrap">{cur?.label ?? ""}</span>
      <CaretDown size={11} weight="bold" className="text-faint" />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
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
