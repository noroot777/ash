import { execFileText as exec } from "./exec.js";

// 任务分支差异证明的是「它的分支改过这条路径」，不是「现在磁盘上这份是它的那一版」。
// worktree 清理掉、面板退回主仓展示时，主仓那条路径上可能已经是别的任务后来提交的另一版——
// 页面打开的是磁盘上现在的内容，归属得对这一份（第 2 轮审查 #1、复审第 1 轮 #2）。
//
// 判法：拿任务分支末端那份 blob 跟磁盘上这份按 git 的规则算出来的 blob 比（`hash-object` 会按
// `.gitattributes` 做同样的换行/过滤处理，内容一样就一定相等）。
//
// **结果是三态，不是一个「匹配上的」集合**（复审第 2 轮 #2）：`mismatch` 是一条确定的负证据——
// 磁盘上这份不是它分支上那一版——调用方不能把它当成「还没找到正证据」，再拿 mtime、目录远近
// 把它重新升成确定。`unknown`（读不出来）同样不能替它作保。

export type BranchVersionCheck = "match" | "mismatch" | "unknown";

/** 一次 cat-file / hash-object 最多核这么多条；批量失败时退回逐条核，挑出读不出来的那几条。 */
const BATCH = 256;

/**
 * `relPaths`（相对工作区根）里每一条：磁盘上这份内容是不是任务分支末端那一版。
 *
 * `prefix` 是工作区根在仓库里的相对位置（`rev-parse --show-prefix`），分支里的路径要带上它。
 * 分支上已经删掉、或者分支上那一处不是文件的，算 `mismatch`。
 */
export async function checkBranchVersions(
  rootPath: string,
  prefix: string,
  sourceBranch: string,
  relPaths: readonly string[],
): Promise<Map<string, BranchVersionCheck>> {
  const out = new Map<string, BranchVersionCheck>();
  for (let at = 0; at < relPaths.length; at += BATCH) {
    const batch = relPaths.slice(at, at + BATCH);
    const checked = await checkBatch(rootPath, prefix, sourceBranch, batch);
    if (checked) {
      for (const [path, verdict] of checked) out.set(path, verdict);
      continue;
    }
    // 一整批读失败（某一个文件刚被删、读不动，`hash-object` 就整条命令失败）：逐条再核，别让
    // 一个坏的连累整批正常文件一起降级。
    for (const path of batch) {
      const one = batch.length > 1 ? await checkBatch(rootPath, prefix, sourceBranch, [path]) : null;
      out.set(path, one?.get(path) ?? "unknown");
    }
  }
  return out;
}

async function checkBatch(
  rootPath: string,
  prefix: string,
  sourceBranch: string,
  paths: readonly string[],
): Promise<Map<string, BranchVersionCheck> | null> {
  const out = new Map<string, BranchVersionCheck>();
  // 带换行的路径塞不进逐行协议：核不出来。
  const lineSafe = paths.filter((path) => {
    if (!/[\r\n]/.test(path)) return true;
    out.set(path, "unknown");
    return false;
  });
  if (!lineSafe.length) return out;
  try {
    const [branch, disk] = await Promise.all([
      exec("git", ["--no-optional-locks", "-C", rootPath, "cat-file", "--batch-check=%(objectname) %(objecttype)"], {
        input: lineSafe.map((path) => `${sourceBranch}:${prefix}${path}\n`).join(""),
        maxBuffer: 16 * 1024 * 1024,
      }),
      exec("git", ["--no-optional-locks", "-C", rootPath, "hash-object", "--stdin-paths"], {
        input: lineSafe.map((path) => `${path}\n`).join(""),
        maxBuffer: 16 * 1024 * 1024,
      }),
    ]);
    const branchIds = branch.stdout.split("\n");
    const diskIds = disk.stdout.split("\n");
    lineSafe.forEach((path, index) => {
      const [id, type] = (branchIds[index] ?? "").split(" ");
      const onDisk = diskIds[index]?.trim();
      if (!onDisk) out.set(path, "unknown");
      // 分支上没有这个文件（`missing`）或不是文件：分支末端那一版里没有它，磁盘上这份当然不是。
      else out.set(path, type === "blob" && id === onDisk ? "match" : "mismatch");
    });
    return out;
  } catch {
    return null;
  }
}

/** 一次最多查这么多条路径的「现在这一版是什么时候提交的」（每条一次 git log）。 */
const MAX_COMMIT_LOOKUPS = 64;

/**
 * 每条路径在当前检出上**最后一次被提交**的时刻（毫秒）。查不到（从没提交过、超过额度、读失败）
 * 就没有这一项。分支版本对不上时，现在这一版是那次提交落下的，并发裁决要拿这个时刻去问。
 */
export async function lastCommitTimes(rootPath: string, relPaths: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  await Promise.all(relPaths.slice(0, MAX_COMMIT_LOOKUPS).map(async (path) => {
    try {
      const { stdout } = await exec("git", [
        "--no-optional-locks", "-C", rootPath, "log", "-1", "--format=%ct", "HEAD", "--", `:(literal)${path}`,
      ]);
      const seconds = Number(stdout.trim());
      if (stdout.trim() && Number.isFinite(seconds)) out.set(path, seconds * 1000);
    } catch {
      // 读不出来就没有这一项：调用方按「不知道是什么时候」处理。
    }
  }));
  return out;
}
