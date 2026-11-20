// 目标分支就检出在项目目录时，验收往它上面写（合并、合并预览档的发布）的共享落地层。
//
// 不变量：写的只有选定的目标分支、和检出着它的项目目录；写的期间项目目录的 HEAD 换不了。两把锁一起持着：
//  · `index.lock` —— 挡住切已有分支、提交、合并（git 自己的约定，拿不到就退）；
//  · `HEAD.lock` —— 挡住不拿索引锁、只改 HEAD 的那几条（`git switch -c`、`git checkout -b`、`git symbolic-ref`）。
//    只持索引锁时，它们能在核完之后把 HEAD 换成同一提交上的新分支，「对届时的 HEAD 写」的合并就落进那个分支
//    （审查第 2 轮 F1 实测：快进、普通合并、squash、不提交四档都中）。
// 持着项目的 `HEAD.lock`，git 就没法经它去挪目标分支（更新引用要顺带记 HEAD 的 reflog，得拿这把锁）。所以写目标
// 分支经一个**私有 HEAD**：一份不检出文件的临时 worktree 的登记目录，HEAD 是指着目标分支的符号引用，对象、引用、
// 配置、钩子都与仓库共用。命令带 `GIT_DIR=<它>`、`GIT_WORK_TREE=<项目目录>`、`GIT_INDEX_FILE=<真索引旁的副本>` 跑：
// 写的引用只可能是目标分支（私有 HEAD 指着它，谁也改不了），文件写进项目目录，索引写进副本，最后把副本换成真索引
// （与 git 自己提交索引同一个动作，换上那一刻索引锁也放了）。
//
// 合并本身还是原来那几条命令、就在项目目录里跑：钩子的工作目录是项目目录、看得到项目里被忽略的本地依赖、看到的
// 分支是目标分支（不能挪到另开的临时检出里合，审查第 1 轮 F3）。这几样记在私有目录里，落完搬回项目：`ORIG_HEAD`、
// `SQUASH_MSG`。项目 HEAD 的 reflog 不会多出这次合并那一行（目标分支自己的 reflog 有）。
//
// 私有 HEAD 指着目标分支期间，它也算「检出在一处」：别处 `git switch <目标>` 会被 git 拒，与推送档占住分支同一个效果。
import { copyFile, open, rename, rm } from "node:fs/promises";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileText as exec } from "./exec.js";
import { gitError, porcelainFiles } from "./git.js";
import { removeTemporaryWorktree, type TemporaryWorktree } from "./git-accept-temp.js";
import type { TaskMergeResult } from "./git-accept.js";

/** 在某个检出里跑一条 git（`-C` 和环境已经定好）。 */
export type GitIn = (args: string[]) => Promise<{ stdout: string }>;
export const gitIn = (cwd: string, env?: NodeJS.ProcessEnv): GitIn =>
  (args) => exec("git", ["-C", cwd, ...args], env ? { env } : {});

const rev = async (repo: string, ref: string) =>
  (await exec("git", ["-C", repo, "rev-parse", "--verify", "--quiet", ref]).catch(() => null))?.stdout.trim() || null;
const gitPath = async (repo: string, name: string) =>
  (await exec("git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-path", name])).stdout.trim();

export type HeldCheckout = {
  /** 私有 git 目录（HEAD 指着目标分支）。 */
  gitDir: string;
  /** 项目目录的真索引。 */
  index: string;
  /** 把 `from` 这份索引换成真索引（换上之后索引锁就不再归我们）。 */
  install(from: string): Promise<void>;
};

export type HoldRefusal = { held: false; stage: "locked" | "moved" | "failed"; message: string };

/**
 * 持住项目目录 `repo` 的检出（两把锁 + 私有 HEAD，见文件头），核过 HEAD 指着 `branch`、在 `at` 上（不给就不核
 * 提交）再跑 `fn`。拿不到锁 / HEAD 不对 / 私有 HEAD 建不出来，都在动任何东西之前拒。
 */
export async function holdCheckout<T>(repo: string, branch: string, at: string | null,
  fn: (held: HeldCheckout) => Promise<T>): Promise<{ held: true; value: T; warning: string | null } | HoldRefusal> {
  const ref = `refs/heads/${branch}`;
  const index = await gitPath(repo, "index");
  const headPath = await gitPath(repo, "HEAD");
  const lock = `${index}.lock`;
  const headLock = `${headPath}.lock`;
  const indexHandle = await open(lock, "wx").catch(() => null);
  if (!indexHandle) return { held: false, stage: "locked", message: `${lock} 已经存在：有别的 git 命令正在用这个检出` };
  await indexHandle.close();
  let indexOurs = true;
  const headHandle = await open(headLock, "wx").catch(() => null);
  if (!headHandle) {
    await rm(lock, { force: true }).catch(() => {});
    return { held: false, stage: "locked", message: `${headLock} 已经存在：有别的 git 命令正在改这个检出的 HEAD` };
  }
  await headHandle.close();
  const warnings: string[] = [];
  let temp: TemporaryWorktree | null = null;
  let outcome: { held: true; value: T } | HoldRefusal;
  try {
    // 持锁之后才核：这之后谁也换不了这个检出的 HEAD，核到的就是写完之前一直不变的样子。
    const head = (await exec("git", ["-C", repo, "symbolic-ref", "-q", "HEAD"]).catch(() => null))?.stdout.trim() || null;
    const now = await rev(repo, ref);
    if (head !== ref || !now || (at !== null && now !== at)) {
      outcome = { held: false, stage: "moved", message: `项目目录 ${repo} 已经不在 ${branch}${at ? ` 的 ${at.slice(0, 12)}` : ""} 上了（现在是`
        + `${head ? `分支 ${head.replace(/^refs\/heads\//, "")}` : "一个游离的提交"}${now && at && now !== at ? `，${branch} 在 ${now.slice(0, 12)}` : ""}）` };
    } else {
      const made = await privateHead(repo, ref, now);
      if ("message" in made) outcome = { held: false, stage: "failed", message: made.message };
      else {
        temp = made.temp;
        const value = await fn({
          gitDir: made.gitDir,
          index,
          install: async (from) => {
            await copyFile(from, lock);
            await rename(lock, index);
            indexOurs = false;
          },
        });
        outcome = { held: true, value };
      }
    }
  } finally {
    // 先放索引锁（没换上新索引时），再放 HEAD 锁：两把都是我们建的空文件，放 = 删。
    if (indexOurs) await rm(lock, { force: true }).catch((error: unknown) => warnings.push(`${lock} 没能删掉（${gitError(error)}），请手动删掉`));
    await rm(headLock, { force: true }).catch((error: unknown) => warnings.push(`${headLock} 没能删掉（${gitError(error)}），请手动删掉`));
    if (temp) {
      const failed = await removeTemporaryWorktree(repo, temp);
      if (failed) console.warn(`[navi] 写目标分支用的私有 HEAD ${temp.path} 没拆干净：${failed}`);
    }
  }
  return outcome.held ? { ...outcome, warning: warnings.length ? warnings.join("；") : null } : outcome;
}

/** 私有 HEAD：不检出文件的临时 worktree，登记目录里的 HEAD 改成指着 `ref` 的符号引用。 */
async function privateHead(repo: string, ref: string, at: string): Promise<{ temp: TemporaryWorktree; gitDir: string } | { message: string }> {
  const root = mkdtempSync(join(tmpdir(), "navi-hold-"));
  const temp = { root, path: join(root, "head") };
  try {
    await exec("git", ["-C", repo, "worktree", "add", "--detach", "--no-checkout", "--quiet", temp.path, at]);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    return { message: `建不出写目标分支用的私有 HEAD（${gitError(error)}）` };
  }
  try {
    const gitDir = (await exec("git", ["-C", temp.path, "rev-parse", "--absolute-git-dir"])).stdout.trim();
    await exec("git", ["--git-dir", gitDir, "symbolic-ref", "HEAD", ref]);
    return { temp, gitDir };
  } catch (error) {
    await removeTemporaryWorktree(repo, temp);
    return { message: `建不出写目标分支用的私有 HEAD（${gitError(error)}）` };
  }
}

/** 持住期间留下的善后问题（锁文件没删掉）：失败回执里带上；成功时合并已经落下，记一条日志。 */
export function withHoldWarning(result: TaskMergeResult, warning: string | null): TaskMergeResult {
  if (!warning) return result;
  if (!result.ok) return { ...result, message: `${result.message}（另外 ${warning}）` };
  console.warn(`[navi] 验收落地之后：${warning}`);
  return result;
}

type Names = { sourceBranch: string; targetBranch: string };

/**
 * 持住项目目录的检出、核过 HEAD 指着目标分支、工作区干净，再让 `run` 经私有 HEAD 在项目目录里合并（见文件头）。
 * `run` 拿到的 git 写的引用只可能是目标分支，文件写进项目目录，索引写进副本；合完把副本换成真索引。
 */
export async function mergeInLockedCheckout(repo: string, names: Names, run: (git: GitIn) => Promise<TaskMergeResult>): Promise<TaskMergeResult> {
  const { targetBranch } = names;
  const fail = (message: string): TaskMergeResult => ({ ok: false, reason: "merge_failed", message, ...names, targetPath: repo });
  const scratch = `${await gitPath(repo, "index")}.navi-merge-${process.pid}-${Date.now()}`;
  try {
    const held = await holdCheckout(repo, targetBranch, null, async ({ gitDir, index, install }): Promise<TaskMergeResult> => {
      // 放在真索引旁边：拆分索引（core.splitIndex）的 sharedindex 文件 git 按「索引所在目录」找。
      await copyFile(index, scratch).catch(() => {});
      const git = gitIn(repo, { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: repo, GIT_INDEX_FILE: scratch });
      // 与锁外那道「工作区干净」同一个口径（git status，未跟踪的也算）。
      const dirtyFiles = porcelainFiles((await git(["status", "--porcelain"])).stdout);
      if (dirtyFiles.length > 0) {
        return { ok: false, reason: "target_dirty", ...names, targetPath: repo, dirtyFiles,
          message: `目标分支 ${targetBranch} 检出在项目目录，合并的同时那里有了没提交的改动；这次没合并，目标分支和工作区都没动。` };
      }
      let result: TaskMergeResult;
      try { result = await run(git); } catch (error) {
        result = fail(`在项目目录 ${repo} 里合并时出错（${gitError(error)}），Navi 没有替你复位；在项目目录里 \`git status\` 核对后手动处理。`);
      }
      // 那份索引就是 git 按这次合并维护好的、与工作区文件对应的一份（冲突中止、复位之后也一样），先换上去。
      try { await install(scratch); } catch (error) {
        return fail(`合并已经在项目目录 ${repo} 里跑完（${result.ok ? "成功" : result.message}），但换上它维护的索引时失败了`
          + `（${error instanceof Error ? error.message : String(error)}），索引还停在合并之前；Navi 没有替你复位，在项目目录里 \`git status\` 核对后`
          + "用 `git reset -q`（只改索引）或手动处理。");
      }
      await carryBack(repo, gitDir);
      return result;
    });
    if (held.held) return withHoldWarning(held.value, held.warning);
    return held.stage === "moved"
      ? fail(`合并的同时${held.message}，这次没动它，重新验收即可。`)
      : fail(`目标分支 ${targetBranch} 检出在项目目录 ${repo}，但没能持住那份检出（${held.message}），这次没合并，目标分支和工作区都没动；处理完再验收。`);
  } catch (error) {
    return fail(`没能核对项目目录 ${repo}（${gitError(error)}），这次没合并，目标分支和工作区都没动。`);
  } finally {
    await rm(scratch, { force: true }).catch(() => {});
  }
}

/** 就地合并留在 git 目录里的东西（合并前的位置、squash 的默认提交说明）从私有目录搬回项目。 */
async function carryBack(repo: string, gitDir: string): Promise<void> {
  const orig = (await exec("git", ["--git-dir", gitDir, "rev-parse", "--verify", "--quiet", "ORIG_HEAD"]).catch(() => null))?.stdout.trim();
  if (orig) await exec("git", ["-C", repo, "update-ref", "--no-deref", "ORIG_HEAD", orig]).catch(() => {});
  const squash = join(gitDir, "SQUASH_MSG");
  if (existsSync(squash)) await copyFile(squash, await gitPath(repo, "SQUASH_MSG")).catch(() => {});
}
