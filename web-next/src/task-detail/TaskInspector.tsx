import { useEffect, useMemo, useState } from "react";
import type { AgentExecutorProfile, AgentType, Group, Schedule, Session, Task, TaskReviewInfo, TaskStatus } from "@harness/shared";
import { AGENT_TYPES, CLI_MODEL_PRESETS, isUserSettableStatus, REASONING_EFFORT_VALUES, TASK_STATUS_LABELS } from "@harness/shared";
import { sameExecutor } from "@harness/shared/executors";
import { CaretRight, ListNumbers, Plus, X } from "@phosphor-icons/react";
import { api } from "../lib/api.ts";
import { LegacyLink } from "../components/LegacyLink.tsx";
import { QueueDrawer } from "./QueueDrawer.tsx";
import { formatInstant, PRIORITY_LABELS } from "./utils.ts";

const STATUS_ORDER: TaskStatus[] = [
  "running", "idle", "paused", "awaiting_review", "queued", "backlog", "done", "failed", "canceled",
];

function InspectorRow({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="task-inspector-row"><span>{label}</span><div>{children}</div></div>;
}

function scheduleLabel(schedule: Schedule | null): string {
  if (!schedule) return "未设置";
  if (!schedule.enabled) return "已停用";
  if (schedule.kind === "once") return schedule.at ? `单次 · ${formatInstant(schedule.at)}` : "单次";
  return `Cron · ${schedule.cron ?? "未配置"}`;
}

export function TaskInspector({
  task,
  groups,
  sessions,
  allTasks,
  onPatch,
  onQueueChanged,
  notify,
}: {
  task: Task;
  groups: Group[];
  sessions: Session[];
  allTasks: Task[];
  onPatch: (patch: Partial<Task>) => Promise<void>;
  onQueueChanged: () => void;
  notify: (message: string) => void;
}) {
  const [labelDraft, setLabelDraft] = useState("");
  const [queueItems, setQueueItems] = useState<{ taskId: string; title: string }[]>([]);
  const [queueOpen, setQueueOpen] = useState(false);
  const [review, setReview] = useState<TaskReviewInfo | null>(null);
  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
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
    api.taskReview(task.id).then((value) => { if (alive) setReview(value); }).catch(() => { if (alive) setReview(null); });
    api.schedule(task.id).then((value) => { if (alive) setSchedule(value); }).catch(() => { if (alive) setSchedule(null); });
    api.agents().then((value) => { if (alive) setProfiles(value); }).catch(() => { if (alive) setProfiles([]); });
    return () => { alive = false; };
  }, [task.id, task.queueId, queueOpen]);

  const patch = async (value: Partial<Task>, message = "任务属性已更新") => {
    try {
      await onPatch(value);
      notify(message);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
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
  const executorValue = task.executorId ? `profile:${task.executorId}` : `default:${agentType}`;
  const modelOptions = [...new Set([task.model, ...CLI_MODEL_PRESETS[agentType]].filter((value): value is string => !!value))];
  const effortOptions = [...new Set([task.reasoningEffort, ...REASONING_EFFORT_VALUES[agentType]].filter((value): value is string => !!value))];

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
          {task.parentId !== null && <p className="task-inspector-note">这是调度者派出的执行者，属性由团队任务统一管理。</p>}
        </section>

        <section>
          <h2>执行信息</h2>
          <InspectorRow label="执行器">
            <select
              value={executorValue}
              disabled={readOnly}
              onChange={(event) => {
                const profileId = event.target.value.startsWith("profile:") ? event.target.value.slice(8) : null;
                const profile = profiles.find((candidate) => candidate.id === profileId);
                const next = {
                  agentType: profile?.type ?? event.target.value.slice(8) as AgentType,
                  executorId: profile?.id ?? null,
                };
                const current = { agentType, executorId: task.executorId ?? null };
                void patch({
                  ...next,
                  ...(sameExecutor(next, current) ? {} : { model: null, reasoningEffort: null }),
                }, "执行器已更新，将从下一回合生效");
              }}
            >
              {AGENT_TYPES.map((type) => <option value={`default:${type}`} key={`default:${type}`}>默认 {type}</option>)}
              {profiles.map((profile) => <option value={`profile:${profile.id}`} key={profile.id}>{profile.name}</option>)}
            </select>
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
              <button className="task-inspector-action" type="button" onClick={() => setQueueOpen(true)}>
                <span><ListNumbers size={13} />查看队列 · {queueItems.length || "…"} 个任务</span><CaretRight size={13} />
              </button>
            </>
          ) : <p className="task-inspector-note">独立任务，不在任何队列中。</p>}
        </section>

        <section>
          <h2>调度与续跑</h2>
          <InspectorRow label="调度"><span>{scheduleLabel(schedule)}</span></InspectorRow>
          <details>
            <summary>续跑指令</summary>
            <pre>{task.resumePrompt?.trim() || "未设置；续跑时使用标准“继续”指令。"}</pre>
          </details>
          <LegacyLink projectId={task.projectId} taskId={task.id} />
        </section>

        <section>
          <h2>审查摘要</h2>
          {latestReview ? (
            <details>
              <summary>第 {latestReview.round} 轮 · {latestReview.conclusion === "verified" ? "已通过" : latestReview.conclusion === "verify_failed" ? "未通过" : latestReview.reviewTaskStatus}</summary>
              <pre>{latestReview.reportMarkdown || "尚无审查报告。"}</pre>
            </details>
          ) : <p className="task-inspector-note">{review?.reviewRequested ? "审查已请求，等待结果。" : "尚未开始审查。"}</p>}
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
