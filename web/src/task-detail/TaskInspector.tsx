import { useEffect, useMemo, useState } from "react";
import type { AgentExecutorProfile, Group, Session, Task, TaskListItem, TaskStatus, TokenUsage } from "@ash/shared";
import { isUserSettableStatus, TASK_STATUS_LABELS } from "@ash/shared";
import { REASONING_EFFORT_DETAIL } from "@ash/shared/cli-presets";
import { addUsage, formatTokens, formatTokensExact, hasUsage, usageTotal } from "@ash/shared/usage";
import { ArrowSquareOut, CaretRight, ListNumbers } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { Dropdown } from "../components/Dropdown.tsx";
import { ImagePreviewGroup } from "../components/ImagePreview.tsx";
import { ScheduleControl } from "../components/ScheduleControl.tsx";
import { TaskLabelsEditor } from "../components/TaskLabelsEditor.tsx";
import { taskParentLink } from "../components/TaskOrigin.tsx";
import {
  executorRunSummary,
  isExecutorPickable,
  nothingRunnable,
  teamExecutorCandidates,
  useAgentAvailability,
} from "../lib/agentAvailability.ts";
import { QueueDrawer } from "./QueueDrawer.tsx";
import { InspectorPromptContent } from "./InspectorPromptContent.tsx";
import { TaskChangeSummary } from "./TaskChangeSummary.tsx";
import { formatInstant, taskDurationInfo } from "./utils.ts";

const STATUS_ORDER: TaskStatus[] = [
  "running", "idle", "paused", "awaiting_review", "queued", "backlog", "done", "failed", "canceled",
];

function InspectorRow({
  label,
  children,
  danger = false,
}: {
  label: string;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return <div className={`task-inspector-row${danger ? " is-danger" : ""}`}><span>{label}</span><div>{children}</div></div>;
}

function ResumePromptEditor({
  value,
  editable,
  onSave,
}: {
  value: string;
  editable: boolean;
  onSave: (value: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [editing, value]);

  const commit = async (nextValue = draft) => {
    const normalized = nextValue.trim();
    if (normalized === value.trim()) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      if (await onSave(normalized)) {
        setDraft(normalized);
        setEditing(false);
      }
    } finally {
      setSaving(false);
    }
  };

  if (editing && editable) {
    return (
      <div className="task-resume-editor is-editing">
        <textarea
          autoFocus
          rows={5}
          value={draft}
          aria-label="续跑指令"
          placeholder="续跑时发送给执行器的消息，例如：继续完成 TTS 阶段"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void commit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setDraft(value);
              setEditing(false);
            }
          }}
        />
        <footer>
          <span>⌘/Ctrl + Enter 保存</span>
          <button type="button" disabled={saving} onClick={() => { setDraft(value); setEditing(false); }}>取消</button>
          <button className="is-primary" type="button" disabled={saving} onClick={() => void commit()}>{saving ? "保存中…" : "保存"}</button>
        </footer>
      </div>
    );
  }

  return (
    <div className="task-resume-editor">
      <div className="task-resume-editor-head">
        <span>{value.trim() ? "下次唤醒时发送" : "未设置，续跑时使用标准“继续”指令"}</span>
        {editable && <button type="button" onClick={() => setEditing(true)}>{value.trim() ? "编辑" : "添加"}</button>}
        {editable && value.trim() && <button type="button" disabled={saving} onClick={() => void commit("")}>清空</button>}
      </div>
      {value.trim() && <pre>{value}</pre>}
    </div>
  );
}

export function TaskInspector({
  task,
  groups,
  sessions,
  allTasks,
  followUps = [],
  onOpenTask,
  onOpenReview,
  onPatch,
  onQueueChanged,
  notify,
}: {
  task: Task;
  groups: Group[];
  sessions: Session[];
  allTasks: TaskListItem[];
  followUps?: { text: string; attachments: string[]; at?: string }[];
  onOpenTask: (taskId: string) => void;
  onOpenReview: () => void;
  onPatch: (patch: Partial<Task>) => Promise<void>;
  onQueueChanged: (updatedTask?: Task) => void;
  notify: (message: string) => void;
}) {
  const [queueItems, setQueueItems] = useState<{ taskId: string; title: string }[]>([]);
  const [queueOpen, setQueueOpen] = useState(false);
  const [requeueing, setRequeueing] = useState(false);
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [profilesReady, setProfilesReady] = useState(false);
  const detection = useAgentAvailability();
  const readOnly = task.parentId !== null || !!task.archived;
  const latestSession = useMemo(
    () => [...sessions].sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0],
    [sessions],
  );
  // 一个 agent 一行，**不同 agent 绝不相加**：单价、上下文、缓存策略都不是一回事，
  // 加出来那个数不代表任何东西（用户 2026-08-07 明确要求分开看）。同一个执行器名下的
  // 多条会话（重跑、续跑各开一行）才合并 —— 那才是同一副账。
  const usageByExecutor = useMemo(() => {
    const groups = new Map<string, TokenUsage>();
    for (const session of sessions) {
      if (!session.usage) continue;
      const label = session.executor || session.agentType;
      const previous = groups.get(label);
      groups.set(label, previous ? addUsage(previous, session.usage) : session.usage);
    }
    return [...groups].filter(([, usage]) => hasUsage(usage));
  }, [sessions]);
  const queuePosition = queueItems.findIndex((item) => item.taskId === task.id);
  const nextQueueItem = queuePosition >= 0 ? queueItems[queuePosition + 1] : undefined;

  useEffect(() => {
    let alive = true;
    if (!task.queueId) setQueueItems([]);
    else api.queue(task.queueId).then((queue) => { if (alive) setQueueItems(queue.items); }).catch(() => undefined);
    setProfilesReady(false);
    api.agents().then((value) => { if (alive) setProfiles(value); })
      .catch(() => { if (alive) setProfiles([]); })
      .finally(() => { if (alive) setProfilesReady(true); });
    return () => { alive = false; };
  }, [task.id, task.queueId, task.queuePosition, queueOpen]);

  const patch = async (value: Partial<Task>, message = "任务属性已更新") => {
    try {
      await onPatch(value);
      notify(message);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const saveResumePrompt = async (value: string) => {
    try {
      await onPatch({ resumePrompt: value || null });
      notify(value ? "续跑指令已保存" : "续跑指令已清空");
      return true;
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
      return false;
    }
  };

  const statusOptions = STATUS_ORDER.filter((status) => isUserSettableStatus(status) || status === task.status);
  const agentType = task.agentType ?? "claude";
  const { workerTypes, leadTypes, leadProfiles } = useMemo(
    () => teamExecutorCandidates(detection, profiles),
    [detection, profiles],
  );
  const executorTypes = task.mode === "team" ? leadTypes : workerTypes;
  const executorProfiles = task.mode === "team" ? leadProfiles : profiles;
  const executorSelection = { agentType, executorId: task.executorId ?? null };
  // 这一节是只读的执行信息：真正生效的模型/强度可能来自 profile 也可能来自任务级
  // 覆盖，一律由 executorRunSummary 算出来照抄。改执行器和模型走对话框底部那排胶囊。
  const run = executorRunSummary(executorSelection, profiles, {
    model: task.model,
    effort: task.reasoningEffort,
  });
  const noExecutor = profilesReady && nothingRunnable(profiles);
  const currentUnavailable = profilesReady
    && !isExecutorPickable(executorSelection, executorTypes, executorProfiles);
  const availabilityMessage = noExecutor
    ? "还没有已注册执行器。"
    : currentUnavailable
      ? task.mode === "team"
        ? "当前团队调度者未注册或不支持常驻会话，请改选可用执行器。"
        : "当前执行器未注册，请改选已注册 Profile 或其类型默认。"
      : task.mode === "team" && detection.status === "loading"
        ? "正在确认已注册调度者的常驻会话能力…"
        : task.mode === "team" && detection.status === "failed"
          ? "常驻能力检测失败；调度者候选仅保留系统已知支持的已注册类型。"
          : null;
  const duration = taskDurationInfo(task);
  const parent = taskParentLink(task, allTasks);
  const canRequeue = task.parentId === null
    && !task.archived
    && !!task.queueId
    && (task.status === "failed" || task.status === "canceled");

  const requeue = async () => {
    if (!task.queueId) return;
    setRequeueing(true);
    try {
      const response = await api.requeueTask(task.id);
      onQueueChanged(response.task);
      void api.queue(task.queueId).then((queue) => setQueueItems(queue.items)).catch(() => undefined);
      notify(response.movedToEnd ? "已重新排队并移到队尾" : "已重新排队");
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRequeueing(false);
    }
  };

  return (
    <div className="task-inspector" aria-label="任务信息">
      <div className="task-inspector-scroll">
        <ImagePreviewGroup isolated>
          <section>
            <details open>
              <summary>原始需求</summary>
              <InspectorPromptContent text={task.body} emptyText="这个任务没有正文说明。" />
            </details>
            <details className="task-inspector-follow-ups">
              <summary>后续追问</summary>
              {followUps.length ? (
                <ol>
                  {followUps.map((followUp, index) => (
                    <li key={`${followUp.at ?? "pending"}:${index}`}>
                      {followUp.at && <time dateTime={followUp.at}>{formatInstant(followUp.at)}</time>}
                      <InspectorPromptContent
                        text={followUp.text}
                        attachments={followUp.attachments}
                        emptyText="（空消息）"
                      />
                    </li>
                  ))}
                </ol>
              ) : <p className="task-inspector-note">暂无后续追问。</p>}
            </details>
          </section>
        </ImagePreviewGroup>

        <section>
          <h2>执行信息</h2>
          <InspectorRow label="执行器">
            <span>{task.executorLabel ?? agentType}</span>
          </InspectorRow>
          <InspectorRow label="模型">
            <span>{run.model ?? "跟随执行器"}</span>
          </InspectorRow>
          <InspectorRow label="智能水平">
            <span>{run.effort ? (REASONING_EFFORT_DETAIL[run.effort] ? `${run.effort}（${REASONING_EFFORT_DETAIL[run.effort]}）` : run.effort) : "跟随执行器"}</span>
          </InspectorRow>
          {availabilityMessage && <p className="task-inspector-note">{availabilityMessage}</p>}
          {latestSession?.versionWarning && <p className="task-inspector-note is-warning">{latestSession.versionWarning}</p>}
          <InspectorRow label="创建时间"><span>{formatInstant(task.createdAt)}</span></InspectorRow>
          {task.startedAt && <InspectorRow label="开始时间"><span>{formatInstant(task.startedAt)}</span></InspectorRow>}
          {task.endedAt && <InspectorRow label="结束时间"><span>{formatInstant(task.endedAt)}</span></InspectorRow>}
          {duration && <InspectorRow label={duration.label}><span title={duration.title}>{duration.text}</span></InspectorRow>}
          {usageByExecutor.map(([label, usage], index) => (
            <InspectorRow key={label} label={index === 0 ? "Token 用量" : ""}>
              <span aria-label={`${label} 累计 ${formatTokensExact(usageTotal(usage))} token`}>
                {usageByExecutor.length > 1 && <em className="task-usage-who">{label}</em>}
                {[formatTokens(usageTotal(usage)), usage.turns ? `${usage.turns} 轮` : ""].filter(Boolean).join(" · ")}
              </span>
            </InspectorRow>
          ))}
          {latestSession?.branch && (
            <InspectorRow label="分支" danger={!task.useWorktree}>
              <code>{latestSession.branch}</code>
            </InspectorRow>
          )}
          {latestSession?.worktreePath && <InspectorRow label="worktree"><code>{latestSession.worktreePath}</code></InspectorRow>}
          {latestSession?.resumeCommand && (
            <button className="task-inspector-action" type="button" onClick={async () => {
              try { await navigator.clipboard.writeText(latestSession.resumeCommand!); notify("已复制 resume 命令"); }
              catch { notify("复制失败，请检查浏览器剪贴板权限后重试"); }
            }}>
              <span>复制 resume 命令</span><span>复制</span>
            </button>
          )}
        </section>

        <TaskChangeSummary task={task} allTasks={allTasks} onOpenReview={onOpenReview} />

        <section>
          <h2>队列</h2>
          {task.queueId ? (
            <>
              <InspectorRow label="所在位置"><span>第 {queuePosition >= 0 ? queuePosition + 1 : (task.queuePosition ?? 0) + 1} / {queueItems.length || "?"} 位</span></InspectorRow>
              <InspectorRow label="下一个"><span>{nextQueueItem?.title ?? "队尾"}</span></InspectorRow>
              {canRequeue && (
                <button className="task-inspector-action" type="button" disabled={requeueing} onClick={() => void requeue()}>
                  <span><ListNumbers size={13} />重新排队</span><span>{requeueing ? "处理中…" : "回到队列"}</span>
                </button>
              )}
              <button className="task-inspector-action" type="button" onClick={() => setQueueOpen(true)}>
                <span><ListNumbers size={13} />查看队列 · {queueItems.length || "…"} 个任务</span><CaretRight size={13} />
              </button>
            </>
          ) : <p className="task-inspector-note">独立任务，不在任何队列中。</p>}
        </section>

        <section>
          <h2>调度与续跑</h2>
          <ScheduleControl
            taskId={task.id}
            notify={notify}
            disabled={task.parentId !== null || !!task.archived}
          />
          <ResumePromptEditor
            value={task.resumePrompt ?? ""}
            editable={task.parentId === null && task.status === "paused" && !task.question}
            onSave={saveResumePrompt}
          />
        </section>

        <section>
          <h2>属性</h2>
          <InspectorRow label="状态">
            <Dropdown
              label="状态"
              value={task.status}
              options={statusOptions.map((status) => ({ value: status, label: TASK_STATUS_LABELS[status] }))}
              disabled={readOnly}
              filterable={false}
              onChange={(status) => void patch({ status: status as TaskStatus })}
            />
          </InspectorRow>
          <InspectorRow label="分组">
            <Dropdown
              label="分组"
              value={task.groupId ?? ""}
              options={[
                { value: "", label: "无分组" },
                ...groups.map((group) => ({
                  value: group.id,
                  label: group.name,
                  detail: group.mode === "parallel" ? "并行" : "串行",
                })),
              ]}
              disabled={readOnly}
              filterable={groups.length > 6}
              filterPlaceholder="筛选分组…"
              placeholder="无分组"
              onChange={(groupId) => void patch({ groupId: groupId || null })}
            />
          </InspectorRow>
          <InspectorRow label="标签">
            <TaskLabelsEditor
              key={task.id}
              labels={task.labels}
              disabled={readOnly}
              onChange={(labels, change) => void patch(
                { labels },
                change.kind === "add" ? "标签已添加" : "标签已移除",
              )}
            />
          </InspectorRow>
          {task.parentId !== null && (
            <>
              <p className="task-inspector-note">这是调度者派出的执行者，属性由团队任务统一管理。</p>
              {parent && (
                <button className="task-inspector-action" type="button" onClick={() => onOpenTask(parent.taskId)}>
                  <span>打开所属团队{parent.task ? ` · ${parent.task.title}` : ""}</span><ArrowSquareOut size={13} />
                </button>
              )}
            </>
          )}
        </section>
      </div>
      {queueOpen && task.queueId && (
        <QueueDrawer
          queueId={task.queueId}
          currentTaskId={task.id}
          allTasks={allTasks}
          onClose={() => setQueueOpen(false)}
          onChanged={() => { onQueueChanged(); void api.queue(task.queueId!).then((queue) => setQueueItems(queue.items)); }}
        />
      )}
    </div>
  );
}
