import { useEffect, useMemo, useState } from "react";
import type { AgentExecutorProfile, Group, Session, Task, TaskStatus } from "@harness/shared";
import { isUserSettableStatus, TASK_STATUS_LABELS } from "@harness/shared";
import { CLI_MODEL_PRESETS, REASONING_EFFORT_VALUES } from "@harness/shared/cli-presets";
import { sameExecutor } from "@harness/shared/executors";
import { ArrowSquareOut, CaretRight, ListNumbers, Plus, X } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { LegacyLink } from "../components/LegacyLink.tsx";
import { ScheduleControl } from "../components/ScheduleControl.tsx";
import { taskParentLink } from "../components/TaskOrigin.tsx";
import {
  executorOptions,
  executorValue,
  isExecutorPickable,
  nothingRunnable,
  parseExecutorValue,
  teamExecutorCandidates,
  useAgentAvailability,
} from "../lib/agentAvailability.ts";
import { QueueDrawer } from "./QueueDrawer.tsx";
import { formatInstant, PRIORITY_LABELS, taskDurationInfo } from "./utils.ts";
import { ReviewDispatchControl } from "../review/ReviewDispatchControl.tsx";
import { useTaskReviewInfo } from "../review/useTaskReviewInfo.ts";

const STATUS_ORDER: TaskStatus[] = [
  "running", "idle", "paused", "awaiting_review", "queued", "backlog", "done", "failed", "canceled",
];

function InspectorRow({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="task-inspector-row"><span>{label}</span><div>{children}</div></div>;
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
  onOpenTask,
  onPatch,
  onQueueChanged,
  notify,
}: {
  task: Task;
  groups: Group[];
  sessions: Session[];
  allTasks: Task[];
  onOpenTask: (taskId: string) => void;
  onPatch: (patch: Partial<Task>) => Promise<void>;
  onQueueChanged: (updatedTask?: Task) => void;
  notify: (message: string) => void;
}) {
  const [labelDraft, setLabelDraft] = useState("");
  const [queueItems, setQueueItems] = useState<{ taskId: string; title: string }[]>([]);
  const [queueOpen, setQueueOpen] = useState(false);
  const [requeueing, setRequeueing] = useState(false);
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [profilesReady, setProfilesReady] = useState(false);
  const detection = useAgentAvailability();
  const { info: review, loading: reviewLoading, error: reviewError, load: loadReview } = useTaskReviewInfo(task.id);
  const readOnly = task.parentId !== null || !!task.archived;
  const latestSession = useMemo(
    () => [...sessions].sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0],
    [sessions],
  );
  const latestReview = review?.rounds.at(-1);
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

  const addLabel = () => {
    const label = labelDraft.trim().replace(/^#/, "");
    if (!label || task.labels.includes(label)) return setLabelDraft("");
    setLabelDraft("");
    void patch({ labels: [...task.labels, label] }, "标签已添加");
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
  const executorSelectValue = executorValue(executorSelection);
  const options = executorOptions({
    types: executorTypes,
    profiles: executorProfiles,
    selection: executorSelection,
    knownProfiles: profiles,
  });
  const pickableCount = executorTypes.length + executorProfiles.length;
  const noExecutor = profilesReady && nothingRunnable(detection, profiles);
  const currentUnavailable = detection.status === "ready"
    && !isExecutorPickable(executorSelection, executorTypes, executorProfiles);
  const availabilityMessage = detection.status === "loading"
    ? "正在检测本机智能体，完成后会收窄候选。"
    : detection.status === "failed"
      ? "本地智能体检测失败，本次不限制类型候选；请确认 CLI 已安装。"
      : noExecutor
        ? "本机没有可用的智能体 CLI，也没有已注册执行器。"
        : currentUnavailable
          ? task.mode === "team"
            ? "当前团队调度者不可用或不支持常驻会话，请改选 resident 执行器。"
            : "当前执行器已不可用，请改选已安装的类型或已注册 Profile。"
          : null;
  const modelOptions = [...new Set([task.model, ...CLI_MODEL_PRESETS[agentType]].filter((value): value is string => !!value))];
  const effortOptions = [...new Set([task.reasoningEffort, ...REASONING_EFFORT_VALUES[agentType]].filter((value): value is string => !!value))];
  const duration = taskDurationInfo(task);
  const parent = taskParentLink(task, allTasks);
  const parentTask = task.parentId ? allTasks.find((candidate) => candidate.id === task.parentId) ?? null : null;
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
    <aside className="task-inspector" aria-label="任务 Inspector">
      <div className="task-inspector-head"><b>Inspector</b><span>任务详情</span></div>
      <div className="task-inspector-scroll">
        <section>
          <h2>属性</h2>
          <InspectorRow label="状态">
            <select value={task.status} disabled={readOnly} onChange={(event) => void patch({ status: event.target.value as TaskStatus })}>
              {statusOptions.map((status) => <option value={status} key={status}>{TASK_STATUS_LABELS[status]}</option>)}
            </select>
          </InspectorRow>
          <InspectorRow label="优先级">
            <select value={task.priority} disabled={readOnly} onChange={(event) => void patch({ priority: event.target.value as Task["priority"] })}>
              {Object.entries(PRIORITY_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
            </select>
          </InspectorRow>
          <InspectorRow label="分组">
            <select value={task.groupId ?? ""} disabled={readOnly} onChange={(event) => void patch({ groupId: event.target.value || null })}>
              <option value="">无分组</option>
              {groups.map((group) => <option value={group.id} key={group.id}>{group.name} · {group.mode}</option>)}
            </select>
          </InspectorRow>
          <InspectorRow label="标签">
            <div className="task-label-editor">
              {task.labels.map((label) => (
                <button type="button" key={label} disabled={readOnly} onClick={() => void patch({ labels: task.labels.filter((item) => item !== label) }, "标签已移除")}>
                  {label}<X size={10} />
                </button>
              ))}
              {!readOnly && (
                <label>
                  <Plus size={11} />
                  <input
                    value={labelDraft}
                    placeholder="添加"
                    aria-label="添加标签"
                    onChange={(event) => setLabelDraft(event.target.value)}
                    onBlur={addLabel}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === ",") { event.preventDefault(); addLabel(); }
                    }}
                  />
                </label>
              )}
            </div>
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

        <section>
          <h2>执行信息</h2>
          <InspectorRow label="执行器">
            <select
              value={pickableCount || options.length ? executorSelectValue : ""}
              disabled={readOnly || pickableCount === 0}
              onChange={(event) => {
                const next = parseExecutorValue(event.target.value, profiles, executorSelection);
                if (!isExecutorPickable(next, executorTypes, executorProfiles)) {
                  notify("该执行器当前不可用，请改选已安装的类型或已注册 Profile");
                  return;
                }
                const current = { agentType, executorId: task.executorId ?? null };
                void patch({
                  ...next,
                  ...(sameExecutor(next, current) ? {} : { model: null, reasoningEffort: null }),
                }, "执行器已更新，将从下一回合生效");
              }}
            >
              {options.length === 0 && <option value="">暂无可用执行器</option>}
              {options.map((option) => (
                <option value={option.value} disabled={option.disabled} key={option.value}>{option.label}</option>
              ))}
            </select>
            {availabilityMessage && <p className="task-inspector-note">{availabilityMessage}</p>}
          </InspectorRow>
          <InspectorRow label="模型">
            <select value={task.model ?? ""} disabled={readOnly} onChange={(event) => void patch({ model: event.target.value || null }, "模型设置已更新，将从下一回合生效")}>
              <option value="">跟随执行器</option>
              {modelOptions.map((model) => <option value={model} key={model}>{model}</option>)}
            </select>
          </InspectorRow>
          <InspectorRow label="思考强度">
            <select value={task.reasoningEffort ?? ""} disabled={readOnly} onChange={(event) => void patch({ reasoningEffort: event.target.value || null }, "思考强度已更新，将从下一回合生效")}>
              <option value="">跟随执行器</option>
              {effortOptions.map((effort) => <option value={effort} key={effort}>{effort}</option>)}
            </select>
          </InspectorRow>
          <InspectorRow label="创建时间"><span>{formatInstant(task.createdAt)}</span></InspectorRow>
          {task.startedAt && <InspectorRow label="开始时间"><span>{formatInstant(task.startedAt)}</span></InspectorRow>}
          {task.endedAt && <InspectorRow label="结束时间"><span>{formatInstant(task.endedAt)}</span></InspectorRow>}
          {duration && <InspectorRow label={duration.label}><span title={duration.title}>{duration.text}</span></InspectorRow>}
          {latestSession?.branch && <InspectorRow label="分支"><code>{latestSession.branch}</code></InspectorRow>}
          {latestSession?.worktreePath && <InspectorRow label="worktree"><code>{latestSession.worktreePath}</code></InspectorRow>}
          {latestSession?.resumeCommand && (
            <button className="task-inspector-action" type="button" onClick={async () => {
              try { await navigator.clipboard.writeText(latestSession.resumeCommand!); notify("已复制 resume 命令"); }
              catch { notify("复制失败，请用旧版打开"); }
            }}>
              <span>复制 resume 命令</span><span>复制</span>
            </button>
          )}
        </section>

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
          <LegacyLink projectId={task.projectId} taskId={task.id} />
        </section>

        <section>
          <h2>审查摘要</h2>
          {reviewLoading ? <p className="task-inspector-note">正在读取审查记录…</p> : latestReview ? (
            <details>
              <summary>第 {latestReview.round} 轮 · {latestReview.conclusion === "verified" ? "已通过" : latestReview.conclusion === "verify_failed" ? "未通过" : latestReview.reviewTaskStatus}</summary>
              <pre>{latestReview.reportMarkdown || "尚无审查报告。"}</pre>
            </details>
          ) : <p className={`task-inspector-note${reviewError ? " is-error" : ""}`}>{reviewError ? `审查记录加载失败：${reviewError}` : review?.reviewRequested ? "审查已请求，等待结果。" : "尚未开始审查。"}</p>}
          {!reviewLoading && (
            <ReviewDispatchControl
              task={task}
              parentTask={parentTask}
              rounds={review?.rounds ?? []}
              prominent={!!reviewError || !latestReview || latestReview.conclusion === "verify_failed"}
              notify={notify}
              onRefresh={() => loadReview(true)}
            />
          )}
        </section>

        <section>
          <details>
            <summary>Prompt 原文</summary>
            <pre>{task.body.trim() || "这个任务没有正文说明。"}</pre>
          </details>
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
    </aside>
  );
}
