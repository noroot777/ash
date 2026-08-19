import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitError } from "./git.js";
import { literalPathspec } from "./git-status.js";
import { assertPathShape, gateScmPaths, ScmOperationError } from "./scm-paths.js";
import { withRepoLock } from "./repo-lock.js";

// ── 工作区 SCM 的写侧：暂存 / 取消暂存 / 丢弃 / 提交 ─────────────────────────
//
// 三条贯穿全文件的决定：
//
// ① **只按显式路径清单动手，不支持「全部」通配。** 面板上看到的状态和点下按钮之间
//    隔着网络往返和一个还在干活的 agent，中间新冒出来的文件不该被这次点击波及。
//    「丢弃全部」由前端把当时列出的路径逐条传上来——用户丢掉的正是他看见的那些。
//    这条不是靠自觉：每个写操作都在锁内过 `gateScmPaths`，路径必须出现在此刻的
//    git status 里。目录（`dir`、`.`）永远不在 status 里，所以「一次丢掉整个目录」
//    在那道闸上就被关掉了——`:(literal)` 只关 glob，关不掉目录递归。
//
// ② **写操作一律走 withRepoLock。** index 虽然每个 worktree 一份，refs 却是全仓共用：
//    提交要写 refs，和验收合并撞车会互相拆台（`repo-lock.ts` 顶部有完整原因）。
//    暂存/丢弃本身不写 refs，但让它们和验收排同一条队是有意的——验收合并到一半时
//    读到的工作区状态本来就不该拿来操作。白名单闸的那次 status 读也必须在锁内。
//
// ③ **不做 push / pull / fetch / 切分支。** 前两个是外发到远程，后两个会把正在干活的
//    agent 的脚下抽掉（harness 的整个 worktree 模型建立在「一个任务一条分支」上）。
//    面板的职责边界是「看清楚并收尾本地改动」，越过这条线的动作应该由用户显式发起。

const exec = promisify(execFile);

export { ScmOperationError };

export interface ScmWriteResult {
  ok: true;
  /** 实际处理的路径数——前端据此报「已暂存 3 个文件」。 */
  affected: number;
}

async function git(root: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", ["-C", root, ...args], { maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    throw new ScmOperationError(gitError(error), 409);
  }
}

/** pathspec 分批：一次塞几千个路径会顶爆命令行长度上限（Windows 约 32K）。 */
async function inBatches(paths: string[], size: number, run: (batch: string[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < paths.length; i += size) await run(paths.slice(i, i + size));
}

const BATCH = 200;

export async function stagePaths(root: string, repoPath: string | null, paths: readonly string[]): Promise<ScmWriteResult> {
  const targets = assertPathShape(paths);
  return withRepoLock(repoPath, async () => {
    await gateScmPaths(root, { paths: targets });
    // `add -A` 而不是 `add`：只有前者会把「文件被删了」也记进索引，否则删除永远暂存不上。
    await inBatches(targets, BATCH, (batch) => git(root, ["add", "-A", "--", ...batch.map(literalPathspec)]));
    return { ok: true as const, affected: targets.length };
  });
}

/**
 * 取消暂存。
 *
 * **重命名要连原路径一起传**：`git mv old new` 之后索引里是两条记录（`old` 删除、`new`
 * 新增，status 合成一条 R 显示给用户）。只 restore `new`，索引里那条 `old` 的删除会原地
 * 留下——用户看到的是「取消暂存成功」，下一次提交却只提交了一个删除。前端 `pathsOf`
 * 因此对每个条目同时送 `path` 和 `origPath`。
 */
export async function unstagePaths(root: string, repoPath: string | null, paths: readonly string[]): Promise<ScmWriteResult> {
  const targets = assertPathShape(paths);
  return withRepoLock(repoPath, async () => {
    await gateScmPaths(root, { paths: targets });
    await inBatches(targets, BATCH, async (batch) => {
      const pathspecs = batch.map(literalPathspec);
      try {
        await git(root, ["restore", "--staged", "--", ...pathspecs]);
      } catch (error) {
        // 还没有任何提交的仓库没有 HEAD 可以 restore 回去，此时「取消暂存」就是把
        // 条目从索引里摘掉（文件留在工作区，于是它回到未跟踪）。
        if (!/HEAD|initial commit|unknown revision/i.test((error as Error).message)) throw error;
        await git(root, ["rm", "--cached", "-r", "--", ...pathspecs]);
      }
    });
    return { ok: true as const, affected: targets.length };
  });
}

/**
 * 丢弃工作区改动。**不可逆**——`git restore` 覆盖回 HEAD/索引的版本，`git clean` 直接
 * 删文件，两者都不进 reflog、不进 stash，事后没有任何找回的路子。所以：
 *
 *   • 未跟踪文件必须由调用方在 `deleteUntracked` 里显式点名，混在一起传不会被删。
 *     「改回原样」和「把文件删掉」是两种后果，不该共用一个按钮的语义。
 *   • 冲突中的文件一律拒绝：`git restore` 对未合并条目的行为取决于给没给 --ours/
 *     --theirs，猜错就是把用户已经解了一半的冲突抹掉。让他先解决冲突。
 */
export async function discardPaths(
  root: string,
  repoPath: string | null,
  paths: readonly string[],
  deleteUntracked: readonly string[] = [],
): Promise<ScmWriteResult> {
  const tracked = paths.length ? assertPathShape(paths) : [];
  const untracked = deleteUntracked.length ? assertPathShape(deleteUntracked) : [];
  if (!tracked.length && !untracked.length) throw new ScmOperationError("没有指定文件");
  return withRepoLock(repoPath, async () => {
    // 一次读，两道闸：路径得在列表里，且不许是冲突中的文件。锁内读到的才是即将被操作的那份。
    await gateScmPaths(root, { paths: [...tracked, ...untracked], rejectConflicted: true });
    if (tracked.length) {
      // `--worktree` 而不是连 `--staged` 一起：面板上「丢弃」丢的是未暂存那一份，
      // 已经暂存的内容要先取消暂存再丢——和 VSCode 一致，也让两步都可以停在中间。
      await inBatches(tracked, BATCH, (batch) =>
        git(root, ["restore", "--worktree", "--", ...batch.map(literalPathspec)]));
    }
    if (untracked.length) {
      // `-f` 是必须的（clean 默认拒绝动手），`-d` 不给：只删点名的文件，不递归清目录。
      await inBatches(untracked, BATCH, (batch) =>
        git(root, ["clean", "-f", "--", ...batch.map(literalPathspec)]));
    }
    return { ok: true as const, affected: tracked.length + untracked.length };
  });
}

export interface ScmCommitOptions {
  message: string;
  /** 提交前把这些路径暂存上——对应面板上「没有暂存内容时直接提交」。 */
  stagePaths?: readonly string[];
  amend?: boolean;
}

export interface ScmCommitResult {
  ok: true;
  sha: string;
  subject: string;
}

export async function commitWorkspace(
  root: string,
  repoPath: string | null,
  options: ScmCommitOptions,
): Promise<ScmCommitResult> {
  const message = options.message.trim();
  if (!message) throw new ScmOperationError("提交信息不能为空");
  const toStage = options.stagePaths?.length ? assertPathShape(options.stagePaths) : [];
  return withRepoLock(repoPath, async () => {
    if (toStage.length) {
      await gateScmPaths(root, { paths: toStage });
      await inBatches(toStage, BATCH, (batch) => git(root, ["add", "-A", "--", ...batch.map(literalPathspec)]));
    }
    // 消息走 stdin（`-F -`）而不是 argv：提交信息里的换行、引号、以及 Windows 上的
    // 命令行长度上限都不必再操心，而且它不会出现在进程列表里。
    await new Promise<void>((resolve, reject) => {
      const child = execFile("git", ["-C", root, "commit", ...(options.amend ? ["--amend"] : []), "-F", "-"], {
        maxBuffer: 8 * 1024 * 1024,
      }, (error) => (error ? reject(new ScmOperationError(gitError(error), 409)) : resolve()));
      child.stdin?.end(`${message}\n`);
    });
    const { stdout } = await exec("git", ["-C", root, "log", "-1", "--format=%H%x1f%s"]);
    const [sha, subject] = stdout.trim().split("\x1f");
    return { ok: true as const, sha, subject: subject ?? message };
  });
}
