// 验收「推送到远程」这一档的编排：门禁之前先把远程同步进本地目标分支，合完再推上去。
// git 那几下在 git-accept-remote.ts，那边的文件头写着为什么是「先同步、再合、再推」。
//
// 只有用户明说要推（确认层那一勾、accept_task 的 push 参数）才推：推送是往外发，不从项目设置里推出来，
// 飞书卡片和工作流自己走到的验收都不推。
//
// 推送失败**不把验收改成失败**：合并已经落在本地目标分支上了，改口说「没验收」等于谎报另一头；
// 但要如实带回去（结果里的 push、时间线上那一行），手动推的命令给全。
import type { tasks, projects } from "./db/schema.js";
import { acceptPlan, type AcceptBy } from "@navi/shared/workflow-policy";
import { taskWorkflowDef } from "./workflows.js";
import { plannedMergeTarget } from "./task-branch-plan.js";
import { pushTargetBranch, resolvePushTarget, syncTargetWithRemote, type PushOutcome, type PushTarget } from "./git-accept-remote.js";
import { appendTaskTimeline, alertLine, receiptLine } from "./task-timeline.js";
import type { AcceptFailure } from "./task-accept-guard.js";
import { hasTaskBranchPrefix } from "@navi/shared/task-branch";

export type { PushOutcome } from "./git-accept-remote.js";
export type PushPlan = PushTarget & { branch: string };

type TaskRow = typeof tasks.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

/** 这一按推不了的原因（不提交、只打标签、没用独立 worktree…）；推得了返回 null。验收台那一勾读同一份判定。 */
export function pushUnavailable(task: TaskRow, project: ProjectRow, by: AcceptBy, commitOverride?: boolean): string | null {
  if (!task.useWorktree) return "这个任务没用独立 worktree，验收不合并，没有要推的提交";
  const plan = acceptPlan(taskWorkflowDef(task.workflow), by, task.workflowAt);
  if (!plan.merge) return "这条线上验收不合并，没有要推的提交";
  if (plan.merge === "tag") return "这条线上验收只打标签不合并，没有要推的提交";
  if ((commitOverride ?? project.acceptCommit !== false) === false) return "这次选了「合并后不提交」，没有要推的提交";
  return null;
}

/**
 * 推到哪（验收台那一勾显示的 `main → origin/main`）。没有远程、目标定不出来 → null。
 * 目标是另一个任务的分支（合进父任务那种）也是 null：那是 Navi 自己的中间分支，推上去只是在远程上留垃圾。
 */
export async function pushDestination(task: TaskRow, project: ProjectRow): Promise<PushPlan | null> {
  const branch = await plannedMergeTarget(task, project.repoPath);
  const target = branch && !hasTaskBranchPrefix(branch) ? await resolvePushTarget(project.repoPath, branch) : null;
  return branch && target ? { ...target, branch } : null;
}

/**
 * 门禁之前（仓库锁里）：推不了就当场拒（什么都没动），推得了就先把远程的新提交快进进本地目标分支。
 * 之后的门禁基准、合并冲突都按同步过的目标分支判 —— 远程的新改动跟任务撞上，照常交回任务去解。
 */
export async function preparePush(task: TaskRow, project: ProjectRow, by: AcceptBy, commitOverride?: boolean):
  Promise<{ plan: PushPlan; failure?: never } | { failure: AcceptFailure; plan?: never }> {
  const refuse = async (reason: string, error: string) => {
    await appendTaskTimeline(task.id, alertLine(`验收未执行：${error}`));
    return { failure: { accepted: false as const, httpStatus: 409 as const, taskId: task.id, reason, error, status: task.status } };
  };
  const unavailable = pushUnavailable(task, project, by, commitOverride);
  if (unavailable) return refuse("push_unavailable", `选了推送到远程，但${unavailable}。这次什么都没动；不推送就能照常验收。`);
  const plan = await pushDestination(task, project);
  if (!plan) return refuse("push_no_remote", "选了推送到远程，但目标分支找不到可以推的远程（仓库没配远程、上游是本地分支，或目标是另一个任务的分支）。这次什么都没动。");
  const sync = await syncTargetWithRemote(project.repoPath, plan.branch, plan);
  if (!sync.ok) return refuse(sync.reason, sync.message);
  if (sync.fastForwarded) {
    await appendTaskTimeline(task.id, receiptLine(
      `推送前先同步：${plan.remote}/${plan.remoteBranch} 有 ${sync.fastForwarded} 个新提交，已快进进本地 ${plan.branch}；这次验收按同步之后的 ${plan.branch} 合并。`));
  }
  return { plan };
}

/** 合完之后推上去，结果写进时间线。 */
export async function pushAfterMerge(taskId: string, repoPath: string, plan: PushPlan): Promise<PushOutcome> {
  const outcome = await pushTargetBranch(repoPath, plan.branch, plan);
  const remote = `${plan.remote}/${plan.remoteBranch}`;
  if (outcome.ok) {
    await appendTaskTimeline(taskId, receiptLine(outcome.upToDate
      ? `推送：${remote} 已经是 ${outcome.commit.slice(0, 8)}，不用再推。`
      : `已推送：${plan.branch} → ${remote}（${outcome.commit.slice(0, 8)}）。`));
    return outcome;
  }
  await appendTaskTimeline(taskId, alertLine(`合并已经落在本地 ${plan.branch}，但推送到 ${remote} 没成功：${outcome.message}。`
    + (outcome.reason === "push_rejected"
      ? `远程在这次验收期间又被推了新提交，没有强推；先 git -C ${repoPath} pull 把两边合好，再推。`
      : `处理好之后手动推：git -C ${repoPath} push ${plan.remote} ${plan.branch}:${plan.remoteBranch}`)));
  return outcome;
}
