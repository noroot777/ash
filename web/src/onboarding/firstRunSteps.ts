import type { AgentExecutorProfile, LlmProvider, ProjectView } from "@ash/shared";

/**
 * 首启向导的三站,按**依赖顺序**排:供应商挂到执行器上,执行器在项目目录里干活。
 * 顺序反过来问,用户会在前一步就撞上「这里要填的东西下一步才有」。
 */
export const FIRST_RUN_STEPS = ["provider", "executor", "project"] as const;
export type FirstRunStep = (typeof FIRST_RUN_STEPS)[number];

export const STEP_LABEL: Record<FirstRunStep, string> = {
  provider: "供应商",
  executor: "执行器",
  project: "项目",
};

/**
 * 这一站算办完了吗。只决定导轨上那个勾,**不决定能不能往下走** —— 三站各有正当的
 * 跳过理由(用 CLI 自带账号 / 这台机器还没装 CLI / 项目回头再建),把它们做成硬门禁
 * 只会让人卡在向导里出不去。
 */
export function stepSettled(
  step: FirstRunStep,
  data: { providers: LlmProvider[]; profiles: AgentExecutorProfile[]; projects: ProjectView[] },
): boolean {
  if (step === "provider") return data.providers.length > 0;
  if (step === "executor") return data.profiles.length > 0;
  return data.projects.length > 0;
}
