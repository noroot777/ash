import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Task, Group, TaskStatus, Priority, AgentType } from "@harness/shared";
import { AGENT_TYPES, isUserSettableStatus, canArchive } from "@harness/shared";
import { sameExecutor } from "@harness/shared/executors";
import { CaretDown, Play, Stop, Trash, ArrowsClockwise, DownloadSimple, GitDiff, ListNumbers } from "@phosphor-icons/react";
import { api, type AcceptTaskFailure } from "./api";
import { STATUS_META, PRIORITIES } from "./constants";
import { CollapsibleText, CopyButton, Kbd, submitShortcutTitle } from "./ui";
import { StatusIcon } from "./StatusIcon";
import { PriorityIcon, LabelAdder } from "./ui";
import { ScheduleControl } from "./ScheduleControl";
import { Menu } from "./Menu";
import { QueueModal } from "./QueueModal";
import { runAction, canStopTask } from "./taskActions";
import { groupLabel } from "./util";
import { TaskTimeChip } from "./time";
// 会话渲染与插话框已拆成独立模块(/team 也复用它们)。
import { Conversation, ConversationScrollButtons, conversationToText, downloadConversation, type LogLine } from "./Conversation";
import { useConversation } from "./useConversation";
import { useStickToBottom } from "./useStickToBottom";
import { ReplyBox } from "./ReplyBox";
import { ExecutorPicker, type ExecutorSelection, useExecutorProfiles } from "./ExecutorPicker";
import { executorLabel } from "./executorLabel";
import { TaskModelControls } from "./TaskModelControls";
import { QuestionCard } from "./QuestionCard";
import { isDispatchedWorker, isSharedTeamWorker } from "./taskPolicy";
import { AttachmentDisplay, parseAttachmentText } from "./messageAttachments";
import { toast } from "./toast";
import { TaskWorktreeChip } from "./TaskWorktreeChip";
import { ReviewTaskContextBar, TaskReviewPanel } from "./TaskReviewPanel";
import { TaskDerivationComposer } from "./TaskDerivationComposer";
import { DerivedTaskLinks } from "./DerivedTaskLinks";
import {
  isTaskDerivationCommand,
  parseTaskDerivationCommand,
  TASK_DERIVATION_COMMANDS,
  type TaskDerivationCommand,
} from "./taskDerivation";
import {
  AcceptanceAction,
  AcceptanceFailureReport,
  TaskDiffWorkspace,
} from "./ReviewWorkspace";
import { TaskPinButton } from "./TaskPinMenu";
export type { LogLine } from "./Conversation";

export function TaskDetail({
  task,
  groups,
  allTasks,
  logs,
  sessionsBump,
  onRun,
  onStop,
  onRetry,
  onReply,
  onPatch,
  onCreateGroup,
  onDelete,
  onArchive,
  onUnarchive,
  onRequeue,
  onOpenTask,
  onTaskCreated,
}: {
  task: Task;
  groups: Group[];
  allTasks: Task[];
  logs: LogLine[];
  sessionsBump: number;
  onRun: () => void;
  onStop: () => void;
  onRetry: () => void;
  onReply: (text: string, opts?: { attachments?: string[]; agent?: AgentType }) => void;
  onPatch: (patch: Partial<Task>) => void | Promise<void>;
  onCreateGroup: () => void;
  onDelete: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  // 重新排队(失败/取消 → 回队列等待)。位置由服务端定:被越过就到队尾。
  onRequeue: () => void;
  onOpenTask: (taskId: string) => void;
  onTaskCreated: (task: Task, doRun?: boolean, select?: boolean) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { profiles, providers } = useExecutorProfiles();
  const dispatchedWorker = isDispatchedWorker(task);
  const parentTask = task.parentId ? allTasks.find((candidate) => candidate.id === task.parentId) : null;
  const sharedTeamWorker = isSharedTeamWorker(task, parentTask);
  const objective = parseAttachmentText(task.body);
  const [derivation, setDerivation] = useState<{ command: TaskDerivationCommand; committed: boolean } | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [acceptFailure, setAcceptFailure] = useState<AcceptTaskFailure | null>(null);

  // 拉会话 + 快照历史输出 + 拼条目流,都在 useConversation 里(/team 调度台共用同
  // 一份装配,免得两个界面的「刷新后 vs 实时」各自漂移)。
  const { items, sessions, snapshot, refetch, refreshing } = useConversation({
    task,
    logs,
    sessionsBump,
    primaryAgent: task.agentType ?? "claude",
  });
  const hasConversation = sessions.length > 0 || snapshot.length > 0 || logs.length > 0;

  const stickToBottom = useStickToBottom(scrollRef, task.id);

  // 任务在哪条 queue 第几位?——allTasks 过滤了 archived,但归档任务仍占队列位置,
  // 所以直接调 API 拿队列总长度,免得 N/M 里的 M 偏少。
  const [queueSize, setQueueSize] = useState<number | null>(null);
  const [queueModalOpen, setQueueModalOpen] = useState(false);
  const currentExecutor: ExecutorSelection = {
    agentType: task.agentType ?? "claude",
    executorId: task.executorId ?? null,
  };
  useEffect(() => {
    if (!task.queueId) { setQueueSize(null); return; }
    let alive = true;
    api.queue(task.queueId).then(
      (q) => { if (alive) setQueueSize(q.items.length); },
      () => { if (alive) setQueueSize(null); },
    );
    return () => { alive = false; };
  }, [task.queueId, queueModalOpen]);

  const patchRunConfig = async (patch: Partial<Task>) => {
    try {
      await onPatch(patch);
      toast("运行设置已更新，将从下一回合生效");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    }
  };
  const runConfigControls = (
    <div className={`flex flex-wrap items-center gap-1.5 ${task.archived ? "pointer-events-none opacity-60" : ""}`}>
      <ExecutorPicker
        selection={currentExecutor}
        onSelect={(selection) => void patchRunConfig({
          agentType: selection.agentType,
          executorId: selection.executorId,
          // 换执行器时旧的模型/思考强度覆盖作废（服务端 PATCH 也会自己清一遍，这里
          // 一并显式带上，免得中间态在界面上闪一下旧值）。
          ...(sameExecutor(selection, currentExecutor)
            ? {}
            : { model: null, reasoningEffort: null }),
        })}
        profiles={profiles}
        providers={providers}
        types={[...AGENT_TYPES]}
        label={task.executorId ? executorLabel({ task }) : `默认 ${executorLabel({ task })}`}
        menuWidth={320}
      />
      <TaskModelControls
        selection={currentExecutor}
        profiles={profiles}
        providers={providers}
        model={task.model}
        reasoningEffort={task.reasoningEffort}
        onModelChange={(model) => void patchRunConfig({ model: model || null })}
        onReasoningEffortChange={(reasoningEffort) => void patchRunConfig({ reasoningEffort: reasoningEffort || null })}
      />
      <span className="inline-flex items-center gap-1 text-[11px] text-faint" title="当前已经开始的 CLI 回合不会热切换模型或思考强度">
        {sessions.length === 0 ? "首次运行使用；之后改动" : "改动"}从下一回合生效
      </span>
    </div>
  );

  return (
    <main className="flex h-full min-h-0 flex-col">
      <ReviewTaskContextBar task={task} allTasks={allTasks} onOpenTask={onOpenTask} />
      <header className="border-b border-line px-6 pb-3 pt-5">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
          {dispatchedWorker ? (
            <h1 className="min-w-48 flex-1 px-1 text-[15px] font-semibold leading-snug text-ink">{task.title}</h1>
          ) : (
            <EditableTitle title={task.title} onSave={(t) => onPatch({ title: t, autoTitle: false })} />
          )}
          <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
            {task.useWorktree && <TaskWorktreeChip cleaned={task.stage === "accepted"} />}
            <TaskTimeChip task={task} />
            <button
              type="button"
              onClick={() => setReviewOpen((value) => !value)}
              className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] font-medium transition-colors ${reviewOpen ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:bg-raised hover:text-ink"}`}
              title="按文件查看任务分支相对基线的 diff"
            >
              <GitDiff size={14} />
              {reviewOpen ? "返回对话" : "查看改动"}
            </button>
            {!sharedTeamWorker && (task.status === "done" || task.stage === "awaiting_acceptance" || task.stage === "accepted") && (
              <AcceptanceAction
                task={task}
                compact
                onFailure={setAcceptFailure}
                onAccepted={(updated) => onTaskCreated(updated, false, false)}
              />
            )}
            {task.archived ? (
              <>
                <span className="inline-flex items-center gap-1.5 rounded-md bg-overlay px-3 py-1.5 text-[13px] font-medium text-muted" title="任务已归档（只读）">
                  已归档
                </span>
                {!dispatchedWorker && (
                  <button
                    onClick={onUnarchive}
                    className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[13px] font-medium text-muted transition-colors hover:bg-raised hover:text-ink"
                  >
                    <ArrowsClockwise size={13} />
                    取消归档
                  </button>
                )}
              </>
            ) : canStopTask(task.status) ? (
              <button
                onClick={onStop}
                className="inline-flex items-center gap-1.5 rounded-md border border-red-500/40 px-3 py-1.5 text-[13px] font-medium text-red-600 transition-colors hover:bg-red-500/10"
              >
                <Stop size={13} weight="fill" />
                停止
              </button>
            ) : (
              (() => {
                const a = runAction(task.status, task.archived);
                return (
                  <button
                    // 重试(failed)走 /retry:续跑原会话,不受「队列前面还有未完成」
                    // 限制(顺序由任务自身检查点 + 队列唤醒保证);运行/继续走 /run。
                    // 与列表、r 键、Cmd-K、DebateView 的分发保持一致。
                    onClick={a.kind === "retry" ? onRetry : onRun}
                    disabled={!a.canClick}
                    className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-accent-fg transition-colors hover:bg-accent-hover disabled:opacity-40 disabled:hover:bg-accent"
                  >
                    <Play size={13} weight="fill" />
                    {a.label}
                  </button>
                );
              })()
            )}
            {/* 重新排队:队列里的 failed/canceled 任务回到 backlog,轮到它时被
                队列自动拉起(有会话则从中断处续跑)。canceled 在队列推进里是
                「透明跳过」,所以手动停过的任务想继续排队必须走这里。done 不给
                ——严格完成协议下 done 都是 agent 亲口确认过的,真要重跑走状态
                下拉改回 backlog。一次调用做完「改状态 + 定位置 + 推进队列」:
                前端曾经拆成 PATCH + runGroup 两步,中间那一瞬间会让本任务抢在
                正在跑的下一个前面(串行队列并跑)。 */}
            {!dispatchedWorker && !task.archived && task.queueId && ["failed", "canceled"].includes(task.status) && (
              <button
                onClick={onRequeue}
                className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-[13px] font-medium text-muted transition-colors hover:bg-raised hover:text-ink"
                title="回到队列等待：前面的任务完成后自动启动。队列若已经跑过它，就排到队尾"
              >
                <ListNumbers size={13} />
                重新排队
              </button>
            )}
            {!dispatchedWorker && !task.archived && canArchive(task.status) && (
              <button
                onClick={onArchive}
                className="inline-flex items-center rounded-md px-2.5 py-1.5 text-[13px] font-medium text-muted transition-colors hover:bg-raised hover:text-ink"
                title="归档任务（从列表收起，可恢复）"
              >
                归档
              </button>
            )}
            <button
              type="button"
              onClick={() => void refetch().catch((error) => toast(error instanceof Error ? error.message : String(error)))}
              disabled={refreshing}
              className="inline-flex h-[30px] items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-muted transition-colors hover:bg-raised hover:text-ink disabled:cursor-wait disabled:opacity-60"
              title="重新拉取会话内容"
            >
              <ArrowsClockwise size={14} className={refreshing ? "animate-spin" : ""} />
              刷新
            </button>
            {items.length > 0 && (
              <>
                <CopyButton
                  text={conversationToText(items, task)}
                  title="复制全部对话"
                  size={15}
                  className="h-[30px] w-[30px] hover:bg-raised"
                />
                <button
                  onClick={() => downloadConversation(items, task)}
                  className="grid h-[30px] w-[30px] place-items-center rounded-md text-muted transition-colors hover:bg-raised hover:text-ink"
                  title="导出对话为 .md 文件"
                >
                  <DownloadSimple size={15} />
                </button>
              </>
            )}
            {!dispatchedWorker && <TaskPinButton task={task} onPatch={onPatch} />}
            {!dispatchedWorker && (
              <button
                onClick={onDelete}
                className="grid h-[30px] w-[30px] place-items-center rounded-md text-muted transition-colors hover:bg-raised hover:text-red-600"
                title="删除任务"
              >
                <Trash size={15} />
              </button>
            )}
          </div>
        </div>

        {/* Task objective — shown right under the title (collapsed to 2 lines;
            click 展开 for the full text). */}
        {objective.body ? (
          <CollapsibleText text={objective.body}>
            {objective.paths.length > 0 ? <AttachmentDisplay paths={objective.paths} className="px-3 pb-2" /> : null}
          </CollapsibleText>
        ) : (
          <AttachmentDisplay paths={objective.paths} className="mt-2" />
        )}

        {!task.reviewOf && (
          <TaskReviewPanel
            task={task}
            allTasks={allTasks}
            onOpenTask={onOpenTask}
            onReviewTaskCreated={(created) => onTaskCreated(created, false, false)}
            defaultExpanded={false}
          />
        )}
        {acceptFailure && <AcceptanceFailureReport failure={acceptFailure} />}

        {/* agent 提问:调 ask_question 后停在这等答案(队列陪等,不会自动续跑)。
            团队模式下调度者通常会自动来答;用户也可以直接在这里答复唤醒。 */}
        {task.question && <QuestionCard task={task} />}

        {/* 检查点续跑：paused 时露出 resumePrompt（agent 留下的「下次喂我什么」），
            让用户知道一旦依赖满足、scheduler 唤醒它会发什么 user 消息。可编辑
            （改写不好的指令）或清空（清空 = 续跑时不携指令，用标准"继续"nudge）。 */}
        {task.status === "paused" && !task.question && (
          <ResumePromptEditor
            value={task.resumePrompt ?? ""}
            onSave={(rp) => onPatch({ resumePrompt: rp || null })}
            readOnly={dispatchedWorker}
          />
        )}

        {/* All controls on one wrapping row: attributes | labels | deps·schedule | session */}
        {dispatchedWorker ? (
          task.queueId && (
            <div className="mt-3 flex items-center gap-1.5 text-[12px]">
              <ListNumbers size={13} className="text-faint" />
              <span className="text-muted">队列</span>
              <span className="rounded bg-overlay px-1.5 py-0.5 text-ink" title="队列位置由调度者管理">
                第 {(task.queuePosition ?? 0) + 1}{queueSize != null ? ` / ${queueSize}` : ""} 位
              </span>
            </div>
          )
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-2 text-[12px]">
            <div className={`flex flex-wrap items-center gap-1.5 ${task.archived ? "pointer-events-none opacity-60" : ""}`}>
              <Prop
                value={task.status}
                onChange={(v) => onPatch({ status: v as TaskStatus })}
                options={Object.values(STATUS_META)
                  .filter((s) => isUserSettableStatus(s.key) || s.key === task.status)
                  .map((s) => ({ value: s.key, label: s.label }))}
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
                  ...groups.map((g) => ({ value: g.id, label: groupLabel(g) })),
                  { value: "__new", label: "+ 新建分组" },
                ]}
              />
            </div>

            <span className="h-4 w-px bg-line" />
            <div className="flex flex-wrap items-center gap-1.5">
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
            </div>

            <span className="h-4 w-px bg-line" />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              {/* 队列归属(DESIGN-scheduling.md §1):任务在某条 queue 里第几位。
                  点开看完整队列、改顺序、把任务移出队列。废弃的 depOptions /
                  resumeDepOptions 在新模型下永远空,挪开免得占视觉位。 */}
              <div className="flex items-center gap-1.5">
                <ListNumbers size={13} className="text-faint" />
                <span className="text-muted">队列</span>
                {task.queueId ? (
                  <button
                    onClick={() => setQueueModalOpen(true)}
                    className="rounded bg-overlay px-1.5 py-0.5 text-ink transition hover:bg-line2"
                    title="点开看完整队列"
                  >
                    第 {(task.queuePosition ?? 0) + 1}{queueSize != null ? ` / ${queueSize}` : ""} 位
                  </button>
                ) : (
                  <span className="text-faint">不在任何队列(独立任务)</span>
                )}
              </div>
              <ScheduleControl taskId={task.id} />
            </div>

            {/* Who will run this — shown only until the first run exists. The live
                run credentials (resume / id / time) now live per-bubble in the
                conversation below, not crammed into this header row. */}
            {sessions.length === 0 && (
              <>
                <span className="h-4 w-px bg-line" />
                {runConfigControls}
              </>
            )}
          </div>
        )}
      </header>

      {reviewOpen ? (
        <TaskDiffWorkspace
          task={task}
          sharedWorker={sharedTeamWorker}
          onClose={() => setReviewOpen(false)}
          onTaskUpdated={(updated) => onTaskCreated(updated, false, false)}
        />
      ) : (
        <>
          <div className="relative min-h-0 flex-1">
            <div
              ref={scrollRef}
              className="h-full overflow-y-auto break-words px-6 py-4 text-[13px] leading-relaxed"
            >
              {/* The run as a conversation: prior output (snapshotted per session on
                  load) and the live stream merge into one bubble per run, so a running
                  task you reload doesn't split into a stale + live pair. */}
              <Conversation items={items} />
              {items.length === 0 && (
                <p className="font-sans text-faint">点击「运行」开始，输出会实时流式显示在这里。</p>
              )}
            </div>
            <ConversationScrollButtons
              scrollRef={scrollRef}
              onManualScroll={(target) => {
                if (target === "bottom") stickToBottom.resumeStickToBottom();
                else stickToBottom.noteUserScrollIntent();
              }}
            />
          </div>

          <DerivedTaskLinks sourceTaskId={task.id} allTasks={allTasks} onOpen={onOpenTask} />
          {task.mode === "single" && (
            <ReplyBox
              taskId={task.id}
              onReply={onReply}
              disabled={!hasConversation || task.status === "running" || task.status === "queued" || !!task.archived}
              disabledPlaceholder={
                task.archived
                  ? "已归档；仍可输入 /team 或 /debate 创建派生任务…"
                  : task.status === "running" || task.status === "queued"
                    ? "当前任务进行中；可输入 /team 或 /debate 创建派生任务…"
                    : "可输入 /team 以本任务为背景开启**多模型协作**\nOR\n可输入 /debate 以本任务为背景开启**辩论**"
              }
              richPlaceholder={
                !task.archived && task.status !== "running" && task.status !== "queued" ? (
                  <span className="flex flex-col">
                    <span>可输入 /team 以本任务为背景开启<strong className="font-semibold text-muted">多模型协作</strong></span>
                    <span>OR</span>
                    <span>可输入 /debate 以本任务为背景开启<strong className="font-semibold text-muted">辩论</strong></span>
                  </span>
                ) : undefined
              }
              initialHeight={84}
              toolbar={hasConversation ? runConfigControls : undefined}
              command={{
                matches: isTaskDerivationCommand,
                items: TASK_DERIVATION_COMMANDS,
                // 回车 = 定稿：输入框清空，卡片接管焦点继续补充。
                onSubmit: (text) => {
                  const parsed = parseTaskDerivationCommand(text);
                  if (parsed) setDerivation({ command: parsed, committed: true });
                },
                // 边打边预览：命中即弹卡，尾巴文本实时进附言/辩题；已定稿的卡不受
                // 后续输入影响（只能用卡上的 X 关掉）。
                onChange: (text) => {
                  setDerivation((cur) => {
                    if (cur?.committed) return cur;
                    const parsed = parseTaskDerivationCommand(text);
                    return parsed ? { command: parsed, committed: false } : null;
                  });
                },
              }}
              inlinePanel={derivation ? (
                <TaskDerivationComposer
                  key={derivation.command.kind}
                  task={task}
                  command={derivation.command}
                  live={!derivation.committed}
                  onClose={() => setDerivation(null)}
                  onCreated={onTaskCreated}
                />
              ) : undefined}
            />
          )}
        </>
      )}
      {!dispatchedWorker && queueModalOpen && task.queueId && (
        <QueueModal
          queueId={task.queueId}
          currentTaskId={task.id}
          readOnlyTaskIds={allTasks.filter(isDispatchedWorker).map((t) => t.id)}
          onClose={() => setQueueModalOpen(false)}
        />
      )}
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
// 导出给 /team 的 header 复用 —— 团队任务的标题也当场改。
export function EditableTitle({ title, onSave }: { title: string; onSave: (t: string) => void }) {
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
      className="-mx-1 min-w-48 flex-1 rounded px-1 text-[15px] font-semibold leading-snug text-ink outline-none hover:bg-raised/40 focus:bg-raised/60"
      title="点击编辑标题"
    />
  );
}

// paused 任务的「续跑指令」面板。普通任务可编辑/清空；调度者派出的执行者只读。
function ResumePromptEditor({
  value,
  onSave,
  readOnly = false,
}: {
  value: string;
  onSave: (rp: string) => void;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  const commit = () => {
    const t = draft.trim();
    onSave(t);
    setEditing(false);
  };
  if (editing && !readOnly) {
    return (
      <div className="mt-2 overflow-hidden rounded-md border border-slate-500/40 bg-slate-500/[0.06]">
        <div className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium text-slate-600">
          <StatusIcon status="paused" size={11} />
          <span>编辑续跑指令</span>
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); commit(); }
            if (e.key === "Escape") { e.preventDefault(); setEditing(false); setDraft(value); }
          }}
          rows={4}
          autoFocus
          placeholder="续跑时发送给 agent 的 user 消息，比如：「继续做 tts 这一段」"
          className="block w-full resize-y bg-transparent px-2.5 py-1.5 text-[12px] leading-snug text-ink outline-none placeholder:text-faint"
        />
        <div className="flex items-center justify-end gap-1.5 border-t border-slate-500/20 px-2 py-1.5">
          <button
            onClick={() => { setEditing(false); setDraft(value); }}
            className="rounded-md px-2 py-1 text-[11px] text-muted hover:text-ink"
          >
            取消
          </button>
          <button
            onClick={commit}
            title={submitShortcutTitle("保存续跑指令")}
            className="inline-flex items-center gap-1.5 rounded-md bg-slate-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-slate-500"
          >
            保存 <Kbd className="border-white/20 bg-white/10" />
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="group/rp mt-2 overflow-hidden rounded-md border border-slate-500/40 bg-slate-500/[0.06]">
      <div className="flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium text-slate-600">
        <StatusIcon status="paused" size={11} />
        <span>{value ? "已到检查点 · 续跑时将发送：" : "已到检查点 · 无续跑指令（续跑用标准「继续」nudge）"}</span>
        {!readOnly && (
          <button
            onClick={() => setEditing(true)}
            className="ml-auto rounded px-1.5 py-0.5 text-[10px] text-slate-600 opacity-0 hover:bg-slate-500/15 group-hover/rp:opacity-100"
            title={value ? "编辑续跑指令" : "添加续跑指令"}
          >
            {value ? "编辑" : "+ 添加"}
          </button>
        )}
        {!readOnly && value && (
          <button
            onClick={() => onSave("")}
            className="rounded px-1.5 py-0.5 text-[10px] text-slate-600/80 opacity-0 hover:bg-slate-500/15 hover:text-slate-600 group-hover/rp:opacity-100"
            title="清空：续跑时改用标准「继续」nudge"
          >
            清空
          </button>
        )}
      </div>
      {value && (
        <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words px-2.5 pb-2 text-[12px] leading-snug text-ink">{value}</pre>
      )}
    </div>
  );
}
