import { statSync } from "node:fs";
import type { TaskWorkspaceLeftover, TaskWorkspaceDiscardResult } from "@navi/shared";
import { dirtyFilesAt, expandHome, gitError, listFiles, localBranchExists, removeWorktree, resolveWorktreeBranchName, worktreePathFor } from "./git.js";
import { withRepoLock } from "./repo-lock.js";
import { execFileText as exec } from "./exec.js";
import { assertReadableWorktree, registeredCheckout, removeMissingWorktreeRegistrations, UnreadableWorktreeError } from "./git-worktree-state.js";
import { assertNotPreviewInstance } from "./preview-instance.js";
import { whileBranchClaimed } from "./git-accept-temp.js";

const isDir = (p: string) => {
  try { return statSync(p).isDirectory(); } catch { return false; }
};

// ── 删除任务时 worktree/分支的去留 ──────────────────────────────────────────
// navi 建 worktree 但**不随手删**;会删的只有这四条路:①验收通过(accept,合并后清理,
// 见 server/CLAUDE.md);②删除任务时勾选「连 worktree 和分支一起删」—— 就是这里;
// ③任务接力确认送达后自动清理(见文件末尾 discardMigratedWorkspace);④归档,按全局
// 设置 `archiveClean`(默认删,见 task-archive-cleanup.ts)。前两条由用户显式点出,
// 后两条是「这件事在本机结束了」的自动收尾。
// 任务行一没,`.worktrees/<taskId>` 目录和 `navi/<id8>` 分支
// 就成了没人认领的垃圾:用户在界面上再也看不见它们,只能靠自己记得去 git 里收拾。
//
// 两件东西各自独立存在:目录被手动 rm 过、分支还留着,或者反过来(分支被删、目录
// 还在),都很常见,所以检测和清理都按两项分别报。

/** 这个任务在仓库里还留着什么。目录检查是同步的,分支要问一次 git。 */
export async function detectTaskWorkspace(
  repoPath: string | null | undefined,
  taskId: string,
): Promise<TaskWorkspaceLeftover> {
  const repo = expandHome(repoPath);
  if (!repo) return { path: null, branch: null };
  const path = worktreePathFor(repo, taskId);
  const branch = await resolveWorktreeBranchName(repo, taskId);
  return {
    path: isDir(path) ? path : null,
    branch: (await localBranchExists(repo, branch)) ? branch : null,
  };
}

/**
 * 删掉这个任务的 worktree 目录和/或分支。写型 git 操作,走仓库锁排队。
 *
 * 先清理本任务已消失的目录登记，再删目录和分支；仍存在的目录会先确认 Git 状态，
 * 反链断开或无法读取时保留文件。其它任务的登记不参与这次清理。
 *
 * `force` 只在**用户看到第一次失败、又点了一次**时才为真:worktree 加 `--force`
 * (有未提交改动时),分支用 `-D`(未合并时)。默认路径一律不带 force,让 git 自己
 * 的安全检查兜住「这里面还有没提交/没合并的东西」。这跟验收清理那条「绝不用 -D」
 * 不冲突 —— 那条管的是自动流程,这里是用户看着报错仍然要求删掉。
 *
 * `forceBranchAt` 只放开分支那一半,worktree 照旧不带 `--force`:调用方已把这个提交存进
 * 别的 ref,所以未合并也能删;目录里没提交的改动则没有任何副本,那一半必须继续让 git 把关。
 * 删的条件是**分支此刻仍指向这个提交**,由 `update-ref -d <ref> <旧值>` 在 ref 锁里比较,
 * 不是删前再读一次:仓库锁只排得住本进程,外部终端、Git 钩子照样能在「存好恢复引用」之后
 * 往分支上再提交,那时 `-D` 会连同已经没有任何 ref 保着的新提交一起删掉(第 1 轮审查实测)。
 */
export async function discardTaskWorkspace(
  repoPath: string | null | undefined,
  taskId: string,
  opts: { worktree: boolean; branch: boolean; force?: boolean; forceBranchAt?: string },
): Promise<TaskWorkspaceDiscardResult> {
  const out: TaskWorkspaceDiscardResult = {
    path: null,
    branch: null,
    worktreeRemoved: false,
    branchDeleted: false,
    worktreeError: null,
    branchError: null,
  };
  const repo = expandHome(repoPath);
  if (!repo || (!opts.worktree && !opts.branch)) return out;
  return withRepoLock(repo, async () => {
    const path = worktreePathFor(repo, taskId);
    const branch = await resolveWorktreeBranchName(repo, taskId);
    await removeMissingWorktreeRegistrations(repo, { branch }).catch(() => {});
    if (opts.worktree && isDir(path)) {
      out.path = path;
      try {
        if (!opts.force) await assertReadableWorktree(path, repo, branch);
        await removeWorktree(repo, path, !!opts.force);
        out.worktreeRemoved = true;
      } catch (error) {
        // 这条报错是用户决定「要不要再点一次、这回带 force」的**唯一**依据,所以不能只
        // 转述 git 那句 "contains modified or untracked files" —— 强删掉的是哪几个文件,
        // 得当场摆在他面前。跟验收清理失败报的是同一份清单。
        const dirty = error instanceof UnreadableWorktreeError ? [] : await dirtyFilesAt(path);
        out.worktreeError = dirty.length > 0
          ? `${gitError(error)}（挡路的是这 ${dirty.length} 个文件：${listFiles(dirty)}）`
          : gitError(error);
      }
      await removeMissingWorktreeRegistrations(repo, { branch }).catch(() => {});
    }
    if (opts.branch && (await localBranchExists(repo, branch))) {
      out.branch = branch;
      try {
        // 预览实例的任务行指向**真仓库**,删分支跟删 worktree 一样是不可逆的真实破坏。
        // `removeWorktree` 自带这道闸,这里原来没有 —— 于是「目录已不在、只剩分支」的
        // 任务能从预览实例里把真分支删掉(审查确定性复现)。两样东西同一道闸。
        assertNotPreviewInstance("删任务分支");
        if (opts.forceBranchAt && !opts.force) await deleteBranchAt(repo, branch, opts.forceBranchAt);
        else await exec("git", ["-C", repo, "branch", opts.force ? "-D" : "-d", branch]);
        out.branchDeleted = true;
      } catch (error) {
        out.branchError = gitError(error);
      }
    }
    return out;
  });
}

/**
 * 分支仍指向 `expected` 才删(见 `discardTaskWorkspace` 的 `forceBranchAt`)。换掉 `git branch -D`
 * 之后,它原本替我们做的几件事都得自己补齐:
 *  · 检出保护:被检出的分支删掉后那个目录的 HEAD 就悬空了。不能「先看一眼没被检出、再删」—— 看完到删之间
 *    别处 `git switch` 了它,那份检出就停在一个不存在的分支上。所以先用不检出文件的临时 worktree 占住它
 *    (git-accept-temp.ts whileBranchClaimed:一个分支同时只能在一处检出,占着期间别处检出会被 git 当场拒),
 *    在占着的时候删;占不住(已被检出 / 开不出来)就不删。删完拆占位时那份临时 worktree 的 HEAD 悬空,
 *    `worktree remove --force` 照样拆得掉,它里面一个文件都没有。分支是符号引用别名时不占:git 检出别名会
 *    顺着解到它指向的分支(HEAD 永远不会指着别名本身),删别名悬空不了任何检出;而拿别名去开占位 worktree,
 *    git 会把它指向的那个分支再检出一份,不拒。但「它是别名」是删之前看的,看完它可能被换成同一提交上的
 *    普通分支再被检出(审查第 1 轮 F1 实测),旧值比较只比提交、认不出类型变了 —— 所以别名用 `symref-delete
 *    <引用> <原目标>` 删,并在同一个事务里 `verify <原目标> <expected>`:「仍是指向那个目标的别名、它还在
 *    expected 上」和「删」一起成立,类型一变或目标挪了 git 就拒,不删(与普通分支带旧值删同一个契约)。
 *  · 只删这个名字本身(`--no-deref`):不加时 update-ref 会顺着符号引用删掉它指向的分支 ——
 *    `navi/<id8>` 是指向 main 的别名时,删掉的是 main(第 2 轮审查实测)。
 *  · 删掉 `branch.<name>.*` 配置节:否则取回后同名分支重建,会沿用旧的上游等设置。
 */
async function deleteBranchAt(repo: string, branch: string, expected: string): Promise<void> {
  const checkout = await registeredCheckout(repo, branch);
  if (checkout.path) throw new Error(`分支 ${branch} 正被工作区 ${checkout.path} 检出，不能删除`);
  const ref = `refs/heads/${branch}`;
  const remove = () => exec("git", ["-C", repo, "update-ref", "--no-deref", "-d", ref, expected])
    .then(() => null, (error: unknown) => error);
  const alias = await exec("git", ["-C", repo, "symbolic-ref", "-q", ref]).then((r) => r.stdout.trim() || null, () => null);
  let failed: unknown;
  if (alias) {
    failed = await exec("git", ["-C", repo, "update-ref", "--no-deref", "--stdin"], { input: `verify ${alias} ${expected}\nsymref-delete ${ref} ${alias}\n` })
      .then(() => null, (error: unknown) => new Error(/unknown command/i.test(gitError(error))
        ? `分支 ${branch} 是指向 ${alias} 的别名，这个 git 版本没法在一个引用事务里核对并删掉它（需要 git 2.46 以上），没有删`
        : `分支 ${branch} 删之前是指向 ${alias} 的别名，删的那一刻已经不是了（${gitError(error)}），没有删；重试会按它现在的样子重新判断`));
  } else {
    const claim = await whileBranchClaimed(repo, branch, remove);
    if (!claim.claimed) {
      throw new Error(claim.checkedOutAt
        ? `分支 ${branch} 正被工作区 ${claim.checkedOutAt} 检出，不能删除`
        : `删除分支 ${branch} 之前没能占住它（${claim.message}），没有删`);
    }
    if (claim.cleanupError) console.warn(`[navi] 删分支 ${branch} 时用来占住它的临时 worktree ${claim.path} 没拆干净：${claim.cleanupError}`);
    failed = claim.value;
  }
  try {
    if (failed) throw failed;
    // 没有这个配置节时 git 报错退出,那正是「没什么要清」
    await exec("git", ["-C", repo, "config", "--remove-section", `branch.${branch}`]).catch(() => {});
  } catch (error) {
    const tip = await exec("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`])
      .then((r) => r.stdout.trim(), () => null);
    if (tip && tip !== expected) {
      throw new Error(`分支 ${branch} 在保存恢复起点之后又有了新提交（${tip.slice(0, 8)}），已保留，没有删掉恢复起点之外的改动`);
    }
    throw error;
  }
}

// ── 例外之三:任务接力(用户 2026-08-27 拍板)────────────────────────────────
// 「任务在哪儿,分支之类的才在哪儿」。任务接力到另一台机器并**确认送达**之后,本机
// 这份 worktree 和分支就是死物:代码全在对端了,留着只会让人误以为还能在本机接着改
// (真改了也是分叉)。所以确认送达后主动删,移回时对称地删掉持有机那一份。
//
// 「彻底传完才删」这条闸分两段,缺一不可:
//   ① 调用方先拿对端应答里的 `git: "bundle"` 证明代码确实落了地(旧版对端不报这个
//      字段 → 什么都不删);
//   ② 这里再让 git 自己把关——`git worktree remove` **不带 --force**,目录里还有
//      未提交/未跟踪的东西它就拒绝,我们照单保留并如实报出。
// 分支只能 -D:它的提交本来就没合回主线,-d 必然拒绝。走到那一步时代码已经在对端、
// 目录也已确认干净,提交不会丢。
export async function discardMigratedWorkspace(
  repoPath: string | null | undefined,
  taskId: string,
): Promise<{ removed: boolean; note: string }> {
  const repo = expandHome(repoPath);
  if (!repo) return { removed: false, note: "" };
  const path = worktreePathFor(repo, taskId);
  const hadDir = isDir(path);
  const wt = await discardTaskWorkspace(repo, taskId, { worktree: true, branch: false });
  if (hadDir && !wt.worktreeRemoved) {
    return {
      removed: false,
      note: `本机 worktree 里还有没随任务带走的东西,已原样保留:${path}（${wt.worktreeError ?? "删除失败"}）。确认不需要后手动删除。`,
    };
  }
  const br = await discardTaskWorkspace(repo, taskId, { worktree: false, branch: true, force: true });
  const parts: string[] = [];
  if (wt.worktreeRemoved) parts.push(`worktree ${path}`);
  if (br.branchDeleted) parts.push(`分支 ${br.branch}`);
  if (br.branch && !br.branchDeleted) {
    return {
      removed: wt.worktreeRemoved,
      note: `${parts.length ? `已清理本机 ${parts.join(" 和 ")};` : ""}分支 ${br.branch} 没能删掉（${br.branchError ?? "未知原因"}）,请手动确认。`,
    };
  }
  return {
    removed: true,
    note: parts.length ? `已清理本机 ${parts.join(" 和 ")}——代码现在只在对端。` : "",
  };
}
