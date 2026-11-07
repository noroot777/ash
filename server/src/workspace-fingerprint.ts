// 工作区的「内容指纹」：HEAD + 每一处未提交改动（含未跟踪文件）此刻的内容。
//
// 审查结论锚在哪一版代码上，靠的就是它（判据见 shared 的 `reviewAnchorMatches`）。只锚 HEAD
// 不够：执行者常常改完不提交，在脏工作区上审出来的结论一落地就和「HEAD 相同且干净」对不上。
//
// 三条取舍：
// - **不往仓库里写对象**。临时索引 + `git add -A` + `write-tree` 能得到真 tree，但会把每个
//   未跟踪大文件（视频、产物）写进 `.git/objects`，而这里每次读审查面板状态都会跑。所以只用
//   `git hash-object`（不带 `-w`）算哈希，再连同路径一起摘要。
// - **不跑项目自己的程序**。`--no-filters` 跳过 clean/LFS 过滤器（与 accept-gate-status 的口径一致）。
// - **按 stat 缓存哈希**。同一个文件大小、mtime、inode、权限都没变就不重算，读状态的代价
//   与 `git status` 同一量级。
//
// 过滤口径与 `workspaceDirty` 共用 `countsAsProjectChange`：同一份工作区不会一边算干净、
// 一边又有一份不同的指纹。
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

export async function workspaceSnapshot(path: string): Promise<WorkspaceSnapshot> {
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
    const contents = await contentHashes(top, changed);
    const digest = createHash("sha256").update(`${head}\n`);
    for (const file of [...changed].sort()) digest.update(`${file}\0${contents.get(file)}\n`);
    return { head, dirty, fingerprint: `v1:${digest.digest("hex")}` };
  } catch {
    return { head, dirty, fingerprint: null };
  }
}

/** 每个改动路径此刻的内容标识：普通文件是 blob 哈希，其余几类各给一个能区分变化的串。 */
async function contentHashes(top: string, files: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const misses: { file: string; abs: string; stat: string }[] = [];
  await Promise.all(files.map(async (file) => {
    const abs = join(top, file);
    const info = await lstat(abs).catch(() => null);
    if (!info) return void out.set(file, "deleted");
    if (info.isSymbolicLink()) return void out.set(file, `link:${await readlink(abs)}`);
    // 未跟踪的嵌套仓库 / 子模块：git 不往里看，取它自己的 HEAD。
    if (info.isDirectory()) return void out.set(file, `dir:${await headCommit(abs) ?? ""}`);
    const mode = info.mode & 0o111 ? "x" : "";
    const stat = `${info.size}:${info.mtimeMs}:${info.ino}:${mode}`;
    const cached = blobCache.get(abs);
    if (cached?.stat === stat) return void out.set(file, `${mode}${cached.blob}`);
    // 换行会把 --stdin-paths 的清单切错；这种路径少见，退回 stat 本身。
    if (abs.includes("\n")) return void out.set(file, `stat:${stat}`);
    misses.push({ file, abs, stat });
  }));
  if (misses.length) {
    const { stdout } = await exec("git", ["-C", top, "hash-object", "--no-filters", "--stdin-paths"],
      { input: `${misses.map((miss) => miss.abs).join("\n")}\n` });
    const blobs = stdout.trim().split("\n");
    if (blobs.length !== misses.length) throw new Error("hash-object 返回条数与请求不符");
    if (blobCache.size + misses.length > CACHE_LIMIT) blobCache.clear();
    misses.forEach((miss, i) => {
      blobCache.set(miss.abs, { stat: miss.stat, blob: blobs[i]! });
      out.set(miss.file, `${miss.stat.endsWith("x") ? "x" : ""}${blobs[i]}`);
    });
  }
  return out;
}
