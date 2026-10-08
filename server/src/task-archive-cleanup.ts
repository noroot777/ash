// 归档时顺手收掉任务留在磁盘上的工作区(用户 2026-10-08 要求「归档也删」)。
//
// 上线前归档只翻一个 `archived` 位,`.worktrees/<id>` 目录和 `ash/<id8>` 分支原样留着:
// 归档列表越长,磁盘上就越多谁也不会再打开的工作副本。现在按全局设置 `archiveClean`
// 清理(默认 all),三档语义与验收清理共用。
//
// 刻意的边界,改这里之前先读:
//  ① **清理失败从不让归档失败**。归档是用户的主要意图,git 那边的拒绝(目录脏、分支
//     未合并)如实回报给他,由他决定要不要去 git 里再处理 —— 跟删除任务那条路同一口径。
//  ② **只用 `git branch -d`、`worktree remove` 不带 `--force`**,跟验收清理一样绝不
//     升级成 `-D`/`--force`。这让归档保持「实质可逆」:未合并的分支一定留下来,取回归档
//     后再跑一次,prepareWorktree 会照着分支把工作区重建出来。要强删有删除任务那条路,
//     那里是用户看着报错又点了一次。
//  ③ **删 worktree 前必须先收预览**。预览进程的 cwd 就在那个目录里,先删目录它会原地
//     变成一个指向空气的服务。收不掉就这一项不删,照实说。
//  ④ **整个清理期间占住这个工作目录全部共用者的回合锁**(第 1 轮审查确定性复现):
//     「写 archived」到「真的删」之间隔着一次仓库锁等待,用户完全来得及在另一个页面点
//     取回再点运行 —— 等我们拿到仓库锁时,那个目录里已经有一个 agent 在跑,删下去它当场
//     读不到自己的文件。占锁挡住新回合,拿到锁后再复核 archived 仍然成立(用户取回了就
//     是不想要这次清理了),两道一起才关得住这个窗口。
//  ⑤ **删掉已合并的分支之前,把它的末端提交存进 `acceptedHeadRef`**(第 1 轮审查):
//     手动 `git merge` 合入主分支的任务没有验收留下的恢复引用,分支一删,取回后重建只
//     剩 `worktreeStartCommit` 这个**开工点**可用,任务自己做完的东西全不在工作区里。
//     存了这个 ref,`restoreAcceptedStart` 会把起点抬到任务完成时的提交。
//  ⑥ **预览实例一律不清理**。那台后端连的是主库快照,任务行指向的却是真仓库;
//     `removeWorktree` 自带这道闸,`git branch -d` 没有,于是「目录已不在、只剩分支」
//     的任务会把真分支删掉(第 1 轮审查确定性复现)。在入口直接挡住,不依赖下游。
import type { ArchiveCleanupItem, ArchiveCleanupReport } from "@ash/shared";
import { eq } from "drizzle-orm";
import { getAppSettings } from "./app-settings.js";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { execFileText as exec } from "./exec.js";
import { expandHome } from "./git.js";
import { IS_PREVIEW_INSTANCE, previewRefusal } from "./preview-instance.js";
import { stopPreviewForWorktreeCleanup } from "./preview.js";
import { withRepoLock } from "./repo-lock.js";
import { claimWorkspaceTurn } from "./runs.js";
import { acceptedHeadRef, branchDeletionRejection, commitAt } from "./task-branch-plan.js";
import { workspaceParticipants } from "./task-workspace.js";
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
  if (IS_PREVIEW_INSTANCE) return { ...empty, skipped: previewRefusal("归档清理工作区") };
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
      const guard = await holdWorkspace(target.id, leftover.path);
      if (!guard) {
        skipped = `「${target.title}」的工作目录上有任务在跑或已被取回，这次没有清理。`;
        continue;
      }
      try {
        items.push(await discardOne(repo, target, leftover, mode, (note) => { skipped = note; }));
      } finally { guard(); }
    }
    return { mode, items, skipped };
  });
}

/**
 * 占住这个工作目录全部共用者的回合锁,并复核任务确实还处于归档态。
 *
 * 两件事必须一起做、而且**顺序是先占后查**:`claimTurn` 不要仓库锁,先查后占的话查完到
 * 占住之间另一次启动完全可以合法插进来(runs.ts `claimWorkspaceTurn` 的注释里记着同一个
 * 窗口的两次复现)。占不到 = 此刻有人在这个目录里干活,这一项就别清。
 *
 * 返回释放函数;占不到或任务已被取回时返回 null(已占的锁在这里就还掉)。
 */
async function holdWorkspace(taskId: string, path: string | null): Promise<(() => void) | null> {
  const row = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!row) return null;
  // 共用者按**目录**算:团队执行者跟调度台跑在同一个 worktree 里,只占自己那把锁的话,
  // 兄弟执行者照样能在我们跑 git 的同一刻起跑。目录已经不在时退回只占自己。
  const peers = path ? await workspaceParticipants(row, path) : [{ id: taskId }];
  const release = claimWorkspaceTurn(peers.map((peer) => peer.id));
  if (!release) return null;
  // 占住之后再读一次 archived:等仓库锁的那段时间里用户可能已经在另一个页面点了取回,
  // 那就是「我还要用它」,这次清理作废。
  const fresh = (await db.select({ archived: tasks.archived }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!fresh?.archived) { release(); return null; }
  return release;
}

/** 单个任务的清理。调用方已经占住回合锁并复核过归档态。 */
async function discardOne(
  repo: string,
  target: ArchiveCleanupTarget,
  leftover: { path: string | null; branch: string | null },
  mode: "all" | "worktree",
  note: (text: string) => void,
): Promise<ArchiveCleanupItem> {
  let worktreeNote: string | null = null;
  let tryWorktree = !!leftover.path;
  if (tryWorktree) {
    try { await stopPreviewForWorktreeCleanup(target.id); }
    catch (error) {
      tryWorktree = false;
      worktreeNote = error instanceof Error ? error.message : String(error);
      note(`预览未能回收，工作区已保留：${worktreeNote}`);
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
  // 末端提交要在删之前读:删完就再也问不出来了。
  const tip = tryBranch && leftover.branch ? await commitAt(repo, leftover.branch) : null;
  const result = await discardTaskWorkspace(repo, target.id, { worktree: tryWorktree, branch: tryBranch });
  if (result.branchDeleted && tip) await rememberTaskHead(repo, target.id, tip);
  return {
    taskId: target.id,
    title: target.title,
    ...result,
    // 没尝试的项也要在报告里露脸,否则「因为预览/依赖没删」在界面上看不出来;
    // 按设置不该删的分支(worktree 档)则保持 null —— 那不是失败。
    path: result.path ?? leftover.path,
    worktreeError: result.worktreeError ?? worktreeNote,
    branch: result.branch ?? (branchNote ? leftover.branch : null),
    branchError: result.branchError ?? branchNote,
  };
}

/**
 * 把任务分支的末端记成它的「完成提交」。验收那条路靠 `recordBranchReceipt` 写同一个 ref
 * (用的是合并提交),手动合入的任务没人替它写 —— 分支一删,`restoreAcceptedStart` 就只剩
 * 开工点可用。写不进去不算清理失败:提交仍在目标分支里,只是取回后要自己找。
 */
async function rememberTaskHead(repo: string, taskId: string, commit: string): Promise<void> {
  try { await exec("git", ["-C", expandHome(repo), "update-ref", acceptedHeadRef(taskId), commit]); }
  catch { /* ref 写不进去不影响已经完成的清理 */ }
}
