import { useEffect, useMemo, useState } from "react";
import {
  TASK_STATUS_LABELS,
  type AgentExecutorProfile,
  type AgentType,
  type Task,
} from "@harness/shared";
import { sameExecutor } from "@harness/shared/executors";
import {
  CaretRight,
  CheckCircle,
  MagnifyingGlass,
  SpinnerGap,
  WarningCircle,
} from "@phosphor-icons/react";
import { EffortPicker } from "../components/EffortPicker.tsx";
import { ExecutorModelPicker } from "../components/ExecutorModelPicker.tsx";
import { registeredAgentTypes } from "../lib/agentAvailability.ts";
import { api } from "../lib/api.ts";
import { ReviewEvidence, useTaskReviewInfo } from "../team/ReviewEvidence.tsx";

const REVIEW_IN_FLIGHT = new Set(["backlog", "queued", "running", "paused"]);
const AUTO_REVIEW_LIMIT = 2;

interface ReviewSelection {
  agentType: AgentType;
  executorId: string | null;
  model: string;
  reasoningEffort: string;
}

function reviewDefaults(task: Task, parent: Task | null): ReviewSelection {
  if (parent?.team) {
    return {
      agentType: parent.team.reviewerAgentType ?? parent.team.worker,
      executorId: parent.team.reviewerExecutorId ?? null,
      model: parent.team.reviewerModel ?? "",
      reasoningEffort: parent.team.reviewerReasoningEffort ?? "",
    };
  }
  return {
    agentType: task.agentType ?? "claude",
    executorId: task.executorId ?? null,
    model: task.model ?? "",
    reasoningEffort: task.reasoningEffort ?? "",
  };
}

function statusLabel(task: Task, latest: ReturnType<typeof latestRound>) {
  if (latest?.conclusion === "verified") return "最近一轮已通过";
  if (latest?.conclusion === "verify_failed") return "最近一轮未通过";
  if (latest) return `最近一轮${TASK_STATUS_LABELS[latest.reviewTaskStatus]}`;
  if (task.reviewRequested) return "已启用自动审查，等待任务完成后派发";
  return "尚未审查";
}

function latestRound(state: ReturnType<typeof useTaskReviewInfo>) {
  return state.info?.rounds.at(-1);
}

function dispatchBlockedReason(task: Task, active: boolean): string | null {
  if (task.reviewOf) return "审查任务自身不能再派审。";
  if (task.archived) return "归档任务不能派审。";
  if (task.status === "running" || task.status === "queued") return "任务结束运行或排队后才能派审。";
  if (active) return "已有一轮审查正在进行。";
  return null;
}

function firstRunnableSelection(
  profiles: AgentExecutorProfile[],
): Pick<ReviewSelection, "agentType" | "executorId"> | null {
  const profile = profiles.find((candidate) => candidate.isDefault) ?? profiles[0];
  if (profile) return { agentType: profile.type, executorId: profile.id };
  return null;
}

export function TaskReviewInspector({
  task,
  allTasks,
  onOpenTask,
  onOpenReview,
  notify,
}: {
  task: Task;
  allTasks: Task[];
  onOpenTask: (taskId: string) => void;
  onOpenReview: () => void;
  notify: (message: string) => void;
}) {
  const review = useTaskReviewInfo(task.id);
  const parent = task.parentId
    ? allTasks.find((candidate) => candidate.id === task.parentId && candidate.mode === "team") ?? null
    : null;
  const defaults = useMemo(() => reviewDefaults(task, parent), [
    parent?.team?.reviewerAgentType,
    parent?.team?.reviewerExecutorId,
    parent?.team?.reviewerModel,
    parent?.team?.reviewerReasoningEffort,
    parent?.team?.worker,
    task.agentType,
    task.executorId,
    task.id,
    task.model,
    task.reasoningEffort,
  ]);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [selection, setSelection] = useState(defaults);
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [profilesReady, setProfilesReady] = useState(false);
  const [profilesFailed, setProfilesFailed] = useState(false);

  useEffect(() => {
    setDispatchOpen(false);
    setSelection(defaults);
  }, [defaults, task.id]);

  useEffect(() => {
    let alive = true;
    setProfilesReady(false);
    setProfilesFailed(false);
    api.agents().then(
      (nextProfiles) => { if (alive) setProfiles(nextProfiles); },
      () => {
        if (!alive) return;
        setProfiles([]);
        setProfilesFailed(true);
      },
    ).finally(() => { if (alive) setProfilesReady(true); });
    return () => { alive = false; };
  }, []);

  const rounds = review.info?.rounds ?? [];
  const latest = latestRound(review);
  const activeRound = rounds.find((round) => REVIEW_IN_FLIGHT.has(round.reviewTaskStatus));
  const blockedReason = dispatchBlockedReason(task, !!activeRound);
  const registeredTypes = useMemo(() => registeredAgentTypes(profiles), [profiles]);
  const selectedProfileExists = !!selection.executorId
    && profiles.some((profile) => profile.id === selection.executorId && profile.type === selection.agentType);
  const executorRunnable = selection.executorId
    ? selectedProfileExists
    : registeredTypes.includes(selection.agentType);
  const autoLimitReached = !!review.info?.reviewRequested
    && task.stage === "verify_failed"
    && rounds.some((round) => round.round >= AUTO_REVIEW_LIMIT && round.conclusion === "verify_failed");

  useEffect(() => {
    if (!profilesReady || executorRunnable) return;
    const fallback = firstRunnableSelection(profiles);
    if (!fallback) return;
    setSelection((current) => ({ ...current, ...fallback, model: "", reasoningEffort: "" }));
  }, [executorRunnable, profiles, profilesReady]);

  const dispatch = async () => {
    if (blockedReason || dispatching || !profilesReady || !executorRunnable) return;
    setDispatching(true);
    try {
      const { reviewTask } = await api.dispatchTaskReview(task.id, {
        agentType: selection.agentType,
        executorId: selection.executorId,
        model: selection.model || null,
        reasoningEffort: selection.reasoningEffort || null,
      });
      setDispatchOpen(false);
      await review.reload(true);
      notify(`已派出第 ${reviewTask.reviewRound ?? rounds.length + 1} 轮审查`);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDispatching(false);
    }
  };

  return (
    <div className="review-inspector" aria-label="任务审查">
      <section className="review-inspector__overview">
        <header>
          <span className={`review-inspector__status${latest?.conclusion ? ` is-${latest.conclusion}` : ""}`}>
            {latest?.conclusion === "verified"
              ? <CheckCircle size={13} weight="fill" />
              : latest?.conclusion === "verify_failed"
                ? <WarningCircle size={13} weight="fill" />
                : <MagnifyingGlass size={13} />}
          </span>
          <div><b>{rounds.length ? `${rounds.length} 轮审查` : "独立审查"}</b><small>{statusLabel(task, latest)}</small></div>
        </header>
        <div className="review-inspector__actions">
          <button
            type="button"
            disabled={!!blockedReason || dispatching}
            onClick={() => setDispatchOpen((open) => !open)}
          >
            {dispatching || activeRound ? <SpinnerGap size={13} className="is-spinning" /> : <MagnifyingGlass size={13} />}
            <span>{dispatching ? "派发中" : activeRound ? "审查进行中" : dispatchOpen ? "收起派审配置" : "派审查"}</span>
          </button>
          <button type="button" onClick={onOpenReview}><span>打开改动工作区</span><CaretRight size={13} /></button>
        </div>
        {blockedReason && <p className="review-inspector__notice">{blockedReason}</p>}
        {autoLimitReached && <p className="review-inspector__notice is-warning">自动复审已达上限，等待人工处理。</p>}
      </section>

      {dispatchOpen && !blockedReason && (
        <section className="review-inspector__dispatch" aria-label="派审配置">
          <p>这轮审查会立即启动；留空时跟随所选执行器。</p>
          <div className="review-inspector__fields">
            <label>
              <span>审查执行器与模型</span>
              {/* 执行器 · 模型一颗胶囊，思考强度另一颗——跟其它选模型的地方同一形状。 */}
              <div className="model-effort-row">
                <ExecutorModelPicker
                  label="审查执行器与模型"
                  types={registeredTypes}
                  profiles={profiles}
                  selection={{ agentType: selection.agentType, executorId: selection.executorId }}
                  model={selection.model || null}
                  emptyText="暂无已注册执行器"
                  onCommit={(target) => setSelection((current) => {
                    const next = { agentType: target.agent, executorId: target.executorId };
                    return {
                      ...current,
                      ...next,
                      model: target.model ?? "",
                      // 换了执行器才清强度：旧档位在新 CLI 上多半根本不存在。
                      reasoningEffort: sameExecutor(next, current) ? current.reasoningEffort : "",
                    };
                  })}
                />
                <EffortPicker
                  type={selection.agentType}
                  model={selection.model}
                  value={selection.reasoningEffort}
                  onChange={(reasoningEffort) => setSelection((current) => ({ ...current, reasoningEffort }))}
                />
              </div>
            </label>
          </div>
          {!profilesReady && <p className="review-inspector__notice">正在读取已注册执行器…</p>}
          {profilesFailed && <p className="review-inspector__notice is-warning">执行器列表读取失败，暂不能派审。</p>}
          {profilesReady && !profilesFailed && !profiles.length && <p className="review-inspector__notice is-warning">还没有已注册执行器。</p>}
          {profilesReady && !executorRunnable && !!profiles.length && <p className="review-inspector__notice is-warning">当前执行器未注册，请换一个已注册执行器。</p>}
          <button type="button" disabled={dispatching || !profilesReady || !executorRunnable} onClick={() => void dispatch()}>
            {dispatching && <SpinnerGap size={13} className="is-spinning" />}{dispatching ? "派发中" : "确认派审查"}
          </button>
        </section>
      )}

      <div className="review-inspector__evidence">
        <ReviewEvidence
          taskId={task.id}
          state={review}
          emptyMessage={review.info?.reviewRequested ? "审查已请求，等待首轮结果。" : "任务完成后可自动派审，也可以在上方手动补审。"}
          onOpenTask={onOpenTask}
        />
      </div>
    </div>
  );
}
