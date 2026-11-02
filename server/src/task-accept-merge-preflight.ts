import { and, eq, isNull } from "drizzle-orm";
import { acceptPlan } from "@ash/shared/workflow-policy";
import type { AcceptBy } from "@ash/shared/workflow-policy";
import { db } from "./db/index.js";
import { tasks, projects } from "./db/schema.js";
import { now } from "./util.js";
import { execFileText } from "./exec.js";
import { expandHome, localBranchExists, resolveWorktreeBranchName } from "./git.js";
import { isAncestor, targetCheckout } from "./git-accept.js";
import { checkoutRecovery } from "./git-worktree-state.js";
import { branchDependency, branchOwner, plannedMergeTarget } from "./task-branch-plan.js";
import { taskWorkflowDef } from "./workflows.js";
import type { AcceptFailure } from "./task-accept-guard.js";

type TaskRow = typeof tasks.$inferSelect;

/**
 * 领取本次验收的目标分支:**只在库里还空着时写**,写完(或没写成)都回读库里那一份当结论。
 *
 * 两半缺一不可。只写不回读的话,调用方手里那份任务快照仍然是空的,后面每一步(自动提交后
 * 的第二次前置检查、前置命令登记目标、最终合并)都会按空值**重新解析** —— 这期间用户在别的
 * 终端切了项目分支,重算出来的就是新分支,还会把刚冻结的值盖掉,成果合进错的分支(第 1 轮
 * 自由审查 F1 用生产函数实测到覆盖)。写的条件不带 `IS NULL` 的话,并发的两次领取后到的
 * 那次照样覆盖先到的那次。
 *
 * 返回 null = 回读不到(任务这一瞬被删了);调用方按「目标解析不出来」处理。
 */
export async function claimAcceptTarget(taskId: string, resolved: string): Promise<string | null> {
  await db.update(tasks).set({ acceptedTargetBranch: resolved, updatedAt: now() })
    .where(and(eq(tasks.id, taskId), isNull(tasks.acceptedTargetBranch)));
  const row = (await db.select({ target: tasks.acceptedTargetBranch }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  return row?.target ?? null;
}

/**
 * 回来的 `task` 是**带着已冻结目标**的那份快照:调用方必须拿它往下走(再一次前置检查、前置
 * 命令、合并),不能接着用传进来的那份 —— 理由见 claimAcceptTarget。
 */
export async function mergePreflight(task: TaskRow, project: typeof projects.$inferSelect | null,
  by: AcceptBy, commit?: boolean): Promise<{ failure: AcceptFailure | null; task: TaskRow }> {
  const pass = { failure: null, task };
  if (!project || !task.useWorktree || task.stage === "merged") return pass;
  const plan = acceptPlan(taskWorkflowDef(task.workflow), by, task.workflowAt);
  if (!plan.merge || plan.merge === "tag") return pass;
  const failWith = (row: TaskRow) => (reason: string, error: string): { failure: AcceptFailure; task: TaskRow } =>
    ({ task: row, failure: { accepted: false, httpStatus: 409, taskId: row.id, status: row.status, reason, error } });
  const dependency = await branchDependency(task, project.repoPath);
  if (dependency && dependency.state !== "ready") return failWith(task)(`base_${dependency.state}`, dependency.message);
  const resolved = await plannedMergeTarget(task, project.repoPath);
  if (!resolved) return failWith(task)("target_unresolved", "目标分支为空且项目当前处于 detached HEAD");
  // **目标一解析出来就冻结,比任何一条失败都早。** 这条不变量的理由写在 task-accept.ts 合并段
  // 那里(一次验收生命周期内目标分支必须冻结,且在动 Git 之前先持久化);这道前置检查是后来
  // 插在它前面的,于是「目标分支不存在 / 被别人检出 / 工作区不干净」这几条都改成在冻结之前
  // 就返回 —— 页面从此显示不出「锁定的目标是哪一个」,改派目标的过期保护(409)也失效,
  // 重试会跟着项目当前 checkout 漂(test-branch-plan-creation 钉的就是这一条)。
  const target = await claimAcceptTarget(task.id, resolved);
  if (!target) return failWith(task)("target_unresolved", "验收目标没能锁定：任务记录已经不在");
  const frozen: TaskRow = { ...task, acceptedTargetBranch: target };
  const fail = failWith(frozen);
  if (!await localBranchExists(project.repoPath, target)) return fail("target_branch_missing", `目标分支 ${target} 不存在`);
  const source = await resolveWorktreeBranchName(project.repoPath, task.id);
  if (!await localBranchExists(project.repoPath, source)) return fail("source_branch_missing", `任务分支 ${source} 不存在`);
  if (source === target) return fail("source_equals_target", "任务分支不能同时作为验收目标分支");
  if (await isAncestor(project.repoPath, source, target)) return { failure: null, task: frozen };
  const checkout = await targetCheckout(project.repoPath, target);
  // 这句话要跟**没有前置命令那条路**说得一样全(git-accept.ts 的同名失败 + task-accept.ts
  // 合并之后那段补写):谁占着它、以及登记坏了该怎么修。门禁前置命令这道闸排在合并之前,
  // 所以合并路径那段补写压根走不到 —— 不在这里自己补,用户看到的就只剩一个路径,既不知道
  // 占用者是哪个任务(于是去删分支,把验收目标弄丢),登记坏掉时也拿不到 git worktree repair
  // 这句提示(#257/#258 两头各钉一条)。
  if (checkout.path && !checkout.atRepo) {
    const owner = await branchOwner(project.repoPath, task.projectId, target);
    const occupant = owner
      ? `占用者是任务「${owner.title}」（${owner.id}）。任务结束后 worktree 仍会占用分支，删除分支会使验收目标丢失。请保留分支并处理验收目标。`
      : "请保留目标分支，删除工作区不能替代验收目标配置。";
    return fail("target_checked_out",
      `目标分支 ${target} 已在另一个 worktree ${checkout.path} 检出；未运行验收前置命令。${occupant}${checkoutRecovery(checkout) ?? ""}`);
  }
  if (!checkout.atRepo && (commit ?? project.acceptCommit) === false) {
    return fail("target_not_checked_out", "合并后不提交要求目标分支检出在项目目录；未运行验收前置命令");
  }
  if (checkout.atRepo) {
    // `repoPath` 是用户填的原文,可能以 `~` 开头 —— git 自己不展开它(`fatal: cannot change
    // to '~/repo'`)。仓库里其它每一处 git 调用都先过 expandHome,这一处漏了。
    const { stdout } = await execFileText("git", ["-C", expandHome(project.repoPath), "status", "--porcelain"]);
    if (stdout.trim()) {
      const dirty = fail("target_dirty", `目标分支 ${target} 的工作区不干净；未运行验收前置命令`);
      return { task: frozen, failure: { ...dirty.failure,
        dirtyFiles: stdout.trimEnd().split("\n").map(line => line.slice(3)), targetBranch: target, targetPath: checkout.path! } };
    }
  }
  return { failure: null, task: frozen };
}
