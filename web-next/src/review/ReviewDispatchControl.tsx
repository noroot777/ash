import { useEffect, useMemo, useState } from "react";
import type { AgentExecutorProfile, Task, TaskReviewRound } from "@harness/shared";
import { MagnifyingGlass, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { EffortField, ExecutorSelect, ModelField } from "../composer/ComposerFields.tsx";
import {
  executorValue,
  isExecutorPickable,
  nothingRunnable,
  parseExecutorValue,
  preferredExecutor,
  registeredAgentTypes,
  type ExecutorSelection,
} from "../lib/agentAvailability.ts";
import { api } from "../lib/api.ts";

const REVIEW_IN_FLIGHT = new Set(["backlog", "queued", "running", "paused"]);

function reviewDefaults(task: Task, parentTask: Task | null): {
  selection: ExecutorSelection;
  model: string;
  effort: string;
} {
  if (parentTask?.mode === "team" && parentTask.team) {
    return {
      selection: {
        agentType: parentTask.team.reviewerAgentType ?? parentTask.team.worker,
        executorId: parentTask.team.reviewerExecutorId ?? null,
      },
      model: parentTask.team.reviewerModel ?? "",
      effort: parentTask.team.reviewerReasoningEffort ?? "",
    };
  }
  return {
    selection: {
      agentType: task.agentType ?? "claude",
      executorId: task.executorId ?? null,
    },
    model: task.model ?? "",
    effort: task.reasoningEffort ?? "",
  };
}

export function ReviewDispatchControl({
  task,
  parentTask = null,
  rounds,
  prominent = false,
  notify,
  onRefresh,
}: {
  task: Task;
  parentTask?: Task | null;
  rounds: TaskReviewRound[];
  prominent?: boolean;
  notify: (message: string) => void;
  onRefresh: () => void | Promise<void>;
}) {
  const defaults = useMemo(
    () => reviewDefaults(task, parentTask),
    [parentTask, task.agentType, task.executorId, task.id, task.model, task.reasoningEffort],
  );
  const [profiles, setProfiles] = useState<AgentExecutorProfile[]>([]);
  const [profilesReady, setProfilesReady] = useState(false);
  const [profilesFailed, setProfilesFailed] = useState(false);
  const [selection, setSelection] = useState<ExecutorSelection>(defaults.selection);
  const [model, setModel] = useState(defaults.model);
  const [effort, setEffort] = useState(defaults.effort);
  const [open, setOpen] = useState(prominent);
  const [dispatching, setDispatching] = useState(false);
  const [dispatchedReviewId, setDispatchedReviewId] = useState<string | null>(null);
  const workerTypes = useMemo(() => registeredAgentTypes(profiles), [profiles]);

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

  useEffect(() => {
    setSelection(defaults.selection);
    setModel(defaults.model);
    setEffort(defaults.effort);
    setOpen(prominent);
    setDispatchedReviewId(null);
  }, [defaults, prominent, task.id]);

  useEffect(() => {
    if (!profilesReady) return;
    if (isExecutorPickable(selection, workerTypes, profiles)) return;
    const fallback = preferredExecutor(workerTypes, profiles, defaults.selection.agentType);
    if (!fallback) return;
    setSelection(fallback);
    setModel("");
    setEffort("");
  }, [defaults.selection.agentType, profiles, profilesReady, selection, workerTypes]);

  useEffect(() => {
    if (dispatchedReviewId && rounds.some((round) => round.reviewTaskId === dispatchedReviewId)) {
      setDispatchedReviewId(null);
    }
  }, [dispatchedReviewId, rounds]);

  if (task.mode !== "single" || task.reviewOf || task.archived) return null;

  const activeRound = rounds.find((round) => REVIEW_IN_FLIGHT.has(round.reviewTaskStatus));
  const targetBusy = task.status === "running" || task.status === "queued";
  const availabilityPending = !profilesReady;
  const noExecutor = profilesReady && nothingRunnable(profiles);
  const selectionPickable = isExecutorPickable(selection, workerTypes, profiles);
  const locallyUnavailable = profilesReady && !selectionPickable;
  const dispatchLocked = !!activeRound || !!dispatchedReviewId;
  const canSend = !targetBusy
    && !dispatchLocked
    && !dispatching
    && !availabilityPending
    && !noExecutor
    && selectionPickable;
  const nextRound = rounds.reduce((highest, round) => Math.max(highest, round.round), 0) + 1;
  const actionLabel = rounds.length ? "补派下一轮" : "派出独立审查";
  const availabilityMessage = availabilityPending
    ? "正在读取已注册执行器…"
    : profilesFailed
      ? "Profile 列表读取失败，暂不能派发审查。"
      : noExecutor
        ? "还没有已注册 Profile。"
        : locallyUnavailable
          ? "当前执行器未注册，请改选已注册 Profile 或其类型默认。"
          : null;

  const dispatch = async () => {
    // UI 状态与真实提交共享同一组拦截条件；服务端仍会处理跨窗口竞争。
    if (!canSend) return;
    setDispatching(true);
    try {
      const { reviewTask } = await api.dispatchTaskReview(task.id, {
        agentType: selection.agentType,
        executorId: selection.executorId,
        model: model.trim() || null,
        reasoningEffort: effort || null,
      });
      setDispatchedReviewId(reviewTask.id);
      setOpen(false);
      await onRefresh();
      notify(`已派出第 ${reviewTask.reviewRound ?? nextRound} 轮审查`);
    } catch (reason) {
      notify(reason instanceof Error ? reason.message : String(reason));
      await onRefresh();
    } finally {
      setDispatching(false);
    }
  };

  return (
    <div className={`review-dispatch-control${prominent ? " is-prominent" : ""}`}>
      <div className="review-dispatch-heading">
        <span><MagnifyingGlass size={13} weight="bold" /></span>
        <div>
          <b>{dispatchLocked ? "独立审查正在进行" : actionLabel}</b>
          <small>{targetBusy ? "目标仍在运行或排队，结束后才能派审。" : dispatchLocked ? "当前轮次结束后可补派下一轮。" : `将立即启动第 ${nextRound} 轮真实运行验证。`}</small>
        </div>
        <button
          type="button"
          disabled={targetBusy || dispatchLocked || dispatching}
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {dispatchLocked || dispatching ? <SpinnerGap size={12} className="is-spinning" /> : <MagnifyingGlass size={12} />}
          {dispatchLocked ? "审查进行中" : open ? "收起" : actionLabel}
        </button>
      </div>
      {open && !targetBusy && !dispatchLocked && (
        <form onSubmit={(event) => { event.preventDefault(); void dispatch(); }}>
          <fieldset disabled={dispatching}>
            <div className="review-dispatch-fields">
              <ExecutorSelect
                label="审查执行器 Profile"
                value={executorValue(selection)}
                types={workerTypes}
                profiles={profiles}
                knownProfiles={profiles}
                fallbackType={defaults.selection.agentType}
                onChange={(value) => {
                  const next = parseExecutorValue(value, profiles, selection);
                  setSelection(next);
                  setModel("");
                  setEffort("");
                }}
              />
              <ModelField role={`review-${task.id}`} label="模型" value={model} type={selection.agentType} onChange={setModel} />
              <EffortField label="思考强度" value={effort} type={selection.agentType} onChange={setEffort} />
            </div>
            {availabilityMessage && (
              <p className={`review-dispatch-availability${locallyUnavailable || noExecutor ? " is-error" : ""}`}>
                {(locallyUnavailable || noExecutor) && <WarningCircle size={12} weight="fill" />}
                {availabilityMessage}
              </p>
            )}
            <footer>
              <span>模型与思考强度留空时跟随所选执行器。</span>
              <button type="submit" disabled={!canSend}>
                {dispatching && <SpinnerGap size={12} className="is-spinning" />}
                {dispatching ? "派发中…" : `确认派出第 ${nextRound} 轮`}
              </button>
            </footer>
          </fieldset>
        </form>
      )}
    </div>
  );
}
