// 验收确认框上「这一按会发生什么」那句话。网页的验收确认框和飞书的待验收卡共用这一份（im/attention.ts）：
// 两边各写一套，迟早一边说「放行」一边说「合并」（审查实测：飞书卡在中途关口上照样写「会合并并清理」）。
import type { TaskListItem } from "./index.ts";
import { STEP_LABELS } from "./workflow.ts";
import { acceptPlan, hasAcceptStation, isFinalHumanGate, nextAnchor } from "./workflow-policy.ts";

// 验收确认框上那句话：**全部读线上写的那一站**，不再写死「合并并删 worktree 和分支」。
// 这是不可逆动作的最后一道说明，它跟实际会发生的事哪怕差一点，用户按下去就会被闪。
// 口径与服务端一致：squash 和「只打标签」之后 git 不认为分支已合并，所以那两档即便
// 选了「删 worktree 和任务分支」，分支也会保留（绝不 -D），这里就照实说。
//
// 线上没画「合并并清理」时**手动验收照样合**（手按覆盖线上写没写，理由见 shared 的
// acceptPlan）——这时更要把话说全：既说清会发生什么，也说清这不是线上写的。这道确认
// 框就是那条规则的安全兜底，措辞含糊等于把兜底拆了。
// 口径与服务端一致：squash 和「只打标签」之后 git 不认为分支已合并，所以那两档即便
// 选了「删 worktree 和任务分支」，分支也会保留（绝不 -D），这里就照实说。**「合并后
// 不提交」同理**：那一档连提交都没落，分支是那份改动唯一的版本库副本，必然保留。
export function acceptanceMessage(task: TaskListItem, commit = true): string {
  const team = task.mode === "team";
  const duet = task.mode === "duet";
  // 后面还有站要走的那道「等我点头」：这一按只是放行，不合并、不清理，线接着往下走。措辞
  // 必须跟着变——拿「会合并会删分支」的话去描述一次放行，用户要么不敢按，要么按完发现什么
  // 都没合。**下一站是什么要指名道姓**：这道关口最常见的写法就是画在「自动验证」前面，
  // 用户按之前该看见「按完是去验证」，而不是笼统的「往下走」。
  if (!isFinalHumanGate(task.workflow, task.workflowAt)) {
    const next = nextAnchor(task.workflow, task.workflowAt);
    const where = next ? `后面还写着「${STEP_LABELS[next.kind]}」` : "这条线上后面还写着别的站";
    return `${where}，所以这一按只是放行这一关：不合并、不清理，这条线会接着往下走到那一站。`;
  }
  if (!task.useWorktree) {
    if (duet) return "这会确认当前讨论结论并标记为验收完成，不执行 Git 操作。";
    return team
      ? "这会确认共享项目工作区中的团队结果，并联动把全部共享执行者标为验收完成。"
      : "这会确认当前项目工作区中的结果并标记为验收完成。";
  }
  const plan = acceptPlan(task.workflow, "human", task.workflowAt);
  const branch = team ? "共享分支" : duet ? "讨论分支" : "任务分支";
  const worktree = team ? "团队 worktree" : duet ? "讨论 worktree" : "任务 worktree";
  const target = mergeTargetLabel(task);
  const tail = team ? "并联动验收共享执行者。" : "";
  // 手动验收永远有合并方案（acceptPlan 的 human 口径），这里只是类型兜底。
  if (!plan.merge) return `这会把该任务标记为验收完成。${tail}`;
  const offScript = task.workflowMode === "free"
    ? "自由工作流没有预设合并站，手动验收按默认规矩来："
    : !hasAcceptStation(task.workflow)
      ? "这条线上没画「合并并清理」，但手动验收按默认规矩来："
      : "";
  const merge = plan.merge === "tag"
    ? `不合并，只在${branch}头上打一个 ash-accepted 标签（${target} 一动不动）`
    : !commit
      ? `${branch}的改动将合进 ${target} 的工作区并暂存，但不提交（${target} 的提交历史一动不动，提交或丢弃由你自己决定）`
      : plan.merge === "squash"
        ? `${branch}将 squash 成一个提交合并回 ${target}`
        : `${branch}将合并回 ${target}`;
  const keepsBranch = plan.merge !== "safe" || !commit;
  const clean = plan.clean === "none"
    ? `，${worktree}与分支都保留`
    : plan.clean === "worktree" || keepsBranch
      ? `，随后清理 ${worktree}，分支保留${keepsBranch && plan.clean === "all" ? `（${commit ? "这一档 git 不认为它已合并" : "改动还没提交，分支是它唯一的副本"}，不强删）` : ""}`
      : `，随后清理 ${worktree} 与分支`;
  return `${offScript}${merge}${clean}。${tail}`;
}

export const mergeTargetLabel = (task: TaskListItem): string =>
  task.acceptedTargetBranch || task.mergeTargetBranch || task.worktreeBase || "未确定（验收时解析）";
