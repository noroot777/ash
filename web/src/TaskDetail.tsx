import { useEffect, useRef, useState } from "react";
import type { Task, Session, TaskStatus } from "@harness/shared";
import { api } from "./api";

export type LogLine = {
  kind: "text" | "thinking" | "tool" | "error" | "done";
  text: string;
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: "待排期",
  queued: "排队中",
  running: "运行中",
  awaiting_review: "等待审核",
  done: "完成",
  failed: "失败",
  canceled: "已取消",
};

export function TaskDetail({
  task,
  logs,
  sessionsBump,
  onRun,
}: {
  task: Task;
  logs: LogLine[];
  sessionsBump: number;
  onRun: () => void;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [history, setHistory] = useState<string>("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load credentials + persisted output on select and when a run finishes.
  useEffect(() => {
    api.sessions(task.id).then(async (ss) => {
      setSessions(ss);
      if (ss.length && logs.length === 0) {
        const txt = await api.sessionOutput(ss[ss.length - 1].id).catch(() => "");
        setHistory(txt);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, sessionsBump]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [logs.length, history]);

  const busy = task.status === "running" || task.status === "queued";

  return (
    <main className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-3 border-b border-neutral-800 px-6 py-4">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-medium tracking-tight">{task.title}</h1>
          <p className="mt-0.5 text-xs text-neutral-500">
            {STATUS_LABEL[task.status]} · {task.mode} · @{task.agentType ?? "—"}
          </p>
        </div>
        <button
          onClick={onRun}
          disabled={busy}
          className="ml-auto rounded-md bg-neutral-200 px-4 py-1.5 text-sm font-medium text-neutral-900 disabled:opacity-40"
        >
          {busy ? "运行中…" : "运行"}
        </button>
      </header>

      {sessions.length > 0 && (
        <div className="flex flex-wrap gap-2 border-b border-neutral-800 px-6 py-3">
          {sessions.map((s) => (
            <Credential key={s.id} s={s} />
          ))}
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-4 font-mono text-[13px] leading-relaxed break-words">
        {task.body && (
          <p className="mb-4 whitespace-pre-wrap break-words border-l-2 border-neutral-700 pl-3 text-neutral-500">
            {task.body}
          </p>
        )}
        {history && logs.length === 0 && (
          <pre className="whitespace-pre-wrap break-words text-neutral-300">{history}</pre>
        )}
        {logs.map((l, i) => (
          <Line key={i} l={l} />
        ))}
        {!history && logs.length === 0 && (
          <p className="text-neutral-600">点击「运行」开始。输出会实时流式显示在这里。</p>
        )}
      </div>
    </main>
  );
}

function Line({ l }: { l: LogLine }) {
  if (l.kind === "tool")
    return <div className="my-0.5 break-words text-amber-300/80">⚙ {l.text}</div>;
  if (l.kind === "error") return <div className="my-0.5 break-words text-red-400">✕ {l.text}</div>;
  if (l.kind === "done")
    return <div className="my-2 text-center text-xs text-neutral-600">{l.text}</div>;
  if (l.kind === "thinking")
    return <div className="my-0.5 whitespace-pre-wrap break-words text-neutral-600 italic">{l.text}</div>;
  return <div className="my-0.5 whitespace-pre-wrap break-words text-neutral-200">{l.text}</div>;
}

function Credential({ s }: { s: Session }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (label: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1200);
  };
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-neutral-800 bg-neutral-900/40 px-2 py-1 text-xs">
      <span className="text-neutral-400">{s.role}</span>
      <span className="text-neutral-600">·</span>
      <span className="text-neutral-500">{s.executor}</span>
      <button
        onClick={() => copy("cmd", s.resumeCommand ?? "")}
        className="ml-1 rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-300 hover:bg-neutral-700"
        title={s.resumeCommand ?? ""}
      >
        {copied === "cmd" ? "已复制" : "复制 resume 命令"}
      </button>
      <button
        onClick={() => copy("id", s.cliSessionId ?? "")}
        className="rounded bg-neutral-800 px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-700"
        title={s.cliSessionId ?? ""}
      >
        {copied === "id" ? "✓" : "ID"}
      </button>
    </div>
  );
}
