import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { normalizeDuetConfig } from "@ash/shared/duet";
import type { GateAction, Session, Task, TaskListItem } from "@ash/shared";
import { runActivityPhase } from "@ash/shared/run-activity";
import { TEAM_DEFAULTS, canArchive, taskDisplayStatus } from "@ash/shared";
import {
  Archive,
  CaretDown,
  ChatCircle,
  ChatTeardrop,
  ClipboardText,
  Play,
  SpinnerGap,
  Stop,
  Trash,
} from "@phosphor-icons/react";
import { ConversationScrollControls } from "../components/ConversationScrollControls.tsx";
import { ExecutionDetails } from "../components/ExecutionTrace.tsx";
import { ImagePreviewGroup } from "../components/ImagePreview.tsx";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { RunActivity } from "../components/RunActivity.tsx";
import { ScheduleControl } from "../components/ScheduleControl.tsx";
import { OriginTaskBar } from "../components/TaskOrigin.tsx";
import { TaskStatusDot } from "../components/TaskStatusDot.tsx";
import { api } from "../lib/api.ts";
import { useTaskReadState } from "../lib/useTaskReadState.ts";
import { DeleteTaskDialog } from "../task-detail/DeleteTaskDialog.tsx";
import { useExecutorGate } from "../task-detail/ExecutorGate.tsx";
import { MessageAttachments } from "../task-detail/Attachments.tsx";
import { TaskPinButton } from "../task-detail/TaskPinButton.tsx";
import { TaskTimeMeta } from "../task-detail/TaskTimeMeta.tsx";
import { formatDuration, formatInstant, parseAttachmentText } from "../task-detail/utils.ts";
import { AcceptanceControls } from "../team/TeamReviewWorkspace.tsx";
import { DuetGateControls, DuetProgressBar } from "./DuetControls.tsx";
import { DuetHandoffBar, DuetHandoffModal, type HandoffChoice } from "./DuetHandoff.tsx";
import { buildDuetHandoffBody, latestDuetGate } from "./duetHandoff.ts";
import { isOpenDuetGate, runCreatedHandoffFollowUps, teamDuetIterationState } from "./handoffPolicy.ts";
import { latestActiveDuetTurn, type DuetTurn } from "./duetState.ts";
import { useDuet } from "./useDuet.ts";

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
  return <span className="duet-typing" aria-label="思考中"><i /><i /><i /></span>;
}

function TurnBubble({
  turn,
  previousRound,
  session,
  fallback,
}: {
  turn: DuetTurn;
  previousRound?: number;
  session?: Session;
  fallback: string;
}) {
  const newRound = turn.round !== previousRound;
  if (turn.speaker === "user") {
    // 这一轮可能是「一句话 + 一张截图」:正文里那段附件清单要还原成缩略图,而不是把本地路径原样念给用户看。
    const said = parseAttachmentText(turn.text);
    return (
      <div className="duet-turn-wrap">
        {newRound && <div className="duet-round-divider"><span />第 {turn.round} 轮<span /></div>}
        <article className="duet-user-turn">
          <header><b>你</b>{turn.target && <span>→ 讨论者 {turn.target}</span>}{turn.at && <time>{formatInstant(turn.at)}</time>}</header>
          {said.body && <p>{said.body}</p>}
          <MessageAttachments paths={said.paths} />
        </article>
      </div>
    );
  }
  const side = turn.speaker === "B" ? "B" : turn.speaker === "A" ? "A" : turn.speaker === "synthesis" ? "synthesis" : "history";
  const role = turn.speaker === "A" ? "讨论者 A" : turn.speaker === "B" ? "讨论者 B" : turn.speaker === "synthesis" ? (!turn.stop || turn.stop === "consensus" ? "共同方案" : "决策文档 · 未共识") : turn.speaker === "review" ? "历史审查" : "历史实现";
  const shownAt = turn.at ?? turn.startedAt ?? session?.startedAt;
  return (
    <div className="duet-turn-wrap">
      {newRound && <div className="duet-round-divider"><span />第 {turn.round} 轮{turn.round === 1 ? " · 盲态开局" : ""}<span /></div>}
      <article className={`duet-turn duet-turn--${side}`}>
        <header>
          <span>{side === "synthesis" ? <ClipboardText size={12} weight="fill" /> : side === "B" ? <ChatTeardrop size={12} weight="fill" /> : <ChatCircle size={12} weight="fill" />}{role}</span>
          <b>{session?.executor || fallback}</b>
          {shownAt && <time>{formatInstant(shownAt)}</time>}
          {typeof turn.durationMs === "number" && <small>· ⏱ {formatDuration(turn.durationMs)} 用时</small>}
          {turn.raised && <em>✋ 可收敛</em>}
          {!turn.done && <TypingDots />}
        </header>
        <ExecutionDetails events={turn.events} running={!turn.done} />
        {!turn.done && !turn.text && !turn.events.length && <p className="duet-thinking">{side === "synthesis" ? "正在把讨论成果整理成共同方案…" : "正在组织本轮观点…"}</p>}
        {turn.text && <MarkdownBody text={turn.text} />}
        {turn.notice && <p className="duet-turn-notice">{turn.notice}</p>}
        {turn.error && <p className="duet-turn-error">{turn.error}</p>}
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

export function DuetView({
  task,
  allTasks,
  onTaskUpdated,
  onTaskCreated,
  onTaskDeleted,
  onSelectTask,
  terminalToggle,
  notify,
}: {
  task: Task;
  allTasks: TaskListItem[];
  onTaskUpdated: (task: Task) => void;
  onTaskCreated: (task: Task) => void;
  onTaskDeleted: (taskId: string) => void;
  onSelectTask: (task: TaskListItem) => void;
  terminalToggle?: ReactNode;
  notify: (message: string) => void;
}) {
  const config = normalizeDuetConfig(task.duet);
  const topic = parseAttachmentText(task.body || config.topic);
  const duet = useDuet(task.id, task.status);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [busy, setBusy] = useState(false);
  // 确认闸的对话框住在 App 层(见 task-detail/ExecutorGate.tsx),这里只拿判据。
  const confirmExecutorSwap = useExecutorGate();
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
  // An unmatched persisted start means "active" only while the task itself is
  // running. After a server interruption the task becomes failed; hiding that
  // orphan prevents a stale thinking bubble from claiming the process survived.
  const turns = task.status === "running"
    ? duet.state.turns
    : duet.state.turns.filter((turn) => turn.done);
  const currentRound = turns.reduce((max, turn) => Math.max(max, turn.round), 0);
  const gate = duet.state.gate ?? latestDuetGate(turns, task.status === "awaiting_review");
  const gateOpen = isOpenDuetGate(gate, task.status);
  const linkedTeams = useMemo(() => allTasks
    .filter((item) => item.mode === "team" && item.originTaskId === task.id)
    .sort((a, b) => timeMs(b.createdAt) - timeMs(a.createdAt)), [allTasks, task.id]);
  const display = taskDisplayStatus(task.status, task.stage, !!task.question);
  const indicator = indicatorForTask(task);
  const action = actionFor(task);
  const lastTurn = turns.at(-1);
  const activeTurn = latestActiveDuetTurn(turns);
  const activityPhase = runActivityPhase(
    task.status,
    !lastTurn ? "empty" : lastTurn.speaker === "user" ? "user" : lastTurn.done ? "agent-ended" : "agent-active",
  );

  const refreshTask = async () => onTaskUpdated(await api.task(task.id));
  const perform = async (kind: Exclude<ReturnType<typeof actionFor>["kind"], null>) => {
    // 会起一轮的动作先过「换执行器」确认闸(§八:不静默替换)。duet 的两位讨论者各占
    // 一格,判据由后端 executor-preflight 给(第 6 轮审查 P1:这条路整个绕过了闸)。
    if ((kind === "run" || kind === "retry") && !(await confirmExecutorSwap(task.id))) return;
    setBusy(true);
    try {
      if (kind === "run") await api.runTask(task.id);
      if (kind === "retry") await api.retryTask(task.id);
      if (kind === "stop") await api.stopTask(task.id);
      await refreshTask();
      notify(kind === "stop" ? "讨论已停止" : kind === "retry" ? "已重试失败轮次" : "讨论已启动");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const gateAction = async (next: GateAction) => {
    // 闸口四个动作里只有「注入意见 / 提问」会真的再起一轮讨论 —— 放行/打回只是结算,
    // 一个 CLI 都不起,那就别拿一句「会换执行器」去打扰。
    if ((next.kind === "inject" || next.kind === "ask") && !(await confirmExecutorSwap(task.id))) return;
    setBusy(true);
    try {
      await api.gate(task.id, next);
      await refreshTask();
      notify(next.kind === "approve" ? "已放行并结束讨论" : next.kind === "reject" ? "已打回并终止讨论" : "意见已送入，讨论继续");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  const archive = async () => {
    try {
      onTaskUpdated(task.archived ? await api.unarchiveTask(task.id) : await api.archiveTask(task.id));
      notify(task.archived ? "已取消归档" : "讨论已归档");
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
        title: `落实讨论结论：${task.title}`.slice(0, 60),
        body: buildDuetHandoffBody(task, gate, turns, freshSessions, choice.note),
        mode: "team",
        originTaskId: task.id,
        agentType: choice.lead.agentType,
        team: {
          ...TEAM_DEFAULTS,
          lead: choice.lead.agentType,
          worker: choice.worker.agentType,
          leadExecutorId: choice.lead.executorId,
          workerExecutorId: choice.worker.executorId,
          leadModel: choice.lead.model,
          leadReasoningEffort: choice.lead.effort,
          workerModel: choice.worker.model,
          workerReasoningEffort: choice.worker.effort,
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
    if (!followUpFailures.length) notify("已创建团队，讨论结论已接力执行");
    else notify(`团队已创建，但${followUpFailures.map(({ phase, reason }) => `${phase === "gate" ? "讨论自动收尾" : "启动"}失败（${reason instanceof Error ? reason.message : String(reason)}）`).join("、")}`);
    return true;
  };
  const iterateTeam = async (team: TaskListItem) => {
    const iteration = teamDuetIterationState(team, allTasks);
    if (!iteration.eligible) return;
    if (iteration.existing) {
      onSelectTask(iteration.existing);
      return;
    }
    if (iterationBusyId) return;
    setIterationBusyId(team.id);
    try {
      let target = await api.iterateTeamDuet(team.id);
      onTaskCreated(target);
      if (target.status === "backlog") {
        try {
          await api.runTask(target.id);
          notify("已创建新一轮讨论并开跑");
          try {
            target = await api.task(target.id);
            onTaskCreated(target);
          } catch { /* task.status 事件仍会刷新列表 */ }
        } catch (reason) {
          notify(`新一轮讨论已创建，但启动失败：${reason instanceof Error ? reason.message : String(reason)}`);
        }
      } else {
        notify("已打开这个团队现有的下一轮讨论");
      }
      onSelectTask(target);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setIterationBusyId(null);
    }
  };

  return (
    <div className="duet-view">
      <OriginTaskBar task={task} allTasks={allTasks} onOpen={(taskId) => {
        const target = allTasks.find((item) => item.id === taskId);
        if (target) onSelectTask(target);
        else notify("关联任务不存在或尚未加载");
      }} />
      <header className="duet-header">
        <span className="duet-kind">讨论</span>
        <TaskPinButton
          task={task}
          onTogglePin={async () => onTaskUpdated(await api.patchTask(task.id, { pinnedAt: task.pinnedAt != null ? null : Date.now() }))}
          notify={notify}
        />
        <input value={title} aria-label="讨论标题" onChange={(event) => setTitle(event.target.value)} onBlur={() => void commitTitle()} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setTitle(task.title); event.currentTarget.blur(); } }} />
        <span className="duet-status">
          {indicator && <TaskStatusDot indicator={indicator} surface="team" />}
          {display.label}
        </span>
        <TaskTimeMeta task={task} />
        <button type="button" className={action.kind === "stop" ? "is-stop" : "is-primary"} data-workspace-run-action={action.kind === "run" || action.kind === "retry" ? action.kind : undefined} disabled={busy || !action.kind || task.archived} onClick={() => action.kind && void perform(action.kind)}>{busy ? <SpinnerGap size={13} className="is-spinning" /> : action.kind === "stop" ? <Stop size={12} weight="fill" /> : <Play size={12} weight="fill" />}{action.label}</button>
        {!task.archived && canArchive(task.status) && <button type="button" title="归档讨论" onClick={() => void archive()}><Archive size={13} /></button>}
        {task.archived && <button type="button" onClick={() => void archive()}>取消归档</button>}
        <button type="button" title="删除讨论" onClick={() => setDeleteOpen(true)}><Trash size={13} /></button>
        {terminalToggle}
      </header>

      <ImagePreviewGroup isolated>
        <details className="duet-context">
          <summary>
            <span className="duet-context-topic"><small>议题</small><b>{topic.body || config.topic || task.title}</b></span>
            <span className="duet-context-meta">
              <span className="is-a"><ChatCircle size={12} weight="fill" />{sessionsByRole.voiceA?.executor || config.voiceA}</span>
              <span className="is-b"><ChatTeardrop size={12} weight="fill" />{sessionsByRole.voiceB?.executor || config.voiceB}</span>
              <span>{config.maxRounds ? `${config.maxRounds} 轮` : "不限轮次"}</span>
              <span>{config.gateG1 === "on" ? "G1 开启" : "无收敛门"}</span>
            </span>
            <CaretDown className="duet-context-caret" size={13} weight="bold" />
          </summary>
          <div className="duet-context-details">
            <div className="duet-context-full-topic">
              <small>完整议题</small><h2>{topic.body || config.topic || task.title}</h2><MessageAttachments paths={topic.paths} />
            </div>
            <ScheduleControl
              taskId={task.id}
              notify={notify}
              disabled={!!task.archived}
              className="duet-schedule-control"
            />
          </div>
        </details>
      </ImagePreviewGroup>

      <ImagePreviewGroup isolated>
        <div className="conversation-scroll-region">
          <div className="duet-stream" ref={scrollRef}>
            {duet.loading && !turns.length && <p className="duet-empty"><SpinnerGap size={14} className="is-spinning" />正在读取讨论记录…</p>}
            {!duet.loading && duet.error && !turns.length && <p className="duet-empty is-error">讨论记录读取失败：{duet.error}</p>}
            {!duet.loading && !duet.error && !turns.length && (activityPhase
              ? <RunActivity status={task.status} mode={task.mode} phase={activityPhase} queuePosition={task.queuePosition} />
              : <p className="duet-empty">点击“运行”开始讨论。双方逐轮发言会实时出现在这里。</p>)}
            {turns.map((turn, index) => (
              <TurnBubble
                key={`${turn.round}-${turn.speaker}-${index}`}
                turn={turn}
                previousRound={turns[index - 1]?.round}
                session={turn.speaker === "A" ? sessionsByRole.voiceA : turn.speaker === "B" ? sessionsByRole.voiceB : undefined}
                fallback={turn.speaker === "B" ? config.voiceB : config.voiceA}
              />
            ))}
            {activityPhase === "replying" && turns.length > 0 && <RunActivity status={task.status} mode={task.mode} phase={activityPhase} queuePosition={task.queuePosition} />}
            {task.status === "running" && turns.length > 0 && lastTurn?.done && activityPhase !== "replying" && (activeTurn
              ? <RunActivity
                  status={task.status}
                  mode={task.mode}
                  phase="continuing"
                  queuePosition={task.queuePosition}
                  copy={{
                    title: `讨论者 ${activeTurn.speaker} 正在发言`,
                    detail: "该讨论者已经开始本轮执行；新的输出或完成结果会自动显示在这里。",
                  }}
                />
              : <p className="duet-between"><TypingDots />正在准备下一次发言…</p>)}
            {task.status === "failed" && <p className="duet-terminal is-error">本次讨论失败并停止</p>}
            {task.status === "canceled" && <p className="duet-terminal">讨论已取消</p>}
          </div>
          <ConversationScrollControls scrollRef={scrollRef} resetKey={`${task.id}:${turns.length}`} />
        </div>
      </ImagePreviewGroup>

      {gate?.open && task.status === "awaiting_review" ? (
        <DuetGateControls
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
        <div className="duet-terminal-handoff">
          <div className="duet-terminal-acceptance">
            <div><b>讨论结论</b><small>确认这份结论，或带着意见让双方继续讨论。</small></div>
            <AcceptanceControls task={task} onTaskUpdated={onTaskUpdated} notify={notify} />
          </div>
          <DuetHandoffBar
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
        <DuetProgressBar round={currentRound} maxRounds={config.maxRounds} gateEnabled={config.gateG1 === "on"} />
      )}
      {teamModal && <DuetHandoffModal busy={teamBusy} onClose={() => setTeamModal(false)} onConfirm={handoff} />}
      {deleteOpen && <DeleteTaskDialog task={task} notify={notify} onDeleted={(ids) => ids.forEach(onTaskDeleted)} onClose={() => setDeleteOpen(false)} />}
    </div>
  );
}
