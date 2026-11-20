// 验收「推送到远程」这一档的编排：门禁之前先把远程同步进本地目标分支，合完先推、推上去了才算合完。
// git 那几下在 git-accept-remote.ts / git-guarded-move.ts，那边的文件头写着为什么是「先同步、再合、再推」。
//
// 只有用户明说要推（确认层那一勾、accept_task 的 push 参数）才推：推送是往外发，不从项目设置里推出来，
// 飞书卡片和工作流自己走到的验收都不推。确认层发来的是**它显示的那个目的地**（含推送地址），执行时
// 解析出来的不是同一处就拒 —— `push:true` 只说明用户同意推，不说明他同意推到执行那一刻算出来的任何地方。
// 门禁续做带的也是第一次解析时冻结下来的那一份。
//
// 推送没成功时**不落 merged、不清理**（审查第 1 轮 F3）：先把这次合并从本地目标分支上退回去，任务的
// 分支和工作区都还在。远程在这期间被别人推了新提交，就同步进来重新合 —— 撞了冲突照常交回任务去解；
// 没撞就再推。推上去了才往下走「merged → 清理 → 已验收」。退不回去（期间有人动了目标分支）就停在
// merged、不清理，再点验收会再推一次。
import type { tasks, projects } from "./db/schema.js";
import { acceptPlan, type AcceptBy } from "@navi/shared/workflow-policy";
import type { AcceptPushDestination } from "@navi/shared/accept-gate";
import { taskWorkflowDef } from "./workflows.js";
import { plannedMergeTarget } from "./task-branch-plan.js";
import { fetchTip, pushTargetBranch, resolvePushTarget, samePushTarget, syncTargetWithRemote, type PushOutcome } from "./git-accept-remote.js";
import { moveBranchGuarded } from "./git-guarded-move.js";
import { isAncestor, type TaskMergeResult } from "./git-accept.js";
import { expandHome } from "./git.js";
import { appendTaskTimeline, alertLine, receiptLine } from "./task-timeline.js";
import type { AcceptFailure } from "./task-accept-guard.js";
import { hasTaskBranchPrefix } from "@navi/shared/task-branch";

export type { PushOutcome } from "./git-accept-remote.js";
export type PushPlan = AcceptPushDestination;

type TaskRow = typeof tasks.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

/** 推送没成功、远程又在动时最多重来几轮（同步 → 重新合 → 再推）。 */
const MAX_PUSH_ROUNDS = 3;

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
  const sync = await syncTargetWithRemote(project.repoPath, plan.branch, plan);
  if (!sync.ok) return refuse(sync.reason, sync.message);
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

/**
 * 合并 + 推送。返回 `push` 失败且 `merge.ok` 时 = 合并留在了本地（退不回去），调用方停在 merged、不清理；
 * 推送失败而退回去了，返回的 `merge` 就是一次失败（目标分支回到合并之前，跟没合过一样）。
 */
export async function mergeThenPush(taskId: string, repoPath: string, plan: PushPlan | null,
  merge: () => Promise<TaskMergeResult>): Promise<{ merge: TaskMergeResult; push?: PushOutcome }> {
  for (let round = 1; ; round++) {
    const merged = await merge();
    if (!plan || !merged.ok || merged.method === "tagged" || merged.method === "no_commit") return { merge: merged };
    const outcome = await pushTargetBranch(repoPath, plan.branch, plan);
    if (outcome.ok) {
      await pushed(taskId, plan, outcome);
      return { merge: merged, push: outcome };
    }
    const names = { sourceBranch: merged.sourceBranch, targetBranch: merged.targetBranch };
    const before = merged.beforeCommit, after = merged.afterCommit;
    const rewound = merged.method !== "already_merged" && before && after && before !== after
      ? await moveBranchGuarded(repoPath, plan.branch, after, before, `推送没成功，把这次合并从 ${plan.branch} 上退回去`) : null;
    if (!rewound?.ok) {
      await appendTaskTimeline(taskId, alertLine(`合并已经落在本地 ${plan.branch}，但推送到 ${plan.remote}/${plan.remoteBranch} 没成功：${outcome.message}。`
        + (rewound ? `也没能把合并退回去（${rewound.message}）。` : "")
        + "任务的分支和工作区都留着；处理好之后再点一次验收会再推一次。"));
      return { merge: merged, push: outcome };
    }
    // 退回去了。远程在这期间是不是被推了新提交：按事实判（远程那一头还是不是合并结果的祖先），不按报错字样 ——
    // 并发推送时 git 报的可能是 remote rejected (failed to update ref)，不是 non-fast-forward。
    const fetched = await fetchTip(repoPath, plan);
    const remoteMoved = fetched.ok && !!fetched.tip && !(await isAncestor(expandHome(repoPath), fetched.tip, after!));
    if (!remoteMoved || round >= MAX_PUSH_ROUNDS) {
      return { merge: { ok: false, reason: remoteMoved ? "push_rejected" : "push_failed", ...names,
        message: `推送到 ${plan.remote}/${plan.remoteBranch} 没成功（${outcome.message}）`
          + (remoteMoved ? `，远程连着 ${round} 次在合并期间又被推了新提交` : "")
          + `；已把这次合并从本地 ${plan.branch} 上退回去，任务的分支和工作区都留着，处理好之后再验收` } };
    }
    const sync = await syncTargetWithRemote(repoPath, plan.branch, plan);
    if (!sync.ok) return { merge: { ok: false, reason: sync.reason, ...names, message: `推送时远程又有了新提交，同步它时没成功：${sync.message}` } };
    await appendTaskTimeline(taskId, receiptLine(`推送时 ${plan.remote}/${plan.remoteBranch} 又多了 ${sync.fastForwarded} 个新提交：`
      + `已把本地这次合并退回去、把新提交同步进 ${plan.branch}，重新合并（第 ${round + 1} 次）；撞了冲突就交回任务去解。`));
  }
}

/** 合并早已落下（上一次停在 merged）时只推。 */
export async function pushMerged(taskId: string, repoPath: string, plan: PushPlan): Promise<PushOutcome> {
  const outcome = await pushTargetBranch(repoPath, plan.branch, plan);
  if (outcome.ok) await pushed(taskId, plan, outcome);
  else await appendTaskTimeline(taskId, alertLine(`推送到 ${plan.remote}/${plan.remoteBranch} 没成功：${outcome.message}。合并留在本地 ${plan.branch}，没有清理，再验收会再推一次。`));
  return outcome;
}
