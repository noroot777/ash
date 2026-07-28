import { Fragment } from "react";
import {
  STAGE_LABELS,
  STAGE_ORDER,
  type Task,
  type TaskStage,
} from "@harness/shared";
import { displayStatusColor } from "./StatusIcon";

const DELIVERY_STEPS = [
  { key: "implementation", label: "实现", stages: ["implemented"] },
  { key: "verification", label: "验证", stages: ["verifying", "verified", "verify_failed"] },
  { key: "acceptance", label: "待验收", stages: ["awaiting_acceptance"] },
  { key: "merge", label: "合并", stages: ["merged"] },
  { key: "complete", label: "完成", stages: ["accepted"] },
] as const satisfies readonly {
  key: string;
  label: string;
  stages: readonly TaskStage[];
}[];

function deliveryStepIndex(stage?: TaskStage | null): number {
  if (!stage) return -1;
  return DELIVERY_STEPS.findIndex((step) => (step.stages as readonly TaskStage[]).includes(stage));
}

function stageRank(stage: TaskStage): number {
  return STAGE_ORDER.indexOf(stage);
}

function currentColor(stage?: TaskStage | null): string {
  return stage ? displayStatusColor(stage) : "#d8d8de";
}

function ProgressTrack({ stage, compact = false }: { stage?: TaskStage | null; compact?: boolean }) {
  const current = deliveryStepIndex(stage);
  const failed = stage === "verify_failed";

  return (
    <div
      className={`flex min-w-0 items-start ${compact ? "w-[116px]" : "w-full"}`}
      role="list"
      aria-label={stage ? `当前阶段：${STAGE_LABELS[stage]}` : "阶段尚未上报"}
    >
      {DELIVERY_STEPS.map((step, index) => {
        const complete = current > index;
        const active = current === index;
        const stepFailed = active && failed;
        const dotColor = complete ? "#5e6ad2" : active ? currentColor(stage) : "#d8d8de";
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
              title={`${step.label}${active && stage ? ` · ${STAGE_LABELS[stage]}` : ""}`}
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

export function StageProgress({ task }: { task: Task }) {
  if (!task.stage && !task.useWorktree) return null;
  const failed = task.stage === "verify_failed";
  return (
    <section className="mt-3 rounded-lg border border-line bg-canvas/70 px-3 py-2.5" aria-label="交付进度">
      <div className="mb-2 flex items-center gap-2 text-[11.5px]">
        <span className="font-semibold text-muted">交付进度</span>
        <span className={`ml-auto ${failed ? "font-semibold text-red-600" : "text-faint"}`}>
          {task.stage ? STAGE_LABELS[task.stage] : "阶段尚未上报"}
        </span>
      </div>
      <ProgressTrack stage={task.stage} />
    </section>
  );
}

function overallStage(tasks: Task[]): TaskStage | null {
  const reported = tasks.flatMap((task) => (task.stage ? [task.stage] : []));
  if (reported.includes("verify_failed")) return "verify_failed";
  if (reported.length !== tasks.length) return null;
  return reported.reduce((earliest, stage) => (stageRank(stage) < stageRank(earliest) ? stage : earliest));
}

export function TeamStageProgress({ workers }: { workers: Task[] }) {
  const tracked = workers
    .map((worker, index) => ({ worker, index }))
    .filter(({ worker }) => worker.stage || worker.useWorktree);
  if (!tracked.length) return null;

  const trackedTasks = tracked.map(({ worker }) => worker);
  const overall = overallStage(trackedTasks);
  const unreported = trackedTasks.filter((worker) => !worker.stage).length;
  const failed = trackedTasks.filter((worker) => worker.stage === "verify_failed").length;
  const summary = failed
    ? `${failed} 个验证失败`
    : unreported
      ? `${unreported} 个尚未上报阶段`
      : `整体按最慢执行者：${STAGE_LABELS[overall!]}`;

  return (
    <section className="mt-3 rounded-lg border border-line bg-canvas/70 px-3 py-2.5" aria-label="团队交付进度">
      <div className="mb-2 flex items-center gap-2 text-[11.5px]">
        <span className="font-semibold text-muted">团队交付进度</span>
        <span className={`ml-auto ${failed ? "font-semibold text-red-600" : "text-faint"}`}>{summary}</span>
      </div>
      <ProgressTrack stage={overall} />
      <div className="mt-2.5 grid grid-cols-2 gap-x-5 gap-y-1.5 border-t border-line pt-2">
        {tracked.map(({ worker, index }) => (
          <div key={worker.id} className="flex min-w-0 items-center gap-2" title={worker.title}>
            <span className="w-4 shrink-0 text-right font-mono text-[9.5px] text-faint">{index + 1}</span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-muted">{worker.title}</span>
            <ProgressTrack stage={worker.stage} compact />
            <span
              className={`w-[66px] shrink-0 truncate text-right text-[10px] ${worker.stage === "verify_failed" ? "font-medium text-red-600" : "text-faint"}`}
            >
              {worker.stage ? STAGE_LABELS[worker.stage] : "待上报"}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
