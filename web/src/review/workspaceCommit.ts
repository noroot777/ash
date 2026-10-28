import { useEffect, useState } from "react";
import type { ScmOverview, ScmStatus } from "../lib/api.ts";

const COMMITTED = "ash:workspace-committed";

export function workspaceCommitPaths(status: ScmStatus): string[] {
  return [...new Set([...status.staged, ...status.unstaged, ...status.untracked, ...status.merge]
    .flatMap(change => change.origPath ? [change.path, change.origPath] : [change.path]))];
}

export function workspaceCommitBlock(overview: ScmOverview): string | null {
  if (overview.readOnly) return overview.readOnly;
  if (overview.taskRunning) return "还有任务正在这个工作目录中运行，请结束后再提交。";
  if (overview.status.merge.length || overview.status.operation) return "存在冲突或未完成的 Git 操作，请先在源代码管理中处理。";
  if (overview.status.truncated) return "文件列表不完整，请在源代码管理中核对后提交。";
  if ([...overview.status.staged, ...overview.status.unstaged, ...overview.status.untracked].some(change => change.nested)) {
    return "包含嵌套 Git 仓库，请先分别处理，避免遗漏改动。";
  }
  return null;
}

export function announceWorkspaceCommit(taskId: string) {
  window.dispatchEvent(new CustomEvent(COMMITTED, { detail: taskId }));
}

export function useWorkspaceCommitVersion(taskId: string) {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const listener = (event: Event) => {
      if ((event as CustomEvent<string>).detail === taskId) setVersion(current => current + 1);
    };
    window.addEventListener(COMMITTED, listener);
    return () => window.removeEventListener(COMMITTED, listener);
  }, [taskId]);
  return version;
}
