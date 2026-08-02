import { useEffect, useMemo, useRef, useState } from "react";
import type { GateAction, Session, Task } from "@harness/shared";
import {
  TEAM_DEFAULTS,
  canArchive,
  normalizeDebateConfig,
  taskDisplayStatus,
} from "@harness/shared";
import {
  Archive,
  ChatCircle,
  ChatTeardrop,
  Play,
  SpinnerGap,
  Stop,
  Trash,
} from "@phosphor-icons/react";
import { ConversationScrollControls } from "../components/ConversationScrollControls.tsx";
import { ImagePreviewGroup } from "../components/ImagePreview.tsx";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { ScheduleControl } from "../components/ScheduleControl.tsx";
import { OriginTaskBar } from "../components/TaskOrigin.tsx";
import { TaskStatusDot } from "../components/TaskStatusDot.tsx";
import { api } from "../lib/api.ts";
import { useTaskReadState } from "../lib/useTaskReadState.ts";
import { DeleteTaskDialog } from "../task-detail/DeleteTaskDialog.tsx";
import { MessageAttachments } from "../task-detail/Attachments.tsx";
import { TaskPinButton } from "../task-detail/TaskPinButton.tsx";
import { TaskTimeMeta } from "../task-detail/TaskTimeMeta.tsx";
import { formatDuration, formatInstant, parseAttachmentText } from "../task-detail/utils.ts";
import { DebateGateControls, DebateProgressBar } from "./DebateControls.tsx";
import { DebateHandoffBar, DebateHandoffModal, type HandoffChoice } from "./DebateHandoff.tsx";
import { buildDebateHandoffBody, latestDebateGate } from "./debateHandoff.ts";
import { isOpenDebateGate, runCreatedHandoffFollowUps, teamDebateIterationState } from "./handoffPolicy.ts";
import type { DebateTurn } from "./debateState.ts";
import { useDebate } from "./useDebate.ts";

function timeMs(value?: string | null): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function latestByRole(sessions: Session[]): Partial<Record<Session["role"], Session>> {
  const result: Partial<Record<Session["role"], Session>> = {};
  for (const session of sessions) {
    const current = result[session.role];
    if (!current || timeMs(session.startedAt) > timeMs(current.startedAt)) result[session.role] = session;
  }
  return result;
}

function TypingDots() {
  return <span className="debate-typing" aria-label="思考中"><i /><i /><i /></span>;
}

function TurnBubble({
  turn,
  previousRound,
  session,
  fallback,
}: {
  turn: DebateTurn;
  previousRound?: number;
  session?: Session;
  fallback: string;
}) {
  const newRound = turn.round !== previousRound;
  if (turn.speaker === "user") {
    return (
      <div className="debate-turn-wrap">
        {newRound && <div className="debate-round-divider"><span />第 {turn.round} 轮<span /></div>}
        <article className="debate-user-turn">
          <header><b>你</b>{turn.target && <span>→ 辩手 {turn.target}</span>}{turn.at && <time>{formatInstant(turn.at)}</time>}</header>
          <p>{turn.text}</p>
        </article>
      </div>
    );
  }
  const side = turn.speaker === "B" ? "B" : turn.speaker === "A" ? "A" : "history";
  const role = turn.speaker === "A" ? "辩手 A" : turn.speaker === "B" ? "辩手 B" : turn.speaker === "review" ? "历史审查" : "历史实现";
  const shownAt = turn.at ?? turn.startedAt ?? session?.startedAt;
  return (
    <div className="debate-turn-wrap">
      {newRound && <div className="debate-round-divider"><span />第 {turn.round} 轮{turn.round === 1 ? " · 盲态开局" : ""}<span /></div>}
      <article className={`debate-turn debate-turn--${side}`}>
        <header>
          <span>{side === "B" ? <ChatTeardrop size={12} weight="fill" /> : <ChatCircle size={12} weight="fill" />}{role}</span>
          <b>{session?.executor || fallback}</b>
          {shownAt && <time>{formatInstant(shownAt)}</time>}
          {typeof turn.durationMs === "number" && <small>· ⏱ {formatDuration(turn.durationMs)} 用时</small>}
          {turn.raised && <em>✋ 可收敛</em>}
          {!turn.done && <TypingDots />}
        </header>
        {turn.tools.map((tool, index) => (
          <details className="debate-tool" key={`${tool.name}-${index}`}><summary>{tool.name}</summary>{tool.detail && <pre>{tool.detail}</pre>}</details>
        ))}
        {!turn.done && !turn.text && !turn.tools.length && <p className="debate-thinking">正在组织本轮观点…</p>}
        {turn.text && <MarkdownBody text={turn.text} />}
        {turn.error && <p className="debate-turn-error">{turn.error}</p>}
      </article>
    </div>
  );
}

function actionFor(task: Task): { kind: "run" | "retry" | "stop" | null; label: string } {
  if (task.status === "running") return { kind: "stop", label: "停止" };
  if (task.status === "failed") return { kind: "retry", label: "重试" };
  if (task.status === "backlog" || task.status === "canceled" || task.status === "paused") return { kind: "run", label: task.status === "paused" ? "继续" : "运行" };
  return { kind: null, label: task.status === "done" ? "已完成" : task.status === "awaiting_review" ? "等待裁决" : task.status === "queued" ? "排队中" : "进行中" };
}

export function DebateView({
  task,
  allTasks,
  onTaskUpdated,
  onTaskCreated,
  onTaskDeleted,
  onSelectTask,
  notify,
}: {
  task: Task;
  allTasks: Task[];
  onTaskUpdated: (task: Task) => void;
  onTaskCreated: (task: Task) => void;
  onTaskDeleted: (taskId: string) => void;
  onSelectTask: (task: Task) => void;
  notify: (message: string) => void;
}) {
  const config = normalizeDebateConfig(task.debate);
  const topic = parseAttachmentText(task.body || config.topic);
  const debate = useDebate(task.id, task.status);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [busy, setBusy] = useState(false);
  const [teamBusy, setTeamBusy] = useState(false);
  const [iterationBusyId, setIterationBusyId] = useState<string | null>(null);
  const [teamModal, setTeamModal] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [title, setTitle] = useState(task.title);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { indicatorForTask } = useTaskReadState(allTasks, task.id);

  useEffect(() => setTitle(task.title), [task.id, task.title]);
  useEffect(() => {
    setTeamModal(false);
    setDeleteOpen(false);
    setIterationBusyId(null);
  }, [task.id]);
  useEffect(() => { void api.sessions(task.id).then(setSessions).catch(() => setSessions([])); }, [task.id, task.status]);
  const sessionsByRole = useMemo(() => latestByRole(sessions), [sessions]);
  const turns = debate.state.turns;
  const currentRound = turns.reduce((max, turn) => Math.max(max, turn.round), 0);
  const gate = debate.state.gate ?? latestDebateGate(turns, task.status === "awaiting_review");
  const gateOpen = isOpenDebateGate(gate, task.status);
  const linkedTeams = useMemo(() => allTasks
    .filter((item) => item.mode === "team" && item.originTaskId === task.id)
    .sort((a, b) => timeMs(b.createdAt) - timeMs(a.createdAt)), [allTasks, task.id]);
  const display = taskDisplayStatus(task.status, task.stage, !!task.question);
  const indicator = indicatorForTask(task);
  const action = actionFor(task);

  const refreshTask = async () => onTaskUpdated(await api.task(task.id));
  const perform = async (kind: Exclude<ReturnType<typeof actionFor>["kind"], null>) => {
    setBusy(true);
    try {
      if (kind === "run") await api.runTask(task.id);
      if (kind === "retry") await api.retryTask(task.id);
      if (kind === "stop") await api.stopTask(task.id);
      await refreshTask();
      notify(kind === "stop" ? "辩论已停止" : kind === "retry" ? "已重试失败轮次" : "辩论已启动");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const gateAction = async (next: GateAction) => {
    setBusy(true);
    try {
      await api.gate(task.id, next);
      await refreshTask();
      notify(next.kind === "approve" ? "已放行并结束辩论" : next.kind === "reject" ? "已打回并终止辩论" : "意见已送入，辩论继续");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const archive = async () => {
    try {
      onTaskUpdated(task.archived ? await api.unarchiveTask(task.id) : await api.archiveTask(task.id));
      notify(task.archived ? "已取消归档" : "辩论已归档");
    } catch (reason) { notify(reason instanceof Error ? reason.message : String(reason)); }
  };
  const commitTitle = async () => {
    const next = title.trim();
    if (!next || next === task.title) return setTitle(task.title);
    try { onTaskUpdated(await api.patchTask(task.id, { title: next, autoTitle: false })); }
    catch (reason) { setTitle(task.title); notify(reason instanceof Error ? reason.message : String(reason)); }
  };
  const handoff = async (choice: HandoffChoice): Promise<boolean> => {
    if (teamBusy) return false;
    setTeamBusy(true);
    let created: Task;
    try {
      const freshSessions = await api.sessions(task.id);
      setSessions(freshSessions);
      created = await api.createTask({
        projectId: task.projectId,
        title: `落实辩论结论：${task.title}`.slice(0, 60),
        body: buildDebateHandoffBody(task, gate, turns, freshSessions, choice.note),
        mode: "team",
        originTaskId: task.id,
        agentType: choice.lead.agentType,
        team: {
          ...TEAM_DEFAULTS,
          lead: choice.lead.agentType,
          worker: choice.worker.agentType,
          leadExecutorId: choice.lead.executorId,
          workerExecutorId: choice.worker.executorId,
        },
        autoTitle: false,
      });
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
      setTeamBusy(false);
      return false;
    }
    onTaskCreated(created);
    setTeamModal(false);
    const followUpFailures = await runCreatedHandoffFollowUps({
      closeGate: gateOpen ? () => api.gate(task.id, { kind: "approve" }) : null,
      startTeam: () => api.runTask(created.id),
    });
    setTeamBusy(false);
    if (!followUpFailures.length) notify("已创建团队，辩论结论已接力执行");
    else notify(`团队已创建，但${followUpFailures.map(({ phase, reason }) => `${phase === "gate" ? "辩论自动收尾" : "启动"}失败（${reason instanceof Error ? reason.message : String(reason)}）`).join("、")}`);
    return true;
  };
  const iterateTeam = async (team: Task) => {
    const iteration = teamDebateIterationState(team, allTasks);
    if (!iteration.eligible) return;
    if (iteration.existing) {
      onSelectTask(iteration.existing);
      return;
    }
    if (iterationBusyId) return;
    setIterationBusyId(team.id);
    try {
      let target = await api.iterateTeamDebate(team.id);
      onTaskCreated(target);
      if (target.status === "backlog") {
        try {
          await api.runTask(target.id);
          notify("已创建新一轮辩论并开跑");
          try {
            target = await api.task(target.id);
            onTaskCreated(target);
          } catch { /* task.status 事件仍会刷新列表 */ }
        } catch (reason) {
          notify(`新一轮辩论已创建，但启动失败：${reason instanceof Error ? reason.message : String(reason)}`);
        }
      } else {
        notify("已打开这个团队现有的下一轮辩论");
      }
      onSelectTask(target);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setIterationBusyId(null);
    }
  };

  return (
    <div className="debate-view">
      <OriginTaskBar task={task} allTasks={allTasks} onOpen={(taskId) => {
        const target = allTasks.find((item) => item.id === taskId);
        if (target) onSelectTask(target);
        else notify("关联任务不存在或尚未加载");
      }} />
      <header className="debate-header">
        <span className="debate-kind">辩论</span>
        <TaskPinButton
          task={task}
          onTogglePin={async () => onTaskUpdated(await api.patchTask(task.id, { pinnedAt: task.pinnedAt != null ? null : Date.now() }))}
          notify={notify}
        />
        <input value={title} aria-label="辩论标题" onChange={(event) => setTitle(event.target.value)} onBlur={() => void commitTitle()} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setTitle(task.title); event.currentTarget.blur(); } }} />
        <span className="debate-status">
          {indicator && <TaskStatusDot indicator={indicator} surface="team" />}
          {display.label}
        </span>
        <TaskTimeMeta task={task} />
        <button type="button" className={action.kind === "stop" ? "is-stop" : "is-primary"} data-workspace-run-action={action.kind === "run" || action.kind === "retry" ? action.kind : undefined} disabled={busy || !action.kind || task.archived} onClick={() => action.kind && void perform(action.kind)}>{busy ? <SpinnerGap size={13} className="is-spinning" /> : action.kind === "stop" ? <Stop size={12} weight="fill" /> : <Play size={12} weight="fill" />}{action.label}</button>
        {!task.archived && canArchive(task.status) && <button type="button" title="归档辩论" onClick={() => void archive()}><Archive size={13} /></button>}
        {task.archived && <button type="button" onClick={() => void archive()}>取消归档</button>}
        <button type="button" title="删除辩论" onClick={() => setDeleteOpen(true)}><Trash size={13} /></button>
      </header>

      <ImagePreviewGroup isolated>
        <section className="debate-config-card">
          <div>
            <small>辩题</small><h2>{topic.body || config.topic || task.title}</h2><MessageAttachments paths={topic.paths} />
            <ScheduleControl
              taskId={task.id}
              notify={notify}
              disabled={!!task.archived}
              className="debate-schedule-control"
            />
          </div>
          <dl>
            <div><dt><ChatCircle size={12} weight="fill" />辩手 A</dt><dd>{sessionsByRole.debaterA?.executor || config.debaterA}</dd></div>
            <div><dt><ChatTeardrop size={12} weight="fill" />辩手 B</dt><dd>{sessionsByRole.debaterB?.executor || config.debaterB}</dd></div>
            <div><dt>轮数</dt><dd>{config.maxRounds ?? "不设限"}</dd></div>
            <div><dt>收敛门</dt><dd>{config.gateG1 === "on" ? "G1 开启" : "关闭"}</dd></div>
          </dl>
        </section>
      </ImagePreviewGroup>

      <ImagePreviewGroup isolated>
        <div className="conversation-scroll-region">
          <div className="debate-stream" ref={scrollRef}>
            {debate.loading && !turns.length && <p className="debate-empty"><SpinnerGap size={14} className="is-spinning" />正在读取辩论记录…</p>}
            {!debate.loading && debate.error && !turns.length && <p className="debate-empty is-error">辩论记录读取失败：{debate.error}</p>}
            {!debate.loading && !debate.error && !turns.length && <p className="debate-empty">点击“运行”开始辩论。双方逐轮发言会实时出现在这里。</p>}
            {turns.map((turn, index) => (
              <TurnBubble
                key={`${turn.round}-${turn.speaker}-${index}`}
                turn={turn}
                previousRound={turns[index - 1]?.round}
                session={turn.speaker === "A" ? sessionsByRole.debaterA : turn.speaker === "B" ? sessionsByRole.debaterB : undefined}
                fallback={turn.speaker === "B" ? config.debaterB : config.debaterA}
              />
            ))}
            {task.status === "running" && turns.length > 0 && turns.at(-1)?.done && <p className="debate-between"><TypingDots />正在准备下一次发言…</p>}
            {task.status === "failed" && <p className="debate-terminal is-error">本次辩论失败并停止</p>}
            {task.status === "canceled" && <p className="debate-terminal">辩论已取消</p>}
          </div>
          <ConversationScrollControls scrollRef={scrollRef} resetKey={`${task.id}:${turns.length}`} />
        </div>
      </ImagePreviewGroup>

      {gate?.open && task.status === "awaiting_review" ? (
        <DebateGateControls
          gate={gate}
          round={currentRound}
          maxRounds={config.maxRounds}
          busy={busy || teamBusy || !!iterationBusyId}
          linkedTeams={linkedTeams}
          allTasks={allTasks}
          iterationBusyId={iterationBusyId}
          onGate={gateAction}
          onOpenTeam={() => setTeamModal(true)}
          onOpenTask={onSelectTask}
          onIterateTeam={(team) => void iterateTeam(team)}
        />
      ) : ["done", "failed", "canceled"].includes(task.status) ? (
        <div className="debate-terminal-handoff">
          <DebateHandoffBar
            linkedTeams={linkedTeams}
            allTasks={allTasks}
            busy={teamBusy || !!iterationBusyId}
            iterationBusyId={iterationBusyId}
            onOpenTeam={() => setTeamModal(true)}
            onOpenTask={onSelectTask}
            onIterateTeam={(team) => void iterateTeam(team)}
          />
        </div>
      ) : (
        <DebateProgressBar round={currentRound} maxRounds={config.maxRounds} gateEnabled={config.gateG1 === "on"} />
      )}
      {teamModal && <DebateHandoffModal busy={teamBusy} onClose={() => setTeamModal(false)} onConfirm={handoff} />}
      {deleteOpen && <DeleteTaskDialog task={task} notify={notify} onDeleted={() => onTaskDeleted(task.id)} onClose={() => setDeleteOpen(false)} />}
    </div>
  );
}
