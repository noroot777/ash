import { lstat, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { execFileText as exec } from "./exec.js";
import { listDirectory, resolveInRoot, type FileEntry, type WorkspaceRoot } from "./file-browser.js";
import { moveToTrash } from "./file-trash.js";
import { literalPathspec, parseStatusV2 } from "./git-status.js";

// ── 删掉任务工作目录里的一个文件 / 一整个文件夹 ───────────────────────────────
//
// 页面上的删除入口只有一个：**中间视图**（点开文件看全文、或者打开文件夹详情，删除按钮
// 在那条顶栏上）。所以这里也只提供两件事：
//
//   ① `readEntryOverview` —— 「这是什么、有多大、git 怎么看它」。文件夹详情页和删除确认
//      框读的是同一份：确认框要说的话（里面有多少个文件、几个未跟踪、删了还能不能找回来）
//      正是详情页要展示的东西，分两份必然对不上。
//   ② `deleteEntry` —— 真删。默认走系统废纸篓（`file-trash.ts`），永久删除是用户在
//      对话框里另外选的一档。
//
// 三条硬拒，和门禁（`workspace-write-gate.ts`）是两回事，它们跟任务状态无关：
//   • **根目录自己**删不得——那是任务的工作区，不是它里面的一个东西。
//   • 路径里带 `.git` 的一概拒：`listDirectory` 本来就把它过滤掉了，界面上点不到，但
//     API 直接调得到；删掉 `.git` 等于把这条分支连同所有提交一起毁了，而它**不在废纸篓
//     的保护范围内**（用户根本不会想到去那儿找一个没显示过的目录）。
//   • 越界由 `resolveInRoot` 挡（字符串前缀 + realpath 两道，见 file-browser.ts）。
//
// 软链**只删链接本身**：跟着链接走会删到工作区外面去，那是越界的另一种写法。所以全程
// 用 lstat，递归统计也不跟。

/** 递归统计的上限：仓库里的 node_modules 动辄几十万项，数到这儿就够回答「有多大」了。 */
const MAX_WALK_ENTRIES = 200_000;

export interface EntryStats {
  files: number;
  dirs: number;
  bytes: number;
  /** 撞上上限：数字是「至少这么多」。 */
  truncated: boolean;
}

export interface EntryGitFacts {
  repo: boolean;
  /** 被 git 跟踪的文件数（文件夹是里面的合计）。>0 就意味着「删了还能从提交里找回来」。 */
  tracked: number;
  /** 有未提交改动的文件数。 */
  dirty: number;
  /** 未跟踪的文件数——git 里没有任何备份的那些。 */
  untracked: number;
  /** 未跟踪文件的样例路径（最多 5 条），确认框直接列出来。 */
  untrackedSamples: string[];
  /** git 没问出来（不是仓库、或命令失败）时的原因。 */
  error: string | null;
}

export interface EntryOverview {
  target: {
    path: string;
    name: string;
    kind: "dir" | "file";
    size: number;
    mtime: string | null;
    absPath: string;
    symlink: boolean;
  };
  /** 文件夹才有：递归统计。 */
  stats: EntryStats | null;
  /** 文件夹才有：这一层的子项（和文件树同一份 `listDirectory`）。 */
  entries: FileEntry[] | null;
  git: EntryGitFacts;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function relPathOf(root: WorkspaceRoot, absPath: string): string {
  return relative(root.path, absPath).split(sep).join("/");
}

/** 路径里有没有 `.git` 这一段。仓库自己的 `.git` 和嵌套仓库的都算。 */
function touchesGitDir(relPath: string): boolean {
  return relPath.split("/").some((segment) => segment === ".git");
}

/**
 * 解析出「要动的到底是哪个东西」，顺带把三条硬拒过掉。
 *
 * 读（overview）和写（delete）共用：详情页能打开的东西，才谈得上删；点不开的东西也不该
 * 因为直接调 API 就能删。
 *
 * **界内判定落在父目录上，不落在目标自己身上**：`resolveInRoot` 会 realpath 目标，于是
 * 一条指向工作区外面的软链会被判成越界——可「删掉这条软链」恰恰是安全且该支持的（删的
 * 是链接本身，目标一个字节都不碰）。所以这里先把父目录过一遍那两道闸（字符串前缀 +
 * realpath），再把最后一段名字拼回去、用 lstat 按它自己论。`a/../b`、`../outside`、
 * 指向外面的目录软链下面的路径，仍旧全在父目录那一关上被拦住。
 *
 * **归一只交给 `resolve`**（它自己处理 `./`、重复分隔符和结尾的 `/`），一个字符都不许
 * 额外削。尤其不能 `trim()`：`" a.txt"`、`"a.txt "` 在 POSIX 上都是合法文件名，削掉空格
 * 就把「删我点的这个」解析成「删旁边那个同名的」——永久删除那一档还没得后悔。
 */
async function resolveEntry(root: WorkspaceRoot, relPath: string) {
  const rootAbs = resolve(root.path);
  const targetAbs = resolve(rootAbs, relPath || ".");
  if (targetAbs === rootAbs) {
    throw Object.assign(new Error("这是任务的工作目录本身，不能在这里删它"), { status: 400 });
  }
  const insidePath = relative(rootAbs, targetAbs).split(sep).join("/");
  if (touchesGitDir(insidePath)) {
    throw Object.assign(new Error(".git 是这条分支的全部历史，不能从文件树里删"), { status: 400 });
  }
  const parentRel = relative(rootAbs, dirname(targetAbs)).split(sep).join("/");
  const parentAbs = await resolveInRoot(root.path, parentRel || ".");
  const absPath = join(parentAbs, basename(targetAbs));
  // lstat 而不是 stat：软链要按它自己论（大小、类型、以及删的时候只删链接）。
  const info = await lstat(absPath).catch(() => null);
  if (!info) throw Object.assign(new Error("文件不存在"), { status: 404 });
  const symlink = info.isSymbolicLink();
  return {
    path: relPathOf(root, absPath),
    name: basename(absPath),
    absPath,
    symlink,
    kind: (!symlink && info.isDirectory() ? "dir" : "file") as "dir" | "file",
    size: info.size,
    mtime: Number.isFinite(info.mtimeMs) ? new Date(info.mtimeMs).toISOString() : null,
  };
}

/** 递归量一遍有多大。不跟软链，撞上限就停下并标 truncated。 */
async function walkStats(absPath: string): Promise<EntryStats> {
  const stats: EntryStats = { files: 0, dirs: 0, bytes: 0, truncated: false };
  const queue = [absPath];
  let seen = 0;
  while (queue.length) {
    const current = queue.pop()!;
    let dirents;
    try {
      dirents = await readdir(current, { withFileTypes: true });
    } catch {
      continue; // 读不动的子目录（权限、正被删）不该让整次统计失败
    }
    for (const dirent of dirents) {
      if (seen >= MAX_WALK_ENTRIES) {
        stats.truncated = true;
        return stats;
      }
      seen += 1;
      const child = join(current, dirent.name);
      if (dirent.isDirectory()) {
        stats.dirs += 1;
        queue.push(child);
        continue;
      }
      stats.files += 1;
      const info = await lstat(child).catch(() => null);
      if (info) stats.bytes += info.size;
    }
  }
  return stats;
}

/**
 * git 怎么看这个路径：里面有多少是跟踪过的（删了能从提交里找回来）、多少改动没提交、
 * 多少压根没进过 git。
 *
 * 这三个数字决定确认框上说哪句话，所以**分开问**：`status` 只报变化，一个干干净净的
 * 已跟踪文件在它那儿什么都不是，跟一个被 .gitignore 忽略的文件长得一模一样。
 */
export async function readEntryGitFacts(root: WorkspaceRoot, relPath: string): Promise<EntryGitFacts> {
  const empty: EntryGitFacts = { repo: false, tracked: 0, dirty: 0, untracked: 0, untrackedSamples: [], error: null };
  if (!root.gitRepo) return empty;
  const pathspec = literalPathspec(relPath);
  try {
    const [tracked, status] = await Promise.all([
      exec("git", ["--no-optional-locks", "-C", root.path, "ls-files", "-z", "--", pathspec],
        { maxBuffer: 32 * 1024 * 1024 }),
      exec("git", ["--no-optional-locks", "-C", root.path, "status", "--porcelain=v2", "-z",
        "--untracked-files=all", "--", pathspec], { maxBuffer: 32 * 1024 * 1024 }),
    ]);
    const parsed = parseStatusV2(status.stdout);
    const dirty = new Set([
      ...parsed.staged.map((change) => change.path),
      ...parsed.unstaged.map((change) => change.path),
      ...parsed.merge.map((change) => change.path),
    ]);
    return {
      repo: true,
      tracked: tracked.stdout.split("\0").filter(Boolean).length,
      dirty: dirty.size,
      untracked: parsed.untracked.length,
      untrackedSamples: parsed.untracked.slice(0, 5).map((change) => change.path),
      error: null,
    };
  } catch (error) {
    // 问不出来不能当成「没有未跟踪内容」——那会让对话框少说一句最该说的话。
    return { ...empty, repo: true, error: messageOf(error) };
  }
}

export async function readEntryOverview(root: WorkspaceRoot, relPath: string): Promise<EntryOverview> {
  const target = await resolveEntry(root, relPath);
  const isDir = target.kind === "dir";
  const [stats, listing, git] = await Promise.all([
    isDir ? walkStats(target.absPath) : null,
    isDir ? listDirectory(root, target.path).catch(() => null) : null,
    readEntryGitFacts(root, target.path),
  ]);
  return { target, stats, entries: listing?.entries ?? null, git };
}

export type DeleteMode = "trash" | "permanent";

export interface DeleteResult {
  ok: true;
  mode: DeleteMode;
  path: string;
  name: string;
  kind: "dir" | "file";
  absPath: string;
}

/**
 * 真删。`trash` 走系统废纸篓，失败就抛（**绝不自动降级成永久删除**——用户点的是「移到
 * 废纸篓」，悄悄换成不可逆的那一档是另一件事，由前端拿着错误再问一次）。
 */
export async function deleteEntry(
  root: WorkspaceRoot,
  relPath: string,
  mode: DeleteMode,
): Promise<DeleteResult> {
  const target = await resolveEntry(root, relPath);
  if (mode === "trash") await moveToTrash(target.absPath);
  // 软链自己是一条「文件」，rm 不跟过去；recursive 只对真目录起作用。
  else await rm(target.absPath, { recursive: target.kind === "dir", force: false });
  return {
    ok: true,
    mode,
    path: target.path,
    name: target.name,
    kind: target.kind,
    absPath: target.absPath,
  };
}
