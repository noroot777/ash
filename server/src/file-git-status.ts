import { execFileText as exec } from "./exec.js";
import { parseStatusV2, type ScmChange } from "./git-status.js";

export type FileGitStatus = {
  changes: Pick<ScmChange, "path" | "origPath" | "kind">[];
  truncated: boolean;
  error: string | null;
};

export async function readFileGitStatus(root: string): Promise<FileGitStatus> {
  try {
    const [status, prefixResult] = await Promise.all([
      exec("git", ["--no-optional-locks", "-C", root, "status", "--porcelain=v2", "-z", "--untracked-files=all", "--", "."],
        { maxBuffer: 32 * 1024 * 1024 }),
      exec("git", ["-C", root, "rev-parse", "--show-prefix"]),
    ]);
    const prefix = prefixResult.stdout.replace(/\r?\n$/, "");
    const relativePath = (path: string | null) => path !== null && path.startsWith(prefix)
      ? path.slice(prefix.length) : null;
    const parsed = parseStatusV2(status.stdout);
    // Git 的 porcelain 路径相对仓库根；文件树也可能从仓库的子目录开始。
    const changes = [...parsed.staged, ...parsed.unstaged, ...parsed.untracked, ...parsed.merge]
      .flatMap((change) => {
        const path = relativePath(change.path);
        const origPath = relativePath(change.origPath);
        if (path) return [{ path, origPath, kind: change.kind }];
        return change.kind === "renamed" && origPath
          ? [{ path: origPath, origPath: null, kind: "deleted" as const }] : [];
      });
    return { changes, truncated: parsed.truncated, error: null };
  } catch (error) {
    return { changes: [], truncated: false, error: error instanceof Error ? error.message : String(error) };
  }
}
