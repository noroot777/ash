import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  TASK_STATUS_LABELS,
  type AgentExecutorProfile,
  type AgentType,
  type Task, type TaskListItem,
} from "@ash/shared";
import { sameExecutor } from "@ash/shared/executors";
import type { WorkflowDef } from "@ash/shared/workflow";
import { RunTargetPicker } from "../components/RunTargetPicker.tsx";
import { InspActions, InspConclusion, InspMainButton, InspMore, type InspMoreItem } from "../inspector/InspHead.tsx";

import { InspButton, InspKv, InspRow } from "../inspector/parts.tsx";
import { registeredAgentTypes } from "../lib/agentAvailability.ts";
import { api } from "../lib/api.ts";
import { useTaskReviewInfo } from "../team/ReviewEvidence.tsx";
import { TaskReviewRounds } from "../review/TaskReviewRounds.tsx";
import { useForcePassVerify } from "../workflow/VerifyGateControls.tsx";
import { verifyStationAtCursor } from "../workflow/workflowModel.ts";

const REVIEW_IN_FLIGHT = new Set(["backlog", "queued", "running", "paused"]);
const AUTO_REVIEW_LIMIT = 2;

interface ReviewSelection {
  agentType: AgentType;
  executorId: string | null;
  model: string;
  reasoningEffort: string;
}

function reviewDefaults(task: Task, parent: TaskListItem | null): ReviewSelection {
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

type Latest = ReturnType<typeof latestRound>;

/** 顶上那一句结论。 */
function conclusion(task: Task, latest: Latest, active: boolean, autoLimitReached: boolean): { tone: "ok" | "bad" | "busy" | "none"; text: string } {
  if (active && latest) return { tone: "busy", text: `第 ${latest.round} 轮验证中` };
  if (latest?.conclusion === "verified") return { tone: "ok", text: `第 ${latest.round} 轮已通过` };
  if (latest?.conclusion === "verify_failed") {
    return { tone: "bad", text: `第 ${latest.round} 轮未通过${autoLimitReached ? " · 自动复验已到上限" : ""}` };
  }
  if (latest) return { tone: "bad", text: `第 ${latest.round} 轮${TASK_STATUS_LABELS[latest.reviewTaskStatus]}，没有结论` };
  if (task.reviewRequested) return { tone: "none", text: "已启用自动验证，任务完成后开始" };
  return { tone: "none", text: "还没验证过" };
}

/** 线停在「自动验证」这一站时多一项「人工强制通过」：确认框和判据跟线路图那一站是同一份。 */
function ForcePassSlot({ task, station, disabled, onTaskUpdated, notify, children }: {
  task: Task;
  station: { def: WorkflowDef; stationId: string };
  disabled: boolean;
  onTaskUpdated: (task: Task) => void;
  notify: (message: string) => void;
  children: (item: InspMoreItem) => ReactNode;
}) {
  const force = useForcePassVerify({ task, def: station.def, stationId: station.stationId, onTaskUpdated, notify });
  return (
    <>
      {children({
        key: "force-pass",
        label: force.busy ? "放行中…" : "人工强制通过…",
        onSelect: force.ask,
        disabled: disabled || force.busy || force.inFlight,
        danger: force.destructive,
      })}
      {force.dialog}
    </>
  );
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
  allTasks: TaskListItem[];
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

  const now = conclusion(task, latest, !!activeRound, autoLimitReached);
  const workspace: InspMoreItem[] = [{ key: "workspace", label: "打开改动工作区", onSelect: onOpenReview }];
  const head = (extra: InspMoreItem | null) => (
    <section className="insp-head" aria-label="验证结论">
      <InspConclusion tone={now.tone}>{now.text}</InspConclusion>
      <InspActions>
        {!activeRound && (
          <InspMainButton action={{
            label: dispatching ? "启动中…" : "验一轮",
            onClick: () => setDispatchOpen((open) => !open),
            disabled: !!blockedReason || dispatching,
            pressed: dispatchOpen,
          }} />
        )}
        <InspMore items={extra ? [...workspace, extra] : workspace} />
      </InspActions>
      {/* 按不了的时候说一句为什么（在验的那一轮已经写在结论里了）。 */}
      {blockedReason && !activeRound && <p className="insp-hint">{blockedReason}</p>}
      {autoLimitReached && verifyStation && <p className="insp-hint">验证器不认账时，可以再验一轮，或在「更多」里由你签字强制通过。</p>}
    </section>
  );

  return (
    <div className="insp-pane review-pane" aria-label="任务验证">
      {verifyStation
        ? (
          <ForcePassSlot task={task} station={verifyStation} disabled={dispatching} onTaskUpdated={onTaskUpdated} notify={notify}>
            {(item) => head(item)}
          </ForcePassSlot>
        )
        : head(null)}

      {dispatchOpen && !blockedReason && (
        <section className="review-pane__dispatch" aria-label="验证配置">
          <InspKv>
            <InspRow label="执行器">
              {/* 跟其它选模型的地方同一副形状：一颗三段胶囊「智能体 · 模型 · 智能水平」。 */}
              <RunTargetPicker
                label="验证执行器与模型"
                types={registeredTypes}
                profiles={profiles}
                selection={{ agentType: selection.agentType, executorId: selection.executorId }}
                model={selection.model || null}
                effort={selection.reasoningEffort}
                emptyText="暂无已注册执行器"
                onCommit={(target) => setSelection((current) => {
                  const next = { agentType: target.agent, executorId: target.executorId };
                  return {
                    ...current,
                    ...next,
                    model: target.model ?? "",
                    // 换了执行器才清智能水平：旧档位在新 CLI 上多半根本不存在。
                    reasoningEffort: sameExecutor(next, current) ? current.reasoningEffort : "",
                  };
                })}
                onEffortChange={(reasoningEffort) => setSelection((current) => ({ ...current, reasoningEffort }))}
              />
            </InspRow>
          </InspKv>
          {/* 验证就跑在这个任务自己身上；换个执行器 = 换一双眼睛来看同一份产物。 */}
          <p className={`insp-hint${profilesFailed || (profilesReady && !executorRunnable) ? " is-bad" : ""}`}>
            {!profilesReady ? "正在读取已注册执行器…"
              : profilesFailed ? "执行器列表读取失败，暂不能验证。"
                : !profiles.length ? "还没有已注册执行器。"
                  : !executorRunnable ? "当前执行器未注册，请换一个已注册执行器。"
                    : "就在本任务的工作目录里立即开始；换执行器就是换一双眼睛来看同一份产物。"}
          </p>
          <div className="insp-inline-acts">
            <InspButton variant="quiet" size="sm" disabled={dispatching} onClick={() => setDispatchOpen(false)}>取消</InspButton>
            <InspButton variant="pri" size="sm" disabled={dispatching || !profilesReady || !executorRunnable} onClick={() => void dispatch()}>
              {dispatching ? "启动中…" : "开始验证"}
            </InspButton>
          </div>
        </section>
      )}

      <TaskReviewRounds
        taskId={task.id}
        state={review}
        emptyMessage={review.info?.reviewRequested ? "验证已启用，等待首轮结果。" : "任务完成后可自动验证，也可以在上面手动验一轮。"}
        onOpenTask={onOpenTask}
      />
    </div>
  );
}
