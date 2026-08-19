import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { cappedGitStdout } from "./git-exec.js";

// ── 工作区实时 git 状态：SCM 面板的读侧 ──────────────────────────────────────
//
// 跟 `git-diff.ts` 是两件事，别合并：那边看的是**分支之间**（任务分支 vs 合入目标，
// 给审查用，只读且天然稳定）；这里看的是**工作目录此刻**——暂存区、未暂存、未跟踪、
// 冲突。对 harness 来说后者的价值在于：约定是「改完立即提交」，所以**工作区不干净
// 本身就是一个信号**（agent 忘了提交，或者被中断在半路），面板要能一眼看出来。
//
// 解析走 `--porcelain=v2 -z`，不是 v1：
//   • v1 的 `XY path` 在重命名时是 `R  new -> old`，路径里带 ` -> ` 就会解错；
//     v2 把原路径放进独立字段。
//   • v1 不带 ahead/behind 与 upstream，那要另外再跑一次 rev-list。
//   • `-z` 是唯一能安全处理带换行/引号文件名的读法（v1 默认还会按 core.quotepath
//     把非 ASCII 转义成 \344\275\240，中文路径全变乱码）。
// 代价是重命名记录（`2 `开头）的原路径是**紧跟其后的下一个 NUL 段**，所以只能顺序
// 消费 token，不能按行 map。

const exec = promisify(execFile);
const DIFF_LIMIT_BYTES = 1024 * 1024;
const MAX_ENTRIES = 2000;
const MAX_COMMITS = 30;

export type ScmChangeKind =
  | "modified" | "added" | "deleted" | "renamed" | "copied" | "typechange" | "unmerged" | "untracked";

export type ScmGroupId = "merge" | "staged" | "unstaged" | "untracked";
export type ScmDiffSource = "staged" | "unstaged" | "untracked";

export interface ScmChange {
  path: string;
  /** 重命名/复制的来源路径，其它情况为 null。 */
  origPath: string | null;
  kind: ScmChangeKind;
  /** 冲突文件的具体形态，例如 both_modified；非冲突为 null。 */
  conflict: string | null;
}

export interface ScmBranchInfo {
  head: string | null;
  detached: boolean;
  oid: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
}

export interface ScmCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  at: string;
}

export interface ScmStatus {
  branch: ScmBranchInfo;
  merge: ScmChange[];
  staged: ScmChange[];
  unstaged: ScmChange[];
  untracked: ScmChange[];
  /** 条目超过上限被截断——面板要说清楚「下面这些没列全」。 */
  truncated: boolean;
  /** 正处在合并/变基/拣选的中途，此时提交与丢弃的含义都不一样。 */
  operation: "merge" | "rebase" | "cherry-pick" | "revert" | null;
}

export interface ScmFileDiff {
  path: string;
  origPath: string | null;
  source: ScmDiffSource;
  diff: string;
  truncated: boolean;
  limitBytes: number;
  binary: boolean;
}

const STAGED_KIND: Record<string, ScmChangeKind> = {
  M: "modified", A: "added", D: "deleted", R: "renamed", C: "copied", T: "typechange",
};

const CONFLICT_LABEL: Record<string, string> = {
  DD: "both_deleted", AU: "added_by_us", UD: "deleted_by_them", UA: "added_by_them",
  DU: "deleted_by_us", AA: "both_added", UU: "both_modified",
};

function kindOf(code: string): ScmChangeKind {
  return STAGED_KIND[code] ?? "modified";
}

/**
 * porcelain v2 的 NUL 分隔输出 → 分组后的改动清单。
 *
 * 一个文件可以**同时**落在 staged 和 unstaged 里（`MM` = 暂存了一版、之后又改了），
 * 这是 git 的真实状态，不是重复项：VSCode 也是两边都显示。合并成一条会让「暂存后
 * 又改了什么」这件事彻底看不见。
 */
export function parseStatusV2(output: string): Omit<ScmStatus, "operation"> {
  const branch: ScmBranchInfo = {
    head: null, detached: false, oid: null, upstream: null, ahead: null, behind: null,
  };
  const merge: ScmChange[] = [];
  const staged: ScmChange[] = [];
  const unstaged: ScmChange[] = [];
  const untracked: ScmChange[] = [];
  const tokens = output.split("\0");
  let truncated = false;
  let count = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const line = tokens[i];
    if (!line) continue;
    if (line.startsWith("# branch.")) {
      const [key, ...rest] = line.slice(2).split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid") branch.oid = value === "(initial)" ? null : value;
      else if (key === "branch.head") {
        branch.detached = value === "(detached)";
        branch.head = branch.detached ? null : value;
      } else if (key === "branch.upstream") branch.upstream = value || null;
      else if (key === "branch.ab") {
        const ab = /^\+(-?\d+) -(-?\d+)$/.exec(value);
        if (ab) {
          branch.ahead = Number(ab[1]);
          branch.behind = Number(ab[2]);
        }
      }
      continue;
    }
    if (line.startsWith("#")) continue;

    const type = line[0];
    if (type !== "1" && type !== "2" && type !== "u" && type !== "?") continue;
    if (count >= MAX_ENTRIES) {
      truncated = true;
      // 重命名记录后面还跟着一个原路径 token，跳过它，否则它会被当成下一条记录。
      if (type === "2") i += 1;
      continue;
    }
    count += 1;

    if (type === "?") {
      untracked.push({ path: line.slice(2), origPath: null, kind: "untracked", conflict: null });
      continue;
    }

    const fields = line.split(" ");
    const xy = fields[1] ?? "..";
    if (type === "u") {
      merge.push({
        path: fields.slice(10).join(" "),
        origPath: null,
        kind: "unmerged",
        conflict: CONFLICT_LABEL[xy] ?? "conflict",
      });
      continue;
    }

    // `1 ` 有 8 个前置字段，`2 ` 多一个 `<X><score>`；路径本身可能含空格，所以按
    // 已知字段数切尾，不能按分隔符数量反推。
    const pathStart = type === "2" ? 9 : 8;
    const path = fields.slice(pathStart).join(" ");
    const origPath = type === "2" ? (tokens[i + 1] ?? null) : null;
    if (type === "2") i += 1;

    const [x, y] = [xy[0], xy[1]];
    if (x && x !== ".") staged.push({ path, origPath, kind: kindOf(x), conflict: null });
    // 未暂存侧永远看不到重命名（重命名是索引里的事），也拿不到原路径。
    if (y && y !== ".") unstaged.push({ path, origPath: null, kind: kindOf(y), conflict: null });
  }

  return { branch, merge, staged, unstaged, untracked, truncated };
}

/** 中途操作靠 .git 里的标记文件判断——git status 不直接给这个。 */
async function inProgressOperation(root: string): Promise<ScmStatus["operation"]> {
  let gitDir: string;
  try {
    const { stdout } = await exec("git", ["-C", root, "rev-parse", "--absolute-git-dir"]);
    gitDir = stdout.trim();
  } catch {
    return null;
  }
  const has = (...parts: string[]) => existsSync(join(gitDir, ...parts));
  if (has("MERGE_HEAD")) return "merge";
  if (has("rebase-merge") || has("rebase-apply")) return "rebase";
  if (has("CHERRY_PICK_HEAD")) return "cherry-pick";
  if (has("REVERT_HEAD")) return "revert";
  return null;
}

export async function readScmStatus(root: string): Promise<ScmStatus> {
  const { stdout } = await exec(
    "git",
    ["-C", root, "status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  return { ...parseStatusV2(stdout), operation: await inProgressOperation(root) };
}

export async function readScmCommits(root: string, limit = MAX_COMMITS): Promise<ScmCommit[]> {
  try {
    const { stdout } = await exec(
      "git",
      ["-C", root, "log", "-n", String(Math.min(limit, MAX_COMMITS)), "--format=%H%x1f%h%x1f%s%x1f%an%x1f%cI"],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout.split("\n").filter(Boolean).map((line) => {
      const [sha, shortSha, subject, author, at] = line.split("\x1f");
      return { sha, shortSha, subject, author, at };
    });
  } catch {
    // 空仓库（还没有任何提交）走这里，返回空列表比抛错合适。
    return [];
  }
}

/**
 * pathspec 一律加 `:(literal)` 前缀。
 *
 * 文件名里出现 `*`、`?`、`[` 在真实仓库里并不罕见，而 git 默认把 pathspec 当 glob：
 * 不加这个前缀，「丢弃 a[1].txt 的改动」会连 a1.txt 一起丢掉。写操作（discard）尤其
 * 不能靠运气——这是不可逆的。
 */
export function literalPathspec(path: string): string {
  return `:(literal)${path}`;
}

export async function readScmFileDiff(
  root: string,
  path: string,
  source: ScmDiffSource,
  origPath: string | null = null,
  limitBytes = DIFF_LIMIT_BYTES,
): Promise<ScmFileDiff> {
  const common = ["diff", "--no-ext-diff", "--no-color", "--unified=3"];
  let args: string[];
  let allowed: readonly number[] = [0];
  if (source === "untracked") {
    // 未跟踪文件在 HEAD 和索引里都不存在，只能跟空文件比。`--no-index` 拿退出码
    // 表示「有没有差异」，有差异就是 1。
    args = [...common, "--no-index", "--", "/dev/null", path];
    allowed = [0, 1];
  } else if (source === "staged") {
    args = [...common, "--cached", "-M", "--", ...(origPath ? [literalPathspec(origPath)] : []), literalPathspec(path)];
  } else {
    args = [...common, "--", literalPathspec(path)];
  }

  let result: { text: string; truncated: boolean };
  try {
    result = await cappedGitStdout(root, args, limitBytes, allowed);
  } catch (error) {
    if (source !== "untracked") throw error;
    // Windows 的部分 git 构建不认 `/dev/null`。退回到「读不出预览」而不是把整个面板
    // 打挂：文件本身照样能在文件浏览器里打开。
    result = { text: "", truncated: false };
  }

  return {
    path,
    origPath,
    source,
    diff: result.text,
    truncated: result.truncated,
    limitBytes,
    binary: /^Binary files .* differ$/m.test(result.text),
  };
}
