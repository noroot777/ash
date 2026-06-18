import { useEffect, useMemo, useRef, useState } from "react";
import type { Task, Session, DebateConfig, GateAction, AgentType, DebateSpeaker, TaskStatus } from "@harness/shared";
import { Stop } from "@phosphor-icons/react";
import type { DebateState, DebateTurn, DebateGate } from "./debateState";
import { ResumeButtons, ToolCall, CollapsibleText } from "./ui";
import { Markdown } from "./Markdown";
import { api } from "./api";
import { ScheduleControl } from "./ScheduleControl";
import { StatusIcon } from "./StatusIcon";
import { STATUSES } from "./constants";
import { runAction, canStopTask } from "./taskActions";
import { TaskTimes, formatInstant } from "./time";

// Animated "thinking" indicator — three dots flashing in sequence.
function TypingDots() {
  return (
    <span className="inline-flex items-center gap-1 text-sky-600">
      <span className="typing-dot" style={{ animationDelay: "0ms" }} />
      <span className="typing-dot" style={{ animationDelay: "150ms" }} />
      <span className="typing-dot" style={{ animationDelay: "300ms" }} />
    </span>
  );
}

// Always-visible run-state pill so the debate's status (esp. failed/running) is
// unambiguous and survives reload — task.status is persisted.
function StatusPill({ status }: { status: TaskStatus }) {
  const label = STATUSES.find((s) => s.key === status)?.label ?? status;
  const running = status === "running" || status === "queued";
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full bg-raised px-2 py-0.5 text-[11px] text-muted ${running ? "animate-pulse" : ""}`}>
      <StatusIcon status={status} size={12} />
      {label}
    </span>
  );
}

export function DebateView({
  task,
  state,
  sessionsBump,
  onRun,
  onStop,
  onRetry,
  onGate,
  onDelete,
}: {
  task: Task;
  state: DebateState;
  sessionsBump: number;
  onRun: () => void;
  onStop: () => void;
  onRetry: () => void;
  onGate: (a: GateAction) => void;
  onDelete: () => void;
}) {
  const cfg = task.debate as DebateConfig;
  const collab = cfg?.style === "collaborate"; // 协作=出代码（有实现/审查/代码门）；辩论=仅讨论
  const [sessions, setSessions] = useState<Session[]>([]);
  const [history, setHistory] = useState<DebateTurn[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Stick to the bottom only when the user is already near it. If they scrolled
  // up to read, incoming tokens must not yank them back down.
  const atBottomRef = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTo({ top: el.scrollHeight });
  }, [state.turns, history]);
  useEffect(() => {
    api.sessions(task.id).then(setSessions);
  }, [task.id, sessionsBump, state.turns.length]);
  // Rebuild timeline from persisted transcript when there are no live turns.
  useEffect(() => {
    if (state.turns.length === 0) {
      api
        .debateTranscript(task.id)
        .then((rows) =>
          setHistory(rows.map((r) => ({ ...r, raised: !!r.raised, tools: [], done: true }))),
        )
        .catch(() => setHistory([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, sessionsBump]);

  const busy = task.status === "running" || task.status === "queued";
  // Merge persisted history with live turns: on a fresh run, history is empty and
  // turns = live; on retry-after-reload, history holds the earlier rounds while
  // live carries the re-run + later turns (deduped by round:speaker, live wins).
  const turns = useMemo<DebateTurn[]>(() => {
    if (state.turns.length === 0) return history;
    const liveKeys = new Set(state.turns.map((t) => `${t.round}:${t.speaker}`));
    const head = history.filter((h) => !liveKeys.has(`${h.round}:${h.speaker}`));
    return [...head, ...state.turns];
  }, [state.turns, history]);

  // The gate comes live via SSE, but on reload (state empty) we rebuild it from
  // the persisted timeline so the bar — and the consensus/disagreement verdict —
  // survives a refresh while the backend is still waiting at the gate.
  const gate: DebateGate | null = useMemo(() => {
    if (state.gate) return state.gate;
    if (task.status !== "awaiting_review") return null;
    const hasImpl = turns.some((t) => t.speaker === "impl");
    const lastA = [...turns].reverse().find((t) => t.speaker === "A");
    const lastB = [...turns].reverse().find((t) => t.speaker === "B");
    return {
      gate: hasImpl ? "G2" : "G1",
      open: true,
      consensus: !!(lastA?.agrees && lastB?.agrees),
      conclusionA: lastA?.conclusion ?? null,
      conclusionB: lastB?.conclusion ?? null,
    };
  }, [state.gate, task.status, turns]);

  // Each speaker reuses one session row across its turns; resolve the latest per
  // role so a bubble's resume credential points at the live session. Falls back
  // to the configured agent type before the session row has loaded.
  const latestByRole = useMemo(() => {
    const m: Record<string, Session> = {};
    for (const s of sessions) {
      if (!m[s.role] || s.startedAt > m[s.role].startedAt) m[s.role] = s;
    }
    return m;
  }, [sessions]);
  // The reviewer is the non-implementer debater (it resumes that debater's session).
  const reviewerSide = cfg?.implementer === "A" ? "B" : "A";
  const sessionFor = (sp: DebateSpeaker): Session | undefined =>
    latestByRole[
      sp === "A" ? "debaterA"
        : sp === "B" ? "debaterB"
          : sp === "review" ? (reviewerSide === "A" ? "debaterA" : "debaterB")
            : "implementer"
    ];
  const agentFor = (sp: DebateSpeaker): AgentType | undefined =>
    sp === "A" ? cfg?.debaterA
      : sp === "B" ? cfg?.debaterB
        : sp === "review" ? (reviewerSide === "A" ? cfg?.debaterA : cfg?.debaterB)
          : cfg?.implementer === "B" ? cfg?.debaterB : cfg?.debaterA;

  return (
    <main className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line px-6 py-4">
        <div className="flex items-center gap-3">
          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${collab ? "bg-teal-500/15 text-teal-700" : "bg-violet-500/20 text-violet-700"}`}>{collab ? "collab" : "debate"}</span>
          <h1 className="min-w-0 flex-1 truncate text-lg font-medium tracking-tight">{task.title}</h1>
          <StatusPill status={task.status} />
          {canStopTask(task.status) ? (
            <button
              onClick={onStop}
              className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border border-red-500/40 px-4 py-1.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-500/10"
            >
              <Stop size={13} weight="fill" />
              停止
            </button>
          ) : (
            (() => {
              const a = runAction(task.status);
              return (
                <button
                  onClick={a.kind === "retry" ? onRetry : onRun}
                  disabled={!a.canClick}
                  title={a.kind === "retry" ? "只重跑失败的那一轮，再继续后续" : undefined}
                  className="shrink-0 whitespace-nowrap rounded-md bg-accent hover:bg-accent-hover px-4 py-1.5 text-sm font-medium text-accent-fg disabled:opacity-40 disabled:hover:bg-accent"
                >
                  {a.label}
                </button>
              );
            })()
          )}
          <button onClick={onDelete} className="shrink-0 rounded-md border border-line px-2 py-1.5 text-sm text-muted hover:text-red-600">
            删除
          </button>
        </div>
        {/* 议题/任务全文 —— 放在标题下的独立文本框（默认折叠成两行，点展开看全文）。 */}
        {cfg?.topic && <CollapsibleText text={cfg.topic} />}
        {/* 配置摘要 + 定时（同一行，定时靠右）。 */}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {cfg && (
            <p className="text-xs text-muted">
              {collab ? "成员A" : "辩手A"} <b className="text-ink">{cfg.debaterA}</b>
              {collab ? " ＋ 成员B " : " ↔ 辩手B "}
              <b className="text-ink">{cfg.debaterB}</b>
              {collab && <> · 实现方 成员{cfg.implementer} · 审查方 成员{cfg.implementer === "A" ? "B" : "A"}</>}
              {" · 轮数 "}{cfg.maxRounds ?? "不设限"}
              {" · "}{collab ? "方案门" : "收敛门"} {cfg.gateG1 === "on" ? "开" : "关"}
              {collab && <> · 代码门 {cfg.gateG2 === "on" ? "开" : "关"}</>}
            </p>
          )}
          <div className="ml-auto">
            <ScheduleControl taskId={task.id} />
          </div>
        </div>
        <TaskTimes task={task} />
      </header>

      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {turns.length === 0 && (
          <p className="text-sm text-faint">点击「运行」开始对抗。双方逐回合的发言会实时显示在这里。</p>
        )}
        {turns.map((t, i) => (
          <Bubble
            key={i}
            turn={t}
            collab={collab}
            prevRound={turns[i - 1]?.round}
            session={sessionFor(t.speaker)}
            agentType={agentFor(t.speaker)}
          />
        ))}
        {/* 辩论=仅讨论：结束后把双方结论提到末尾做一张「讨论结论」卡（协作不需要，它产出的是代码）。 */}
        {!collab && task.status === "done" && (() => {
          const ca = [...turns].reverse().find((t) => t.speaker === "A")?.conclusion;
          const cb = [...turns].reverse().find((t) => t.speaker === "B")?.conclusion;
          if (!ca && !cb) return null;
          return (
            <div className="mb-3 rounded-lg border border-emerald-500/30 bg-emerald-500/[0.06] px-3 py-2 text-[13px]">
              <div className="mb-1 text-[11px] font-medium text-emerald-700">讨论结论</div>
              {ca && <div className="text-ink"><b className="text-sky-700">辩手A</b> · {ca}</div>}
              {cb && <div className="text-ink"><b className="text-emerald-700">辩手B</b> · {cb}</div>}
            </div>
          );
        })()}
        {/* Between-turn liveness: busy but no open bubble → still working. */}
        {busy && turns.length > 0 && turns[turns.length - 1].done && (
          <div className="mb-3 flex items-center gap-2 text-[12px] text-muted">
            <TypingDots /> 运行中…
          </div>
        )}
        {/* Terminal markers so a stopped debate reads as stopped, not stuck. */}
        {task.status === "failed" && (
          <div className="mb-3 text-center text-[12px] text-red-600">✕ 本次对抗已失败并停止</div>
        )}
        {task.status === "canceled" && (
          <div className="mb-3 text-center text-[12px] text-faint">— 已取消 —</div>
        )}
      </div>

      {gate?.open && task.status === "awaiting_review" && <GateBar gate={gate} collab={collab} onGate={onGate} />}
    </main>
  );
}

function Bubble({
  turn,
  collab,
  prevRound,
  session,
  agentType,
}: {
  turn: DebateTurn;
  collab: boolean;
  prevRound?: number;
  session?: Session;
  agentType?: AgentType;
}) {
  const showDivider = turn.round !== prevRound;
  const side = turn.speaker;

  // A human intervention (gate inject/ask): a right-aligned bubble with the time
  // the user spoke — the /pair analog of a single task's reply bubble.
  if (side === "user") {
    return (
      <div className="mb-3 rise">
        {showDivider && (
          <div className="my-3 text-center text-xs text-faint">── 第 {turn.round} 轮 ──</div>
        )}
        <div className="flex flex-col items-end">
          <div className="max-w-[88%] rounded-lg border border-accent/30 bg-accent/[0.08] px-3 py-2">
            <div className="mb-1 flex items-center gap-2 text-[11px] text-muted">
              <span className="font-medium text-ink/70">你</span>
              {turn.at && (
                <>
                  <span className="text-faint">·</span>
                  <span className="text-faint">{formatInstant(turn.at)}</span>
                </>
              )}
            </div>
            <div className="whitespace-pre-wrap break-words text-[13px] text-ink">{turn.text}</div>
          </div>
        </div>
      </div>
    );
  }

  const align = side === "A" ? "items-start" : side === "B" ? "items-end" : "items-center";
  const color =
    side === "A"
      ? "border-sky-500/40 bg-sky-500/8"
      : side === "B"
        ? "border-emerald-500/40 bg-emerald-500/8"
        : side === "review"
          ? "border-amber-500/40 bg-amber-500/[0.08]"
          : "border-violet-500/40 bg-violet-500/[0.07]";
  const who = side === "A" ? (collab ? "成员A" : "辩手A") : side === "B" ? (collab ? "成员B" : "辩手B") : side === "review" ? "代码审查" : "实现方";
  // Prefer the concrete executor label (e.g. "codex@local"); fall back to the
  // configured agent type before the session row has loaded.
  const agentLabel = session?.executor ?? agentType;

  return (
    <div className="mb-3 rise">
      {showDivider && (
        <div className="my-3 text-center text-xs text-faint">
          ── 第 {turn.round} 轮{turn.round === 1 ? (collab ? " · 各自提案" : " · 盲态开局") : ""} ──
        </div>
      )}
      <div className={`flex flex-col ${align}`}>
        <div className={`max-w-[88%] rounded-lg border px-3 py-2 ${color} ${side === "impl" || side === "review" ? "w-full max-w-full" : ""}`}>
          <div className="mb-1 flex items-center gap-2 text-[11px] text-muted">
            <span className="font-medium text-ink/70">{who}</span>
            {agentLabel && (
              <>
                <span className="text-faint">·</span>
                <span className="text-muted">{agentLabel}</span>
              </>
            )}
            {turn.raised && <span className="text-amber-700">✋ 可收敛</span>}
            {!turn.done && <TypingDots />}
          </div>
          {turn.tools.map((t, i) => (
            <ToolCall key={i} name={t.name} detail={t.detail} />
          ))}
          {!turn.done && !turn.text && turn.tools.length === 0 && (
            <div className="py-0.5 text-[12px] text-muted">思考中…</div>
          )}
          <Markdown text={turn.text} />
          {turn.error && <div className="mt-1 break-words text-xs text-red-600">✕ {turn.error}</div>}
          {session && (session.resumeCommand || session.cliSessionId) && <ResumeButtons s={session} />}
        </div>
      </div>
    </div>
  );
}

function GateBar({ gate, collab, onGate }: { gate: DebateGate; collab: boolean; onGate: (a: GateAction) => void }) {
  const [mode, setMode] = useState<"inject" | "ask" | null>(null);
  const [text, setText] = useState("");
  const isG1 = gate.gate === "G1";
  const consensus = !!gate.consensus;
  const label = !isG1
    ? "代码门 · 等待你裁决"
    : collab
      ? "方案门 · 统一方案就绪，待你确认"
      : consensus
        ? "收敛门 · 双方已达成共识"
        : "收敛门 · 双方仍有分歧（结论如下，供你定夺）";
  const nameA = collab ? "成员A" : "辩手A";
  const nameB = collab ? "成员B" : "辩手B";

  return (
    <div className="border-t border-violet-500/40 bg-violet-500/[0.07] px-6 py-3">
      {/* G1: always show BOTH sides' final conclusions so a self-reported
          "consensus" that actually differs can be caught at a glance. */}
      {isG1 && (
        <div className="mb-2 flex flex-col gap-0.5 text-xs">
          <div className={collab || consensus ? "text-emerald-700" : "text-amber-700"}>
            {collab
              ? "✓ 两位成员已合并出统一方案（如下，若不符可打回或回炉）"
              : consensus
                ? "✓ 双方均表示可收敛、自评结论一致（结论如下，若实际不符可打回或回炉）"
                : "⚠ 双方未达成一致，以下是两方各自结论："}
          </div>
          {gate.conclusionA || gate.conclusionB ? (
            <>
              {gate.conclusionA && (
                <div className="text-ink"><b className="text-sky-700">{nameA}</b> · {gate.conclusionA}</div>
              )}
              {gate.conclusionB && (
                <div className="text-ink"><b className="text-emerald-700">{nameB}</b> · {gate.conclusionB}</div>
              )}
            </>
          ) : (
            <div className="text-faint">（双方未给出明确「结论」行）</div>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-violet-700">{label}</span>
        <div className="ml-auto flex flex-wrap gap-2">
          <button onClick={() => onGate({ kind: "approve" })} className="rounded-md bg-emerald-500 px-3 py-1 text-xs font-medium text-white">
            {isG1 ? (collab ? "放行→实现" : "放行→结束") : "放行"}
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
