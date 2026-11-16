import type { BranchPlanEntry, TaskListItem } from "@ash/shared";

/**
 * 这一按**真正合到哪**。验收台上凡是说到「合入目标」的地方（确认层的步骤、和顶行走向的一致性核对、
 * 换目标菜单里的「当前」）都从这里取，不各自拼字段 —— 各拼各的，优先级一错就会出现顶行与 diff 按
 * other 算、确认层却写着 main 还放行（第 5 轮审查）。
 *
 * 首选服务端分支计划给的目标：它和验收走同一个口径（plannedMergeTarget：上次验收失败时冻结的目标优先，
 * 配置为空时按项目当前检出解析）。计划还没读到时退回任务字段，优先级同 shared 的 mergeTargetLabel；
 * 都没有就是 null（还没确定）。
 */
export function acceptTargetOf(task: TaskListItem, planned: BranchPlanEntry | null | undefined): string | null {
  return planned?.targetBranch || task.acceptedTargetBranch || task.mergeTargetBranch || task.worktreeBase || null;
}

/** 顶行走向兜底显示的目标：diff 读回来的那一个优先（改动就是按它算的）。 */
export function routeTargetOf(task: TaskListItem, diffTarget: string | null | undefined): string {
  return diffTarget || task.acceptedTargetBranch || task.mergeTargetBranch || task.worktreeBase || "验收时确定";
}

/** 分支名比对时去掉 `refs/heads/` 前缀（服务端解析合入目标时同样这么归一）。 */
export const sameBranch = (a: string, b: string) => branchName(a) === branchName(b);
const branchName = (name: string) => name.trim().replace(/^refs\/heads\//, "");
