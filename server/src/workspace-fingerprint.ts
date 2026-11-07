// 工作区的「内容指纹」：HEAD + 每一处未提交改动（含未跟踪文件）此刻的内容。
//
// 审查结论锚在哪一版代码上，靠的就是它（判据见 shared 的 `reviewAnchorMatches`）。只锚 HEAD
// 不够：执行者常常改完不提交，在脏工作区上审出来的结论一落地就和「HEAD 相同且干净」对不上。
//
// 几条取舍：
// - **不往仓库里写对象**。临时索引 + `git add -A` + `write-tree` 能得到真 tree，但会把每个
//   未跟踪大文件（视频、产物）写进 `.git/objects`，而这里每次读审查面板状态都会跑。所以只用
//   `git hash-object`（不带 `-w`）算哈希，再连同路径一起摘要。
// - **不跑项目自己的程序**。`--no-filters` 跳过 clean/LFS 过滤器（与 accept-gate-status 的口径一致）。
// - **按 stat 缓存哈希，但缓存只服务显示**。读面板状态时大小、mtime、ctime、inode、权限都没变
//   就复用哈希，代价与 `git status` 同一量级。可这组属性能被刻意保持（`utime` 改回 mtime，
//   ctime 也有粒度），所以**拿指纹去授权的地方**（打锚点、放行修复）传 `verify`：每个文件都
//   重读字节，缓存只写不读。
// - **证明不了就是未知**。只有「明确不存在」算删除；读不到（权限、目录 HEAD 取不到、嵌套仓库
//   摘要失败）一律让整份指纹变 null——把「无法证明内容」变成一个稳定的串，等于凭空给出
//   「内容没变」的证明。
// - **子模块与嵌套仓库递归摘要**。git 在父仓里只报它「改了」，里面再怎么改父仓的那一行都不变，
//   只取它的 HEAD 会漏掉其中未提交的改动。递归前先证明**这个目录自己就是仓库根**：普通目录里
//   跑 git 会一路向上找到父仓，拿「是目录」当「是仓库」就会对着自己无限递归（已跟踪文件改成
//   同名目录时就是这样）。不是仓库根的目录只记「类型变了」，里面的文件 status 会逐个列出来。
// - **丢了仓库标记的子模块**（gitlink 还在索引里、目录里的 `.git` 没了）`git status` 一个字都
//   不报，里面怎么改都看不见。所以每次都过一遍索引里的 gitlink：要么是独立仓库（status 管得到），
//   要么空着 / 不存在（没初始化），否则证明不了。
import { createHash } from "node:crypto";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { execFileText as exec } from "./exec.js";
import { countsAsProjectChange, expandHome, headCommit } from "./git.js";

export type WorkspaceSnapshot = {
  head: string | null;
  /** null = 取不到（按未知处理，不能当干净）。 */
  dirty: boolean | null;
  /** null = 取不到（没有 HEAD、git 读失败）。 */
  fingerprint: string | null;
};

const STATUS_MAX_BUFFER = 64 * 1024 * 1024;
const CACHE_LIMIT = 20_000;
const blobCache = new Map<string, { stat: string; blob: string }>();

/** `verify`：结果要拿去授权（打锚点 / 放行修复），每个文件都重读字节，不信 stat 缓存。 */
export function workspaceSnapshot(path: string, opts: { verify?: boolean } = {}): Promise<WorkspaceSnapshot> {
  return snapshotOf(expandHome(path), !!opts.verify, new Set());
}

/** `seen`：这条递归链上已经摘要过的仓库根（规范化路径），撞上就是绕回来了。 */
async function snapshotOf(cwd: string, verify: boolean, seen: Set<string>): Promise<WorkspaceSnapshot> {
  const head = await headCommit(cwd);
  let top: string;
  let changed: string[];
  let gitlinks: string[];
  try {
    const [root, status, index] = await Promise.all([
      exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"]),
      exec("git", ["-C", cwd, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"],
        { maxBuffer: STATUS_MAX_BUFFER }),
      exec("git", ["-C", cwd, "ls-files", "--stage", "-z"], { maxBuffer: STATUS_MAX_BUFFER }),
    ]);
    top = root.stdout.trim();
    changed = status.stdout.split("\0").filter(countsAsProjectChange).map((line) => line.slice(3));
    // `--stage -z` 每条是「mode object stage\tpath」。
    gitlinks = index.stdout.split("\0").filter((row) => row.startsWith("160000 "))
      .map((row) => row.slice(row.indexOf("\t") + 1));
  } catch {
    return { head, dirty: null, fingerprint: null };
  }
  const dirty = changed.length > 0;
  if (!head) return { head, dirty, fingerprint: null };
  try {
    const root = await realpath(top);
    if (seen.has(root)) throw new Error(`仓库递归绕回了自己：${root}`);
    const chain = new Set([...seen, root]);
    await Promise.all(gitlinks.map((file) => assertGitlinkVisible(join(top, file))));
    const contents = await contentHashes(top, changed, verify, chain);
    const digest = createHash("sha256").update(`${head}\n`);
    for (const file of [...changed].sort()) digest.update(`${file}\0${contents.get(file)}\n`);
    return { head, dirty, fingerprint: `v1:${digest.digest("hex")}` };
  } catch {
    return { head, dirty, fingerprint: null };
  }
}

const missing = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/** 每个改动路径此刻的内容标识：普通文件是 blob 哈希，其余几类各给一个能区分变化的串。证明不了就抛。 */
async function contentHashes(
  top: string, files: string[], verify: boolean, chain: Set<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const misses: { file: string; abs: string; stat: string; mode: string }[] = [];
  await Promise.all(files.map(async (file) => {
    const abs = join(top, file);
    const info = await lstat(abs).catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
    if (!info) return void out.set(file, "deleted");
    if (info.isSymbolicLink()) return void out.set(file, `link:${await readlink(abs)}`);
    if (info.isDirectory()) {
      if (!await isRepoRoot(abs)) return void out.set(file, "dir");
      const nested = await snapshotOf(abs, verify, chain);
      if (!nested.fingerprint) throw new Error(`嵌套仓库摘要失败：${file}`);
      return void out.set(file, `repo:${nested.fingerprint}`);
    }
    const mode = info.mode & 0o111 ? "x" : "";
    const stat = `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}:${mode}`;
    const cached = verify ? undefined : blobCache.get(abs);
    if (cached?.stat === stat) return void out.set(file, `${mode}${cached.blob}`);
    misses.push({ file, abs, stat, mode });
  }));
  // 换行会把 --stdin-paths 的清单切错：这种路径少见，单独按参数算。
  const listed = misses.filter((miss) => !miss.abs.includes("\n"));
  const blobs = listed.length ? (await exec("git", ["-C", top, "hash-object", "--no-filters", "--stdin-paths"],
    { input: `${listed.map((miss) => miss.abs).join("\n")}\n` })).stdout.trim().split("\n") : [];
  if (blobs.length !== listed.length) throw new Error("hash-object 返回条数与请求不符");
  const odd = misses.filter((miss) => miss.abs.includes("\n"));
  for (const miss of odd) {
    blobs.push((await exec("git", ["-C", top, "hash-object", "--no-filters", "--", miss.abs])).stdout.trim());
  }
  if (blobCache.size + misses.length > CACHE_LIMIT) blobCache.clear();
  [...listed, ...odd].forEach((miss, i) => {
    blobCache.set(miss.abs, { stat: miss.stat, blob: blobs[i]! });
    out.set(miss.file, `${miss.mode}${blobs[i]}`);
  });
  return out;
}

/** 这个目录自己就是一个仓库的根（而不是 git 从它往上找到的父仓）。读不出来就抛。 */
async function isRepoRoot(dir: string): Promise<boolean> {
  const { stdout } = await exec("git", ["-C", dir, "rev-parse", "--show-toplevel"]);
  return await realpath(stdout.trim()) === await realpath(dir);
}

/** 索引里的一个 gitlink 此刻的内容 status 管不管得到：独立仓库、空目录、不存在都行，其余抛。 */
async function assertGitlinkVisible(dir: string): Promise<void> {
  const entries = await readdir(dir).catch((error: unknown) => {
    if (missing(error)) return [];
    throw error;
  });
  if (!entries.length || await isRepoRoot(dir)) return;
  throw new Error(`子模块丢了仓库标记，里面的改动 git 看不见：${dir}`);
}
