const labels: Record<string, string> = {
  not_git_repo: "项目不是 Git 仓库",
  target_unresolved: "无法确定目标分支",
  source_branch_missing: "任务分支不存在或已清理",
  target_branch_missing: "合入目标分支不在本地",
  no_merge_base: "任务分支与合入目标没有共同基点",
  accepted_snapshot_unreadable: "无法读取验收时保存的提交",
  start_commit_unreadable: "无法读取任务的开工提交",
  task_diff_unreadable: "无法读取任务的分支改动，请刷新后重试",
};

export function branchDiffReason(reason?: string | null): string {
  // 未知码保留原文，便于从后端日志或代码定位原因。
  return labels[reason ?? ""] ?? (reason || "未解析到可比较的工作区");
}
