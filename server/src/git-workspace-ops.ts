import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { gitError } from "./git.js";
import { literalPathspec, readScmStatus, type ScmChange, type ScmStatus } from "./git-status.js";
import { assertPathShape, gateScmPaths, ScmOperationError } from "./scm-paths.js";
import { withRepoLock } from "./repo-lock.js";

// ── 工作区 SCM 的写侧：暂存 / 取消暂存 / 丢弃 / 提交 ─────────────────────────
//
// 四条贯穿全文件的决定：
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
// ③ **改到一半停下时，已经生效的那部分必须如实报账。** 三种情形都真实存在：路径多到
//    顶爆命令行长度上限（Windows 约 32K）只能拆成几次 git 调用，前一批成功后一批失败；
//    **一次 git 调用内部**做到哪算哪（pathspec 是逐个文件处理的，前几个已经改完才在
//    后面某个上失败）；以及提交——预暂存写完索引之后 commit 才跑，hook 拒绝时文件已经
//    在索引里了。git 不提供跨调用的事务，`git clean` 删掉的更是不进 reflog 也不进 stash。
//    这时候只回一句「失败」，用户会合理地以为整次操作没做，下一次提交就把没打算带的
//    东西带上了。所以这两处都抛 `ScmPartialError`，带上「哪些已经生效」——而这份清单是
//    失败后**重读状态**逐条算出来的，不是「跑完几批」（见 `runAll`）——路由再连同刷新
//    后的状态回给面板。
//
// ④ **不做 push / pull / fetch / 切分支。** 前两个是外发到远程，后两个会把正在干活的
//    agent 的脚下抽掉（harness 的整个 worktree 模型建立在「一个任务一条分支」上）。
//    面板的职责边界是「看清楚并收尾本地改动」，越过这条线的动作应该由用户显式发起。

const exec = promisify(execFile);

export { ScmOperationError };

/**
 * 一次操作**没整个做完，但已经改动了工作区**。
 *
 * `done` 里的路径已经生效了，不是「本来要做的」。消息由抛出点自己写全，因为它会原样
 * 出现在用户眼前那条横幅上，而「暂存了 200 个但第 201 个失败」和「文件全暂存上了、
 * 提交没成」要说的是两件不同的事，套一个模板说不清。状态用 409：请求本身没错，是这次
 * 操作没能整个做完，客户端拿到清单后该做的是重看一眼状态、决定要不要重试剩下的。
 */
export class ScmPartialError extends ScmOperationError {
  constructor(
    message: string,
    readonly done: readonly string[],
    readonly pending: readonly string[],
  ) {
    super(message, 409);
    this.name = "ScmPartialError";
  }
}

/** git 的报错常有三四行（error/fatal 各一行），这条消息要进一句提示语，压成一行。 */
function oneLine(text: string): string {
  const joined = text.split("\n").map((line) => line.trim()).filter(Boolean).join("；");
  return joined.length > 300 ? `${joined.slice(0, 300)}…` : joined;
}

export interface ScmWriteResult {
  ok: true;
  /** 实际处理的路径数——前端据此报「已暂存 3 个文件」。 */
  affected: number;
}

/**
 * 拿到仓库锁之后、动手之前**原子占住这个任务**，返回一个释放函数（写操作在 finally 里
 * 调它）。
 *
 * 路由层进门时查过一次任务在不在飞，但排 `withRepoLock` 可能等上几秒（验收合并正占着
 * 锁），这几秒里 agent 完全可能被唤醒开跑——进门时的判断到动手时已经过期。而**再查一次
 * 也不够**：查是观察式的，任务启动那把锁不需要仓库锁，查完到 git 命令真跑起来之间，另
 * 一次启动仍能合法插进来（第 2 轮审查确定性复现）。所以这一步必须是「占住」而不是
 * 「看一眼」：占不到就抛，由路由翻译成「需要 force」。
 */
export type ScmRelease = (() => void) | void;
export type ScmGuard = () => ScmRelease | Promise<ScmRelease>;

/** 占住 → 干活 → 无论成败都还回去。四个写操作的公共骨架。 */
async function guarded<T>(guard: ScmGuard | undefined, run: () => Promise<T>): Promise<T> {
  const release = await guard?.();
  try {
    return await run();
  } finally {
    release?.();
  }
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
const BATCH = 200;

interface ScmBatchGroup {
  paths: readonly string[];
  run: (batch: string[]) => Promise<unknown>;
  /**
   * 失败之后按**重读到的状态**回答「这一条到底动没动」。
   *
   * 判据一律写成「这条路径还在不在它操作前所在的那个分组里」：不在了 = 这次操作对它
   * 生效了。没给这个函数的分组只能退回按批计数（见 `runAll`）。
   *
   * 冲突那一档不必在这里各写一遍：还留在 `merge` 里就一律算没动，`runAll` 统一挡在
   * 所有判据之前。
   */
  done?: (path: string, after: ScmStatus) => boolean;
}

/** 状态里的一组改动含不含这条路径。重命名的原路径也算——取消暂存会连它一起点名。 */
const listed = (changes: readonly ScmChange[], path: string): boolean =>
  changes.some((change) => change.path === path || change.origPath === path);

/**
 * 按顺序跑完若干组路径，返回处理总数。
 *
 * 一条都没生效就原样把错误抛出去（那才是「整次操作没生效」，多包一层只会让消息更绕）；
 * 已经落地过至少一条才升级成 `ScmPartialError`。分组之间也接着算——丢弃是先 restore
 * 已跟踪、再 clean 未跟踪，clean 中途炸了的时候，前面那些 restore 同样已经生效。
 *
 * **「已经生效的是哪些」不能拿批次数当答案。** git 对 pathspec 是逐个文件处理的，一批
 * 之内做到哪算哪：`git restore --worktree a.txt locked/b.txt` 完全可能已经把 a.txt 覆盖
 * 回去了，才在 b.txt 上撞见 Permission denied。按批计数这时 `done === 0`，于是抛的是
 * 一句普通失败——用户看到的是「操作没成功」，而 a.txt 的改动已经不可逆地没了
 * （第 1 轮审查在函数级和路由级都复现）。所以失败之后**重读一次状态**，按每条路径的
 * 实际结果报账；重读不出来或状态被截断（`truncated` 时「不在列表里」不能证明它动过）
 * 才退回按批计数，那是个下限而不是答案。
 *
 * `note` 是给这次操作补一句后果说明（丢弃的「找不回来」），随消息一起进横幅。
 */
async function runAll(
  root: string,
  action: string,
  groups: readonly ScmBatchGroup[],
  note?: string,
): Promise<number> {
  const all = groups.flatMap((group) => [...group.paths]);
  const batched = new Set<string>();
  try {
    for (const group of groups) {
      for (let i = 0; i < group.paths.length; i += BATCH) {
        const batch = group.paths.slice(i, i + BATCH);
        await group.run([...batch]);
        for (const path of batch) batched.add(path);
      }
    }
  } catch (error) {
    // 两样证据取并集：跑完的整批是**事实**（它确实返回成功了），重读的状态补上批内
    // 那一半。少算一条就是把一次不可逆的丢失藏起来，这里宁可算多不算少。
    const after = await readScmStatus(root).then((s) => (s.truncated ? null : s), () => null);
    const done: string[] = [];
    const pending: string[] = [];
    for (const group of groups) {
      for (const path of group.paths) {
        // 还在冲突里 = 这一条压根没解决，任何操作都谈不上落地。这一档必须在各组自己的
        // 判据**之前**问：未解决的冲突只出现在 `merge` 组，既不在 `unstaged` 也不在
        // `staged`，于是「不在 unstaged 里」这类判据会一律把它读成「已经暂存成功」——
        // 面板一边说「已生效」、一边下面还挂着「冲突 2」，把「标记为已解决」这个关键
        // 状态反着告诉用户（第 2 轮审查在函数级和页面上都复现）。
        // 整批跑完那条证据不受这一档影响：`git add` 返回成功就意味着冲突真的落成了
        // stage-0，那是事实，不是反推。
        const settled = batched.has(path)
          || (!!after && !listed(after.merge, path) && !!group.done && group.done(path, after));
        (settled ? done : pending).push(path);
      }
    }
    if (!done.length) throw error;
    throw new ScmPartialError(
      `${action}只做成了一部分：${done.length} 个已经生效${note ? `（${note}）` : ""}、${pending.length} 个没动。`
      + `失败原因：${oneLine((error as Error).message)}`,
      done,
      pending,
    );
  }
  return all.length;
}

/**
 * `git clean` 之前的可删性预检：**要么全删，要么一个都不删**。
 *
 * 未跟踪文件的删除是这个面板里唯一找不回来的操作，而它偏偏又必须分批。审查里复现过
 * 的场景是最后一批落在不可写目录上：前 200 个已经永久没了，用户只收到一句报错。
 * 提前把整份清单的父目录问一遍，就能在**动手之前**把这类失败变成「全不动 + 说清楚
 * 是哪几个」。
 *
 * **这是尽力预检，不是保证**：Windows 的 ACL 不体现在 `access` 上，文件被别的进程占用
 * 也测不出来，两次调用之间 agent 还可能把目录改掉。真漏过去了由 `ScmPartialError`
 * 兜底如实报账——两层各管一半，缺一个都不够。反过来说预检也不能省：报账是事后如实说
 * 「这几个已经没了」，预检才能让它们压根不必没。
 */
async function assertRemovable(root: string, paths: readonly string[]): Promise<void> {
  const writable = new Map<string, boolean>();
  const blocked: string[] = [];
  for (const path of paths) {
    const dir = dirname(resolve(root, path));
    let ok = writable.get(dir);
    if (ok === undefined) {
      ok = await access(dir, constants.W_OK).then(() => true, () => false);
      writable.set(dir, ok);
    }
    if (!ok) blocked.push(path);
  }
  if (blocked.length) {
    throw new ScmOperationError(
      `这些文件所在的目录不可写，为免删到一半停下，这次一个都没删：${blocked.join("、")}`,
      409,
    );
  }
}

export async function stagePaths(
  root: string,
  repoPath: string | null,
  paths: readonly string[],
  guard?: ScmGuard,
): Promise<ScmWriteResult> {
  const targets = assertPathShape(paths);
  return withRepoLock(repoPath, () => guarded(guard, async () => {
    await gateScmPaths(root, { paths: targets });
    // `add -A` 而不是 `add`：只有前者会把「文件被删了」也记进索引，否则删除永远暂存不上。
    const affected = await runAll(root, "暂存", [{
      paths: targets,
      run: (batch) => git(root, ["add", "-A", "--", ...batch.map(literalPathspec)]),
      // 暂存成功 = 这条不再有未暂存的那一半，未跟踪的则已经进了索引。
      done: (path, after) => !listed(after.unstaged, path) && !listed(after.untracked, path),
    }]);
    return { ok: true as const, affected };
  }));
}

/**
 * 取消暂存。
 *
 * **重命名要连原路径一起传**：`git mv old new` 之后索引里是两条记录（`old` 删除、`new`
 * 新增，status 合成一条 R 显示给用户）。只 restore `new`，索引里那条 `old` 的删除会原地
 * 留下——用户看到的是「取消暂存成功」，下一次提交却只提交了一个删除。前端 `pathsOf`
 * 因此对**重命名**条目同时送 `path` 和 `origPath`；复制（C）不在此列，它的 origPath 是
 * 另一个独立存在的文件，捎带上等于替用户取消了他没点的那一个。
 */
export async function unstagePaths(
  root: string,
  repoPath: string | null,
  paths: readonly string[],
  guard?: ScmGuard,
): Promise<ScmWriteResult> {
  const targets = assertPathShape(paths);
  return withRepoLock(repoPath, () => guarded(guard, async () => {
    await gateScmPaths(root, { paths: targets });
    const affected = await runAll(root, "取消暂存", [{
      paths: targets,
      run: async (batch) => {
        const pathspecs = batch.map(literalPathspec);
        try {
          await git(root, ["restore", "--staged", "--", ...pathspecs]);
        } catch (error) {
          // 还没有任何提交的仓库没有 HEAD 可以 restore 回去，此时「取消暂存」就是把
          // 条目从索引里摘掉（文件留在工作区，于是它回到未跟踪）。
          if (!/HEAD|initial commit|unknown revision/i.test((error as Error).message)) throw error;
          await git(root, ["rm", "--cached", "-r", "--", ...pathspecs]);
        }
      },
      // 取消暂存成功 = 这条不再出现在暂存区那一侧（rm --cached 那条路会让它变回未跟踪）。
      done: (path, after) => !listed(after.staged, path),
    }]);
    return { ok: true as const, affected };
  }));
}

/**
 * 丢弃工作区改动。**不可逆**——`git restore` 覆盖回 HEAD/索引的版本，`git clean` 直接
 * 删文件，两者都不进 reflog、不进 stash，事后没有任何找回的路子。所以：
 *
 *   • 未跟踪文件必须由调用方在 `deleteUntracked` 里显式点名，混在一起传不会被删。
 *     「改回原样」和「把文件删掉」是两种后果，不该共用一个按钮的语义。
 *   • 冲突中的文件一律拒绝：`git restore` 对未合并条目的行为取决于给没给 --ours/
 *     --theirs，猜错就是把用户已经解了一半的冲突抹掉。让他先解决冲突。
 *   • 动手之前先过 `assertRemovable`，把「删到一半卡住」尽量变成「一个都没删」。
 */
export async function discardPaths(
  root: string,
  repoPath: string | null,
  paths: readonly string[],
  deleteUntracked: readonly string[] = [],
  guard?: ScmGuard,
): Promise<ScmWriteResult> {
  const tracked = paths.length ? assertPathShape(paths) : [];
  const untracked = deleteUntracked.length ? assertPathShape(deleteUntracked) : [];
  if (!tracked.length && !untracked.length) throw new ScmOperationError("没有指定文件");
  return withRepoLock(repoPath, () => guarded(guard, async () => {
    // 一次读，两道闸：路径得在列表里，且不许是冲突中的文件。锁内读到的才是即将被操作的那份。
    await gateScmPaths(root, { paths: [...tracked, ...untracked], rejectConflicted: true });
    if (untracked.length) await assertRemovable(root, untracked);
    const affected = await runAll(root, "丢弃", [
      // `--worktree` 而不是连 `--staged` 一起：面板上「丢弃」丢的是未暂存那一份，
      // 已经暂存的内容要先取消暂存再丢——和 VSCode 一致，也让两步都可以停在中间。
      {
        paths: tracked,
        run: (batch) => git(root, ["restore", "--worktree", "--", ...batch.map(literalPathspec)]),
        // 丢弃成功 = 工作区已经跟索引一致，这条不再出现在「未暂存」里（原本是 `MM` 的
        // 只丢掉未暂存那一半，暂存侧那条还在，所以只能问未暂存这一侧）。
        done: (path, after) => !listed(after.unstaged, path),
      },
      // `-f` 是必须的（clean 默认拒绝动手），`-d` 不给：只删点名的文件，不递归清目录。
      {
        paths: untracked,
        run: (batch) => git(root, ["clean", "-f", "--", ...batch.map(literalPathspec)]),
        done: (path, after) => !listed(after.untracked, path),
      },
    ], "改动找不回来");
    return { ok: true as const, affected };
  }));
}

export interface ScmCommitOptions {
  message: string;
  /** 提交前把这些路径暂存上——对应面板上「没有暂存内容时直接提交」。 */
  stagePaths?: readonly string[];
  amend?: boolean;
}

export interface ScmCommitResult {
  ok: true;
  /** 提交落地后补读到的 sha；补读失败就是 null——提交本身已经算数（见下）。 */
  sha: string | null;
  subject: string;
  /** 提交已经成功、但之后某一步只为显示服务的读取失败了，附一句实话。 */
  warning?: string;
}

/**
 * 提交。
 *
 * **预暂存和 commit 是两步，中间没有回滚。** `stagePaths` 先把点名的路径写进索引，之后
 * commit 才跑；pre-commit hook 拒绝、提交身份没配、签名失败……任何一种都会让「文件已经
 * 在索引里、但没有提交」成为事实。这时候只回一句「提交失败」，用户会合理地以为索引没
 * 动，下一次提交就把这些本来没打算带上的东西一起带进去了。
 *
 * 所以失败时抛 `ScmPartialError` 把已暂存的清单交代清楚，而**不回滚**：用户原有的
 * staged 内容和这次预暂存的混在同一个索引里，`restore --staged` 一刀切下去会连人家
 * 之前挑好的暂存一起抹掉——那是拿一个静默的破坏去补另一个。要精确还原就得先把原索引
 * 完整存下来，代价和风险都比「如实说清楚」大得多。
 */
export async function commitWorkspace(
  root: string,
  repoPath: string | null,
  options: ScmCommitOptions,
  guard?: ScmGuard,
): Promise<ScmCommitResult> {
  const message = options.message.trim();
  if (!message) throw new ScmOperationError("提交信息不能为空");
  const toStage = options.stagePaths?.length ? assertPathShape(options.stagePaths) : [];
  return withRepoLock(repoPath, () => guarded(guard, async () => {
    if (toStage.length) {
      await gateScmPaths(root, { paths: toStage });
      await runAll(root, "提交前的暂存", [{
        paths: toStage,
        run: (batch) => git(root, ["add", "-A", "--", ...batch.map(literalPathspec)]),
        done: (path, after) => !listed(after.unstaged, path) && !listed(after.untracked, path),
      }]);
    }
    // 消息走 stdin（`-F -`）而不是 argv：提交信息里的换行、引号、以及 Windows 上的
    // 命令行长度上限都不必再操心，而且它不会出现在进程列表里。
    try {
      await new Promise<void>((resolve, reject) => {
        const child = execFile("git", ["-C", root, "commit", ...(options.amend ? ["--amend"] : []), "-F", "-"], {
          maxBuffer: 8 * 1024 * 1024,
        }, (error) => (error ? reject(new ScmOperationError(gitError(error), 409)) : resolve()));
        child.stdin?.end(`${message}\n`);
      });
    } catch (error) {
      if (!toStage.length) throw error;
      throw new ScmPartialError(
        `提交没有成功，但这 ${toStage.length} 个文件已经暂存进索引了——不处理的话，`
        + `下一次提交会把它们一起带上。失败原因：${oneLine((error as Error).message)}`,
        toStage,
        [],
      );
    }
    // **`git commit` 以 0 退出的那一刻就是不可逆的成功边界。** 提交已经写进 HEAD，
    // 之后这条 `git log` 只是为了把 sha 和标题显示出来。它照样可能失败——post-commit
    // hook 把仓库目录挪走、磁盘瞬时出错、仓库被别的进程锁住……让这一步把已经落地的
    // 提交翻成「提交失败」，是拿一个显示问题去撒一个关于事实的谎：用户会照这句话再提
    // 交一次，或者继续按旧列表操作（第 1 轮审查用 post-commit hook 复现）。所以读不到
    // 就回 sha=null 加一句警告，成功仍然是成功。
    try {
      const { stdout } = await exec("git", ["-C", root, "log", "-1", "--format=%H%x1f%s"]);
      const [sha, subject] = stdout.trim().split("\x1f");
      return { ok: true as const, sha: sha || null, subject: subject || message };
    } catch (error) {
      return {
        ok: true as const,
        sha: null,
        subject: message,
        warning: `提交已经成功，但没读到它的提交号：${oneLine(gitError(error))}`,
      };
    }
  }));
}
