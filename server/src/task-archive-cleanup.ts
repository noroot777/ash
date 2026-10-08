// 归档时顺手收掉任务留在磁盘上的工作区(用户 2026-10-08 要求「归档也删」)。
//
// 上线前归档只翻一个 `archived` 位,`.worktrees/<id>` 目录和 `ash/<id8>` 分支原样留着:
// 归档列表越长,磁盘上就越多谁也不会再打开的工作副本。现在按全局设置 `archiveClean`
// 清理(默认 all),三档语义与验收清理共用。
//
// 三条刻意的边界,改这里之前先读:
//  ① **清理失败从不让归档失败**。归档是用户的主要意图,git 那边的拒绝(目录脏、分支
//     未合并)如实回报给他,由他决定要不要去 git 里再处理 —— 跟删除任务那条路同一口径。
//  ② **只用 `git branch -d`、`worktree remove` 不带 `--force`**,跟验收清理一样绝不
//     升级成 `-D`/`--force`。这让归档保持「实质可逆」:未合并的分支一定留下来,取回归档
//     后再跑一次,prepareWorktree 会照着分支把工作区重建出来。要强删有删除任务那条路,
//     那里是用户看着报错又点了一次。
//  ③ **删 worktree 前必须先收预览**。预览进程的 cwd 就在那个目录里,先删目录它会原地
//     变成一个指向空气的服务。收不掉就这一项不删,照实说。
import type { ArchiveCleanupItem, ArchiveCleanupReport } from "@ash/shared";
import { getAppSettings } from "./app-settings.js";
import { stopPreviewForWorktreeCleanup } from "./preview.js";
import { withRepoLock } from "./repo-lock.js";
import { branchDeletionRejection } from "./task-branch-plan.js";
import { detectTaskWorkspace, discardTaskWorkspace } from "./workspace-cleanup.js";

export type ArchiveCleanupTarget = { id: string; title: string };

/**
 * 归档这一批任务(团队是 lead + 全部执行者)的工作区清理。调用方在**任务行已经落
 * archived 之后**调它:清理只是收尾,不参与归档本身的成败。
 *
 * `repoPath` 由调用方给:这一批必须同属一个仓库(团队执行者继承 lead 的 projectId),
 * 整批才能在一次仓库锁里做完。
 */
export async function cleanupArchivedWorkspaces(
  repoPath: string | null | undefined,
  targets: ArchiveCleanupTarget[],
): Promise<ArchiveCleanupReport> {
  const mode = (await getAppSettings()).archiveClean;
  const empty: ArchiveCleanupReport = { mode, items: [], skipped: null };
  if (mode === "none" || !targets.length) return empty;
  const repo = repoPath;
  if (!repo) return empty; // 非 git 项目:没有 worktree 也没有分支
  // 整批清理一次拿锁:团队的执行者是逐个删的,中间不要插进别人的验收合并。锁可重入,
  // 内层 discardTaskWorkspace 自己那次直接放行。
  return withRepoLock(repo, async () => {
    const items: ArchiveCleanupItem[] = [];
    let skipped: string | null = null;
    for (const target of targets) {
      const leftover = await detectTaskWorkspace(repo, target.id);
      if (!leftover.path && !leftover.branch) continue; // 已验收/从未开 worktree:无事可做
      let worktreeNote: string | null = null;
      let tryWorktree = !!leftover.path;
      if (tryWorktree) {
        try { await stopPreviewForWorktreeCleanup(target.id); }
        catch (error) {
          tryWorktree = false;
          worktreeNote = error instanceof Error ? error.message : String(error);
          skipped = `预览未能回收，工作区已保留：${worktreeNote}`;
        }
      }
      // 分支只在 all 档删,而且要过「别的任务还依赖它吗」那道闸:父成果已合入时
      // `git branch -d` 是会成功的,而子任务的 worktreeBase 就钉在这个分支上。
      let branchNote: string | null = null;
      let tryBranch = mode === "all" && !!leftover.branch;
      if (tryBranch) {
        const rejection = await branchDeletionRejection(repo, target.id);
        if (rejection) { tryBranch = false; branchNote = rejection.error; }
      }
      const result = await discardTaskWorkspace(repo, target.id, { worktree: tryWorktree, branch: tryBranch });
      items.push({
        taskId: target.id,
        title: target.title,
        ...result,
        // 没尝试的项也要在报告里露脸,否则「因为预览/依赖没删」在界面上看不出来;
        // 按设置不该删的分支(worktree 档)则保持 null —— 那不是失败。
        path: result.path ?? leftover.path,
        worktreeError: result.worktreeError ?? worktreeNote,
        branch: result.branch ?? (branchNote ? leftover.branch : null),
        branchError: result.branchError ?? branchNote,
      });
    }
    return { mode, items, skipped };
  });
}
