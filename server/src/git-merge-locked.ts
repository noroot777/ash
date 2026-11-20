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
// 分支是目标分支（不能挪到另开的临时检出里合，审查第 1 轮 F3）。合并记在 git 目录里的东西（`ORIG_HEAD`、
// `SQUASH_MSG`、没中止成的合并状态）落在私有目录里，拆之前搬回项目（carryBack）。项目 HEAD 的 reflog 不会多出
// 这次合并那一行（目标分支自己的 reflog 有）。
//
// 私有 HEAD 指着目标分支期间，它也算「检出在一处」：别处 `git switch <目标>` 会被 git 拒，与推送档占住分支同一个效果。
//
// 私有 HEAD 只是换了一个 git 目录，下面三样不跟着换，所以都在持锁之后、动手之前补上（审查第 3 轮）：
//  · 建、拆私有 HEAD 是 Navi 自己的准备动作，不调用户钩子（`reference-transaction` 会在 `worktree add`、
//    `symbolic-ref` 时跑；合并预览档的发布整段都不许跑项目程序）。合并本身那几条照旧调钩子。
//  · 原检出里没做完的操作（等着提交的合并、挑拣、变基……）记在项目的 git 目录里，私有目录看不见：
//    持锁后先看项目的，有就拒（原生 `git merge` 也会拒）。反过来合并失败留在私有目录里的合并状态，
//    拆之前搬回项目，`git merge --abort` 在项目目录里照样能用。
//  · 依赖 git 目录位置的配置（`includeIf "gitdir:…"` 精确到项目那份 .git 时）换了目录就不生效，钩子目录、
//    提交身份就可能悄悄换掉：就地合并前比一遍项目目录和私有 HEAD 下的有效配置，不一样就拒。按检出的配置
//    （`config.worktree`）和稀疏检出规则 `git worktree add` 会照抄，比完也一致。
import { copyFile, mkdtemp, open, rename, rm } from "node:fs/promises";
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

let noHooks: Promise<string> | null = null;
/** 放在 git 子命令前：钩子目录指向一个空目录、fsmonitor 关掉 —— Navi 自己的动作不调项目程序。 */
export const noUserPrograms = async () => {
  noHooks ??= mkdtemp(join(tmpdir(), "navi-no-hooks-"));
  return ["-c", `core.hooksPath=${await noHooks}`, "-c", "core.fsmonitor=false"];
};

/** 原检出里没做完的操作留下的记号（都在每个检出自己的 git 目录里）。 */
const PENDING = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_LOG"];
async function pendingOperation(repo: string): Promise<string | null> {
  const paths = (await exec("git", ["-C", repo, "rev-parse", "--path-format=absolute", ...PENDING.flatMap((name) => ["--git-path", name])])).stdout.trim().split("\n");
  const found = PENDING.filter((_, i) => paths[i] && existsSync(paths[i]!));
  return found.length ? found.join("、") : null;
}

export type HeldCheckout = {
  /** 私有 git 目录（HEAD 指着目标分支）。 */
  gitDir: string;
  /** 项目目录的真索引。 */
  index: string;
  /** 把 `from` 这份索引换成真索引（换上之后索引锁就不再归我们）。 */
  install(from: string): Promise<void>;
};

export type HoldRefusal = { held: false; stage: "locked" | "moved" | "busy" | "failed"; message: string };

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
  let busy: string | null = null;
  try {
    // 持锁之后才核：这之后谁也换不了这个检出的 HEAD，核到的就是写完之前一直不变的样子。
    const head = (await exec("git", ["-C", repo, "symbolic-ref", "-q", "HEAD"]).catch(() => null))?.stdout.trim() || null;
    const now = await rev(repo, ref);
    if (head !== ref || !now || (at !== null && now !== at)) {
      outcome = { held: false, stage: "moved", message: `项目目录 ${repo} 已经不在 ${branch}${at ? ` 的 ${at.slice(0, 12)}` : ""} 上了（现在是`
        + `${head ? `分支 ${head.replace(/^refs\/heads\//, "")}` : "一个游离的提交"}${now && at && now !== at ? `，${branch} 在 ${now.slice(0, 12)}` : ""}）` };
    } else if ((busy = await pendingOperation(repo))) {
      outcome = { held: false, stage: "busy", message: `项目目录 ${repo} 里还有一场没做完的 git 操作（${busy}）` };
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
      const failed = await removeTemporaryWorktree(repo, temp, await noUserPrograms());
      if (failed) console.warn(`[navi] 写目标分支用的私有 HEAD ${temp.path} 没拆干净：${failed}`);
    }
  }
  return outcome.held ? { ...outcome, warning: warnings.length ? warnings.join("；") : null } : outcome;
}

/** 私有 HEAD：不检出文件的临时 worktree，登记目录里的 HEAD 改成指着 `ref` 的符号引用。 */
async function privateHead(repo: string, ref: string, at: string): Promise<{ temp: TemporaryWorktree; gitDir: string } | { message: string }> {
  const root = mkdtempSync(join(tmpdir(), "navi-hold-"));
  const temp = { root, path: join(root, "head") };
  const sealed = await noUserPrograms();
  try {
    await exec("git", ["-C", repo, ...sealed, "worktree", "add", "--detach", "--no-checkout", "--quiet", temp.path, at]);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    return { message: `建不出写目标分支用的私有 HEAD（${gitError(error)}）` };
  }
  try {
    const gitDir = (await exec("git", ["-C", temp.path, "rev-parse", "--absolute-git-dir"])).stdout.trim();
    await exec("git", ["--git-dir", gitDir, ...sealed, "symbolic-ref", "HEAD", ref]);
    return { temp, gitDir };
  } catch (error) {
    await removeTemporaryWorktree(repo, temp, sealed);
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
      const drift = await configDrift(repo, git);
      if (drift) {
        return fail(`项目目录 ${repo} 的 git 配置里有几项要看 git 目录的位置才生效（${drift}，多半是精确到这份 .git 的 \`includeIf "gitdir:…"\`），`
          + "Navi 就地合并时没法保证它们原样生效（钩子、提交身份可能悄悄换掉），所以这次没合并，目标分支和工作区都没动。"
          + "在项目目录里手动合并，或者把这几项改成不依赖 git 目录位置之后再验收。");
      }
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
      const lost = await carryBack(repo, gitDir);
      return lost ? withHoldWarning(result, lost) : result;
    });
    if (held.held) return withHoldWarning(held.value, held.warning);
    if (held.stage === "busy") {
      return fail(`${held.message}，目标分支 ${targetBranch} 就检出在那里，这次没合并，目标分支和工作区都没动；`
        + "先在项目目录里把它做完或中止（`git status` 会提示怎么做），再验收。");
    }
    return held.stage === "moved"
      ? fail(`合并的同时${held.message}，这次没动它，重新验收即可。`)
      : fail(`目标分支 ${targetBranch} 检出在项目目录 ${repo}，但没能持住那份检出（${held.message}），这次没合并，目标分支和工作区都没动；处理完再验收。`);
  } catch (error) {
    return fail(`没能核对项目目录 ${repo}（${gitError(error)}），这次没合并，目标分支和工作区都没动。`);
  } finally {
    await rm(scratch, { force: true }).catch(() => {});
  }
}

/** 项目目录和私有 HEAD 下的有效配置（含 include）不一样的那些键；一样就是 null。 */
async function configDrift(repo: string, git: GitIn): Promise<string | null> {
  const entries = async (run: GitIn) => (await run(["config", "--list", "--includes", "-z"])).stdout.split("\0").filter(Boolean);
  const [project, held] = await Promise.all([entries(gitIn(repo)), entries(git)]);
  const remaining = [...held];
  const differ = new Set<string>();
  for (const entry of project) {
    const at = remaining.indexOf(entry);
    if (at >= 0) remaining.splice(at, 1);
    else differ.add(entry.split("\n")[0]!);
  }
  for (const entry of remaining) differ.add(entry.split("\n")[0]!);
  return differ.size ? [...differ].slice(0, 5).join("、") + (differ.size > 5 ? ` 等 ${differ.size} 项` : "") : null;
}

/** 就地合并留在私有 git 目录里、原生合并会留在项目里的东西。 */
const STATE_FILES = ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "MERGE_RR", "SQUASH_MSG"];
const STATE_REFS = ["ORIG_HEAD", "AUTO_MERGE"];

/**
 * 拆私有 HEAD 之前把这些搬回项目：合并前的位置、squash 的默认提交说明，以及合并失败又没中止成时的合并状态
 * （搬回来 `git merge --abort` 在项目目录里才用得了）。搬不回去的列出来交给调用方告诉用户。
 */
async function carryBack(repo: string, gitDir: string): Promise<string | null> {
  const lost: string[] = [];
  const sealed = await noUserPrograms();
  for (const name of STATE_REFS) {
    const at = (await exec("git", ["--git-dir", gitDir, "rev-parse", "--verify", "--quiet", name]).catch(() => null))?.stdout.trim();
    if (at) await exec("git", ["-C", repo, ...sealed, "update-ref", "--no-deref", name, at]).catch((error: unknown) => lost.push(`${name}（${gitError(error)}）`));
  }
  for (const name of STATE_FILES) {
    const from = join(gitDir, name);
    if (existsSync(from)) await copyFile(from, await gitPath(repo, name)).catch((error: unknown) => lost.push(`${name}（${gitError(error)}）`));
  }
  return lost.length ? `合并留在 git 目录里的 ${lost.join("、")} 没能搬回项目目录，它们在项目里可能是旧的` : null;
}
