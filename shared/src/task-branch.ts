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
  return [TASK_BRANCH_PREFIX, ...LEGACY_TASK_BRANCH_PREFIXES].map((prefix) => `${prefix}${id8}`);
}

/** 这条分支是不是这条任务的分支（任一代前缀）。 */
export function isTaskBranchOf(branch: string | null | undefined, taskId: string): boolean {
  return !!branch && taskBranchNames(taskId).includes(branch);
}
