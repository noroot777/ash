import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileText as exec } from "./exec.js";
import { hasWorktreeRegistration, samePath, UnreadableWorktreeError } from "./git-worktree-state.js";

// 删除中断可能留下源码，却丢失 .git 指针或它指向的登记。先验证剩余源码，再整目录备份，
// ignored 数据也一并保留；不把「Git 读不出来」直接当成可删除的空目录。
export async function preserveRemovedWorktree(repo: string, path: string, branch: string): Promise<string | null> {
  if (!samePath(dirname(path), join(repo, ".worktrees"))) return null;
  const directory = await lstat(path).catch(() => null);
  const pointer = join(path, ".git");
  if (!directory?.isDirectory()) return null;
  const pointerStat = await lstat(pointer).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return null;
  });
  if (pointerStat && !pointerStat.isFile()) return null;
  const common = (await exec("git", ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
  if (pointerStat) {
    const match = /^gitdir: (.+)$/.exec((await readFile(pointer, "utf8")).trim());
    if (!match) return null;
    const admin = resolve(path, match[1]);
    if (!samePath(dirname(admin), join(common, "worktrees"))) return null;
    try { await lstat(admin); return null; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  if (await hasWorktreeRegistration(repo, path, branch)) return null;
  const commit = await exec("git", ["--git-dir", common, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`])
    .then(result => result.stdout.trim()).catch(error => {
      if ((error as { code?: number }).code !== 1) throw error;
      throw new UnreadableWorktreeError(`无法确认工作区 ${path} 已清理：任务分支 ${branch} 不存在或无法解析，无法核对残留源码。目录及文件已保留，请先从已核实的提交恢复该任务分支，再重试清理。`);
    });

  const scratch = await mkdtemp(join(tmpdir(), "ash-worktree-recovery-"));
  try {
    const options = { cwd: path, env: { ...process.env, GIT_INDEX_FILE: join(scratch, "index") } };
    const args = ["--git-dir", common, "--work-tree", path];
    await exec("git", [...args, "read-tree", commit], options);
    try { await exec("git", [...args, "update-index", "--ignore-missing", "--refresh"], options); }
    catch (error) { if ((error as { code?: number }).code !== 1) throw error; }
    const changes = (await exec("git", [...args, "diff-files", "--name-status", "-z", "--no-renames", "--no-ext-diff", "--"], options)).stdout.split("\0");
    const dirty: string[] = [];
    for (let i = 0; i + 1 < changes.length; i += 2) {
      if (changes[i] !== "D") dirty.push(changes[i + 1]);
    }
    const untracked = (await exec("git", [...args, "ls-files", "--others", "--exclude-standard", "-z", "--"], options)).stdout.split("\0").filter(Boolean);
    dirty.push(...untracked);
    if (dirty.length) throw new UnreadableWorktreeError(`无法确认工作区 ${path} 已清理：Git 登记已丢失，但仍有修改或未跟踪文件（${dirty.slice(0, 20).join("、")}）。目录及文件已保留，请先保存这些改动。`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  const backups = join(common, "ash-worktree-backups");
  await mkdir(backups, { recursive: true });
  const backup = join(backups, `${basename(path)}-${randomUUID()}`);
  await rename(path, backup);
  // 指针移到备份目录之外，后续重建同名 worktree 时，备份不会误连到新的登记。
  if (pointerStat) await rename(join(backup, ".git"), `${backup}.git-pointer`);
  return backup;
}
