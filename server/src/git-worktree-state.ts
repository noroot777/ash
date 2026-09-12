import { basename, dirname, join, resolve } from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { execFileText as exec } from "./exec.js";

type Registration = { path: string; branch: string | null; prunable: boolean; locked: boolean };
type Scope = { branch: string } | { path: string };
type Checkout = {
  path: string | null;
  locked: boolean;
  needsRepair: boolean;
  missingBacklink?: { file: string; content: string };
};

export function physicalPath(path: string): string {
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

export function samePath(a: string, b: string): boolean {
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

async function missingBacklink(repo: string, record: Registration, path: string): Promise<Checkout["missingBacklink"]> {
  if (missing(path) || !missing(join(path, ".git"))) return;
  const common = (await exec("git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
  const entries = await readdir(join(common, "worktrees"), { withFileTypes: true });
  const matches = await Promise.all(entries.filter(entry => entry.isDirectory()).map(async entry => {
    const admin = join(common, "worktrees", entry.name);
    try {
      const [head, backlink, commondir] = await Promise.all(["HEAD", "gitdir", "commondir"].map(file => readFile(join(admin, file), "utf8")));
      return head.trim() === `ref: refs/heads/${record.branch}`
        && samePath(dirname(resolve(admin, backlink.trim())), record.path)
        && samePath(resolve(admin, commondir.trim()), common) ? admin : null;
    } catch { return null; }
  }));
  const unique = matches.filter((path): path is string => path !== null);
  if (unique.length === 1) return { file: join(path, ".git"), content: `gitdir: ${unique[0]}` };
}

export async function registeredCheckout(repo: string, branch: string): Promise<Checkout> {
  for (const record of await registrations(repo)) {
    if (record.branch !== branch || removable(repo, record)) continue;
    const path = survivingPath(repo, record) ?? record.path;
    return { path, locked: record.locked, needsRepair: record.prunable,
      ...(record.prunable ? { missingBacklink: await missingBacklink(repo, record, path).catch(() => undefined) } : {}) };
  }
  return { path: null, locked: false, needsRepair: false };
}

export function checkoutRecovery(checkout: Checkout): string | null {
  const unlock = checkout.locked
    ? `该工作区被 git worktree lock 锁定，请先在项目目录运行 git worktree unlock，并传入登记路径 ${checkout.path}，然后刷新依赖。` : "";
  const backlink = checkout.missingBacklink;
  const repair = backlink
    ? `工作区的 .git 指针文件缺失。已核对对应的 Git 登记，请新建文件 ${backlink.file}，内容为以下一行（末尾换行）：\n${backlink.content}\n保存后在项目目录运行 git worktree repair，并传入工作区当前完整路径 ${checkout.path}。修复后核对并处理未提交文件，再重试操作。`
    : checkout.needsRepair
      ? "工作区链接已损坏或路径已移动，请先在项目目录运行 git worktree repair；若项目或工作区被移动，再运行该命令并传入上述工作区的当前完整路径。修复后处理未提交文件，再重试操作。" : "";
  return unlock + repair || null;
}

// Git 的 prune 是全仓操作；remove 对确已消失的路径只清理这一条登记，且保留 locked 保护。
export async function removeMissingWorktreeRegistrations(repo: string, scope: Scope): Promise<void> {
  for (const record of await registrations(repo)) {
    const selected = "branch" in scope ? record.branch === scope.branch : samePath(record.path, scope.path);
    if (selected && removable(repo, record)) await exec("git", ["-C", repo, "worktree", "remove", "--", record.path]);
  }
}

export class UnreadableWorktreeError extends Error {}

export async function hasWorktreeRegistration(repo: string, path: string, branch: string): Promise<boolean> {
  return (await registrations(repo)).some(record => samePath(record.path, path)
    || (record.branch === branch && !samePath(record.path, repo)));
}

export async function assertReadableWorktree(path: string, repo: string, branch: string): Promise<void> {
  try {
    const top = (await exec("git", ["-C", path, "rev-parse", "--show-toplevel"])).stdout.trim();
    if (!samePath(top, path)) throw new Error("Git resolved a different working directory");
    await exec("git", ["-C", path, "status", "--porcelain"]);
  } catch {
    const checkout = await registeredCheckout(repo, branch).catch(() => null);
    const recovery = checkout?.path && samePath(checkout.path, path) ? checkoutRecovery(checkout) : null;
    throw new UnreadableWorktreeError(`无法确认工作区 ${path} 的 Git 登记和未提交文件状态，目录及文件已保留；${recovery || "未能定位对应的工作区链接，请先核对该工作区的 Git 登记，再修复链接并重试清理。"}`);
  }
}
