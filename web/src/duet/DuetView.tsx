import { useEffect, useMemo, useRef, useState } from "react";
import { normalizeDuetConfig } from "@ash/shared/duet";
import type { GateAction, Session, Task, TaskActions, TaskListItem } from "@ash/shared";
import { runActivityPhase } from "@ash/shared/run-activity";
import { TEAM_DEFAULTS, taskDisplayStatus } from "@ash/shared";
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
import { contentVersion } from "../lib/useStickToBottom.ts";
import { executionEventsSize } from "../task-detail/conversationContentSize.ts";
import { ExecutionDetails } from "../components/ExecutionTrace.tsx";
import { ImagePreviewGroup } from "../components/ImagePreview.tsx";
import { MarkdownBody } from "../components/MarkdownBody.tsx";
import { MessageText } from "../components/MessageText.tsx";
import { taskFileResolver } from "../components/markdownPolicy.ts";
import { RunActivity } from "../components/RunActivity.tsx";
import { ScheduleControl } from "../components/ScheduleControl.tsx";
import { OriginTaskBar, TaskCreationBadge } from "../components/TaskOrigin.tsx";
import { TaskStatusDot } from "../components/TaskStatusDot.tsx";
import { api } from "../lib/api.ts";
import { toggleArchive } from "../lib/archive.ts";
import { blocker, refreshTaskActions, shown, useTaskActions } from "../lib/useTaskActions.ts";
import { IconButton } from "../components/IconButton.tsx";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import { useTaskReadState } from "../lib/useTaskReadState.ts";
import { DeleteTaskDialog } from "../task-detail/DeleteTaskDialog.tsx";
import { useExecutorGate } from "../task-detail/ExecutorGate.tsx";
import { MessageAttachments } from "../task-detail/Attachments.tsx";
import { TaskPinButton } from "../task-detail/TaskPinButton.tsx";
import { TaskTimeMeta } from "../task-detail/TaskTimeMeta.tsx";
import { turnImageMarkdown } from "../task-detail/turnImages.ts";
import { conversationInputAnchor, conversationInputs } from "../task-detail/conversationInputs.ts";
import { formatDuration, formatInstant, parseAttachmentText } from "../task-detail/utils.ts";
import { AcceptanceControls } from "../acceptance/AcceptanceControls.tsx";
import { DuetGateControls, DuetProgressBar } from "./DuetControls.tsx";
import { DuetHandoffBar, DuetHandoffModal, type HandoffChoice } from "./DuetHandoff.tsx";
import { buildDuetHandoffBody, latestDuetGate } from "./duetHandoff.ts";
import { isOpenDuetGate, runCreatedHandoffFollowUps } from "./handoffPolicy.ts";
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
  inputId,
  previousRound,
  session,
  fallback,
  taskId,
}: {
  turn: DuetTurn;
  /** 我插的话在左侧输入导航上的那一格（只有 speaker 是 user 的轮次有）。 */
  inputId?: string;
  previousRound?: number;
  session?: Session;
  fallback: string;
  /** 讨论者引用的本机图片按这个任务的工作目录取（见 markdownPolicy 的 taskFileResolver）。 */
  taskId: string;
}) {
  const newRound = turn.round !== previousRound;
  if (turn.speaker === "user") {
    // 这一轮可能是「一句话 + 一张截图」:正文里那段附件清单要还原成缩略图,而不是把本地路径原样念给用户看。
    const said = parseAttachmentText(turn.text);
    return (
      <div className="duet-turn-wrap">
        {newRound && <div className="duet-round-divider"><span />第 {turn.round} 轮<span /></div>}
        <article className="duet-user-turn" {...(inputId ? conversationInputAnchor(inputId) : {})}>
          <header><b>你</b>{turn.target && <span>→ 讨论者 {turn.target}</span>}{turn.at && <time>{formatInstant(turn.at)}</time>}</header>
          {said.body && <MessageText text={said.body} />}
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
        <ExecutionDetails events={turn.events} running={!turn.done} awaiting={turn.awaiting} />
        {!turn.done && !turn.text && !turn.events.length && <p className="duet-thinking">{side === "synthesis" ? "正在把讨论成果整理成共同方案…" : "正在组织本轮观点…"}</p>}
        {/* 讨论者写的 `![](output/x.png)` 指的是**它工作目录里**那张图，浏览器直接取不到。
            配对走会话流那同一套（turnImageMarkdown → turnImages）：有「说那句话时的快照
            拷贝」就用它，明确没有拷贝才现在去目录里取，目录被清掉了就什么都不画（绝不
            留裂图标）。`resolveFile` 仍留着——正文里指向图片的**链接**也要进灯箱。 */}
        {turn.text && (
          <MarkdownBody
            text={turnImageMarkdown(turn.text, turn.images, taskId)}
            resolveFile={taskFileResolver(taskId)}
          />
        )}
        {turn.notice && <p className="duet-turn-notice">{turn.notice}</p>}
        {turn.error && <p className="duet-turn-error">{turn.error}</p>}
      </article>
    </div>
  );
}

// 讨论头那颗主键：有东西可停时是停止，否则是此刻轮到你的那一步（出不出、点不点得了都照服务端的
// 判据，lib/useTaskActions.ts）；两样都没有就灰着写一句现在的状态。
function actionFor(task: Task, actions: TaskActions | null): { kind: "run" | "retry" | "stop" | null; label: string; blocked: string | null } {
  if (shown(actions?.stop)) return { kind: "stop", label: task.status === "queued" ? "不排了" : "停止", blocked: blocker(actions!.stop) };
  const primary = shown(actions?.primary) ? actions!.primary! : null;
  if (primary) {
    return { kind: primary.kind === "retry" ? "retry" : "run", label: primary.kind === "retry" ? "重试" : primary.kind === "resume" ? "继续" : "运行", blocked: blocker(primary) };
  }
  return { kind: null, label: task.status === "done" ? "已完成" : task.status === "awaiting_review" ? "等待裁决" : task.status === "queued" ? "排队中" : "进行中", blocked: null };
}

/* 一个回合里用户能读到多少字。跟会话流那张表同一条判据:正文、执行过程原文、结论与
   提示都算,轮次/说话人/时刻/用时不算 —— 后者变化不代表屏幕上多了要读的东西。
   `turn.events` 以前整个没算:duetState 的 appendExecutionEvent 会把连续思考拼进**已有
   那条**的 detail,回合数和正文长度都一动不动(审查第 4 轮 F1)。 */
const duetTurnSize = (turn: DuetTurn): number =>
  (turn.text?.length ?? 0)
  + (turn.images?.length ?? 0) /* 配上一张图,正文里就多出一张画得出来的东西 */
  + executionEventsSize(turn.events)
  + (turn.conclusion?.length ?? 0) + (turn.notice?.length ?? 0) + (turn.error?.length ?? 0);

export function DuetView({
  task,
  allTasks,
  onTaskUpdated,
  onTaskCreated,
  onTaskDeleted,
  onSelectTask,
  notify,
}: {
  task: Task;
  allTasks: TaskListItem[];
  onTaskUpdated: (task: Task) => void;
  onTaskCreated: (task: Task) => void;
  onTaskDeleted: (taskId: string) => void;
  onSelectTask: (task: TaskListItem) => void;
  notify: (message: string) => void;
}) {
  const config = normalizeDuetConfig(task.duet);
  // 议题里的附件块要还原成缩略图，不能把「[用户附带的文件…] - /abs/path」念给用户看。
  // 解析不出正文时**只回退到标题**：再退回 config.topic 就等于把那段原文原样贴出来
  // （只贴图不打字建的讨论正是这种，第 1 轮审查 P1）。body 与 topic 由服务端保证是
  // 同一份成稿（server 的 duetTopicText），所以这里退到哪一个都不会丢正文。
  const topic = parseAttachmentText(task.body || config.topic);
  const topicText = topic.body || task.title;
  const duet = useDuet(task.id, task.status);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [busy, setBusy] = useState(false);
  // 确认闸的对话框住在 App 层(见 task-detail/ExecutorGate.tsx),这里只拿判据。
  const confirmExecutorSwap = useExecutorGate();
  const [teamBusy, setTeamBusy] = useState(false);
  const [teamModal, setTeamModal] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [title, setTitle] = useState(task.title);
  const scrollRef = useRef<HTMLDivElement>(null);
  // 完整议题：任务正文画在会话流外面，⌘K 正文命中要在这里落（见 ConversationScrollControls 的 revealRoots）。
  const topicRef = useRef<HTMLDivElement>(null);
  const { indicatorForTask } = useTaskReadState(allTasks, task.id);

  useEffect(() => setTitle(task.title), [task.id, task.title]);
  useEffect(() => {
    setTeamModal(false);
    setDeleteOpen(false);
  }, [task.id]);
  useEffect(() => { void api.sessions(task.id).then(setSessions).catch(() => setSessions([])); }, [task.id, task.status]);
  const sessionsByRole = useMemo(() => latestByRole(sessions), [sessions]);
  // An unmatched persisted start means "active" only while the task itself is
  // running. After a server interruption the task becomes failed; hiding that
  // orphan prevents a stale thinking bubble from claiming the process survived.
  const turns = useMemo(() => task.status === "running"
    ? duet.state.turns
    : duet.state.turns.filter((turn) => turn.done), [duet.state.turns, task.status]);
  // 我插的话没有条目 id，按「第几次插话」认：轮次只往后追加，插话本身也一定是 done 的，
  // 上面那道过滤动不了它们的先后。
  const userTurnIds = useMemo(() => {
    let count = 0;
    return new Map(turns.flatMap((turn) => turn.speaker === "user" ? [[turn, `duet-user:${count++}`] as const] : []));
  }, [turns]);
  const inputs = useMemo(() => conversationInputs(
    { text: task.body || config.topic, at: task.createdAt },
    turns.flatMap((turn) => {
      const id = userTurnIds.get(turn);
      return id ? [{ kind: "user", id, text: turn.text, at: turn.at }] : [];
    }),
  ), [config.topic, task.body, task.createdAt, turns, userTurnIds]);
  const currentRound = turns.reduce((max, turn) => Math.max(max, turn.round), 0);
  const gate = duet.state.gate ?? latestDuetGate(turns, task.status === "awaiting_review");
  const gateOpen = isOpenDuetGate(gate, task.status);
  const linkedTeams = useMemo(() => allTasks
    .filter((item) => item.mode === "team" && item.originTaskId === task.id)
    .sort((a, b) => timeMs(b.createdAt) - timeMs(a.createdAt)), [allTasks, task.id]);
  const display = taskDisplayStatus(task.status, task.stage, !!task.question);
  const indicator = indicatorForTask(task);
  const actions = useTaskActions(task.id);
  const action = actionFor(task, actions);
  const actionTip = useHoverTip();
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
      void refreshTaskActions(task.id);
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
      await api.gate(task.id, next, gate?.version);
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
      onTaskUpdated(await toggleArchive(task, notify, "讨论"));
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
      closeGate: gateOpen ? () => api.gate(task.id, { kind: "approve" }, gate?.version) : null,
      startTeam: () => api.runTask(created.id),
    });
    setTeamBusy(false);
    if (!followUpFailures.length) notify("已创建团队，讨论结论已接力执行");
    else notify(`团队已创建，但${followUpFailures.map(({ phase, reason }) => `${phase === "gate" ? "讨论自动收尾" : "启动"}失败（${reason instanceof Error ? reason.message : String(reason)}）`).join("、")}`);
    return true;
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
        <TaskCreationBadge task={task} />
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
        <button type="button" className={`${action.kind === "stop" ? "is-stop" : "is-primary"}${action.blocked ? " is-disabled" : ""}`} data-workspace-run-action={action.kind === "run" || action.kind === "retry" ? action.kind : undefined} disabled={busy || !action.kind} aria-disabled={action.blocked ? true : undefined} {...(action.blocked ? actionTip.anchorProps : {})} onClick={() => action.kind && !action.blocked && void perform(action.kind)}>{busy ? <SpinnerGap size={13} className="is-spinning" /> : action.kind === "stop" ? <Stop size={12} weight="fill" /> : <Play size={12} weight="fill" />}{action.label}</button>
        {action.blocked && <HoverTip at={actionTip.at}>{action.blocked}</HoverTip>}
        {!task.archived && shown(actions?.archive) && (
          <IconButton label="归档讨论" tip={blocker(actions!.archive) ?? "归档讨论"} className={actions!.archive.ok ? "" : "is-disabled"} aria-disabled={!actions!.archive.ok || undefined} onClick={() => { if (actions!.archive.ok) void archive(); }}><Archive size={13} /></IconButton>
        )}
        {task.archived && <button type="button" onClick={() => void archive()}>取消归档</button>}
        <button type="button" title="删除讨论" onClick={() => setDeleteOpen(true)}><Trash size={13} /></button>
        </header>

      <ImagePreviewGroup isolated>
        <details className="duet-context">
          <summary>
            <span className="duet-context-topic"><small>议题</small><b data-search-skip="">{topicText}</b></span>
            <span className="duet-context-meta">
              <span className="is-a"><ChatCircle size={12} weight="fill" />{sessionsByRole.voiceA?.executor || config.voiceA}</span>
              <span className="is-b"><ChatTeardrop size={12} weight="fill" />{sessionsByRole.voiceB?.executor || config.voiceB}</span>
              <span>{config.maxRounds ? `${config.maxRounds} 轮` : "不限轮次"}</span>
              <span>{config.gateG1 === "on" ? "G1 开启" : "无收敛门"}</span>
            </span>
            <CaretDown className="duet-context-caret" size={13} weight="bold" />
          </summary>
          <div className="duet-context-details">
            <div className="duet-context-full-topic" ref={topicRef}>
              <small>完整议题</small><h2>{topicText}</h2><MessageAttachments paths={topic.paths} />
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
                inputId={userTurnIds.get(turn)}
                previousRound={turns[index - 1]?.round}
                session={turn.speaker === "A" ? sessionsByRole.voiceA : turn.speaker === "B" ? sessionsByRole.voiceB : undefined}
                fallback={turn.speaker === "B" ? config.voiceB : config.voiceA}
                taskId={task.id}
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
          {/* resetKey 只认「换了哪个任务」。以前它还混着 turns.length,于是每开一轮都被
              当成换任务、无条件拽到底 —— 读历史读到一半就被打断(审查 B5)。新一轮该不该
              跟,现在由下面这个内容版本说了算:贴着底就跟,在上面读历史就不动。 */}
          <ConversationScrollControls scrollRef={scrollRef} resetKey={task.id} inputs={inputs} revealReady={!duet.loading} revealRoots={[topicRef]}
            tailKey={contentVersion(turns, duetTurnSize,
              (turn) => `${turn.round}:${turn.speaker}:${turn.done ? 1 : 0}`)} />
        </div>
      </ImagePreviewGroup>

      {gate?.open && task.status === "awaiting_review" ? (
        <DuetGateControls
          gate={gate}
          round={currentRound}
          maxRounds={config.maxRounds}
          busy={busy || teamBusy}
          linkedTeams={linkedTeams}
          onGate={gateAction}
          onOpenTeam={() => setTeamModal(true)}
          onOpenTask={onSelectTask}
        />
      ) : ["done", "failed", "canceled"].includes(task.status) ? (
        <div className="duet-terminal-handoff">
          <AcceptanceControls className="duet-terminal-acceptance" task={task} onTaskUpdated={onTaskUpdated} notify={notify}
            lead={<b className="acc-title">讨论结论</b>} />
          <DuetHandoffBar
            linkedTeams={linkedTeams}
            busy={teamBusy}
            onOpenTeam={() => setTeamModal(true)}
            onOpenTask={onSelectTask}
          />
        </div>
      ) : (
        <DuetProgressBar round={currentRound} maxRounds={config.maxRounds} gateEnabled={config.gateG1 === "on"} />
      )}
      {teamModal && <DuetHandoffModal taskId={task.id} busy={teamBusy} onClose={() => setTeamModal(false)} onConfirm={handoff} />}
      {deleteOpen && <DeleteTaskDialog task={task} notify={notify} onDeleted={(ids) => ids.forEach(onTaskDeleted)} onClose={() => setDeleteOpen(false)} />}
    </div>
  );
}
