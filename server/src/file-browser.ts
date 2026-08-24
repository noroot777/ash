import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { desc, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { projects, sessions, tasks } from "./db/schema.js";
import { isInsidePath, windowsPathRejection } from "./platform.js";
import { expandHome, isGitRepo, owningRepoOf, symbolicBranch, worktreePathFor } from "./git.js";
import { isolatedWorkspaceOwner } from "./task-workspace.js";

// 任务的「文件浏览」只读地看一眼这个任务实际在哪干活。**绝不能调 prepareWorktree**：
// 那是写型操作，会为一个只想看看文件的点击凭空建出 worktree 和分支来。
// 解析顺序按可信度：跑过的会话记的 cwd > 约定的 worktree 目录 > 归属任务（团队调度台 /
// 被审任务）的会话与 worktree > 项目仓库本身。
// （useWorktree 字段推不出答案：它在单飞任务和团队执行者身上语义相反，所以归属一律问
// `isolatedWorkspaceOwner`，它跟 `taskWorkspace` 是同一棵决策树。）

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_RAW_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 4000;
const SNIFF_BYTES = 8192;

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg", "heic", "tif", "tiff"]);
const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon",
  svg: "image/svg+xml", heic: "image/heic", tif: "image/tiff", tiff: "image/tiff",
  pdf: "application/pdf",
};

export type FileEntryKind = "dir" | "file";
export type FileContentKind = "text" | "image" | "pdf" | "binary";

export interface WorkspaceRoot {
  path: string;
  branch: string | null;
  gitRepo: boolean;
  /** 这个根是怎么定下来的，界面上要说清楚「你看的是哪儿」。 */
  source: "session" | "worktree" | "repo";
  /**
   * `path` **这个目录自己**属于哪个仓库（linked worktree 记主仓）——写型 git 操作按它
   * 串行。刻意不叫 `repoPath`：项目登记的那个 `repoPath` 是可以被 PATCH 改掉的登记值，
   * 会话 cwd 一旦落在别处，两者就指向不同物理目录，锁与实际操作分家（第 2 轮审查复现）。
   */
  repo: string | null;
  /**
   * 这个工作区归哪个项目。带上它是为了**推送时能拿到项目自己的 git 凭证**
   * （`git-credentials.ts`）：任务工作区推的是项目那个仓库，凭证配在项目上，
   * 从这儿一路带过去比在 scm 路由里再查一次任务省一趟。
   */
  projectId: string | null;
}

export interface FileEntry {
  name: string;
  path: string;
  kind: FileEntryKind;
  size: number;
  mtime: string | null;
  ignored: boolean;
  symlink: boolean;
}

const isDir = async (path: string) => {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
};

/** 这个任务的文件在哪。找不到任何可读目录时返回 null。 */
export async function taskFileRoot(taskId: string): Promise<WorkspaceRoot | null> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return null;
  const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
  const repoPath = expandHome(project?.repoPath) || null;

  const candidates: { path: string; source: WorkspaceRoot["source"] }[] = [];
  const pushSessionCwds = async (id: string) => {
    const runs = await db.select().from(sessions).where(eq(sessions.taskId, id)).orderBy(desc(sessions.startedAt));
    for (const run of runs) {
      const cwd = expandHome(run.cwd ?? run.worktreePath);
      if (cwd) candidates.push({ path: cwd, source: "session" });
    }
  };

  await pushSessionCwds(taskId);
  if (repoPath) candidates.push({ path: worktreePathFor(repoPath, taskId), source: "worktree" });

  // 自己名下什么都没有，不代表它该看项目主仓：**共享工作区的归属任务不是它自己**
  // （团队执行者跟随调度台、审查任务跟随被审任务）。一个还没跑过的执行者，真跑起来
  // 就落进领队那个 worktree；不查它就会退到项目主仓，页面展示一份完全无关的 git 状态，
  // 还谎称「那个目录还没建出来」——目录明明在，执行者的改动却看不到（第 3 轮审查复现）。
  const owner = await isolatedWorkspaceOwner(task);
  if (owner && owner !== taskId) {
    await pushSessionCwds(owner);
    if (repoPath) candidates.push({ path: worktreePathFor(repoPath, owner), source: "worktree" });
  }

  // 归属工作区确实不存在时才落到这儿：只读门禁据 source === "repo" 判「还没建出来」。
  if (repoPath) candidates.push({ path: repoPath, source: "repo" });

  for (const candidate of candidates) {
    if (!(await isDir(candidate.path))) continue;
    const gitRepo = await isGitRepo(candidate.path);
    return {
      path: candidate.path,
      branch: gitRepo ? await symbolicBranch(candidate.path) : null,
      gitRepo,
      source: candidate.source,
      // 从**选中的这个目录**问出来，不是项目登记的 repoPath：会话 cwd 可能落在另一个
      // 仓库里，那时候锁项目 repoPath 等于没锁。问不出来（不是 git 目录）才退回登记值。
      repo: (gitRepo ? await owningRepoOf(candidate.path) : null) ?? repoPath,
      projectId: task.projectId ?? null,
    };
  }
  return null;
}

/**
 * 把相对路径解成绝对路径，越界就抛。
 *
 * 两道关都要过：字符串前缀挡住 `../..`，realpath 之后再挡一次，否则工作区里一条指向
 * 外面的软链就是现成的越狱通道。**「越界」和「不存在」必须分开报**：realpath 要求路径
 * 真实存在，而 agent 随时在删文件，树上一个过期条目点下去若是回「路径不在这个任务的工
 * 作目录里」，读起来像在指控用户越权，实际只是文件没了。
 *
 * 前缀比较一律走 platform.ts 的 isInsidePath：NTFS 大小写不敏感，`C:\Foo` 和 `c:\foo`
 * 是同一个目录，裸 startsWith 在那边**既误拒**(大小写不同的合法路径)**又是绕过面**。
 * UNC(`\\server\share`、`\\?\C:\`)和 8.3 短名则是另一类 —— 前缀比较根本盖不住,
 * 单独由 windowsPathRejection 拒掉。
 */
async function resolveInRoot(root: string, relPath: string): Promise<string> {
  const outside = () => Object.assign(new Error("路径不在这个任务的工作目录里"), { status: 400 });
  const rootAbs = resolve(root);
  const target = resolve(rootAbs, relPath || ".");
  if (!isInsidePath(rootAbs, target, sep)) throw outside();

  const realRoot = await realpath(rootAbs).catch(() => null);
  if (!realRoot) throw Object.assign(new Error("这个任务的工作目录已经不在了"), { status: 404 });
  const realTarget = await realpath(target).catch(() => null);
  if (!realTarget) {
    // 目标不存在：父目录仍在界内才算「文件没了」，否则连位置都是界外的，照越界报。
    const realParent = await realpath(dirname(target)).catch(() => null);
    if (!realParent || !isInsidePath(realRoot, realParent, sep)) throw outside();
    // 不存在 = realpath 没机会把 8.3 短名展开,只能拿原样的路径查。
    if (windowsPathRejection(target)) throw outside();
    throw Object.assign(new Error("文件不存在"), { status: 404 });
  }
  if (!isInsidePath(realRoot, realTarget, sep)) throw outside();
  if (windowsPathRejection(realTarget)) throw outside();
  return target;
}

/** 一次问清楚这批名字里哪些被 .gitignore 挡着。非 git 仓库直接返回空集。 */
async function ignoredPaths(root: string, relPaths: string[]): Promise<Set<string>> {
  if (!relPaths.length) return new Set();
  return new Promise((done) => {
    const child = spawn("git", ["-C", root, "check-ignore", "-z", "--stdin"], {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { out += chunk; });
    // 退出码 1 = 一个都没命中，是正常结果不是错误；128 才是真出错，这时按「都不忽略」处理。
    child.once("close", () => done(new Set(out.split("\0").filter(Boolean))));
    child.once("error", () => done(new Set()));
    child.stdin.on("error", () => {});
    child.stdin.end(relPaths.join("\0") + "\0");
  });
}

export async function listDirectory(
  root: WorkspaceRoot,
  relPath: string,
): Promise<{ path: string; entries: FileEntry[]; truncated: boolean }> {
  const abs = await resolveInRoot(root.path, relPath);
  if (!(await isDir(abs))) throw Object.assign(new Error("不是目录"), { status: 400 });

  const dirents = (await readdir(abs, { withFileTypes: true }))
    .filter((entry) => entry.name !== ".git");
  const truncated = dirents.length > MAX_ENTRIES;
  const kept = truncated ? dirents.slice(0, MAX_ENTRIES) : dirents;

  const entries: FileEntry[] = [];
  for (const dirent of kept) {
    const full = join(abs, dirent.name);
    let info;
    try {
      info = await lstat(full);
    } catch {
      continue; // 列目录和 stat 之间被删掉了
    }
    const symlink = info.isSymbolicLink();
    const directory = symlink ? await isDir(full) : info.isDirectory();
    entries.push({
      name: dirent.name,
      path: relative(root.path, full).split(sep).join("/"),
      kind: directory ? "dir" : "file",
      size: directory ? 0 : info.size,
      mtime: Number.isFinite(info.mtimeMs) ? new Date(info.mtimeMs).toISOString() : null,
      ignored: false,
      symlink,
    });
  }

  if (root.gitRepo) {
    const ignored = await ignoredPaths(root.path, entries.map((entry) => entry.path));
    for (const entry of entries) entry.ignored = ignored.has(entry.path);
  }

  entries.sort((a, b) => (
    Number(a.ignored) - Number(b.ignored)
    || (a.kind === b.kind ? 0 : a.kind === "dir" ? -1 : 1)
    || a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true, sensitivity: "base" })
  ));
  return { path: relative(root.path, abs).split(sep).join("/"), entries, truncated };
}

function extensionOf(path: string) {
  return extname(path).replace(/^\./, "").toLowerCase();
}

/**
 * 文本还是二进制。先看有没有 NUL（二进制最可靠的特征），再看 UTF-8 解出来有多少
 * 替换字符 —— 少量替换字符可能只是文件末尾被截断截在多字节中间，不能一见就判死。
 */
function looksTextual(buffer: Buffer): boolean {
  const head = buffer.subarray(0, SNIFF_BYTES);
  if (head.includes(0)) return false;
  if (!buffer.length) return true;
  const decoded = buffer.toString("utf8");
  let broken = 0;
  for (let i = 0; i < decoded.length; i++) if (decoded.charCodeAt(i) === 0xfffd) broken++;
  return broken <= Math.max(4, Math.floor(decoded.length * 0.002));
}

/**
 * 只要一个「这个相对路径在本机的什么位置」的答案，不碰文件内容。
 *
 * 「在文件夹中显示」「用某个应用打开」「探测能打开它的应用」都只需要这个：
 * 走 readFileContent 会为一次点击白读最多 2 MB 并做一遍文本嗅探，而且目录会被它拒掉
 * —— 对着文件夹按「在文件夹中查看」是很自然的动作，不该报「这是一个目录」。
 */
export async function resolveTarget(
  root: WorkspaceRoot,
  relPath: string,
): Promise<{ absPath: string; directory: boolean }> {
  const abs = await resolveInRoot(root.path, relPath);
  const info = await stat(abs).catch(() => null);
  if (!info) throw Object.assign(new Error("文件不存在"), { status: 404 });
  return { absPath: abs, directory: info.isDirectory() };
}

export interface FileContent {
  path: string;
  name: string;
  size: number;
  mtime: string | null;
  kind: FileContentKind;
  text: string | null;
  truncated: boolean;
  absPath: string;
  mime: string | null;
}

export async function readFileContent(root: WorkspaceRoot, relPath: string): Promise<FileContent> {
  const abs = await resolveInRoot(root.path, relPath);
  const info = await stat(abs).catch(() => null);
  if (!info) throw Object.assign(new Error("文件不存在"), { status: 404 });
  if (info.isDirectory()) throw Object.assign(new Error("这是一个目录"), { status: 400 });

  const ext = extensionOf(abs);
  const base: Omit<FileContent, "kind" | "text" | "truncated"> = {
    path: relative(root.path, abs).split(sep).join("/"),
    name: basename(abs),
    size: info.size,
    mtime: Number.isFinite(info.mtimeMs) ? new Date(info.mtimeMs).toISOString() : null,
    absPath: abs,
    mime: MIME_BY_EXTENSION[ext] ?? null,
  };
  if (IMAGE_EXTENSIONS.has(ext)) return { ...base, kind: "image", text: null, truncated: false };
  if (ext === "pdf") return { ...base, kind: "pdf", text: null, truncated: false };

  const handle = await open(abs, "r");
  try {
    const wanted = Math.min(info.size, MAX_TEXT_BYTES + 1);
    const buffer = Buffer.alloc(wanted);
    const { bytesRead } = await handle.read(buffer, 0, wanted, 0);
    const slice = buffer.subarray(0, Math.min(bytesRead, MAX_TEXT_BYTES));
    if (!looksTextual(buffer.subarray(0, bytesRead))) {
      return { ...base, kind: "binary", text: null, truncated: false };
    }
    return {
      ...base,
      kind: "text",
      text: slice.toString("utf8"),
      truncated: info.size > MAX_TEXT_BYTES,
    };
  } finally {
    await handle.close();
  }
}

/** 原样吐字节（图片/PDF 预览用）。 */
export async function openRawStream(root: WorkspaceRoot, relPath: string) {
  const abs = await resolveInRoot(root.path, relPath);
  const info = await stat(abs).catch(() => null);
  if (!info || info.isDirectory()) throw Object.assign(new Error("文件不存在"), { status: 404 });
  if (info.size > MAX_RAW_BYTES) throw Object.assign(new Error("文件过大，无法在线预览"), { status: 413 });
  return {
    stream: createReadStream(abs),
    size: info.size,
    mime: MIME_BY_EXTENSION[extensionOf(abs)] ?? "application/octet-stream",
    name: basename(abs),
    absPath: abs,
  };
}
