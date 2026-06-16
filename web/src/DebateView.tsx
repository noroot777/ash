import { useEffect, useRef, useState } from "react";
import type { Task, Session, DebateConfig, GateAction } from "@harness/shared";
import type { DebateState, DebateTurn } from "./debateState";
import { Credential } from "./ui";
import { api } from "./api";
import { ScheduleControl } from "./ScheduleControl";

export function DebateView({
  task,
  state,
  sessionsBump,
  onRun,
  onGate,
  onDelete,
}: {
  task: Task;
  state: DebateState;
  sessionsBump: number;
  onRun: () => void;
  onGate: (a: GateAction) => void;
  onDelete: () => void;
}) {
  const cfg = task.debate as DebateConfig;
  const [sessions, setSessions] = useState<Session[]>([]);
  const [history, setHistory] = useState<DebateTurn[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [state.turns]);
  useEffect(() => {
    api.sessions(task.id).then(setSessions);
  }, [task.id, sessionsBump, state.turns.length]);
  // Rebuild timeline from persisted transcript when there are no live turns.
  useEffect(() => {
    if (state.turns.length === 0) {
      api
        .debateTranscript(task.id)
        .then((rows) =>
          setHistory(rows.map((r) => ({ ...r, tools: [], done: true }))),
        )
        .catch(() => setHistory([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, sessionsBump]);

  const busy = task.status === "running" || task.status === "queued";
  const turns = state.turns.length > 0 ? state.turns : history;

  return (
    <main className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line px-6 py-4">
        <div className="flex items-center gap-3">
          <span className="rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">debate</span>
          <h1 className="truncate text-lg font-medium tracking-tight">{cfg?.topic ?? task.title}</h1>
          <button
            onClick={onRun}
            disabled={busy}
            className="ml-auto rounded-md bg-accent hover:bg-accent-hover px-4 py-1.5 text-sm font-medium text-accent-fg disabled:opacity-40"
          >
            {busy ? "进行中…" : "运行"}
          </button>
          <button onClick={onDelete} className="rounded-md border border-line px-2 py-1.5 text-sm text-muted hover:text-red-600">
            删除
          </button>
        </div>
        {cfg && (
          <p className="mt-2 text-xs text-muted">
            辩手A <b className="text-ink">{cfg.debaterA}</b> ↔ 辩手B{" "}
            <b className="text-ink">{cfg.debaterB}</b> · 实现方 辩手{cfg.implementer} · 轮数{" "}
            {cfg.maxRounds ?? "不设限"} · G1 {cfg.gateG1 === "on" ? "开" : "关"} · G2 {cfg.gateG2 === "on" ? "开" : "关"}
          </p>
        )}
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

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {turns.length === 0 && (
          <p className="text-sm text-faint">点击「运行」开始对抗。双方逐回合的发言会实时显示在这里。</p>
        )}
        {turns.map((t, i) => (
          <Bubble key={i} turn={t} prevRound={turns[i - 1]?.round} />
        ))}
      </div>

      {state.gate?.open && task.status === "awaiting_review" && (
        <GateBar gate={state.gate.gate} onGate={onGate} />
      )}
    </main>
  );
}

function Bubble({ turn, prevRound }: { turn: DebateTurn; prevRound?: number }) {
  const showDivider = turn.round !== prevRound;
  const side = turn.speaker;
  const align = side === "A" ? "items-start" : side === "B" ? "items-end" : "items-center";
  const color =
    side === "A"
      ? "border-sky-500/40 bg-sky-500/8"
      : side === "B"
        ? "border-emerald-500/40 bg-emerald-500/8"
        : "border-violet-500/40 bg-violet-500/[0.07]";
  const who = side === "A" ? "辩手A" : side === "B" ? "辩手B" : "实现方";

  return (
    <div className="mb-3 rise">
      {showDivider && (
        <div className="my-3 text-center text-xs text-faint">
          ── 第 {turn.round} 轮{turn.round === 1 ? " · 盲态开局" : ""} ──
        </div>
      )}
      <div className={`flex flex-col ${align}`}>
        <div className={`max-w-[88%] rounded-lg border px-3 py-2 ${color} ${side === "impl" ? "w-full max-w-full" : ""}`}>
          <div className="mb-1 flex items-center gap-2 text-[11px] text-muted">
            <span>{who}</span>
            {turn.raised && <span className="text-amber-700">✋ 可收敛</span>}
            {!turn.done && <span className="text-sky-700">…</span>}
          </div>
          {turn.tools.map((t, i) => (
            <div key={i} className="my-0.5 break-words font-mono text-[11px] text-amber-700/70">⚙ {t}</div>
          ))}
          <div className="whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink">{turn.text}</div>
          {turn.error && <div className="mt-1 break-words text-xs text-red-600">✕ {turn.error}</div>}
        </div>
      </div>
    </div>
  );
}

function GateBar({ gate, onGate }: { gate: string; onGate: (a: GateAction) => void }) {
  const [mode, setMode] = useState<"inject" | "ask" | null>(null);
  const [text, setText] = useState("");
  const label = gate === "G1" ? "共识门 · 等待你裁决" : "代码门 · 等待你裁决";

  return (
    <div className="border-t border-violet-500/40 bg-violet-500/[0.07] px-6 py-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-violet-700">{label}</span>
        <div className="ml-auto flex flex-wrap gap-2">
          <button onClick={() => onGate({ kind: "approve" })} className="rounded-md bg-emerald-500 px-3 py-1 text-xs font-medium text-white">
            放行
          </button>
          <button onClick={() => onGate({ kind: "reject" })} className="rounded-md border border-line2 px-3 py-1 text-xs text-ink">
            打回终止
          </button>
          <button onClick={() => setMode(mode === "inject" ? null : "inject")} className="rounded-md border border-line2 px-3 py-1 text-xs text-ink">
            注入意见→回炉
          </button>
          <button onClick={() => setMode(mode === "ask" ? null : "ask")} className="rounded-md border border-line2 px-3 py-1 text-xs text-ink">
            提问→继续
          </button>
        </div>
      </div>
      {mode && (
        <div className="mt-2 flex gap-2">
          <textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            placeholder={mode === "inject" ? "补充意见，双方据此回炉再辩…" : "向双方提出的问题…"}
            className="flex-1 resize-none rounded-md border border-line bg-panel px-2 py-1 text-sm outline-none"
          />
          <button
            disabled={!text.trim()}
            onClick={() => {
              onGate({ kind: mode, text: text.trim() });
              setText("");
              setMode(null);
            }}
            className="rounded-md bg-accent hover:bg-accent-hover px-3 py-1 text-xs font-medium text-accent-fg disabled:opacity-40"
          >
            提交
          </button>
        </div>
      )}
    </div>
  );
}
