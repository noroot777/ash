// 验收「推送到远程」这一档的编排：门禁之前先把远程同步进本地目标分支，合完先推、推上去了才算合完。
// git 那几下在 git-accept-remote.ts / git-guarded-move.ts，那边的文件头写着为什么是「先同步、再合、再推」。
//
// 只有用户明说要推（确认层那一勾、accept_task 的 push 参数）才推：推送是往外发，不从项目设置里推出来，
// 飞书卡片和工作流自己走到的验收都不推。确认层发来的是**它显示的那个目的地**（含推送地址），执行时
// 解析出来的不是同一处就拒 —— `push:true` 只说明用户同意推，不说明他同意推到执行那一刻算出来的任何地方。
// 门禁续做带的也是第一次解析时冻结下来的那一份。
//
// 顺序是「先推、后落本地」（git-accept-detached.ts 文件头）：合并结果在 Navi 自己的临时检出里生成，推的就是
// 那个提交；远程收下了才把本地目标分支快进过去。所以推不上去时本地一个字节都没动、不落 merged、不清理，
// 没有「退回去」这一步；推上去了、本地却快进不了（期间被挪了、检出里的改动会被覆盖）照样算验收完成 ——
// 远程那份就是这次合并，本地只是落后，回执里写明让用户 pull 一下（`localBehind`）。
//
// 远程在这期间被别人推了新提交：同步进来之后**从头重新验收**（`push_remote_moved`，acceptTask 在同一把仓库锁里
// 重来），不在这里拿原来那份合并参数再合一次（审查第 2 轮 F2）：目标分支变了，门禁测过的那棵树、预演的基准都
// 不作数了 —— 重来那一遍按同步之后的目标重新预演，撞了冲突照常交回任务去解，门禁基准变了就重跑门禁（带着这份
// 冻结的目的地，跑完自动接着验收并推送），都没有就直接合、再推。
import type { tasks, projects } from "./db/schema.js";
import { acceptPlan, type AcceptBy } from "@navi/shared/workflow-policy";
import type { AcceptPushDestination } from "@navi/shared/accept-gate";
import { taskWorkflowDef } from "./workflows.js";
import { plannedMergeTarget } from "./task-branch-plan.js";
import type { AcceptStrategy } from "@navi/shared/workflow";
import { fetchTip, pushCommit, resolvePushTarget, samePushTarget, syncTargetWithRemote, type PushOutcome } from "./git-accept-remote.js";
import { commitOf, isAncestor, type TaskMergeFailureReason, type TaskMergeOptions, type TaskMergeResult } from "./git-accept.js";
import { landDetached, mergeDetached } from "./git-accept-detached.js";
import { expandHome } from "./git.js";
import { withRepoLock } from "./repo-lock.js";
import { assertNotPreviewInstance } from "./preview-instance.js";
import { appendTaskTimeline, alertLine, receiptLine } from "./task-timeline.js";
import type { AcceptFailure } from "./task-accept-guard.js";
import { hasTaskBranchPrefix } from "@navi/shared/task-branch";

export type { PushOutcome } from "./git-accept-remote.js";
export type PushPlan = AcceptPushDestination;

type TaskRow = typeof tasks.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

/** 推送时远程又被推了新提交：从头重来最多几轮。 */
const MAX_PUSH_ROUNDS = 3;

/** 这一按的推送选择：解析过就换成冻结的目的地，从头重来的那一遍沿用它，不再按那一刻重新解析。 */
export type PushChoice = { choice: boolean | PushPlan };

/** acceptTask 在仓库锁里调：`push_remote_moved` 就带着同一份推送选择从头再验一遍，连着几轮都这样才停。 */
export async function untilRemoteSettles<R extends { accepted: boolean; reason?: string; error?: string }>(taskId: string,
  choice: PushChoice["choice"], once: (push: PushChoice) => Promise<R>): Promise<R> {
  const push: PushChoice = { choice };
  for (let round = 1; ; round++) {
    const result = await once(push);
    if (result.accepted || result.reason !== "push_remote_moved") return result;
    if (round < MAX_PUSH_ROUNDS) continue;
    const error = `${result.error}；已经从头重来了 ${round} 次，远程一直在动，这次先停下。任务的分支和工作区都留着，过一会儿再验收。`;
    await appendTaskTimeline(taskId, alertLine(`验收未完成：${error}`));
    return { ...result, error };
  }
}

const where = (plan: PushPlan) => `${plan.branch} → ${plan.remote}/${plan.remoteBranch}（${plan.url}）`;

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
 * 推到哪（验收台那一勾显示的 `main → origin/main`）。没有远程、配了多个推送地址、目标定不出来 → null。
 * 目标是另一个任务的分支（合进父任务那种）也是 null：那是 Navi 自己的中间分支，推上去只是在远程上留垃圾。
 */
export async function pushDestination(task: TaskRow, project: ProjectRow): Promise<PushPlan | null> {
  const branch = await plannedMergeTarget(task, project.repoPath);
  const target = branch && !hasTaskBranchPrefix(branch) ? await resolvePushTarget(project.repoPath, branch) : null;
  return branch && target ? { ...target, branch } : null;
}

/**
 * 门禁之前（仓库锁里）：推不了、目的地跟确认的不是同一处就当场拒（什么都没动），推得了就先把远程的
 * 新提交快进进本地目标分支。之后的门禁基准、合并冲突都按同步过的目标分支判。
 * `confirmed`：调用方确认过的目的地（确认层、门禁续做）；`true` = 调用方只说了「推」（accept_task）。
 */
export async function preparePush(task: TaskRow, project: ProjectRow, by: AcceptBy, commitOverride: boolean | undefined,
  confirmed: PushPlan | true): Promise<{ plan: PushPlan; failure?: never } | { failure: AcceptFailure; plan?: never }> {
  const refuse = async (reason: string, error: string) => {
    await appendTaskTimeline(task.id, alertLine(`验收未执行：${error}`));
    return { failure: { accepted: false as const, httpStatus: 409 as const, taskId: task.id, reason, error, status: task.status } };
  };
  const unavailable = pushUnavailable(task, project, by, commitOverride);
  if (unavailable) return refuse("push_unavailable", `选了推送到远程，但${unavailable}。这次什么都没动；不推送就能照常验收。`);
  const plan = await pushDestination(task, project);
  if (!plan) {
    return refuse("push_no_remote", "选了推送到远程，但目标分支找不到可以推的远程（仓库没配远程、上游是本地分支、"
      + "配了多个推送地址，或目标是另一个任务的分支）。这次什么都没动。");
  }
  if (confirmed !== true && !samePushTarget(confirmed, plan)) {
    return refuse("push_destination_changed", `推送的目的地变了：确认时是 ${where(confirmed)}，现在是 ${where(plan)}。`
      + "这次什么都没动；重新打开确认看一眼再验收。");
  }
  const sync = await syncTargetWithRemote(project.repoPath, plan.branch, plan, project.id);
  if (!sync.ok) return refuse(sync.reason, sync.message);
  if (sync.warning) await appendTaskTimeline(task.id, alertLine(sync.warning));
  if (sync.fastForwarded) {
    await appendTaskTimeline(task.id, receiptLine(
      `推送前先同步：${plan.remote}/${plan.remoteBranch} 有 ${sync.fastForwarded} 个新提交，已快进进本地 ${plan.branch}；这次验收按同步之后的 ${plan.branch} 合并。`));
  }
  return { plan };
}

async function pushed(taskId: string, plan: PushPlan, outcome: Extract<PushOutcome, { ok: true }>) {
  await appendTaskTimeline(taskId, receiptLine(outcome.upToDate
    ? `推送：${plan.remote}/${plan.remoteBranch} 已经是 ${outcome.commit.slice(0, 8)}，不用再推。`
    : `已推送：${plan.branch} → ${plan.remote}/${plan.remoteBranch}（${outcome.commit.slice(0, 8)}）。`));
}

type DetachedArgs = { target: string; strategy: AcceptStrategy; options: TaskMergeOptions };

/**
 * 合并 + 推送：在临时检出里合出结果 → 推这个结果 → 推上去了才快进本地目标分支。
 * 推送失败返回的 `merge` 是一次失败（本地没动，跟没合过一样）；其中 `push_remote_moved` = 远程期间又进了
 * 新提交、已同步进本地目标分支，调用方从头重新验收（文件头）。
 */
export async function pushFirst(task: { id: string; projectId: string }, repoPath: string, plan: PushPlan,
  args: DetachedArgs): Promise<{ merge: TaskMergeResult; push?: PushOutcome }> {
  assertNotPreviewInstance("合并任务分支");
  return withRepoLock(repoPath, () => pushFirstLocked(task, repoPath, plan, args));
}

async function pushFirstLocked(task: { id: string; projectId: string }, repoPath: string, plan: PushPlan,
  args: DetachedArgs): Promise<{ merge: TaskMergeResult; push?: PushOutcome }> {
  const merged = await mergeDetached(repoPath, task.id, args.target, args.strategy, args.options);
  if (!merged.ok) return { merge: merged };
  const names = { sourceBranch: merged.sourceBranch, targetBranch: merged.targetBranch };
  const outcome = await pushCommit(repoPath, merged.result, plan, task.projectId);
  if (!outcome.ok) {
    const failed = (reason: TaskMergeFailureReason, why: string) => ({ push: outcome, merge: { ok: false as const, reason, ...names,
      message: `推送到 ${plan.remote}/${plan.remoteBranch} 没成功（${outcome.message}）${why}` } });
    // 远程在这期间是不是被推了新提交：按事实判（远程那一头还是不是合并结果的祖先），不按报错字样 ——
    // 并发推送时 git 报的可能是 remote rejected (failed to update ref)，不是 non-fast-forward。
    const fetched = await fetchTip(repoPath, plan, task.projectId);
    const remoteMoved = fetched.ok && !!fetched.tip && !(await isAncestor(expandHome(repoPath), fetched.tip, merged.result));
    if (!remoteMoved) return failed("push_failed", `；本地 ${plan.branch} 一个字节都没动，任务的分支和工作区都留着，处理好之后再验收`);
    const sync = await syncTargetWithRemote(repoPath, plan.branch, plan, task.projectId);
    if (!sync.ok) return failed(sync.reason, `，远程期间又被推了新提交，同步它时没成功：${sync.message}`);
    if (sync.warning) await appendTaskTimeline(task.id, alertLine(sync.warning));
    await appendTaskTimeline(task.id, receiptLine(`推送时 ${plan.remote}/${plan.remoteBranch} 又多了 ${sync.fastForwarded} 个新提交：`
      + `本地 ${plan.branch} 没动过，已把新提交同步进来，按同步之后的 ${plan.branch} 从头重新验收`
      + "（重新预演；撞了冲突交回任务去解，门禁的基准变了就重跑门禁，跑完自动接着验收并推送）。"));
    return failed("push_remote_moved", "，远程在合并期间又被推了新提交");
  }
  await pushed(task.id, plan, outcome);
  const landed = await landDetached(repoPath, merged);
  let push: PushOutcome = outcome;
  if (!landed.ok) {
    push = { ...outcome, localBehind: landed.message };
    await appendTaskTimeline(task.id, alertLine(`这次合并已经推到 ${plan.remote}/${plan.remoteBranch}（${merged.result.slice(0, 8)}），`
      + `但没能快进进本地 ${plan.branch}：${landed.message}。远程那份就是这次合并，验收照常完成；在项目目录 pull 一下本地就跟上了。`));
  }
  return { push, merge: { ok: true, ...names, method: merged.method, beforeCommit: merged.base, afterCommit: merged.result,
    ...(merged.warnings ? { warnings: merged.warnings } : {}) } };
}

/**
 * 合并早已落下（上一次停在 merged、任务分支也删了）时只推：远程已经有那次合并就不用推；没有就推本地目标分支
 * **此刻那一个提交**（先读成哈希、核过它含着那次合并，推的是这个哈希，不是推送那一刻分支指着谁）。
 */
export async function pushMerged(task: { id: string; projectId: string }, repoPath: string, plan: PushPlan,
  mergeCommit: string): Promise<PushOutcome> {
  const repo = expandHome(repoPath);
  const base = { remote: plan.remote, remoteBranch: plan.remoteBranch };
  const fetched = await fetchTip(repoPath, plan, task.projectId);
  const fail = async (message: string): Promise<PushOutcome> => {
    await appendTaskTimeline(task.id, alertLine(`推送到 ${plan.remote}/${plan.remoteBranch} 没成功：${message}。合并留在本地 ${plan.branch}，没有清理，再验收会再推一次。`));
    return { ...base, ok: false, reason: "push_failed", message };
  };
  if (!fetched.ok) return fail(fetched.message);
  let outcome: PushOutcome;
  if (fetched.tip && await isAncestor(repo, mergeCommit, fetched.tip)) {
    outcome = { ...base, ok: true, commit: fetched.tip, upToDate: true };
  } else {
    const tip = await commitOf(repo, `refs/heads/${plan.branch}`);
    if (!tip || !(await isAncestor(repo, mergeCommit, tip))) return fail(`本地 ${plan.branch} 已经不含那次合并（${mergeCommit.slice(0, 8)}）`);
    outcome = await pushCommit(repoPath, tip, plan, task.projectId);
    if (!outcome.ok) return fail(outcome.message);
  }
  await pushed(task.id, plan, outcome);
  return outcome;
}
