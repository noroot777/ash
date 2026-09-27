import { readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { projects, sessions, tasks } from "./db/schema.js";
import { execFileText as exec } from "./exec.js";
import type { WorkspaceRoot } from "./file-browser.js";
import { readFileGitStatus } from "./file-git-status.js";
import { taskBranchChangedPaths } from "./git-diff.js";

// 「这个任务做出来的、值得看一眼的东西」——图片、网页、音视频、PDF。
//
// 跟文件树、改动面板刻意不是同一个问题：那两个回答「工作目录里现在有什么」和「代码
// 改了哪几行」，而这里回答「跑完这一趟，产出了什么可以直接看的东西」。所以判据是两条
// 叠加：**这个文件是这个任务弄出来的**，而且**它是拿来看的、不是拿来读 diff 的**。
//
// 「是这个任务弄出来的」有三个互不重叠的证据来源，缺一不可：
//   • working   —— 还在工作目录里没提交（git status 的未跟踪/已修改/已暂存）；
//   • committed —— 已经提交在任务分支上（相对合入目标的 merge-base 那一段）。仓库约定
//     是改完立即提交，所以**绝大多数产物落在这一档**，只看 git status 会几乎全漏；
//   • ignored   —— 被 .gitignore 挡着（output/、dist/…）。git 两条线都看不见它，只能扫
//     文件系统，再用「修改时间晚于任务第一次开跑」把仓库里本来就有的那些滤掉。
//
// mtime 这条判据**只对 ignored 这一档成立**，别往前两档推：建 worktree 是一次检出，所有
// 被跟踪的文件 mtime 都等于任务开跑的那一刻，拿 mtime 去问「是不是这次生成的」会把整个
// 仓库都答成「是」。被忽略的文件不在索引里、检出不会碰它们，那一档的 mtime 才有意义。

export type ArtifactKind = "image" | "video" | "audio" | "page" | "pdf";
/** 这份产物是从哪条线索认出来的，界面上要分组说清楚。 */
export type ArtifactOrigin = "working" | "committed" | "ignored";

export interface TaskArtifact {
  /** 相对工作区根、posix 分隔符——跟文件树、文件查看器用的是同一个主键。 */
  path: string;
  name: string;
  dir: string;
  kind: ArtifactKind;
  size: number;
  mtime: string | null;
  origin: ArtifactOrigin;
}

export interface TaskArtifactsResult {
  artifacts: TaskArtifact[];
  /** 撞上条数上限，后面还有没列出来的。 */
  truncated: boolean;
  /** ignored 那一档的时间下限（任务第一次开跑）。null = 没跑过，这一档整个跳过。 */
  since: string | null;
  /** 某一路线索读失败了（git 不可用之类）。不致命，只是那一档可能缺东西。 */
  error: string | null;
}

const KIND_BY_EXTENSION = new Map<string, ArtifactKind>([
  ...["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg", "heic", "tif", "tiff"]
    .map((ext) => [ext, "image"] as const),
  ...["mp4", "mov", "webm", "mkv", "avi", "m4v", "ogv"].map((ext) => [ext, "video"] as const),
  ...["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "aiff"].map((ext) => [ext, "audio"] as const),
  ...["html", "htm"].map((ext) => [ext, "page"] as const),
  ["pdf", "pdf"],
] as const satisfies readonly (readonly [string, ArtifactKind])[]);

// 扫被忽略的目录时绕开的那些：依赖树、构建缓存、IDE 自留地。它们本来就塞满 .svg/.png，
// 一个都不是「这个任务做出来的」，扫进去只会把真产物淹掉，还白费一趟磁盘遍历。
const SKIP_DIRS = new Set([
  ".git", "node_modules", "bower_components", ".yarn", ".pnpm-store",
  ".venv", "venv", "env", "__pycache__", "site-packages", ".tox", ".mypy_cache", ".pytest_cache",
  ".cache", ".parcel-cache", ".turbo", ".next", ".nuxt", ".svelte-kit", ".angular", ".astro",
  ".gradle", ".m2", "Pods", "DerivedData", ".stack-work", "elm-stuff", ".bundle",
  ".terraform", ".idea", ".vscode", ".expo", ".dart_tool",
  "coverage", ".nyc_output",
]);

const MAX_ARTIFACTS = 400;
/** 遍历被忽略目录时最多看这么多条目——目录再深再宽，也不让一次面板刷新拖垮服务端。 */
const MAX_WALK_ENTRIES = 20000;
const MAX_WALK_DEPTH = 8;

function kindOf(path: string): ArtifactKind | null {
  return KIND_BY_EXTENSION.get(extname(path).replace(/^\./, "").toLowerCase()) ?? null;
}

/** 任务第一次开跑的时刻。没有会话（还没跑过）时返回 null。 */
async function firstRunAt(taskId: string): Promise<string | null> {
  const first = (await db.select({ startedAt: sessions.startedAt })
    .from(sessions)
    .where(eq(sessions.taskId, taskId))
    .orderBy(asc(sessions.startedAt))
    .limit(1)).at(0);
  return first?.startedAt ?? null;
}

/**
 * 被 .gitignore 挡着的那些条目。`--directory` 让整个被忽略的目录折成一条 `dir/`，
 * 否则 node_modules 一家就能吐十万条路径。
 */
async function ignoredEntries(root: string): Promise<string[]> {
  const { stdout } = await exec("git", [
    "--no-optional-locks", "-C", root, "ls-files",
    "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory", "-z",
  ], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.split("\0").filter(Boolean);
}

/** 走一棵子树，把能看的文件挑出来。带深度、条数双上限，撞上就停。 */
async function walkForArtifacts(
  rootPath: string,
  relDir: string,
  budget: { entries: number },
  found: Set<string>,
): Promise<void> {
  const queue: { rel: string; depth: number }[] = [{ rel: relDir, depth: 0 }];
  while (queue.length) {
    const current = queue.shift()!;
    if (current.depth > MAX_WALK_DEPTH || budget.entries <= 0) return;
    let dirents;
    try {
      dirents = await readdir(join(rootPath, current.rel), { withFileTypes: true });
    } catch {
      continue; // 目录没了 / 读不动，跳过这一枝就好
    }
    for (const dirent of dirents) {
      if (budget.entries-- <= 0) return;
      const rel = current.rel ? `${current.rel}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        if (SKIP_DIRS.has(dirent.name)) continue;
        queue.push({ rel, depth: current.depth + 1 });
      } else if (dirent.isFile() && kindOf(dirent.name)) {
        found.add(rel);
      }
    }
  }
}

/**
 * 三路线索合成一份产物清单。
 *
 * 任何一路读失败都只记一句 `error` 继续走完剩下的：git 不在、分支被删、目录只读，都不该
 * 让整块面板变成一条红字——另外两路通常还能给出东西来。
 */
export async function readTaskArtifacts(
  taskId: string,
  root: WorkspaceRoot,
): Promise<TaskArtifactsResult> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  const problems: string[] = [];
  // 同一个文件可能同时是「已提交」和「又改了」。origin 取最靠近当下的那一档，
  // 所以按 working → committed → ignored 的顺序写入，先写的不被后面覆盖。
  const origins = new Map<string, ArtifactOrigin>();
  const remember = (path: string, origin: ArtifactOrigin) => {
    if (path && kindOf(path) && !origins.has(path)) origins.set(path, origin);
  };

  if (root.gitRepo) {
    const status = await readFileGitStatus(root.path);
    if (status.error) problems.push(`读工作区改动失败：${status.error}`);
    for (const change of status.changes) {
      if (change.kind !== "deleted") remember(change.path, "working");
    }

    // 已提交那一档：路径出自仓库根，而工作区根可能是仓库的某个子目录，得换算一次。
    const project = task
      ? (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0)
      : undefined;
    if (task && project?.repoPath) {
      const committed = await taskBranchChangedPaths(
        project.repoPath,
        task.id,
        task.mergeTargetBranch || task.worktreeBase,
        task.worktreeStartCommit,
      );
      if (committed.available) {
        let prefix = "";
        try {
          prefix = (await exec("git", ["-C", root.path, "rev-parse", "--show-prefix"])).stdout.replace(/\r?\n$/, "");
        } catch {
          prefix = "";
        }
        for (const path of committed.paths) {
          if (prefix && !path.startsWith(prefix)) continue;
          remember(prefix ? path.slice(prefix.length) : path, "committed");
        }
      }
    }
  }

  // 被忽略 / 根本不在 git 管辖里的那一档。只认「任务开跑之后才写的」。
  const since = await firstRunAt(taskId);
  const scanned = new Set<string>();
  if (since) {
    const budget = { entries: MAX_WALK_ENTRIES };
    if (root.gitRepo) {
      try {
        for (const entry of await ignoredEntries(root.path)) {
          if (budget.entries <= 0) break;
          if (entry.endsWith("/")) {
            const dir = entry.slice(0, -1);
            if (SKIP_DIRS.has(basename(dir))) continue;
            await walkForArtifacts(root.path, dir, budget, scanned);
          } else if (kindOf(entry)) {
            budget.entries -= 1;
            scanned.add(entry);
          }
        }
      } catch (error) {
        problems.push(`读被忽略的文件失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      // 不是 git 仓库：没有任何 git 线索，整棵树都只能靠修改时间来认。
      await walkForArtifacts(root.path, "", budget, scanned);
    }
  }

  const sinceMs = since ? Date.parse(since) : Number.NaN;
  const candidates = new Map<string, ArtifactOrigin>(origins);
  for (const path of scanned) if (!candidates.has(path)) candidates.set(path, "ignored");

  // 并发 stat：候选可能有上千个，一个个串着问，面板每 8 秒就白等一轮。
  const stated = await Promise.all([...candidates].map(async ([path, origin]) => {
    const info = await stat(join(root.path, path)).catch(() => null);
    return { path, origin, info };
  }));

  const artifacts: TaskArtifact[] = [];
  for (const { path, origin, info } of stated) {
    if (!info || !info.isFile()) continue; // 已删除 / 已改名的旧路径
    const mtimeMs = Number.isFinite(info.mtimeMs) ? info.mtimeMs : null;
    // 只有 ignored 那一档需要时间证据；git 认识的文件，git 已经证明过它变了。
    if (origin === "ignored" && (mtimeMs === null || !Number.isFinite(sinceMs) || mtimeMs < sinceMs)) continue;
    artifacts.push({
      path,
      name: basename(path),
      dir: path.split("/").slice(0, -1).join("/"),
      kind: kindOf(path)!,
      size: info.size,
      mtime: mtimeMs === null ? null : new Date(mtimeMs).toISOString(),
      origin,
    });
  }

  // 新的排前面：面板要回答的是「它刚刚做出了什么」。
  artifacts.sort((a, b) => (Date.parse(b.mtime ?? "") || 0) - (Date.parse(a.mtime ?? "") || 0)
    || a.path.localeCompare(b.path, "zh-Hans-CN", { numeric: true, sensitivity: "base" }));

  return {
    artifacts: artifacts.slice(0, MAX_ARTIFACTS),
    truncated: artifacts.length > MAX_ARTIFACTS,
    since,
    error: problems.join("；") || null,
  };
}
