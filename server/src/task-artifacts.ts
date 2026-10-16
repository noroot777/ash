import { readdir, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { asc, eq, inArray } from "drizzle-orm";
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
//     文件系统，再用时间判据把仓库里本来就有的那些滤掉。
//
// mtime 这条判据**只对 ignored 这一档成立**，别往前两档推：建 worktree 是一次检出，所有
// 被跟踪的文件 mtime 都等于任务开跑的那一刻，拿 mtime 去问「是不是这次生成的」会把整个
// 仓库都答成「是」。被忽略的文件不在索引里、检出不会碰它们，那一档的 mtime 才有意义。
//
// ── 判据边界：共享工作区 ───────────────────────────────────────────────────────
// `useWorktree=false` 的任务**直接在项目主仓干活**，同一个目录上先后（乃至同时）跑过
// 的任务都往那里写东西。两条边界都得划，少一条就串台：
//
//   ① 时间必须是**区间**而不是一个下限。一个 2026-06 跑过的任务用「开跑之后」去问，答案
//      是「这个仓库从那天起出现过的一切」：实测 daily-report 上三个不同任务拿到的清单
//      一模一样，400 条撞上限，其中 395 条是另一个任务三个月后的产出，它自己那几个反而
//      被挤出去了。所以时间判据取**任务真正在跑的那几段**（`runWindows`）。
//   ② 目录得排掉**别人的隔离工作区**：`<repo>/.worktrees/<任务>` 按定义是另一个任务的
//      地盘。它会落进 `git ls-files --ignored` 的结果，是因为 `.gitignore` 里 `videos/`、
//      `tmp/` 这类**没有前导斜杠**的规则匹配任意层级——所以跳过判定必须看路径的**每一
//      段**，只看 basename 挡不住 `.worktrees/x/videos/`（node_modules 同理）。
//
// 这两条收完，剩下的不确定性只有「同一个目录、同一段时间里并行跑的任务」（团队执行者、
// 共享主仓的并发任务）。那是物理上分不开的：同一个目录里的一个文件，除了时间没有别的
// 线索能说它是谁写的。界面上的角标说明按这个口径写。

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
  /** 时间判据的起点（任务第一次开跑）。null = 没跑过，吃时间判据的那几档整个跳过。 */
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

// 扫被忽略的目录时绕开的那些：依赖树、构建缓存、IDE 自留地，以及**别的任务的隔离工作
// 区**（`.worktrees/<任务>`、`.claude/worktrees/<名字>`）。前几类本来就塞满 .svg/.png，
// 一个都不是「这个任务做出来的」；最后一类更直接——那里面每一个文件都属于另一个任务。
const SKIP_DIRS = new Set([
  ".git", "node_modules", "bower_components", ".yarn", ".pnpm-store",
  ".venv", "venv", "env", "__pycache__", "site-packages", ".tox", ".mypy_cache", ".pytest_cache",
  ".cache", ".parcel-cache", ".turbo", ".next", ".nuxt", ".svelte-kit", ".angular", ".astro",
  ".gradle", ".m2", "Pods", "DerivedData", ".stack-work", "elm-stuff", ".bundle",
  ".terraform", ".idea", ".vscode", ".expo", ".dart_tool",
  "coverage", ".nyc_output",
  // 别的任务的隔离工作区：ash 自己建的在 `.worktrees/<任务>`，EnterWorktree 建的在
  // `.claude/worktrees/`——`.claude` 整个跳过（里面是 agent 的配置、技能和临时工作区，
  // 没有一样是「这一趟做出来给人看的东西」）。
  ".worktrees", ".claude",
]);
/**
 * Chrome/Chromium 的 profile 根有两样专有的东西：带空格的 `Local State` 文件和 `Default/`
 * 子目录。认它们、不认目录名——profile 根叫什么全凭起它的人（`x-browser-profile`、
 * `user-data-dir`…），而里面躺着成千上万个扩展图标、favicon 和 manifest 图标，一条都不是
 * 产出，数量却能把真产物整个压下去（实测一个 CDP 任务的面板 113 条里 107 条是图标）。
 */
const BROWSER_PROFILE_MARKERS = ["Local State", "Default"];
/**
 * 按**前缀**挡的那些：Python 虚拟环境的实际命名远不止 `.venv`（`.venv-melotts`、
 * `.venv-voxcpm`…）。它们一家就有几万个文件，字典序还排在最前面——实测 daily-report 上
 * 整个扫描预算在这里烧光，真产物一条都轮不到（面板空着，看起来像「什么都没做出来」）。
 */
const SKIP_DIR_PREFIXES = ["venv", ".venv"];

const MAX_ARTIFACTS = 400;
/** 遍历被忽略目录时最多看这么多条目——目录再深再宽，也不让一次面板刷新拖垮服务端。 */
const MAX_WALK_ENTRIES = 40000;
const MAX_WALK_DEPTH = 8;
/** 共享工作区上按时间认「已提交」时，最多回看这么多个提交。 */
const MAX_WINDOW_COMMITS = 500;

/**
 * 回合收尾之后还可能继续落盘的一点宽限：哨兵起的长跑命令（`start_monitor` 的进程由 ash
 * 拉起，活得比回合久）、agent 退出那一瞬还在写的子进程。给宽限是为了不漏，给得短是为了
 * 不串——共享工作区上，窗口每放宽一分钟就多吃一分钟别人的产出。
 */
const RUN_WINDOW_GRACE_MS = 10 * 60 * 1000;
/**
 * `ended_at` 是空的、任务却早已不在飞：那是**结算没留下收尾时刻**的老会话行（库里集中在
 * 2026-06，81/2355 条）。这种行按「从最后一个回合起算这么长」兜底。宁可宽一点多认几个，
 * 也不能当成「开放到现在」——那等于把这一档打回原形。
 */
const UNSETTLED_RUN_MS = 6 * 60 * 60 * 1000;

type ArtifactTask = typeof tasks.$inferSelect;

/** 任务在跑的一段时间（毫秒时间戳，闭区间）。 */
interface RunWindow {
  start: number;
  end: number;
}

function kindOf(path: string): ArtifactKind | null {
  return KIND_BY_EXTENSION.get(extname(path).replace(/^\./, "").toLowerCase()) ?? null;
}

/**
 * 这条相对路径要不要整个绕开。
 *
 * **逐段判**，不是只看最后一段：被忽略的条目可以是 `.worktrees/x/videos/` 这样的深路径
 * （无前导斜杠的 .gitignore 规则匹配任意层级），只问 basename 的话挡下的是 `videos`，
 * 而真正该挡的 `.worktrees` 在中间。虚拟环境那一类按前缀挡，
 * 因为它们的实际命名带后缀（`.venv-melotts`）。
 */
function skipsPath(rel: string): boolean {
  return rel.split("/").filter(Boolean).some((part) => SKIP_DIRS.has(part)
    || SKIP_DIR_PREFIXES.some((prefix) => part.startsWith(prefix)));
}

async function taskRow(id: string): Promise<ArtifactTask | undefined> {
  return (await db.select().from(tasks).where(eq(tasks.id, id))).at(0);
}

/**
 * 运行时间算在这个工作区头上的那些任务：自己，加上**跟它共用同一个目录的上游**。
 *
 * 为什么不直接用 `isolatedWorkspaceOwner`：那一个答的是「该落进哪个 worktree」，共享主仓
 * 时它返回 null，于是审查任务拿不到被审任务的 id——而审查任务工作区里值得看的东西，恰恰
 * 全是被审任务做出来的，只按审查自己那几分钟去卡，面板会一个不剩。这里答的是另一个问题：
 * 「这个目录里的东西，哪些任务的运行时间解释得通」，所以沿 `reviewOf`（审查跟到被审）和
 * **团队**父任务（执行者跟到调度台）两条边往上收，但**不要求目录隔离**。
 *
 * 普通派生任务的 `parentId` 不算：那是「从父分支起步」的依赖关系，它有自己的工作目录。
 */
async function workspaceRunOwners(task: ArtifactTask): Promise<ArtifactTask[]> {
  const owners = [task];
  const seen = new Set([task.id]);
  for (let cursor = 0; cursor < owners.length; cursor += 1) {
    const current = owners[cursor]!;
    const upstream: { id: string; teamOnly: boolean }[] = [];
    if (current.reviewOf) upstream.push({ id: current.reviewOf, teamOnly: false });
    if (current.parentId) upstream.push({ id: current.parentId, teamOnly: true });
    for (const { id, teamOnly } of upstream) {
      if (seen.has(id)) continue;
      seen.add(id);
      const row = await taskRow(id);
      if (!row || row.projectId !== task.projectId) continue;
      if (teamOnly && row.mode !== "team") continue;
      owners.push(row);
    }
  }
  return owners;
}

/** 这些任务真正在跑的那几段，重叠的合并掉（升序、互不相交）。 */
async function runWindows(owners: readonly ArtifactTask[]): Promise<RunWindow[]> {
  const inFlight = new Set(owners
    .filter((row) => row.status === "running" || row.status === "queued")
    .map((row) => row.id));
  const rows = await db.select({
    taskId: sessions.taskId,
    startedAt: sessions.startedAt,
    endedAt: sessions.endedAt,
    turnStartedAt: sessions.turnStartedAt,
    activeMs: sessions.activeMs,
  }).from(sessions).where(inArray(sessions.taskId, owners.map((row) => row.id)));

  const spans: RunWindow[] = [];
  for (const row of rows) {
    const start = Date.parse(row.startedAt ?? "");
    if (!Number.isFinite(start)) continue;
    const ended = Date.parse(row.endedAt ?? "");
    let end: number;
    if (Number.isFinite(ended)) {
      end = ended + RUN_WINDOW_GRACE_MS;
    } else if (inFlight.has(row.taskId)) {
      // 这一轮还在飞：**开到无穷**，不是「到现在这一刻」。它正在写，之后出现的东西只会
      // 是它写的，不存在「太晚了不算它的」；而拿 `Date.now()` 当硬上限会真的漏掉刚落盘
      // 的文件——mtime 是亚毫秒浮点、Date.now() 是整毫秒，同一毫秒内读就判在窗口外
      // （测试里偶发过一次），更别说容器/网络盘上文件时间与系统时钟本来就能差出几秒。
      end = Number.POSITIVE_INFINITY;
    } else {
      const lastTurn = Date.parse(row.turnStartedAt ?? "");
      const from = Number.isFinite(lastTurn) ? Math.max(start, lastTurn) : start;
      end = from + Math.max(row.activeMs ?? 0, UNSETTLED_RUN_MS) + RUN_WINDOW_GRACE_MS;
    }
    spans.push({ start, end: Math.max(end, start) });
  }

  spans.sort((a, b) => a.start - b.start);
  const merged: RunWindow[] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

const withinWindows = (ms: number | null, windows: readonly RunWindow[]) =>
  ms !== null && Number.isFinite(ms) && windows.some((window) => ms >= window.start && ms <= window.end);

/**
 * 被 .gitignore 挡着的那些条目，**按跟运行区间的相关性排序**。`--directory` 让整个被忽略
 * 的目录折成一条 `dir/`，否则 node_modules 一家就能吐十万条路径。
 *
 * 排序不是锦上添花：扫描有预算上限（`MAX_WALK_ENTRIES`），而 git 给出的是**字典序**——
 * 实测一个 1300+ 被忽略目录的项目里，预算在排前面的那几棵大树上烧光，真产物一条都轮不
 * 到。拿目录自己的 mtime 排一下，预算就先花在最可能装着这一趟产出的地方；预算真不够时，
 * 丢掉的也是最不相关的那些，而不是「字典序靠后的那些」。
 *
 * 目录 mtime 只是**优先级**，不能当剪枝用：它只记直接子项的增删，深一层新建文件不会把
 * 它顶上来。所以三档都要扫，只是顺序不同。
 */
async function ignoredEntriesByRelevance(root: string, windows: readonly RunWindow[]): Promise<string[]> {
  const { stdout } = await exec("git", [
    "--no-optional-locks", "-C", root, "ls-files",
    "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory", "-z",
  ], { maxBuffer: 16 * 1024 * 1024 });
  const entries = stdout.split("\0").filter(Boolean);
  const latestEnd = Math.max(...windows.map((window) => window.end));
  const ranked = await Promise.all(entries.map(async (rel) => {
    const info = await stat(join(root, rel.endsWith("/") ? rel.slice(0, -1) : rel)).catch(() => null);
    const mtime = info && Number.isFinite(info.mtimeMs) ? info.mtimeMs : 0;
    // 0 = 这一档自己就在区间里动过；1 = 区间之后才动过（仍可能装着区间里的文件）；
    // 2 = 区间之前就没再动过（只可能装着后来被改写的旧文件）。
    const rank = withinWindows(mtime, windows) ? 0 : (mtime > latestEnd ? 1 : 2);
    return { rel, rank, mtime };
  }));
  ranked.sort((a, b) => a.rank - b.rank || b.mtime - a.mtime);
  return ranked.map((entry) => entry.rel);
}

/**
 * 共享工作区上的「已提交」那一档：**当前 HEAD 上落在任务运行区间里的提交**动过哪些路径。
 *
 * 有任务分支时 committed 走 `merge-base..分支`，那是精确的；而 `useWorktree=false` 的任务
 * 直接在项目主仓的目标分支上提交，压根没有一条属于它的分支，`taskBranchChangedPaths`
 * 一律报 `source_branch_missing`——于是这类任务**提交进仓库的产物一个都列不出来**（而仓库
 * 约定是改完立即提交，等于这一档全瞎）。退回时间证据：精度跟 ignored 那一档一样，同一段
 * 时间里别人在同一个目录提交的东西分不开，但比「一个都看不到」好。
 *
 * merge 提交默认不出 `--name-only` 内容，所以「用户事后把别的任务分支合进来」带来的那一
 * 大堆不会算到这里，正合判据。
 */
async function committedInWindows(root: string, windows: readonly RunWindow[]): Promise<string[]> {
  if (!windows.length) return [];
  const since = new Date(Math.min(...windows.map((window) => window.start))).toISOString();
  // 有一段还开着（任务在飞）就不设上界：那一段的 end 是 Infinity，塞进 Date 只会抛。
  const openEnded = windows.some((window) => !Number.isFinite(window.end));
  const until = openEnded ? null : new Date(Math.max(...windows.map((window) => window.end))).toISOString();
  const { stdout } = await exec("git", [
    "--no-optional-locks", "-c", "core.quotePath=false", "-C", root, "log",
    `--since=${since}`, ...(until ? [`--until=${until}`] : []), `--max-count=${MAX_WINDOW_COMMITS}`,
    // \x01 开头的行是提交时刻，其余非空行是它动过的路径。
    "--format=%x01%cI", "--name-only",
  ], { maxBuffer: 16 * 1024 * 1024 });

  const paths = new Set<string>();
  let at: number = Number.NaN;
  for (const raw of stdout.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("\u0001")) {
      at = Date.parse(line.slice(1));
      continue;
    }
    // 区间是若干段的并集，`--since/--until` 只能给出外包络，逐个提交再核一次。
    if (!line || !kindOf(line) || !withinWindows(at, windows)) continue;
    paths.add(line);
  }
  return [...paths];
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
    const names = new Set(dirents.map((dirent) => dirent.name));
    if (BROWSER_PROFILE_MARKERS.every((marker) => names.has(marker))) continue; // 浏览器 profile，整棵不要
    for (const dirent of dirents) {
      if (budget.entries-- <= 0) return;
      const rel = current.rel ? `${current.rel}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        if (skipsPath(rel)) continue;
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
  const task = await taskRow(taskId);
  const problems: string[] = [];
  // 同一个文件可能同时是「已提交」和「又改了」。origin 取最靠近当下的那一档，
  // 所以按 working → committed → ignored 的顺序写入，先写的不被后面覆盖。
  const origins = new Map<string, ArtifactOrigin>();
  // git 两档不过 `skipsPath`：那张表是**扫文件系统时**的护栏（依赖树、构建缓存、别人的
  // worktree 里本来就塞满图片），而 git 认识的路径已经自带归属证据——一份真被提交进
  // `coverage/` 的报告该列出来，不该被护栏误伤。
  const remember = (path: string, origin: ArtifactOrigin) => {
    if (path && kindOf(path) && !origins.has(path)) origins.set(path, origin);
  };

  // 时间判据：这个工作区上「它在跑」的那几段。空数组 = 没跑过，吃时间的那几档整个跳过。
  const windows = task ? await runWindows(await workspaceRunOwners(task)) : [];

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
      let prefix = "";
      try {
        prefix = (await exec("git", ["-C", root.path, "rev-parse", "--show-prefix"])).stdout.replace(/\r?\n$/, "");
      } catch {
        prefix = "";
      }
      const relocate = (path: string) => {
        if (prefix && !path.startsWith(prefix)) return null;
        return prefix ? path.slice(prefix.length) : path;
      };
      const committed = await taskBranchChangedPaths(
        project.repoPath,
        task.id,
        task.mergeTargetBranch || task.worktreeBase,
        task.worktreeStartCommit,
      );
      if (committed.available) {
        for (const path of committed.paths) {
          const rel = relocate(path);
          if (rel) remember(rel, "committed");
        }
      } else {
        // 没有属于它的分支（共享工作区）/ 目标分支被删：退回运行区间里的提交。
        try {
          for (const path of await committedInWindows(root.path, windows)) {
            const rel = relocate(path);
            if (rel) remember(rel, "committed");
          }
        } catch (error) {
          problems.push(`读运行期间的提交失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  // 被忽略 / 根本不在 git 管辖里的那一档。只认「任务在跑的那几段里写的」。
  const since = await firstRunAt(taskId);
  const scanned = new Set<string>();
  if (windows.length) {
    const budget = { entries: MAX_WALK_ENTRIES };
    if (root.gitRepo) {
      try {
        for (const entry of await ignoredEntriesByRelevance(root.path, windows)) {
          if (budget.entries <= 0) break;
          if (entry.endsWith("/")) {
            const dir = entry.slice(0, -1);
            if (skipsPath(dir)) continue;
            await walkForArtifacts(root.path, dir, budget, scanned);
          } else if (kindOf(entry) && !skipsPath(entry)) {
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
    // 预算烧光了得说出来：那时「列表是空的」不等于「它什么都没做出来」，而这两件事在
    // 面板上长得一模一样。
    if (budget.entries <= 0) {
      problems.push("工作目录太大，被 .gitignore 挡着的那一档只扫了一部分（已按最近改动优先）");
    }
  }

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
    if (origin === "ignored" && !withinWindows(mtimeMs, windows)) continue;
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
