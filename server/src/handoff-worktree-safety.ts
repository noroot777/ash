import { lstatSync } from "node:fs";
import { join } from "node:path";
import { execFileText as exec } from "./exec.js";
import { expandHome } from "./git.js";
import { HandoffError } from "./handoff-types.js";

const nulPaths = (raw: string): string[] => raw.split("\0").filter(Boolean);

const pathConflicts = (root: string, rel: string, tracked: ReadonlySet<string>): boolean => {
  const parts = rel.split("/");
  for (let index = 1; index <= parts.length; index += 1) {
    const candidate = parts.slice(0, index).join("/");
    if (tracked.has(candidate)) return false;
    try {
      const entry = lstatSync(join(root, candidate));
      if (index === parts.length || !entry.isDirectory()) return true;
    } catch { /* 这一层不存在，继续检查更深路径即可 */ }
  }
  return false;
};

/**
 * reset --hard 会静默覆盖“当前未跟踪、目标提交将开始跟踪”的同名路径。
 * 只检查目标树新增的路径，因此 .DS_Store、日志等不相干未跟踪文件仍可原样保留；
 * ignored 文件也必须检查，避免本机唯一一份 .env/草稿被远端同名新文件吞掉。
 */
export async function untrackedOverwriteConflicts(
  worktree: string,
  targetRef: string,
): Promise<string[] | null> {
  try {
    const root = expandHome(worktree);
    const [{ stdout: trackedRaw }, { stdout: targetRaw }] = await Promise.all([
      exec("git", ["-C", root, "ls-files", "-z"]),
      exec("git", ["-C", root, "ls-tree", "-rz", "--name-only", targetRef]),
    ]);
    const tracked = new Set(nulPaths(trackedRaw));
    return nulPaths(targetRaw).filter((rel) => !tracked.has(rel) && pathConflicts(root, rel, tracked));
  } catch {
    return null;
  }
}

/** reset --hard 只允许快进：原机接力后新增/分叉的已提交工作同样不能被静默覆盖。 */
export async function assertWorktreeHeadCanAdvance(worktree: string, targetRef: string): Promise<void> {
  const root = expandHome(worktree);
  let head: string;
  try {
    const result = await exec("git", ["-C", root, "rev-parse", "HEAD"]);
    head = result.stdout.trim();
  } catch {
    throw new HandoffError(`无法确认目标机任务 worktree 的当前提交：${root}。先检查这个目录，再重试。`, 409);
  }
  try {
    await exec("git", ["-C", root, "merge-base", "--is-ancestor", head, targetRef]);
  } catch {
    throw new HandoffError(
      `目标机现有的任务 worktree 包含本次传入提交未包含的本地提交或分叉（当前 ${head.slice(0, 8)}），不能覆盖。先合并两边提交，或另建分支保存目标机提交后再重试。`,
      409,
    );
  }
}
