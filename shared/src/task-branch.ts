// 任务分支的名字：开 worktree 的任务落在 `navi/<id 前 8 位>` 上。改名之前建的任务分支是
// `ash/<id8>`、更早是 `harness/<id8>`（前缀见 legacy-names.ts），仓库里还在，**按任务找分支时
// 三代都认**；新建只用当前前缀。
import { LEGACY_TASK_BRANCH_PREFIXES } from "./legacy-names.ts";

export const TASK_BRANCH_PREFIX = "navi/";

/** 新建任务分支用的名字。 */
export function taskBranchName(taskId: string): string {
  return `${TASK_BRANCH_PREFIX}${taskId.slice(0, 8)}`;
}

/** 这条任务的分支可能叫的各个名字，当前名在前。按任务找分支时挨个试，第一个存在的就是。 */
export function taskBranchNames(taskId: string): string[] {
  const id8 = taskId.slice(0, 8);
  return TASK_BRANCH_PREFIXES.map((prefix) => `${prefix}${id8}`);
}

/** 这条分支是不是这条任务的分支（任一代前缀）。 */
export function isTaskBranchOf(branch: string | null | undefined, taskId: string): boolean {
  return !!branch && taskBranchNames(taskId).includes(branch);
}

/** 任务分支的各代前缀，当前在前。 */
export const TASK_BRANCH_PREFIXES: readonly string[] = [TASK_BRANCH_PREFIX, ...LEGACY_TASK_BRANCH_PREFIXES];

/** 分支名带不带任务分支的前缀（任一代）。 */
export const hasTaskBranchPrefix = (branch: string): boolean =>
  TASK_BRANCH_PREFIXES.some((prefix) => branch.startsWith(prefix));

/** 形如 `<前缀><id 前 8 位>` 的任务分支（任一代）→ 那截 id；不是就 null。 */
export function taskIdPrefixOfBranch(branch: string): string | null {
  for (const prefix of TASK_BRANCH_PREFIXES) {
    if (!branch.startsWith(prefix)) continue;
    const rest = branch.slice(prefix.length);
    if (rest.length >= 1 && rest.length <= 8 && !rest.includes("/")) return rest;
  }
  return null;
}

/** 一条远端分支：`ref` 是 `origin/foo` 这种写法，`branch` 是它在本地对应的同名分支。 */
export type RemoteBranch = { ref: string; remote: string; branch: string };

/**
 * 项目的分支清单（新建任务挑开工起点用）。`branches` 只列本地分支，跟老调用方兼容；远端分支另列在
 * `remoteBranches`，是本地记着的那份（刷新要先 fetch）。
 */
export type ProjectBranches = { branches: string[]; remoteBranches: RemoteBranch[]; remotes: string[]; current: string | null };
