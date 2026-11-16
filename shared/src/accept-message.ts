// 「这一按会发生什么」：网页验收台确认层的步骤清单、和飞书待验收卡上那句话（im/attention.ts）
// 都从这里推出来。两边各写一套，迟早一边说「放行」一边说「合并」（审查实测：飞书卡在中途关口
// 上照样写「会合并并清理」）。所以事实只算一次（acceptanceSteps），话由它拼（acceptanceMessage）。
import type { TaskListItem } from "./index.ts";
import { STEP_LABELS } from "./workflow.ts";
import type { AcceptClean, AcceptStrategy } from "./workflow.ts";
import { acceptPlan, hasAcceptStation, isFinalHumanGate, nextAnchor } from "./workflow-policy.ts";

/**
 * 这一按的事实。**全部读线上写的那一站**，不再写死「合并并删 worktree 和分支」：这是不可逆
 * 动作的最后一道说明，它跟实际会发生的事哪怕差一点，用户按下去就会被闪。
 *
 * 口径与服务端一致：squash 和「只打标签」之后 git 不认为分支已合并，所以那两档即便选了
 * 「删 worktree 和任务分支」，分支也会保留（绝不 -D）；「合并后不提交」同理 —— 那一档连提交
 * 都没落，分支是那份改动唯一的版本库副本，必然保留。
 *
 * 线上没画「合并并清理」时**手动验收照样合**（手按覆盖线上写没写，理由见 acceptPlan），
 * `offScript` 记下这一点，好让说明把话说全。
 */
export type AcceptanceSteps =
  /** 后面还有站要走的那道「等我点头」：只是放行，不合并、不清理。next = 下一站的名字。 */
  | { kind: "release"; next: string | null }
  /** 不走 Git：在项目目录里干活的任务（或线上写了「不合并」）只标记验收完成。 */
  | { kind: "mark"; scope: "single" | "team" | "duet" | "plain"; team: boolean }
  | {
      kind: "merge";
      scope: "single" | "team" | "duet";
      merge: AcceptStrategy;
      /** 这一次落不落提交（tag 那一档恒为 true：它不产生合并提交）。 */
      commit: boolean;
      target: string;
      clean: AcceptClean;
      /** 清理时任务分支是否保留，以及为什么。 */
      keepsBranch: boolean;
      offScript: "free" | "unscripted" | null;
      team: boolean;
    };

export function acceptanceSteps(task: TaskListItem, commit = true): AcceptanceSteps {
  const team = task.mode === "team";
  const duet = task.mode === "duet";
  // 中途那道关口：拿「会合并会删分支」的话去描述一次放行，用户要么不敢按，要么按完发现什么
  // 都没合。下一站是什么要指名道姓（最常见的写法就是画在「自动验证」前面）。
  if (!isFinalHumanGate(task.workflow, task.workflowAt)) {
    const next = nextAnchor(task.workflow, task.workflowAt);
    return { kind: "release", next: next ? STEP_LABELS[next.kind] : null };
  }
  const scope = team ? "team" : duet ? "duet" : "single";
  if (!task.useWorktree) return { kind: "mark", scope, team };
  const plan = acceptPlan(task.workflow, "human", task.workflowAt);
  // 手动验收永远有合并方案（acceptPlan 的 human 口径），这里只是类型兜底。
  if (!plan.merge) return { kind: "mark", scope: "plain", team };
  const committed = plan.merge === "tag" ? true : commit;
  return {
    kind: "merge",
    scope,
    merge: plan.merge,
    commit: committed,
    target: mergeTargetLabel(task),
    clean: plan.clean,
    keepsBranch: plan.merge !== "safe" || !committed,
    offScript: task.workflowMode === "free" ? "free" : !hasAcceptStation(task.workflow) ? "unscripted" : null,
    team,
  };
}

export function acceptanceMessage(task: TaskListItem, commit = true): string {
  const steps = acceptanceSteps(task, commit);
  if (steps.kind === "release") {
    const where = steps.next ? `后面还写着「${steps.next}」` : "这条线上后面还写着别的站";
    return `${where}，所以这一按只是放行这一关：不合并、不清理，这条线会接着往下走到那一站。`;
  }
  const tail = steps.team ? "并联动验收共享执行者。" : "";
  if (steps.kind === "mark") {
    if (steps.scope === "plain") return `这会把该任务标记为验收完成。${tail}`;
    if (steps.scope === "duet") return "这会确认当前讨论结论并标记为验收完成，不执行 Git 操作。";
    return steps.scope === "team"
      ? "这会确认共享项目工作区中的团队结果，并联动把全部共享执行者标为验收完成。"
      : "这会确认当前项目工作区中的结果并标记为验收完成。";
  }
  const branch = steps.scope === "team" ? "共享分支" : steps.scope === "duet" ? "讨论分支" : "任务分支";
  const worktree = steps.scope === "team" ? "团队 worktree" : steps.scope === "duet" ? "讨论 worktree" : "任务 worktree";
  const target = steps.target;
  const offScript = steps.offScript === "free"
    ? "自由工作流没有预设合并站，手动验收按默认规矩来："
    : steps.offScript === "unscripted" ? "这条线上没画「合并并清理」，但手动验收按默认规矩来：" : "";
  const merge = steps.merge === "tag"
    ? `不合并，只在${branch}头上打一个 ash-accepted 标签（${target} 一动不动）`
    : !steps.commit
      ? `${branch}的改动将合进 ${target} 的工作区并暂存，但不提交（${target} 的提交历史一动不动，提交或丢弃由你自己决定）`
      : steps.merge === "squash"
        ? `${branch}将 squash 成一个提交合并回 ${target}`
        : `${branch}将合并回 ${target}`;
  const keepsBranch = steps.merge !== "safe" || !commit;
  const clean = steps.clean === "none"
    ? `，${worktree}与分支都保留`
    : steps.clean === "worktree" || keepsBranch
      ? `，随后清理 ${worktree}，分支保留${keepsBranch && steps.clean === "all" ? `（${commit ? "这一档 git 不认为它已合并" : "改动还没提交，分支是它唯一的副本"}，不强删）` : ""}`
      : `，随后清理 ${worktree} 与分支`;
  return `${offScript}${merge}${clean}。${tail}`;
}

export const mergeTargetLabel = (task: TaskListItem): string =>
  task.acceptedTargetBranch || task.mergeTargetBranch || task.worktreeBase || "未确定（验收时解析）";
