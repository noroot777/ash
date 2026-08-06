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
import { ForcePassVerifyButton } from "../workflow/VerifyGateControls.tsx";
import { verifyStationAtCursor } from "../workflow/workflowModel.ts";

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
  if (task.reviewRequested) return "已启用自动验证，等待任务完成后开始";
  return "尚未验证";
}

function latestRound(state: ReturnType<typeof useTaskReviewInfo>) {
  return state.info?.rounds.at(-1);
}

function dispatchBlockedReason(task: Task, active: boolean): string | null {
  if (task.reviewOf) return "历史审查任务自身不能再验。";
  if (task.archived) return "归档任务不能验证。";
  if (task.status === "running" || task.status === "queued") return "任务结束运行或排队后才能验证。";
  if (active) return "已有一轮验证正在进行。";
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
  onTaskUpdated,
  notify,
}: {
  task: Task;
  allTasks: Task[];
  onOpenTask: (taskId: string) => void;
  onOpenReview: () => void;
  onTaskUpdated: (task: Task) => void;
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
  // 线停在「自动验证」这一站时，这里也得有一条出路：卡住的人多半是从这一页点进来看
  // 证据的，不该再让他猜「要去工作流页才有按钮」。判据与线路图那边同源（都出自
  // resolveCursor），没有编排的老任务返回 null——它们的验证不卡任何东西。
  const verifyStation = useMemo(() => verifyStationAtCursor(task), [task]);

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
      const { round } = await api.dispatchTaskReview(task.id, {
        agentType: selection.agentType,
        executorId: selection.executorId,
        model: selection.model || null,
        reasoningEffort: selection.reasoningEffort || null,
      });
      setDispatchOpen(false);
      await review.reload(true);
      notify(`已开始第 ${round} 轮验证`);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDispatching(false);
    }
  };

  return (
    <div className="review-inspector" aria-label="任务验证">
      <section className="review-inspector__overview">
        <header>
          <span className={`review-inspector__status${latest?.conclusion ? ` is-${latest.conclusion}` : ""}`}>
            {latest?.conclusion === "verified"
              ? <CheckCircle size={13} weight="fill" />
              : latest?.conclusion === "verify_failed"
                ? <WarningCircle size={13} weight="fill" />
                : <MagnifyingGlass size={13} />}
          </span>
          <div><b>{rounds.length ? `${rounds.length} 轮验证` : "自动验证"}</b><small>{statusLabel(task, latest)}</small></div>
        </header>
        <div className="review-inspector__actions">
          <button
            type="button"
            disabled={!!blockedReason || dispatching}
            onClick={() => setDispatchOpen((open) => !open)}
          >
            {dispatching || activeRound ? <SpinnerGap size={13} className="is-spinning" /> : <MagnifyingGlass size={13} />}
            <span>{dispatching ? "启动中" : activeRound ? "验证进行中" : dispatchOpen ? "收起验证配置" : "验一轮"}</span>
          </button>
          <button type="button" onClick={onOpenReview}><span>打开改动工作区</span><CaretRight size={13} /></button>
          {verifyStation && (
            <ForcePassVerifyButton
              task={task}
              def={verifyStation.def}
              stationId={verifyStation.stationId}
              disabled={dispatching}
              onTaskUpdated={onTaskUpdated}
              notify={notify}
            />
          )}
        </div>
        {blockedReason && <p className="review-inspector__notice">{blockedReason}</p>}
        {autoLimitReached && (
          <p className="review-inspector__notice is-warning">
            {verifyStation
              ? "自动复验已达上限。可以按上面「验一轮」再验，或由你签字强制通过。"
              : "自动复验已达上限，等待人工处理。"}
          </p>
        )}
      </section>

      {dispatchOpen && !blockedReason && (
        <section className="review-inspector__dispatch" aria-label="验证配置">
          {/* 验证就跑在这个任务自己身上；换个执行器 = 换一双眼睛来看同一份产物。 */}
          <p>这轮验证会就在本任务的工作目录里立即开始；换执行器就是换一双眼睛，留空时跟随所选执行器。</p>
          <div className="review-inspector__fields">
            <label>
              <span>验证执行器与模型</span>
              {/* 执行器 · 模型一颗胶囊，思考强度另一颗——跟其它选模型的地方同一形状。 */}
              <div className="model-effort-row">
                <ExecutorModelPicker
                  label="验证执行器与模型"
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
          {profilesFailed && <p className="review-inspector__notice is-warning">执行器列表读取失败，暂不能验证。</p>}
          {profilesReady && !profilesFailed && !profiles.length && <p className="review-inspector__notice is-warning">还没有已注册执行器。</p>}
          {profilesReady && !executorRunnable && !!profiles.length && <p className="review-inspector__notice is-warning">当前执行器未注册，请换一个已注册执行器。</p>}
          <button type="button" disabled={dispatching || !profilesReady || !executorRunnable} onClick={() => void dispatch()}>
            {dispatching && <SpinnerGap size={13} className="is-spinning" />}{dispatching ? "启动中" : "确认开始验证"}
          </button>
        </section>
      )}

      <div className="review-inspector__evidence">
        <ReviewEvidence
          taskId={task.id}
          state={review}
          emptyMessage={review.info?.reviewRequested ? "验证已启用，等待首轮结果。" : "任务完成后可自动验证，也可以在上方手动补一轮。"}
          onOpenTask={onOpenTask}
        />
      </div>
    </div>
  );
}
