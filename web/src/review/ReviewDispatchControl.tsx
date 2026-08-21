import { useEffect, useMemo, useState } from "react";
import type { AgentExecutorProfile, Task, TaskReviewRound } from "@ash/shared";
import { MagnifyingGlass, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import { ExecutorPickerField } from "../composer/ExecutorPickerField.tsx";
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
  // 验证轮不再是一个独立任务，所以「我刚点过」记的是轮次号：等这一轮出现在 rounds 里就解锁。
  const [dispatchedRound, setDispatchedRound] = useState<number | null>(null);
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
    setDispatchedRound(null);
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
    if (dispatchedRound !== null && rounds.some((round) => round.round === dispatchedRound)) {
      setDispatchedRound(null);
    }
  }, [dispatchedRound, rounds]);

  if (task.mode !== "single" || task.reviewOf || task.archived) return null;

  const activeRound = rounds.find((round) => REVIEW_IN_FLIGHT.has(round.reviewTaskStatus));
  // running/queued 之外，「停在待答/待续跑」同样派不动：startVerifyRound 明确拒绝
  // question/resumePrompt 非空的任务（那两个字段会被验证结算当成「验证者本轮中途提问」，
  // 派验证之前就存在的话这一轮永远收不了尾）。前端不同步这道门禁，暂停待答的任务上就会
  // 出现一个可点但必失败的「开始验证」（审查实测）。判据与 server/src/review.ts 同源。
  const pendingAnswer = !!task.question || !!task.resumePrompt;
  const targetBusy = task.status === "running" || task.status === "queued" || pendingAnswer;
  const availabilityPending = !profilesReady;
  const noExecutor = profilesReady && nothingRunnable(profiles);
  const selectionPickable = isExecutorPickable(selection, workerTypes, profiles);
  const locallyUnavailable = profilesReady && !selectionPickable;
  const dispatchLocked = !!activeRound || dispatchedRound !== null;
  const canSend = !targetBusy
    && !dispatchLocked
    && !dispatching
    && !availabilityPending
    && !noExecutor
    && selectionPickable;
  const nextRound = rounds.reduce((highest, round) => Math.max(highest, round.round), 0) + 1;
  const actionLabel = rounds.length ? "再验一轮" : "开始验证";
  const availabilityMessage = availabilityPending
    ? "正在读取已注册执行器…"
    : profilesFailed
      ? "Profile 列表读取失败，暂不能开始验证。"
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
      const { round } = await api.dispatchTaskReview(task.id, {
        agentType: selection.agentType,
        executorId: selection.executorId,
        model: model.trim() || null,
        reasoningEffort: effort || null,
      });
      setDispatchedRound(round);
      setOpen(false);
      await onRefresh();
      notify(`已开始第 ${round} 轮验证`);
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
          <b>{dispatchLocked ? "验证正在进行" : actionLabel}</b>
          <small>{pendingAnswer ? "任务正等待答复或续跑，处理完才能验证。" : targetBusy ? "目标仍在运行或排队，结束后才能验证。" : dispatchLocked ? "当前轮次结束后可再验一轮。" : `将就在这个任务上立即开始第 ${nextRound} 轮真实运行验证。`}</small>
        </div>
        <button
          type="button"
          disabled={targetBusy || dispatchLocked || dispatching}
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {dispatchLocked || dispatching ? <SpinnerGap size={12} className="is-spinning" /> : <MagnifyingGlass size={12} />}
          {dispatchLocked ? "验证进行中" : open ? "收起" : actionLabel}
        </button>
      </div>
      {open && !targetBusy && !dispatchLocked && (
        <form onSubmit={(event) => { event.preventDefault(); void dispatch(); }}>
          <fieldset disabled={dispatching}>
            <div className="review-dispatch-fields">
              <ExecutorPickerField
                label="验证执行器"
                value={executorValue(selection)}
                types={workerTypes}
                profiles={profiles}
                knownProfiles={profiles}
                fallbackType={defaults.selection.agentType}
                override={{ model, effort }}
                onChange={(value, override) => {
                  setSelection(parseExecutorValue(value, profiles, selection));
                  setModel(override.model);
                  setEffort(override.effort);
                }}
                onEffortChange={setEffort}
              />
            </div>
            {availabilityMessage && (
              <p className={`review-dispatch-availability${locallyUnavailable || noExecutor ? " is-error" : ""}`}>
                {(locallyUnavailable || noExecutor) && <WarningCircle size={12} weight="fill" />}
                {availabilityMessage}
              </p>
            )}
            <footer>
              <span>模型与智能水平留空时跟随所选执行器；换执行器就是换一双眼睛来验同一份产物。</span>
              <button type="submit" disabled={!canSend}>
                {dispatching && <SpinnerGap size={12} className="is-spinning" />}
                {dispatching ? "启动中…" : `确认开始第 ${nextRound} 轮`}
              </button>
            </footer>
          </fieldset>
        </form>
      )}
    </div>
  );
}
