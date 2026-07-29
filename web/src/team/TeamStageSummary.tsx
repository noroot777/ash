import { Fragment } from "react";
import { STAGE_LABELS, STAGE_ORDER, type Task, type TaskStage } from "@harness/shared";
import { displayStatusColor } from "../StatusIcon";

// ── 团队交付进度(时间轴那一行的右端) ────────────────────────────────────────
// 「执行者自己不再验证」那一轮把交付进度整块下线了,但要下线的只是**执行者(普通
// 任务)自己页面上那条进度条** —— 团队这一层的汇总是另一回事:它回答「这支队伍整体
// 走到哪了」,一眼看出还有人卡在验证、还是全都等着验收。所以这里只保留团队汇总。
//
// 三格:验证 → 待验收 → 完成。**每一格在正常流程里都会真的亮一次**,这是刻意的 ——
// 七个 stage 值不是七步:
//   • `implemented` 并进「验证」格:执行者早就不自报它了(阶段由审查者驱动),给它
//     单开一格等于让所有任务盯着一个永远灰着的点看,那是在暗示「这步卡住了」。
//   • `merged` 并进「完成」格:验收里合并成功到清理完成之间只隔几百毫秒,正常时根本
//     看不见它。它**只在出事时停住**(清理前有任务又跑起来、或 worktree 脏/分支删不
//     掉,见 server/src/task-accept.ts),所以按「完成格的异常态」处理:圆点照常亮,
//     右边文字改成「N 个已合并待清理」并标黄 —— 比给它一格更醒目,也不占正常流程。
const STEPS = [
  { key: "verification", label: "验证", stages: ["implemented", "verifying", "verified", "verify_failed"] },
  { key: "acceptance", label: "待验收", stages: ["awaiting_acceptance"] },
  { key: "complete", label: "完成", stages: ["merged", "accepted"] },
] as const satisfies readonly { key: string; label: string; stages: readonly TaskStage[] }[];

// 共享执行者(团队 worktree 里的那些)退出了人工验收:验证完就停,直到团队级验收把
// 它们联动成 accepted。历史数据里可能还留着 awaiting_acceptance/merged,统一按
// verified 显示 —— 否则会显示出一个它们根本不会走的验收步骤。
function sharedWorkerDisplayStage(stage?: TaskStage | null): TaskStage | null {
  if (stage === "awaiting_acceptance" || stage === "merged") return "verified";
  return stage ?? null;
}

function displayStageOf(worker: Task): TaskStage | null {
  return worker.useWorktree ? worker.stage ?? null : sharedWorkerDisplayStage(worker.stage);
}

function stepIndex(stage: TaskStage | null): number {
  if (!stage) return -1;
  return STEPS.findIndex((step) => (step.stages as readonly TaskStage[]).includes(stage));
}

// 整体 = 最慢的那个人:全员都上报过才给结论,任何一个验证失败就直接报失败。
function overallStage(stages: (TaskStage | null)[]): TaskStage | null {
  if (stages.includes("verify_failed")) return "verify_failed";
  if (stages.some((s) => !s)) return null;
  return (stages as TaskStage[]).reduce((slowest, stage) =>
    STAGE_ORDER.indexOf(stage) < STAGE_ORDER.indexOf(slowest) ? stage : slowest,
  );
}

function ProgressDots({ stage }: { stage: TaskStage | null }) {
  const current = stepIndex(stage);
  const failed = stage === "verify_failed";
  return (
    <div className="flex w-[86px] min-w-0 items-center" role="list" aria-label="团队交付进度">
      {STEPS.map((step, i) => {
        const done = current > i;
        const active = current === i;
        const color = done ? "#5e6ad2" : active ? displayStatusColor(stage!) : "#d8d8de";
        return (
          <Fragment key={step.key}>
            {i > 0 && (
              <span
                aria-hidden
                className="mx-1 h-px min-w-1 flex-1"
                style={{ backgroundColor: current >= i ? "#5e6ad2" : "#e7e7ea" }}
              />
            )}
            <span
              role="listitem"
              title={`${step.label}${active && stage ? ` · ${STAGE_LABELS[stage]}` : ""}`}
              className="block h-[7px] w-2 shrink-0"
            >
              <span
                aria-hidden
                className="block h-[7px] w-[7px] rounded-full"
                style={{
                  backgroundColor: color,
                  boxShadow: active ? `0 0 0 ${failed ? 2 : 3}px ${color}1f` : undefined,
                }}
              />
            </span>
          </Fragment>
        );
      })}
    </div>
  );
}

export function TeamStageSummary({ workers }: { workers: Task[] }) {
  // 只统计「该有阶段」的执行者:跑在共享目录里没开 worktree、也从没上报过的,算不
  // 进交付进度(否则一个纯打杂的执行者会把整队永远压在「尚未上报」)。
  const tracked = workers.filter((w) => w.stage || w.useWorktree);
  if (!tracked.length) return null;

  const stages = tracked.map(displayStageOf);
  const overall = overallStage(stages);
  const failed = stages.filter((s) => s === "verify_failed").length;
  const stuckMerged = stages.filter((s) => s === "merged").length;
  const unreported = stages.filter((s) => !s).length;
  const alerts = [
    failed ? `${failed} 个验证失败` : null,
    // 合并完成但清理没做完:这是唯一会让 stage 停在 merged 的情形,值得单独喊一声。
    stuckMerged ? `${stuckMerged} 个已合并待清理` : null,
    unreported ? `${unreported} 个尚未上报阶段` : null,
  ].filter(Boolean);
  const summary = alerts.length ? alerts.join(" · ") : `整体按最慢执行者：${STAGE_LABELS[overall!]}`;
  const tone = failed ? "font-semibold text-red-600" : stuckMerged ? "text-amber-600" : "text-faint";

  return (
    <div className="ml-auto flex min-w-0 items-center gap-2 text-[10.5px]">
      <ProgressDots stage={overall} />
      <span className={`whitespace-nowrap ${tone}`} title={summary}>
        {summary}
      </span>
    </div>
  );
}
