import { execFileText as exec } from "./exec.js";
import { parseStatusV2, type ScmChange, type ScmDiffSource } from "./git-status.js";

/**
 * 文件树把 git status 的四组拍平成一个列表，每条都得记住自己出自哪一组：不然「点开这个
 * 文件」就无从知道该比哪一段——同一个文件在暂存侧和工作树侧内容可以完全不同。冲突文件
 * 读的是工作树，所以 `merge` 归 `unstaged`（与 `scmModel.ts` 的 `diffSourceOf` 同口径）。
 */
export type FileGitStatus = {
  changes: (Pick<ScmChange, "path" | "origPath" | "kind"> & { source: ScmDiffSource })[];
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
    const grouped: [ScmDiffSource, ScmChange[]][] = [
      ["staged", parsed.staged],
      ["unstaged", parsed.unstaged],
      ["untracked", parsed.untracked],
      ["unstaged", parsed.merge],
    ];
    // Git 的 porcelain 路径相对仓库根；文件树也可能从仓库的子目录开始。
    const changes = grouped
      .flatMap(([source, list]) => list.map((change) => ({ source, change })))
      .flatMap(({ source, change }) => {
        const path = relativePath(change.path);
        const origPath = relativePath(change.origPath);
        if (path) return [{ path, origPath, kind: change.kind, source }];
        return change.kind === "renamed" && origPath
          ? [{ path: origPath, origPath: null, kind: "deleted" as const, source }] : [];
      });
    return { changes, truncated: parsed.truncated, error: null };
  } catch (error) {
    return { changes: [], truncated: false, error: error instanceof Error ? error.message : String(error) };
  }
}
