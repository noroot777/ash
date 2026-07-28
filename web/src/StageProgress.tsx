import { Fragment } from "react";
import {
  STAGE_LABELS,
  STAGE_ORDER,
  type Task,
  type TaskStage,
} from "@harness/shared";
import { displayStatusColor } from "./StatusIcon";
import { sharedWorkerDisplayStage, sharedWorkerStageLabel } from "./taskPolicy";

type DeliveryStep = {
  key: string;
  label: string;
  stages: readonly TaskStage[];
};

const FULL_DELIVERY_STEPS = [
  { key: "implementation", label: "实现", stages: ["implemented"] },
  { key: "verification", label: "验证", stages: ["verifying", "verified", "verify_failed"] },
  { key: "acceptance", label: "待验收", stages: ["awaiting_acceptance"] },
  { key: "merge", label: "合并", stages: ["merged"] },
  { key: "complete", label: "完成", stages: ["accepted"] },
] as const satisfies readonly DeliveryStep[];

const SHARED_WORKER_STEPS = [
  { key: "implementation", label: "实现", stages: ["implemented"] },
  { key: "verification", label: "验证", stages: ["verifying", "verified", "verify_failed"] },
  { key: "complete", label: "完成", stages: ["accepted"] },
] as const satisfies readonly DeliveryStep[];

function deliveryStepIndex(stage: TaskStage | null | undefined, steps: readonly DeliveryStep[]): number {
  if (!stage) return -1;
  return steps.findIndex((step) => (step.stages as readonly TaskStage[]).includes(stage));
}

function stageRank(stage: TaskStage): number {
  return STAGE_ORDER.indexOf(stage);
}

function currentColor(stage?: TaskStage | null): string {
  return stage ? displayStatusColor(stage) : "#d8d8de";
}

function ProgressTrack({
  stage,
  compact = false,
  sharedWorker = false,
}: {
  stage?: TaskStage | null;
  compact?: boolean;
  sharedWorker?: boolean;
}) {
  const displayStage = sharedWorker ? sharedWorkerDisplayStage(stage) : stage;
  const steps: readonly DeliveryStep[] = sharedWorker ? SHARED_WORKER_STEPS : FULL_DELIVERY_STEPS;
  const current = deliveryStepIndex(displayStage, steps);
  const failed = displayStage === "verify_failed";
  const stageLabel = sharedWorker ? sharedWorkerStageLabel(stage) : displayStage ? STAGE_LABELS[displayStage] : null;

  return (
    <div
      className={`flex min-w-0 items-start ${compact ? "w-[116px]" : "w-full"}`}
      role="list"
      aria-label={stageLabel ? `当前阶段：${stageLabel}` : "阶段尚未上报"}
    >
      {steps.map((step, index) => {
        const complete = current > index;
        const active = current === index;
        const stepFailed = active && failed;
        const dotColor = complete ? "#5e6ad2" : active ? currentColor(displayStage) : "#d8d8de";
        const labelColor = stepFailed ? "#eb5757" : active ? dotColor : undefined;
        return (
          <Fragment key={step.key}>
            {index > 0 && (
              <span
                aria-hidden
                className={`mt-[3px] h-px min-w-1 flex-1 ${compact ? "mx-1" : "mx-2"}`}
                style={{ backgroundColor: current >= index ? "#5e6ad2" : "#e7e7ea" }}
              />
            )}
            <span
              role="listitem"
              title={`${step.label}${active && stageLabel ? ` · ${stageLabel}` : ""}`}
              className={`flex shrink-0 flex-col items-center ${compact ? "w-2" : "w-12"}`}
            >
              <span
                aria-hidden
                className="block h-[7px] w-[7px] rounded-full"
                style={{
                  backgroundColor: dotColor,
                  boxShadow: active
                    ? `0 0 0 3px ${dotColor}1f`
                    : stepFailed
                      ? `0 0 0 2px ${dotColor}1f`
                      : undefined,
                }}
              />
              {!compact && (
                <span
                  className={`mt-1 whitespace-nowrap text-[10.5px] ${active ? "font-semibold" : "text-faint"}`}
                  style={labelColor ? { color: labelColor } : undefined}
                >
                  {stepFailed ? "验证失败" : step.label}
                </span>
              )}
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}

export function StageProgress({ task, sharedWorker = false }: { task: Task; sharedWorker?: boolean }) {
  if (!task.stage && !task.useWorktree) return null;
  const failed = task.stage === "verify_failed";
  const stageLabel = sharedWorker ? sharedWorkerStageLabel(task.stage) : task.stage ? STAGE_LABELS[task.stage] : null;
  return (
    <section className="mt-3 rounded-lg border border-line bg-canvas/70 px-3 py-2.5" aria-label="交付进度">
      <div className="mb-2 flex items-center gap-2 text-[11.5px]">
        <span className="font-semibold text-muted">交付进度</span>
        <span className={`ml-auto ${failed ? "font-semibold text-red-600" : "text-faint"}`}>
          {stageLabel ?? "阶段尚未上报"}
        </span>
      </div>
      <ProgressTrack stage={task.stage} sharedWorker={sharedWorker} />
    </section>
  );
}

function overallStage(tasks: Task[]): TaskStage | null {
  const reported = tasks.flatMap((task) => {
    const stage = task.useWorktree ? task.stage : sharedWorkerDisplayStage(task.stage);
    return stage ? [stage] : [];
  });
  if (reported.includes("verify_failed")) return "verify_failed";
  if (reported.length !== tasks.length) return null;
  return reported.reduce((earliest, stage) => (stageRank(stage) < stageRank(earliest) ? stage : earliest));
}

export function TeamStageSummary({ workers }: { workers: Task[] }) {
  const tracked = workers.filter((worker) => worker.stage || worker.useWorktree);
  if (!tracked.length) return null;

  const overall = overallStage(tracked);
  const displayStages = tracked.map((worker) =>
    worker.useWorktree ? worker.stage : sharedWorkerDisplayStage(worker.stage),
  );
  const unreported = displayStages.filter((stage) => !stage).length;
  const failed = displayStages.filter((stage) => stage === "verify_failed").length;
  const alerts = [
    failed ? `${failed} 个验证失败` : null,
    unreported ? `${unreported} 个尚未上报阶段` : null,
  ].filter(Boolean);
  const summary = alerts.length > 0
    ? alerts.join(" · ")
    : `整体按最慢执行者：${STAGE_LABELS[overall!]}`;

  return (
    <div className="ml-auto flex min-w-0 items-center gap-2 text-[10.5px]" aria-label="团队交付进度">
      <ProgressTrack stage={overall} compact />
      <span
        className={`whitespace-nowrap ${failed ? "font-semibold text-red-600" : "text-faint"}`}
        title={summary}
      >
        {summary}
      </span>
    </div>
  );
}
