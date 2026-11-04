import { execFileText as exec } from "./exec.js";
import type { CommitEvidence } from "./task-artifact-scope.js";

// 「这条路径过去被它改过」不等于「现在磁盘上这份是它那一版」。页面打开的是磁盘上现在的内容，
// 归属得对这一份（第 2 轮审查 #1、复审第 1 轮 #2、复审第 3 轮 #2）。两类证据都要过这一关：
//
//   - 任务分支差异：分支末端那份 blob 跟磁盘上这份比；
//   - 运行区间里按时间找到的提交：那几次提交里，有没有哪一次落下的 blob 就是磁盘上这份。
//     **不按日期推「现在是哪一版」**：合并提交默认不列路径、提交日期可以回拨，「最晚那次」答不了。
//
// 磁盘上这份的 blob 用 `hash-object` 算（会按 `.gitattributes` 做同样的换行/过滤处理，内容一样就
// 一定相等）。结果都是三态：`mismatch` 是一条确定的负证据，调用方不能当成「还没找到正证据」，
// 再拿 mtime 把它重新升成确定；`unknown`（读不出来）同样不能替它作保。

export type BranchVersionCheck = "match" | "mismatch" | "unknown";

/** 一次 cat-file / hash-object 最多核这么多条；批量失败时退回逐条核，挑出读不出来的那几条。 */
const BATCH = 256;

/** 带换行的路径塞不进逐行协议。 */
const lineSafe = (path: string) => !/[\r\n]/.test(path);

/**
 * 磁盘上这些文件（相对 `rootPath`）各自的 blob。读不出来的那几条没有这一项。
 *
 * 一整批失败（某一个文件刚被删、读不动，`hash-object` 就整条命令失败）时逐条再算，别让一个坏的
 * 连累整批正常文件。
 */
async function diskBlobs(rootPath: string, paths: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const hash = async (batch: readonly string[]) => {
    const { stdout } = await exec("git", ["--no-optional-locks", "-C", rootPath, "hash-object", "--stdin-paths"], {
      input: batch.map((path) => `${path}\n`).join(""),
      maxBuffer: 16 * 1024 * 1024,
    });
    const ids = stdout.split("\n");
    batch.forEach((path, index) => {
      const id = ids[index]?.trim();
      if (id) out.set(path, id);
    });
  };
  const safe = paths.filter(lineSafe);
  for (let at = 0; at < safe.length; at += BATCH) {
    const batch = safe.slice(at, at + BATCH);
    try {
      await hash(batch);
    } catch {
      for (const path of batch) await hash([path]).catch(() => {});
    }
  }
  return out;
}

/**
 * `<提交或分支>:<仓库内路径>` 这些对象各自的 blob（不是文件、不存在的就是 null）。整条命令失败返回 null。
 */
async function treeBlobs(rootPath: string, specs: readonly string[]): Promise<(string | null)[] | null> {
  const out: (string | null)[] = [];
  try {
    for (let at = 0; at < specs.length; at += BATCH) {
      const batch = specs.slice(at, at + BATCH);
      const { stdout } = await exec("git", ["--no-optional-locks", "-C", rootPath, "cat-file", "--batch-check=%(objectname) %(objecttype)"], {
        input: batch.map((spec) => `${spec}\n`).join(""),
        maxBuffer: 16 * 1024 * 1024,
      });
      const lines = stdout.split("\n");
      batch.forEach((_, index) => {
        const [id, type] = (lines[index] ?? "").split(" ");
        out.push(type === "blob" && id ? id : null);
      });
    }
    return out;
  } catch {
    return null;
  }
}

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
  const paths = relPaths.filter(lineSafe);
  const [disk, branch] = await Promise.all([
    diskBlobs(rootPath, paths),
    treeBlobs(rootPath, paths.map((path) => `${sourceBranch}:${prefix}${path}`)),
  ]);
  const out = new Map<string, BranchVersionCheck>(relPaths.map((path) => [path, "unknown"]));
  paths.forEach((path, index) => {
    const onDisk = disk.get(path);
    if (!onDisk || !branch) return;
    out.set(path, branch[index] === onDisk ? "match" : "mismatch");
  });
  return out;
}

/** 磁盘上这份是运行区间里哪一次提交落下的；对不上 / 核不出来就是另外两态。 */
export type CommitVersionCheck = { commit: CommitEvidence } | "mismatch" | "unknown";

/**
 * 每条路径：在它被运行区间里那几次提交动过的版本里，找出 blob 就是磁盘上这份的那一次。
 * 有好几次落下的是同一份内容时，精确区间里的优先，同档里取最晚的。
 */
export async function checkCommitVersions(
  rootPath: string,
  prefix: string,
  candidates: ReadonlyMap<string, readonly CommitEvidence[]>,
): Promise<Map<string, CommitVersionCheck>> {
  const out = new Map<string, CommitVersionCheck>([...candidates.keys()].map((path) => [path, "unknown"]));
  const paths = [...candidates.keys()].filter(lineSafe);
  if (!paths.length) return out;
  const pairs = paths.flatMap((path) => candidates.get(path)!.map((commit) => ({ path, commit })));
  const [disk, blobs] = await Promise.all([
    diskBlobs(rootPath, paths),
    treeBlobs(rootPath, pairs.map(({ path, commit }) => `${commit.hash}:${prefix}${path}`)),
  ]);
  if (!blobs) return out;
  const best = new Map<string, CommitEvidence>();
  pairs.forEach(({ path, commit }, index) => {
    if (!disk.get(path) || blobs[index] !== disk.get(path)) return;
    const seen = best.get(path);
    if (!seen || (commit.exact && !seen.exact) || (commit.exact === seen.exact && commit.at > seen.at)) best.set(path, commit);
  });
  for (const path of paths) {
    if (!disk.has(path)) continue;
    const commit = best.get(path);
    out.set(path, commit ? { commit } : "mismatch");
  }
  return out;
}
