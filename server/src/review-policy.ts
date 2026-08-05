// 审查链的**判定**部分：要不要自动派审、最多几轮、这一轮的结论该怎么处置、这一轮
// 用谁去验。全是纯函数（除了 withVerifyExecutor 只读一份快照），所以回归测试可以直接
// 喂输入断言输出，不用起数据库。
//
// 跟 review.ts 分开是因为它们是两件事：这里回答「该不该、几轮、找谁」，那边负责
// 建审查任务、写证据、打回原任务。判定这一侧现在要读任务身上那条线，再挤在一个文件里
// 会把一份七百行的文件推得更长。
import type { ReviewDispatchInput, TaskStatus } from "@harness/shared";
import type { WorkflowDef } from "@harness/shared/workflow";
import {
  LEGACY_AUTO_REVIEW_ROUNDS, workflowPolicy, type WorkflowPolicy,
} from "@harness/shared/workflow-policy";
import type { tasks } from "./db/schema.js";
import { taskWorkflowDef } from "./workflows.js";

type TaskRow = typeof tasks.$inferSelect;
export type Settlement = "canceled" | "paused" | "done" | "failed";

/** 老任务（身上没有线）的自动复审上限。新任务的轮数写在它自己那条线上。 */
export const MAX_AUTO_REVIEW_ROUNDS = LEGACY_AUTO_REVIEW_ROUNDS;

// 这条线要不要自动验、最多验几轮 —— 身上没线的老任务原样走老规矩。
//
// 两条口径分开写，免得以后有人把它们合成一句「有线就听线的」：
// ① 单飞任务：线上有「自动验证」这一站就自动派审。这正是编排的意义。
// ② 团队执行者：多一道闸——团队那边没要求审查时，不能因为默认起手式里带了验证站
//    就凭空给每个执行者冒出一个审查任务。团队的 review 开关仍是那一层的主开关。
export function reviewPlan(input: {
  parentIsTeam: boolean;
  reviewRequested: boolean;
  workflow?: WorkflowDef | null;
}): { auto: boolean; maxRounds: number; policy: WorkflowPolicy | null } {
  const policy = workflowPolicy(input.workflow);
  if (!policy || !policy.verify) {
    return {
      auto: !policy && input.parentIsTeam && input.reviewRequested,
      maxRounds: LEGACY_AUTO_REVIEW_ROUNDS,
      policy,
    };
  }
  return {
    auto: input.parentIsTeam ? input.reviewRequested : true,
    maxRounds: policy.verifyRounds,
    policy,
  };
}

export function shouldAutoDispatchReview(input: {
  confirmedDone: boolean;
  status: TaskStatus;
  parentIsTeam: boolean;
  mode: string;
  reviewOf: string | null;
  reviewRequested: boolean;
  stage: string | null;
  existingRounds: number;
  workflow?: WorkflowDef | null;
}): boolean {
  if (!input.confirmedDone || input.status !== "done") return false;
  if (input.mode === "team" || input.reviewOf) return false;
  const plan = reviewPlan(input);
  if (!plan.auto) return false;
  if (input.existingRounds === 0) return true;
  return input.stage === "verify_failed" && input.existingRounds < plan.maxRounds;
}

export type ReviewOutcomeAction = "verified" | "repair" | "stop" | "failed" | "invalid";

export function reviewOutcomeAction(input: {
  reviewStatus: Settlement;
  conclusion: string | null;
  reviewRequested: boolean;
  round: number;
  parentIsTeam?: boolean;
  workflow?: WorkflowDef | null;
}): ReviewOutcomeAction {
  if (input.reviewStatus === "failed" || input.reviewStatus === "canceled") return "failed";
  if (input.reviewStatus !== "done") return "invalid";
  if (input.conclusion === "verified") return "verified";
  if (input.conclusion !== "verify_failed") return "invalid";
  const plan = reviewPlan({
    parentIsTeam: input.parentIsTeam ?? true,
    reviewRequested: input.reviewRequested,
    workflow: input.workflow,
  });
  // 跑满这条线写的轮数就是自动链的终点。再往后的轮次只可能是人手动派的，所以它可以
  // 再交回去修一次，而不是又悄悄排一轮复审。
  // 线上写「没过就停下等人 / 问我一句」时 maxRounds = 1，于是第一轮没过就停 —— 用户
  // 在编排里选的就是这个。
  return plan.auto && input.round === plan.maxRounds ? "stop" : "repair";
}

// 「用哪个模型验」这件事写在线上的「自动验证」那一站里，派审时拿它当默认执行器。
// 用户在界面上手点「再审一轮」并且指定了执行器时，以手点的为准 —— 那是此刻的意思。
export function withVerifyExecutor(target: TaskRow, override: ReviewDispatchInput): ReviewDispatchInput {
  const verify = workflowPolicy(taskWorkflowDef(target.workflow))?.verify;
  if (!verify) return override;
  if (override.executorId || override.agentType) return override;
  return {
    ...override,
    executorId: override.executorId ?? verify.p.executorId,
    model: override.model ?? verify.p.model,
    reasoningEffort: override.reasoningEffort ?? verify.p.reasoningEffort,
  };
}
