import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { IS_WINDOWS, isInsidePath, windowsPathRejection } from "./platform.js";
import { readScmStatus, type ScmStatus } from "./git-status.js";

// ── SCM 的路径闸：读侧和写侧共用同一把 ──────────────────────────────────────
//
// 面板传上来的每一条路径最终都会进 `git restore` / `git clean` / `git diff` 的参数，
// 所以这里是唯一一道拦得住「读到仓库外」和「一次删掉一整个目录」的地方。三层，缺一不可：
//
//   ① **形状闸**（`assertPathShape`）——纯语法：非空、不是绝对路径、没有 `.` / `..` 段、
//      不以分隔符结尾。它**绝不改写路径**：`" spaced.txt "` 前后的空格、POSIX 上文件名里
//      合法的反斜杠，都是文件名的一部分，trim 或替换掉就等于去操作另一个（多半不存在的）
//      文件。早先那版做了 `trim()` + `\`→`/`，合法文件名在面板上看得见却暂存不上。
//
//   ② **白名单闸**（`gateScmPaths`）——路径必须出现在**此刻的 git status 里**。这条把
//      「只按显式文件清单动手」从注释变成了硬保证：目录（`dir`、`.`）永远不会出现在
//      status 里，所以 `:(literal)` 关不掉的**目录递归**在这里被关掉了——不然一次
//      `discard(["dir"])` 就是不可逆地丢掉整个目录。写操作的这一读必须在**仓库锁之内**，
//      读到的才是即将被操作的那一份。
//
//   ③ **realpath 闸**（`assertInsideRoot`）——只有未跟踪文件的预览需要：那条路走
//      `git diff --no-index -- /dev/null <path>`，是四条里唯一绕开 git pathspec、直接
//      按文件系统路径读盘的。工作区里一条指向 `/etc/passwd` 的软链会原样出现在 status
//      的未跟踪列表里，白名单闸放行它，只有 realpath 拦得住。
//
// 截断的代价说在明处：status 超过 2000 条会截断，被截掉的文件既不能预览也不能操作。
// 这是有意的——白名单闸宁可少放，不可错放；面板本来就在横幅上说了「没列全」。

export class ScmOperationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "ScmOperationError";
  }
}

/**
 * 路径的形状闸。**只判断，不改写**——返回的就是传进来的那些字符串。
 *
 * 「反斜杠」这件事在两个平台上是两种东西，两处都得跟着平台走：
 *   • **分隔符**：Windows 上 `\` 是货真价实的分隔符，必须一起拆开查 `..`；POSIX 上它
 *     是文件名里的合法字符，拆开反而会把 `a\b.txt` 误判成两段。
 *   • **绝对路径的开头**：`\leading.txt` 在 Windows 上是根路径，在 POSIX 上就只是一个
 *     开头有点怪的普通文件名——它能正常出现在 git status 里，无条件拒掉就等于面板上
 *     看得见、却既不能预览也不能操作。
 * 盘符（`C:/…`）两个平台都拒：POSIX 上叫 `C:` 的目录理论上合法，但真出现时白名单闸
 * 也放不过去，宁可在这里就把这个歧义形状挡掉。
 */
export function assertPathShape(paths: readonly string[]): string[] {
  if (!paths.length) throw new ScmOperationError("没有指定文件");
  for (const path of paths) {
    if (!path) throw new ScmOperationError("文件路径为空");
    if (path.includes("\0")) throw new ScmOperationError("文件路径含非法字符");
    if (path.startsWith("/") || (IS_WINDOWS && path.startsWith("\\")) || /^[A-Za-z]:/.test(path)) {
      throw new ScmOperationError(`路径必须是仓库相对路径：${path}`);
    }
    const segments = IS_WINDOWS ? path.split(/[\\/]/) : path.split("/");
    // 空段同时挡下 `a//b` 和以分隔符结尾的目录 pathspec（`dir/`）。
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new ScmOperationError(`路径不合法：${path}`);
    }
  }
  return [...paths];
}

/** 当前状态里出现过的全部路径，含重命名的原路径——白名单闸的那张表。 */
export function scmKnownPaths(status: ScmStatus): Set<string> {
  const known = new Set<string>();
  for (const list of [status.merge, status.staged, status.unstaged, status.untracked]) {
    for (const change of list) {
      known.add(change.path);
      if (change.origPath) known.add(change.origPath);
    }
  }
  return known;
}

export interface ScmGateOptions {
  /** 必须出现在当前状态里的路径。 */
  paths: readonly string[];
  /** 命中冲突就拒——丢弃专用，见 `discardPaths` 的注释。 */
  rejectConflicted?: boolean;
  /** 已经读好的状态（调用方在同一把锁里读过就传进来，别重复 fork 一个 git）。 */
  status?: ScmStatus;
}

/**
 * 白名单闸。返回这次读到的状态，方便调用方接着用。
 *
 * 「不在列表里」和「正在冲突中」分开报：前者多半是面板拿着过时的状态（agent 刚把文件
 * 提交掉了），后者是用户得先去解决冲突，两种下一步动作完全不同。
 */
export async function gateScmPaths(root: string, options: ScmGateOptions): Promise<ScmStatus> {
  const status = options.status ?? await readScmStatus(root);
  if (!options.paths.length) return status;
  const known = scmKnownPaths(status);
  const unknown = options.paths.filter((path) => !known.has(path));
  if (unknown.length) {
    throw new ScmOperationError(
      `这些路径不在当前的改动列表里${status.truncated ? "（改动条目已超上限被截断）" : ""}：${unknown.join("、")}`,
      409,
    );
  }
  if (options.rejectConflicted) {
    const conflicted = new Set(status.merge.map((change) => change.path));
    const hit = options.paths.filter((path) => conflicted.has(path));
    if (hit.length) throw new ScmOperationError(`这些文件正处在冲突中，先解决冲突再操作：${hit.join("、")}`);
  }
  return status;
}

/**
 * 解出绝对路径并确认它真的落在工作目录里（软链跟到底之后也要落在里面）。
 *
 * 和 `file-browser.ts` 的 `resolveInRoot` 是同一套判据，但那份要求文件存在、也承担
 * 「越界」与「不存在」分开报的责任；这里只需要一句「在不在界内」，所以没有复用它。
 */
export async function assertInsideRoot(root: string, relPath: string): Promise<string> {
  const outside = () => new ScmOperationError("路径不在这个任务的工作目录里", 400);
  const rootAbs = resolve(root);
  const target = resolve(rootAbs, relPath);
  if (!isInsidePath(rootAbs, target, sep)) throw outside();
  const realRoot = await realpath(rootAbs).catch(() => null);
  if (!realRoot) throw new ScmOperationError("这个任务的工作目录已经不在了", 404);
  const realTarget = await realpath(target).catch(() => null);
  // 读不到 realpath 就是文件没了（agent 随时在删），按界内处理交给 git 去报。
  if (realTarget && (!isInsidePath(realRoot, realTarget, sep) || windowsPathRejection(realTarget))) throw outside();
  return target;
}
