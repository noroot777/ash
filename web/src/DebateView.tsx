import { useEffect, useMemo, useRef, useState } from "react";
import type { Task, Session, GateAction, AgentType, DebateSpeaker, TaskStatus } from "@harness/shared";
import { TEAM_DEFAULTS } from "@harness/shared";
import { Stop, Robot, X } from "@phosphor-icons/react";
import { rebuildDebateState, type DebateState, type DebateTurn, type DebateGate } from "./debateState";
import { ResumeButtons, ToolCall, CollapsibleText } from "./ui";
import { Markdown } from "./Markdown";
import { api } from "./api";
import { ScheduleControl } from "./ScheduleControl";
import { StatusIcon } from "./StatusIcon";
import { STATUS_META } from "./constants";
import { runAction, canStopTask } from "./taskActions";
import { canArchive, normalizeDebateConfig } from "@harness/shared";
import { TaskTimeChip, formatDuration, formatInstant } from "./time";
import { executorLabel } from "./executorLabel";
import { toast } from "./toast";
import { buildDebateHandoffBody, isTeamCommand, latestDebateGate } from "./debateHandoff";
import { AttachmentDisplay, parseAttachmentText } from "./messageAttachments";
import { useExecutorProfiles } from "./ExecutorPicker";
import { ConversationScrollButtons } from "./Conversation";
import {
  defaultTeamConfig,
  FinishedTeamHandoffBar,
  LinkedTeamCard,
  TeamHandoffButton,
  TeamHandoffModal,
  type TeamHandoffChoice,
} from "./DebateTeamHandoff";

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
  const label = STATUS_META[status].label;
  const running = status === "running" || status === "queued";
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full bg-raised px-2 py-0.5 text-[11px] text-muted ${running ? "animate-pulse" : ""}`}>
      <StatusIcon status={status} size={12} />
      {label}
    </span>
  );
}

const timeMs = (iso?: string | null): number => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : 0;
};

export function DebateView({
  task,
  allTasks,
  state,
  sessionsBump,
  onRun,
  onStop,
  onRetry,
  onGate,
  onDelete,
  onArchive,
  onUnarchive,
  onOpenTask,
  onTeamCreated,
}: {
  task: Task;
  allTasks: Task[];
  state: DebateState;
  sessionsBump: number;
  onRun: () => void;
  onStop: () => void;
  onRetry: () => void;
  onGate: (a: GateAction) => void | Promise<unknown>;
  onDelete: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onOpenTask: (taskId: string) => void;
  onTeamCreated: (task: Task, doRun?: boolean, select?: boolean) => void;
}) {
  const cfg = normalizeDebateConfig(task.debate);
  const topic = parseAttachmentText(task.body || cfg?.topic || "");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [history, setHistory] = useState<DebateTurn[]>([]);
  const [persistedGate, setPersistedGate] = useState<DebateGate | null>(null);
  const [teamBusy, setTeamBusy] = useState(false);
  const [teamModalOpen, setTeamModalOpen] = useState(false);
  const [iterateBusy, setIterateBusy] = useState(false);
  const { profiles } = useExecutorProfiles();
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
        .then((rows) => {
          const rebuilt = rebuildDebateState(rows);
          setHistory(rebuilt.turns);
          setPersistedGate(rebuilt.gate);
        })
        .catch(() => {
          setHistory([]);
          setPersistedGate(null);
        });
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
    if (persistedGate) return persistedGate;
    return latestDebateGate(turns, task.status === "awaiting_review");
  }, [state.gate, persistedGate, task.status, turns]);

  const linkedTeam = useMemo(
    () => allTasks
      .filter((item) => item.mode === "team" && item.originTaskId === task.id)
      .sort((a, b) => timeMs(b.createdAt) - timeMs(a.createdAt))[0],
    [allTasks, task.id],
  );

  const handoffToTeam = async (command: string, choice?: TeamHandoffChoice): Promise<boolean> => {
    if (teamBusy || !isTeamCommand(command)) return false;
    setTeamBusy(true);
    let created: Task;
    try {
      // Refresh at handoff time so a just-finished debate cannot create a team
      // task with stale/missing transcript paths from the page's earlier fetch.
      const handoffSessions = await api.sessions(task.id);
      setSessions(handoffSessions);
      created = await api.createTask({
        projectId: task.projectId,
        title: `落实辩论结论：${task.title}`.slice(0, 60),
        body: buildDebateHandoffBody(task, gate, turns, command, handoffSessions),
        mode: "team",
        originTaskId: task.id,
        agentType: choice?.lead.agentType ?? TEAM_DEFAULTS.lead,
        team: choice ? defaultTeamConfig(choice) : { ...TEAM_DEFAULTS },
        autoTitle: false,
      });
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
      setTeamBusy(false);
      return false;
    }

    // Upsert without navigating: the gate/footer changes into the live linked
    // team card in place. The card is the explicit navigation affordance.
    onTeamCreated(created, false, false);
    if (gate?.gate === "G1" && gate.consensus) {
      try {
        await onGate({ kind: "approve" });
      } catch (error) {
        toast(`团队任务已创建，但辩论自动放行失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      await api.runTask(created.id);
      toast("已创建团队任务，辩论结论已交给团队执行", "info");
    } catch (error) {
      toast(`团队任务已创建，但启动失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setTeamBusy(false);
    }
    return true;
  };
  const confirmTeamHandoff = (choice: TeamHandoffChoice) => {
    const command = choice.note.trim() ? `/team ${choice.note.trim()}` : "/team 开干";
    return handoffToTeam(command, choice);
  };
  const iterateTeam = async (team: Task) => {
    if (iterateBusy) return;
    const existing = allTasks.find((item) => item.mode === "debate" && item.originTaskId === team.id);
    if (existing) {
      onTeamCreated(existing, false, true);
      return;
    }
    setIterateBusy(true);
    try {
      const created = await api.iterateTeamDebate(team.id);
      onTeamCreated(created, true, true);
      toast("已创建新一轮辩论并开跑", "info");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setIterateBusy(false);
    }
  };

  // Each speaker reuses one session row across its turns; resolve the latest per
  // role so a bubble's resume credential points at the live session. Falls back
  // to the configured agent type before the session row has loaded.
  const latestByRole = useMemo(() => {
    const m: Record<string, Session> = {};
    for (const s of sessions) {
      if (!m[s.role] || timeMs(s.startedAt) > timeMs(m[s.role].startedAt)) m[s.role] = s;
    }
    return m;
  }, [sessions]);
  const sessionFor = (sp: DebateSpeaker): Session | undefined =>
    latestByRole[
      sp === "A" ? "debaterA"
        : sp === "B" ? "debaterB"
          : sp === "review" ? "reviewer"
            : sp === "impl" ? "implementer" : ""
    ];
  const agentFor = (sp: DebateSpeaker): AgentType | undefined =>
    sp === "A" ? cfg?.debaterA
      : sp === "B" ? cfg?.debaterB
        : undefined;
  const debaterName = (speaker: "A" | "B") => {
    const type = speaker === "A" ? cfg.debaterA : cfg.debaterB;
    const executorId = speaker === "A" ? cfg.debaterAExecutorId : cfg.debaterBExecutorId;
    return (executorId ? profiles.find((profile) => profile.id === executorId)?.name : null) ?? type;
  };

  return (
    <main className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line px-6 py-4">
        <div className="flex items-center gap-3">
          <span className="shrink-0 rounded bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">debate</span>
          <h1 className="min-w-0 flex-1 truncate text-lg font-medium tracking-tight">{task.title}</h1>
          <StatusPill status={task.status} />
          <TaskTimeChip task={task} />
          {task.archived ? (
            <>
              <span className="inline-flex shrink-0 items-center rounded-md bg-overlay px-3 py-1.5 text-sm text-muted" title="任务已归档（只读）">已归档</span>
              <button onClick={onUnarchive} className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:text-ink">取消归档</button>
            </>
          ) : canStopTask(task.status) ? (
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
          {!task.archived && canArchive(task.status) && (
                <button onClick={onArchive} className="shrink-0 rounded-md border border-line px-2 py-1.5 text-sm text-muted hover:text-ink">
                  归档
                </button>
              )}
              <button onClick={onDelete} className="shrink-0 rounded-md border border-line px-2 py-1.5 text-sm text-muted hover:text-red-600">
            删除
          </button>
        </div>
        {/* 议题/任务全文 —— 放在标题下的独立文本框（默认折叠成两行，点展开看全文）。 */}
        {topic.body ? (
          <CollapsibleText text={topic.body}>
            {topic.paths.length > 0 ? <AttachmentDisplay paths={topic.paths} className="px-3 pb-2" /> : null}
          </CollapsibleText>
        ) : (
          <AttachmentDisplay paths={topic.paths} className="mt-2" />
        )}
        {/* 配置摘要 + 定时（同一行，定时靠右）。 */}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {cfg && (
            <p className="text-xs text-muted">
              辩手A <b className="text-ink">{debaterName("A")}</b>
              {" ↔ 辩手B "}
              <b className="text-ink">{debaterName("B")}</b>
              {" · 轮数 "}{cfg.maxRounds ?? "不设限"}
              {" · 收敛门 "}{cfg.gateG1 === "on" ? "开" : "关"}
            </p>
          )}
          <div className="ml-auto">
            <ScheduleControl taskId={task.id} />
          </div>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto px-6 py-4">
          {turns.length === 0 && (
            <p className="text-sm text-faint">点击「运行」开始对抗。双方逐回合的发言会实时显示在这里。</p>
          )}
          {turns.map((t, i) => (
            <Bubble
              key={i}
              turn={t}
              task={task}
              prevRound={turns[i - 1]?.round}
              session={sessionFor(t.speaker)}
              agentType={agentFor(t.speaker)}
            />
          ))}
          {/* 结束后把双方结论提到末尾做一张「讨论结论」卡。 */}
          {task.status === "done" && (() => {
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
        <ConversationScrollButtons scrollRef={scrollRef} />
      </div>

      {gate?.open && task.status === "awaiting_review" && (
        <GateBar
          gate={gate}
          onGate={onGate}
          onTeam={handoffToTeam}
          onOpenTeam={() => setTeamModalOpen(true)}
          teamBusy={teamBusy}
          linkedTeam={linkedTeam}
          allTasks={allTasks}
          onOpenTask={onOpenTask}
          onDebateAgain={(team) => void iterateTeam(team)}
          debateAgainBusy={iterateBusy}
        />
      )}
      {(task.status === "done" || task.status === "failed" || task.status === "canceled") && (
        <FinishedTeamHandoffBar
          linkedTeam={linkedTeam}
          allTasks={allTasks}
          busy={teamBusy}
          onOpenTask={onOpenTask}
          onOpenPicker={() => setTeamModalOpen(true)}
          onDirectTeam={handoffToTeam}
          onDebateAgain={(team) => void iterateTeam(team)}
          debateAgainBusy={iterateBusy}
        />
      )}
      {teamModalOpen && (
        <TeamHandoffModal
          busy={teamBusy}
          onClose={() => setTeamModalOpen(false)}
          onConfirm={confirmTeamHandoff}
        />
      )}
    </main>
  );
}

function Bubble({
  turn,
  task,
  prevRound,
  session,
  agentType,
}: {
  turn: DebateTurn;
  task: Task;
  prevRound?: number;
  session?: Session;
  agentType?: AgentType;
}) {
  const showDivider = turn.round !== prevRound;
  const side = turn.speaker;

  // A human intervention (gate inject/ask): a right-aligned bubble with the time
  // the user spoke — the debate analog of a single task's reply bubble.
  if (side === "user") {
    const content = parseAttachmentText(turn.text);
    return (
      <div className="mb-3 rise">
        {showDivider && (
          <div className="my-3 text-center text-xs text-faint">── 第 {turn.round} 轮 ──</div>
        )}
        <div className="flex flex-col items-end">
          <div className="max-w-[88%] rounded-lg border border-accent/30 bg-accent/[0.08] px-3 py-2">
            <div className="mb-1 flex items-center gap-2 text-[11px] text-muted">
              <span className="font-medium text-ink/70">你</span>
              {turn.target && (
                <span className="text-faint">→ 辩手{turn.target}</span>
              )}
              {turn.at && (
                <>
                  <span className="text-faint">·</span>
                  <span className="text-faint">{formatInstant(turn.at)}</span>
                </>
              )}
            </div>
            {content.body && <div className="whitespace-pre-wrap break-words text-[13px] text-ink">{content.body}</div>}
            <AttachmentDisplay paths={content.paths} className={content.body ? "mt-2" : ""} />
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
  const who = side === "A" ? "辩手A" : side === "B" ? "辩手B" : side === "review" ? "历史代码审查" : "历史实现";
  // Prefer the concrete executor label (e.g. "codex@local"); fall back to the
  // configured agent type before the session row has loaded.
  const agentLabel = executorLabel({ session, task, agentType, fallback: "" });

  return (
    <div className="mb-3 rise">
      {showDivider && (
        <div className="my-3 text-center text-xs text-faint">
          ── 第 {turn.round} 轮{turn.round === 1 ? " · 盲态开局" : ""} ──
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
            {(turn.at ?? turn.startedAt) && <><span className="text-faint">·</span><span className="text-faint">{formatInstant(turn.at ?? turn.startedAt)}</span></>}
            {typeof turn.durationMs === "number" && <><span className="text-faint">·</span><span className="text-faint">用时 {formatDuration(turn.durationMs)}</span></>}
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
          {/* 老转写没有 per-turn 时间戳:退回会话级时间(「⏱ … 起」明确是会话时间,
              不冒充发言时刻),别让整页一个时间都没有。新数据有 turn 时刻就不重复。 */}
          {session && (session.resumeCommand || session.cliSessionId) && <ResumeButtons s={session} showTime={!turn.at && !turn.startedAt} />}
        </div>
      </div>
    </div>
  );
}

function GateBar({
  gate,
  onGate,
  onTeam,
  onOpenTeam,
  teamBusy,
  linkedTeam,
  allTasks,
  onOpenTask,
  onDebateAgain,
  debateAgainBusy,
}: {
  gate: DebateGate;
  onGate: (a: GateAction) => void | Promise<unknown>;
  onTeam: (command: string) => Promise<boolean>;
  onOpenTeam: () => void;
  teamBusy: boolean;
  linkedTeam?: Task;
  allTasks: Task[];
  onOpenTask: (taskId: string) => void;
  onDebateAgain: (team: Task) => void;
  debateAgainBusy: boolean;
}) {
  const [mode, setMode] = useState<"inject" | "ask" | null>(null);
  const [text, setText] = useState("");
  const [target, setTarget] = useState<"A" | "B" | null>(null); // 提问定向到的辩手（仅 ask·G1）
  const [mIdx, setMIdx] = useState(0);
  const isG1 = gate.gate === "G1";
  const consensus = !!gate.consensus;
  const consensusBy = gate.consensusBy ?? (consensus ? "both" : undefined);
  const label = !isG1
    ? "历史代码门 · 等待你裁决"
    : consensus
      ? `收敛门 · ${consensusBy === "both" ? "双方已达成共识" : "单方声明一致，待你确认"}`
      : "收敛门 · 双方仍有分歧（结论如下，供你定夺）";
  const nameA = "辩手A";
  const nameB = "辩手B";

  // @-mention：仅 G1 的「提问」支持把问题定向给单个辩手；历史代码门不显示候选。
  // 末尾 @token 触发候选；选中即设定 target 并去掉 @token。中文名用宽松正则。
  const canMention = isG1 && mode === "ask";
  const mCands = [{ key: "A" as const, name: nameA }, { key: "B" as const, name: nameB }];
  const mMatch = canMention ? /@([^\s@]*)$/.exec(text) : null;
  const cands = mMatch
    ? mCands.filter((c) => {
        const q = (mMatch[1] ?? "").toLowerCase();
        return !q || c.name.includes(mMatch[1]) || c.key.toLowerCase().startsWith(q);
      })
    : [];
  const mentionOpen = !!mMatch && cands.length > 0;
  const pick = (k: "A" | "B") => {
    setTarget(k);
    setText((s) => s.replace(/@[^\s@]*$/, ""));
    setMIdx(0);
  };
  const switchMode = (m: "inject" | "ask") => {
    setMode((cur) => (cur === m ? null : m));
    setTarget(null); // 切换/收起输入框时清空定向
  };
  const submit = async () => {
    if (!text.trim() || !mode) return;
    if (isTeamCommand(text)) {
      if (await onTeam(text)) setText("");
      return;
    }
    if (mode === "ask") onGate({ kind: "ask", text: text.trim(), target: target ?? undefined });
    else onGate({ kind: "inject", text: text.trim() });
    setText("");
    setMode(null);
    setTarget(null);
  };

  return (
    <div className="border-t border-violet-500/40 bg-violet-500/[0.07] px-6 py-3">
      {/* G1: always show BOTH sides' final conclusions so a self-reported
          "consensus" that actually differs can be caught at a glance. */}
      {isG1 && (
        <div className="mb-2 flex flex-col gap-0.5 text-xs">
          <div className={consensus ? "text-emerald-700" : "text-amber-700"}>
            {consensus
              ? consensusBy === "both"
                ? "✓ 双方均表示可收敛、自评结论一致（结论如下，若实际不符可打回或回炉）"
                : `✓ 辩手${consensusBy}表示可收敛且自评与对方一致（对方未再表态；结论如下，可打回或回炉）`
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
          {isG1 && (
            linkedTeam ? (
              <LinkedTeamCard
                team={linkedTeam}
                allTasks={allTasks}
                onOpen={onOpenTask}
                compact
                onDebateAgain={onDebateAgain}
                debateAgainBusy={debateAgainBusy}
              />
            ) : (
              <TeamHandoffButton busy={teamBusy} onClick={onOpenTeam} />
            )
          )}
          <button onClick={() => onGate({ kind: "approve" })} className="rounded-md bg-emerald-500 px-3 py-1 text-xs font-medium text-white">
            {isG1 ? "放行→结束" : "放行"}
          </button>
          <button onClick={() => onGate({ kind: "reject" })} className="rounded-md border border-line2 px-3 py-1 text-xs text-ink">
            打回终止
          </button>
          <button onClick={() => switchMode("inject")} className="rounded-md border border-line2 px-3 py-1 text-xs text-ink">
            注入意见→回炉
          </button>
          <button onClick={() => switchMode("ask")} className="rounded-md border border-line2 px-3 py-1 text-xs text-ink">
            提问→继续
          </button>
        </div>
      </div>
      {mode && (
        <div className="relative mt-2">
          {/* @-mention 候选：仅 ask·G1 出现，↑↓ 选、回车确定 */}
          {mentionOpen && (
            <div className="absolute bottom-full left-0 z-10 mb-1 w-56 overflow-hidden rounded-lg border border-line2 bg-panel p-1 shadow-xl">
              <div className="px-2 py-1 text-[10px] text-faint">把问题定向给 · ↑↓ 选，回车确定</div>
              {cands.map((c, i) => (
                <button
                  key={c.key}
                  onMouseEnter={() => setMIdx(i)}
                  onClick={() => pick(c.key)}
                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-ink ${i === mIdx ? "bg-raised" : ""}`}
                >
                  <Robot size={14} className="text-muted" /> @{c.name}
                </button>
              ))}
            </div>
          )}
          {target && (
            <div className="mb-1.5 flex items-center text-[12px]">
              <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-ink">
                <Robot size={12} /> 只问 @{target === "A" ? nameA : nameB}
                <button onClick={() => setTarget(null)} className="text-faint hover:text-ink" title="改为问双方">
                  <X size={11} weight="bold" />
                </button>
              </span>
            </div>
          )}
          <div className="flex gap-2">
            <textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (mentionOpen) {
                  if (e.key === "ArrowDown") { e.preventDefault(); setMIdx((i) => Math.min(cands.length - 1, i + 1)); return; }
                  if (e.key === "ArrowUp") { e.preventDefault(); setMIdx((i) => Math.max(0, i - 1)); return; }
                  if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); pick((cands[mIdx] ?? cands[0]).key); return; }
                }
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void submit(); }
              }}
              rows={2}
              placeholder={
                mode === "inject"
                  ? "补充意见，双方据此回炉再辩…"
                  : canMention
                    ? "向某位辩手提问，@ 指向单个（不填=问双方）…"
                    : "补充问题；提交后回到辩论继续…"
              }
              className="flex-1 resize-y rounded-md border border-line bg-panel px-2 py-1 text-sm outline-none"
            />
            <button
              disabled={!text.trim() || teamBusy}
              onClick={() => void submit()}
              className="self-start rounded-md bg-accent hover:bg-accent-hover px-3 py-1 text-xs font-medium text-accent-fg disabled:opacity-40"
            >
              提交
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
