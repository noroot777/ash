import type { BaseUpdateRecovery } from "@ash/shared/branch-plan";
import { acceptedCommitDiff } from "./git-diff.js";
import { commitAt, containsCommit } from "./task-branch-plan.js";
import { execFileText as exec } from "./exec.js";

export async function manualBaseProposal(repo: string, branch: string, current: string | null,
  candidates: [string | null, string][], targetBranch: string | null): Promise<{
    start: string | null; manual: NonNullable<BaseUpdateRecovery["manual"]>; blocker: string | null;
  }> {
  let start: string | null = null;
  let basis = "任务分支已不存在。解除挂起会保留现存备份，之后可删除任务或重新建立工作区；不会标记为已验收。";
  if (current) {
    for (const [commit, description] of candidates) {
      if (commit && await containsCommit(repo, commit, current)) { start = commit; basis = description; break; }
    }
    const target = !start && targetBranch ? await commitAt(repo, targetBranch) : null;
    if (target) {
      start = await exec("git", ["-C", repo, "merge-base", current, target]).then(r => r.stdout.trim() || null, () => null);
      if (start) basis = "拟以当前分支与合入目标的共同祖先为起点。下面的差异可能包含父任务成果，请核对范围。";
    }
    if (!start) {
      start = current;
      basis = "没有可用的历史基点。拟以当前提交重新开工：已有代码全部保留，但不再计入之后的任务 diff；不会伪造合入凭据。请明确核对这一范围变化。";
    }
    const preview = await acceptedCommitDiff(repo, branch, start, current, 128 * 1024);
    if (!preview.available) return { start, manual: { basis, files: [], diff: "", truncated: false }, blocker: "恢复差异暂时无法读取，请刷新重试；未解除挂起或修改当前代码。" };
    return { start, manual: { basis, files: preview.files.map(f => f.path), diff: preview.diff, truncated: preview.truncated }, blocker: null };
  }
  for (const [commit] of candidates) { if (commit && await commitAt(repo, commit)) { start = commit; break; } }
  return { start, manual: { basis, files: [], diff: "", truncated: false }, blocker: null };
}
