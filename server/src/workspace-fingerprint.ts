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
//   只取它的 HEAD 会漏掉其中未提交的改动。
import { createHash } from "node:crypto";
import { lstat, readlink } from "node:fs/promises";
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
export async function workspaceSnapshot(path: string, opts: { verify?: boolean } = {}): Promise<WorkspaceSnapshot> {
  const cwd = expandHome(path);
  const head = await headCommit(cwd);
  let top: string;
  let changed: string[];
  try {
    const [root, status] = await Promise.all([
      exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"]),
      exec("git", ["-C", cwd, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"],
        { maxBuffer: STATUS_MAX_BUFFER }),
    ]);
    top = root.stdout.trim();
    changed = status.stdout.split("\0").filter(countsAsProjectChange).map((line) => line.slice(3));
  } catch {
    return { head, dirty: null, fingerprint: null };
  }
  const dirty = changed.length > 0;
  if (!head) return { head, dirty, fingerprint: null };
  try {
    const contents = await contentHashes(top, changed, !!opts.verify);
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
async function contentHashes(top: string, files: string[], verify: boolean): Promise<Map<string, string>> {
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
      const nested = await workspaceSnapshot(abs, { verify });
      if (!nested.fingerprint) throw new Error(`嵌套仓库摘要失败：${file}`);
      return void out.set(file, `dir:${nested.fingerprint}`);
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
