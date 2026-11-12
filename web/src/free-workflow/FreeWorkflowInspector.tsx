import { useMemo, useRef, useState } from "react";
import type {
  FreeReviewRound,
  FreeReviewRun,
  FreeWorkflowExecution,
  Task,
} from "@ash/shared";
import {
  CheckCircle,
  MagnifyingGlass,
  SpinnerGap,
  WarningCircle,
} from "@phosphor-icons/react";
import type { FreeWorkflowApiState } from "../lib/api.ts";
import { FreeReviewRoundDrawer } from "./FreeReviewRoundBody.tsx";
import { recurrenceText, reviewKey, reviewRoundLabel, timing } from "./freeReviewRounds.ts";
import { useFreeWorkflowState } from "./useFreeWorkflowState.ts";

type Activity =
  | { type: "execution"; at: string; key: string; execution: FreeWorkflowExecution }
  | { type: "review"; at: string; key: string; run: FreeReviewRun; round: FreeReviewRound };

// 只收「让任务本身往前走了一步」的事。打开/关闭预览不算——那是随手开一眼看效果的
// 看片器，开十次也不改变任务走到了哪儿，摆进这条线只会把真正的进展冲淡。
function actualActivities(state: FreeWorkflowApiState | null): Activity[] {
  if (!state) return [];
  const activities: Activity[] = [
    ...(state.executions ?? []).map((execution): Activity => ({
      type: "execution", at: execution.startedAt, key: `execution-${execution.id}`, execution,
    })),
    ...state.reviews.flatMap((run) => run.rounds.map((round): Activity => ({
      type: "review", at: round.startedAt, key: `review-${run.id}-${round.round}`, run, round,
    }))),
  ];
  return activities.sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
}

function executionLabel(execution: FreeWorkflowExecution): string {
  if (execution.status === "running") return "正在进行";
  if (execution.status === "completed") return "已完成";
  if (execution.status === "paused") return "已暂停";
  if (execution.status === "canceled") return "已取消";
  return "执行失败";
}

/** 「工作流」格（自由工作流）：真正发生过的执行与审查，按先后一行一条。 */
export function FreeWorkflowInspector({ task }: { task: Task }) {
  const free = useFreeWorkflowState(task.id);
  const [selectedReviewKey, setSelectedReviewKey] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const workflowListRef = useRef<HTMLOListElement>(null);
  const state = free.state;
  const activities = useMemo(() => actualActivities(state), [state]);
  const opened = selectedReviewKey
    ? activities.find((activity): activity is Extract<Activity, { type: "review" }> =>
        activity.type === "review" && reviewKey(activity.run.id, activity.round.round) === selectedReviewKey) ?? null
    : null;

  if (free.loading && !free.state) return <div className="free-workflow-inspector is-loading"><SpinnerGap size={14} className="is-spinning" />正在生成实际工作流…</div>;
  if (free.error && !free.state) return <div className="free-workflow-inspector is-loading is-error"><WarningCircle size={14} />{free.error}</div>;

  const selectReview = (run: FreeReviewRun, round: FreeReviewRound) => {
    const key = reviewKey(run.id, round.round);
    setSelectedReviewKey((current) => current === key ? null : key);
  };

  return (
    <>
      <div className="free-workflow-inspector" ref={rootRef}>
        <section className="free-workflow-generated">
          <header><span>根据实际情况生成</span><small>这里不预判下一步，只记录真正发生过的操作。</small></header>
          <ol ref={workflowListRef}>
            {activities.map((activity) => {
              if (activity.type === "execution") {
                const running = activity.execution.status === "running";
                const warning = activity.execution.status !== "completed" && !running;
                return <li key={activity.key} className={running ? "is-active" : warning ? "is-warning" : "is-done"}>
                  <span>{running ? <SpinnerGap size={14} className="is-spinning" /> : warning ? <WarningCircle size={14} /> : <CheckCircle size={14} weight="fill" />}</span>
                  <div><b>任务执行</b><small>{executionLabel(activity.execution)} · {timing(activity.execution.startedAt, activity.execution.endedAt)}</small></div>
                </li>;
              }
              const active = activity.round.status === "reviewing";
              const passed = activity.round.conclusion === "verified";
              const key = reviewKey(activity.run.id, activity.round.round);
              const recurrence = recurrenceText(activity.round);
              return <li key={activity.key} className={active ? "is-active" : passed ? "is-done" : "is-warning"}>
                <button type="button" aria-expanded={selectedReviewKey === key} onClick={() => selectReview(activity.run, activity.round)}>
                  <span>{active ? <SpinnerGap size={14} className="is-spinning" /> : passed ? <CheckCircle size={14} weight="fill" /> : <MagnifyingGlass size={14} />}</span>
                  <div><b>{activity.run.reviewerName} · {activity.run.checkMode === "logic" ? "逻辑检查" : "语法检查"}</b><small>{reviewRoundLabel(activity.round)}{recurrence ? ` · ${recurrence}` : ""} · 第 {activity.round.round} 轮 / 最多 {activity.run.retryLimit + 1} 轮 · {timing(activity.round.startedAt, activity.round.endedAt)}{activity.run.note ? " · 含附言" : ""}</small></div>
                </button>
              </li>;
            })}
          </ol>
          {!activities.length && <p>目前还没有实际工作流记录；任务执行或派审后，这里会按发生顺序补出记录。</p>}
        </section>
      </div>
      {opened && (
        <FreeReviewRoundDrawer
          taskId={task.id}
          run={opened.run}
          round={opened.round}
          anchorRef={rootRef}
          keepOpenRef={workflowListRef}
          onClose={() => setSelectedReviewKey(null)}
        />
      )}
    </>
  );
}
