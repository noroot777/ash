import { basename, dirname, join, resolve } from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { execFileText as exec } from "./exec.js";

type Registration = { path: string; branch: string | null; prunable: boolean; locked: boolean };
type Scope = { branch: string } | { path: string };

function physicalPath(path: string): string {
  let head = resolve(path);
  const tail: string[] = [];
  for (;;) {
    try { return join(realpathSync(head), ...tail.reverse()); }
    catch {
      const parent = dirname(head);
      if (parent === head) return resolve(path);
      tail.push(basename(head));
      head = parent;
    }
  }
}

function samePath(a: string, b: string): boolean {
  return physicalPath(a) === physicalPath(b);
}

function missing(path: string): boolean {
  try { lstatSync(path); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}

async function registrations(repo: string): Promise<Registration[]> {
  const { stdout } = await exec("git", ["-C", repo, "worktree", "list", "--porcelain", "-z"]);
  return stdout.split("\0\0").filter(Boolean).map(record => {
    const fields = record.split("\0");
    return {
      path: fields.find(field => field.startsWith("worktree "))!.slice(9),
      branch: fields.find(field => field.startsWith("branch refs/heads/"))?.slice(18) ?? null,
      prunable: fields.some(field => field === "prunable" || field.startsWith("prunable ")),
      locked: fields.some(field => field === "locked" || field.startsWith("locked ")),
    };
  });
}

function survivingPath(repo: string, record: Registration): string | null {
  if (!missing(record.path)) return record.path;
  // 项目改名后登记仍指向旧位置，任务目录则随项目一起留在新的 .worktrees 下。
  if (basename(dirname(record.path)) === ".worktrees") {
    const relocated = join(repo, ".worktrees", basename(record.path));
    if (!missing(relocated)) return relocated;
  }
  return null;
}

function removable(repo: string, record: Registration): boolean {
  return record.prunable && !record.locked && !survivingPath(repo, record);
}

export async function registeredCheckout(repo: string, branch: string): Promise<{ path: string | null; locked: boolean; needsRepair: boolean }> {
  for (const record of await registrations(repo)) {
    if (record.branch !== branch || removable(repo, record)) continue;
    return { path: survivingPath(repo, record) ?? record.path, locked: record.locked, needsRepair: record.prunable };
  }
  return { path: null, locked: false, needsRepair: false };
}

export function checkoutRecovery(checkout: { locked: boolean; needsRepair: boolean }): string | null {
  if (checkout.locked) return "该工作区被 git worktree lock 锁定，请先在项目目录运行 git worktree unlock，并将该工作区的完整路径作为参数，再刷新依赖并重试释放。";
  if (checkout.needsRepair) return "工作区链接已损坏或路径已移动，请先在项目目录运行 git worktree repair；若项目或工作区被移动，再运行该命令并传入上述工作区的当前完整路径。修复后处理未提交文件，再释放工作区。";
  return null;
}

// Git 的 prune 是全仓操作；remove 对确已消失的路径只清理这一条登记，且保留 locked 保护。
export async function removeMissingWorktreeRegistrations(repo: string, scope: Scope): Promise<void> {
  for (const record of await registrations(repo)) {
    const selected = "branch" in scope ? record.branch === scope.branch : samePath(record.path, scope.path);
    if (selected && removable(repo, record)) await exec("git", ["-C", repo, "worktree", "remove", "--", record.path]);
  }
}

export class UnreadableWorktreeError extends Error {}

export async function assertReadableWorktree(path: string): Promise<void> {
  try {
    const top = (await exec("git", ["-C", path, "rev-parse", "--show-toplevel"])).stdout.trim();
    if (!samePath(top, path)) throw new Error("Git resolved a different working directory");
    await exec("git", ["-C", path, "status", "--porcelain"]);
  } catch {
    throw new UnreadableWorktreeError(`无法确认工作区 ${path} 的 Git 登记和未提交文件状态，目录及文件已保留；请先在项目目录运行 git worktree repair；若项目或工作区被移动，再运行该命令并传入上述工作区的当前完整路径。修复链接后再重试清理`);
  }
}
