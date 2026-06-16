import { useEffect, useRef, useState } from "react";
import type { Task, Group, Session, TaskStatus, Priority } from "@harness/shared";
import { api } from "./api";
import { STATUSES, PRIORITIES } from "./constants";
import { Credential } from "./ui";
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

  return (
    <main className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line px-6 py-4">
        <div className="flex items-center gap-3">
          <h1 className="truncate text-lg font-medium tracking-tight">{task.title}</h1>
          <button
            onClick={onRun}
            disabled={busy}
            className="ml-auto rounded-md bg-ink px-4 py-1.5 text-sm font-medium text-canvas disabled:opacity-40"
          >
            {busy ? "运行中…" : "运行"}
          </button>
          <button
            onClick={onDelete}
            className="rounded-md border border-line px-2 py-1.5 text-sm text-muted hover:text-red-400"
            title="删除任务"
          >
            删除
          </button>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <Select
            value={task.status}
            onChange={(v) => onPatch({ status: v as TaskStatus })}
            options={STATUSES.map((s) => ({ value: s.key, label: s.label }))}
          />
          <Select
            value={task.priority}
            onChange={(v) => onPatch({ priority: v as Priority })}
            options={PRIORITIES.map((p) => ({ value: p.key, label: `优先级·${p.label}` }))}
          />
          <Select
            value={task.groupId ?? ""}
            onChange={(v) => (v === "__new" ? onCreateGroup() : onPatch({ groupId: v || null }))}
            options={[
              { value: "", label: "无分组" },
              ...groups.map((g) => ({ value: g.id, label: `${g.name} · ${g.mode}` })),
              { value: "__new", label: "+ 新建分组" },
            ]}
          />
          {task.labels.map((l) => (
            <button
              key={l}
              onClick={() => onPatch({ labels: task.labels.filter((x) => x !== l) })}
              className="rounded-full bg-overlay px-2 py-0.5 text-ink hover:line-through"
              title="点击移除"
            >
              {l}
            </button>
          ))}
          <button onClick={addLabel} className="rounded-full border border-line px-2 py-0.5 text-muted">
            + 标签
          </button>
          <span className="ml-auto text-faint">
            {task.mode} {task.mode === "single" ? `· @${task.agentType ?? "—"}` : ""}
          </span>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-faint">依赖</span>
          {task.dependsOn.map((d) => {
            const dep = allTasks.find((t) => t.id === d);
            return (
              <button
                key={d}
                onClick={() => onPatch({ dependsOn: task.dependsOn.filter((x) => x !== d) })}
                className="rounded bg-overlay px-1.5 py-0.5 text-ink hover:line-through"
                title="点击移除依赖"
              >
                {dep?.title ?? d}
              </button>
            );
          })}
          <select
            value=""
            onChange={(e) => {
              if (e.target.value) onPatch({ dependsOn: [...task.dependsOn, e.target.value] });
            }}
            className="rounded-md border border-line bg-panel px-2 py-1 text-muted outline-none"
          >
            <option value="">+ 添加依赖</option>
            {allTasks
              .filter((t) => t.id !== task.id && !task.dependsOn.includes(t.id))
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
          </select>
          {task.dependsOn.length === 0 && <span className="text-faint">无（同组并行时按依赖排序）</span>}
        </div>

        <div className="mt-2">
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
          <p className="mb-4 whitespace-pre-wrap break-words border-l-2 border-line2 pl-3 text-muted">
            {task.body}
          </p>
        )}
        {history && logs.length === 0 && <pre className="whitespace-pre-wrap break-words text-ink">{history}</pre>}
        {logs.map((l, i) => (
          <Line key={i} l={l} />
        ))}
        {!history && logs.length === 0 && (
          <p className="text-faint">点击「运行」开始。输出会实时流式显示在这里。</p>
        )}
      </div>
    </main>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-line bg-panel px-2 py-1 text-ink outline-none hover:bg-overlay"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Line({ l }: { l: LogLine }) {
  if (l.kind === "tool") return <div className="my-0.5 break-words text-amber-300/80">⚙ {l.text}</div>;
  if (l.kind === "error") return <div className="my-0.5 break-words text-red-400">✕ {l.text}</div>;
  if (l.kind === "done") return <div className="my-2 text-center text-xs text-faint">{l.text}</div>;
  if (l.kind === "thinking")
    return <div className="my-0.5 whitespace-pre-wrap break-words italic text-faint">{l.text}</div>;
  return <div className="my-0.5 whitespace-pre-wrap break-words text-ink">{l.text}</div>;
}
