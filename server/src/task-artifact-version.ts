import { execFileText as exec } from "./exec.js";

// 任务分支差异证明的是「它的分支改过这条路径」，不是「现在磁盘上这份是它的那一版」。
// worktree 清理掉、面板退回主仓展示时，主仓那条路径上可能已经是别的任务后来提交的另一版——
// 页面打开的是磁盘上现在的内容，归属得对这一份（第 2 轮审查 #1、复审第 1 轮 #2）。
//
// 判法：拿任务分支末端那份 blob 跟磁盘上这份按 git 的规则算出来的 blob 比（`hash-object` 会按
// `.gitattributes` 做同样的换行/过滤处理，内容一样就一定相等）。一样 → 分支证明照旧成立；
// 不一样、分支上已经删了、或者核不出来 → 不认这份是它的版本，调用方按时间重新判。

/**
 * `relPaths`（相对工作区根）里，磁盘上这份内容**就是**任务分支末端那一版的那些。
 *
 * `prefix` 是工作区根在仓库里的相对位置（`rev-parse --show-prefix`），分支里的路径要带上它。
 * 任何一步读失败都返回空集：核不出来就不替它作保。
 */
export async function matchingBranchVersions(
  rootPath: string,
  prefix: string,
  sourceBranch: string,
  relPaths: readonly string[],
): Promise<Set<string>> {
  // 带换行的路径塞不进逐行协议，照「核不出来」处理。
  const paths = relPaths.filter((path) => !/[\r\n]/.test(path));
  if (!paths.length) return new Set();
  try {
    const [branch, disk] = await Promise.all([
      exec("git", ["--no-optional-locks", "-C", rootPath, "cat-file", "--batch-check=%(objectname) %(objecttype)"], {
        input: paths.map((path) => `${sourceBranch}:${prefix}${path}\n`).join(""),
        maxBuffer: 16 * 1024 * 1024,
      }),
      exec("git", ["--no-optional-locks", "-C", rootPath, "hash-object", "--stdin-paths"], {
        input: paths.map((path) => `${path}\n`).join(""),
        maxBuffer: 16 * 1024 * 1024,
      }),
    ]);
    const branchIds = branch.stdout.split("\n");
    const diskIds = disk.stdout.split("\n");
    const out = new Set<string>();
    paths.forEach((path, index) => {
      const [id, type] = (branchIds[index] ?? "").split(" ");
      if (type === "blob" && id && id === diskIds[index]?.trim()) out.add(path);
    });
    return out;
  } catch {
    return new Set();
  }
}
