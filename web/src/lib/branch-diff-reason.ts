const labels: Record<string, string> = {
  not_git_repo: "项目不是 Git 仓库",
  target_unresolved: "无法确定目标分支",
  source_branch_missing: "任务分支不存在或已清理",
  target_branch_missing: "合入目标分支不在本地",
  no_merge_base: "任务分支与合入目标没有共同基点",
  accepted_snapshot_unreadable: "无法读取验收时保存的提交",
  start_commit_unreadable: "无法读取任务的开工提交",
  base_conflict: "开工点带来的代码和任务分支里已合入的目标分支合不到一起，算不出这条任务自己的改动",
  base_unreadable: "合成对比基准时 git 没有给出结果，请刷新后重试",
  task_diff_unreadable: "无法读取任务的分支改动，请刷新后重试",
  commit_list_unreadable: "提交清单读不出来，请刷新后重试",
};

/**
 * 提交清单自己读不出来、diff 却是好的时候，要另外说的那个原因（diff 也读不出来时原因已经写在 diff 的位置上）。
 * 任务分支已经清理不算：验收之后 diff 按冻结的区间读，那时是没有清单可列，不是读失败。
 */
export function commitListFailure(commits: { total: number | null; reason?: string | null }, diffAvailable: boolean): string | null {
  if (commits.total !== null || !diffAvailable || !commits.reason || commits.reason === "source_branch_missing") return null;
  return commits.reason;
}

export function branchDiffReason(reason?: string | null): string {
  // 未知码保留原文，便于从后端日志或代码定位原因。
  return labels[reason ?? ""] ?? (reason || "未解析到可比较的工作区");
}
