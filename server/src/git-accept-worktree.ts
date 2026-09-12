import { lstat, readlink, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { execFileText as exec } from "./exec.js";
import { removeWorktree } from "./git.js";
import { physicalPath, UnreadableWorktreeError } from "./git-worktree-state.js";
import { assertNotPreviewInstance } from "./preview-instance.js";

type Link = { path: string; target: string };
const listed = (paths: string[]) => paths.slice(0, 20).join("、") + (paths.length > 20 ? `等 ${paths.length} 项` : "");
const under = (path: string, directory: string) => path === directory || path.startsWith(`${directory}/`);

async function stat(path: string) {
  try { return await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return null; }
}

async function borrowedLink(worktree: string, file: string): Promise<Link | null> {
  const path = join(worktree, file);
  if (!(await stat(path))?.isSymbolicLink()) return null;
  const target = await readlink(path);
  const diff = relative(physicalPath(worktree), physicalPath(resolve(dirname(path), target)));
  if (!isAbsolute(diff) && diff !== ".." && !diff.startsWith(`..${sep}`)) return null;
  const tracked = await exec("git", ["-C", worktree, "ls-files", "-z", "--", `:(literal)${file}`]);
  return tracked.stdout ? null : { path: file, target };
}

// 手工借来的依赖链接不在预览的 links 记录中；非 force 删除前只撤外部、未跟踪的链接。
// 真实目录仍遵循 Git 的正常清理行为，删除的 ignored 数据另记到验收时间线。
export async function removeAcceptedWorktree(repo: string, worktree: string, notices: string[]): Promise<void> {
  assertNotPreviewInstance("删 worktree");
  const { stdout } = await exec("git", ["-C", worktree, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--ignored=matching"], { maxBuffer: 16 * 1024 * 1024 });
  const rows = stdout.split("\0").filter(Boolean).map(row => ({ kind: row.slice(0, 2), path: row.slice(3).replace(/\/$/, "") }));
  const ignored = rows.filter(row => row.kind === "!!").map(row => row.path);
  const links = new Map<string, Link & { required: boolean }>();
  if (rows.every(row => row.kind === "??" || row.kind === "!!")) {
    for (const row of rows) {
      const parts = row.path.split("/");
      if (!parts.includes("node_modules")) continue;
      const candidates = parts.flatMap((part, i) => part === "node_modules" ? [parts.slice(0, i + 1).join("/")] : []);
      candidates.push(row.path);
      for (const candidate of candidates) {
        const required = row.kind === "??";
        const planned = links.get(candidate);
        if (planned) { planned.required ||= required; break; }
        try {
          const link = await borrowedLink(worktree, candidate);
          if (link) { links.set(candidate, { ...link, required }); break; }
          if (required && (await stat(join(worktree, candidate)))?.isSymbolicLink()) throw new UnreadableWorktreeError(`依赖链接 ${candidate} 指向工作区内部或涉及已跟踪文件，目录及文件已保留；请先核对并处理该链接，再重试验收。`);
        } catch (error) {
          if (required) throw error;
        }
      }
    }
  }
  const removed: string[] = [];
  try {
    if (rows.every(row => row.kind === "!!" || (row.kind === "??" && [...links.keys()].some(link => under(row.path, link))))) {
      for (const link of links.values()) {
        try {
          const current = await borrowedLink(worktree, link.path);
          if (!current || current.target !== link.target) throw new Error(`依赖链接 ${link.path} 在清理前发生变化，已保留，请重试验收`);
          await unlink(join(worktree, link.path));
          removed.push(link.path);
        } catch (error) {
          // ignored 条目不阻塞 Git 的非 force 删除，撤链接失败时仍交回原生清理。
          if (link.required) throw error;
        }
      }
    }
    await removeWorktree(repo, worktree, false);
  } finally {
    if (removed.length) notices.push(`已撤下借用的依赖符号链接：${listed(removed)}。链接目标未删除。`);
    const deleted: string[] = [];
    for (const path of ignored) {
      if (removed.some(link => under(path, link))) continue;
      if (await stat(join(worktree, path)).catch(() => undefined) === null) deleted.push(path);
    }
    if (deleted.length) notices.push(`随 worktree 一并删除了 Git 忽略的本地文件或目录：${listed(deleted)}；这些本地数据未另行备份。`);
  }
}
