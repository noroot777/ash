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

export interface FirstRunData {
  providers: LlmProvider[];
  profiles: AgentExecutorProfile[];
  projects: ProjectView[];
}

/**
 * 这一站还差什么 —— 一句话,`null` = 齐了。
 *
 * 导轨上的勾和最后那行「还差什么」共用这一份判据,**不决定能不能往下走**:三站各有
 * 正当的跳过理由(用 CLI 自带账号 / 这台机器还没装 CLI / 项目回头再建),做成硬门禁
 * 只会让人卡在向导里出不去。
 *
 * 执行器这一站的判据是**派得动**,不是「注册过」。隔离档的多人实例里,宿主机的 CLI
 * 订阅被抹掉了,没接 relay 的 CLI 和没挂供应商的执行器注册完照样跑不起来 —— 给它打
 * 个勾等于当面说谎,用户要到真正派任务时才知道(第 1 轮审查实测注册 gemini 的那条)。
 * 判据直接用服务端现算的 `dispatchBlocked`,不在前端另抄一份 CLI 黑名单。
 */
export function stepGap(step: FirstRunStep, data: FirstRunData): string | null {
  if (step === "provider") return data.providers.length ? null : "供应商还空着";
  if (step === "executor") {
    if (!data.profiles.length) return "执行器还空着";
    return data.profiles.some((profile) => !profile.dispatchBlocked)
      ? null
      : "注册的执行器都还派不了任务";
  }
  return data.projects.length ? null : "项目还空着";
}

export function stepSettled(step: FirstRunStep, data: FirstRunData): boolean {
  return stepGap(step, data) === null;
}
