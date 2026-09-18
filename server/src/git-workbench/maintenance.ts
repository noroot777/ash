import { lstat, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { GitWorkbenchState } from "@ash/shared/git-workbench";
import { fail, git } from "./core.js";
import { journalDirectory } from "./journal.js";
import { worktreePorcelain } from "../git-worktree-state.js";

export async function readBackups(
  root: string,
): Promise<GitWorkbenchState["backups"]> {
  const raw = await git(root, [
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(subject)",
    "refs/ash-backup/",
  ]);
  return raw
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [ref, sha, subject] = line.split("\0");
      return { ref, sha, subject };
    });
}

export async function deleteBackup(
  root: string,
  ref: string,
  sha: string,
): Promise<void> {
  if (
    !ref.startsWith("refs/ash-backup/") ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)
  )
    fail("备份引用不合法", 400);
  await git(root, ["check-ref-format", ref]);
  const current = (await git(root, ["rev-parse", "--verify", ref])).trim();
  if (current !== sha) fail("备份已经变化，请刷新后重新确认");
  await git(root, ["update-ref", "-d", ref, sha]);
}

export async function cleanupRebaseHelpers(
  root: string,
): Promise<{ removed: number; blocked: string | null }> {
  try {
    const directory = await journalDirectory(root);
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    const candidates = entries.filter(
      (entry) =>
        entry.isDirectory() &&
        /^rebase-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(entry.name),
    );
    if (!candidates.length) return { removed: 0, blocked: null };
    const trees = (await worktreePorcelain(args => git(root, args)))
      .split("\0")
      .filter((field) => field.startsWith("worktree "))
      .map((field) => field.slice(9));
    if (!trees.length)
      return { removed: 0, blocked: "无法确认工作树状态，辅助文件已保留" };
    // The helpers are shared by worktrees; a paused rebase may still have pending exec steps.
    for (const tree of trees) {
      for (const name of ["rebase-merge", "rebase-apply"]) {
        const path = resolve(
          tree,
          (await git(tree, ["rev-parse", "--git-path", name])).trim(),
        );
        const present = await lstat(path).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (present)
          return {
            removed: 0,
            blocked:
              "仍有工作树正在变基，辅助文件已保留；完成或中止后可再次清理",
          };
      }
    }
    let removed = 0;
    for (const candidate of candidates) {
      const path = join(directory, candidate.name);
      if (!(await lstat(path)).isDirectory()) continue;
      await rm(path, { recursive: true });
      removed++;
    }
    return { removed, blocked: null };
  } catch {
    return {
      removed: 0,
      blocked: "无法安全检查或清理变基辅助文件，请检查工作树和目录权限后重试",
    };
  }
}
