import { access, readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { execFileText as exec } from "./exec.js";
import { withinWindows, type RunWindow } from "./task-artifact-windows.js";

// 产物面板的**文件系统那一半**：哪些路径要整棵绕开、被忽略的条目按什么顺序扫、预算怎么
// 花。归属证据在 `task-artifact-scope.ts`，三档合成在 `task-artifacts.ts`。

export type ArtifactKind = "image" | "video" | "audio" | "page" | "pdf";

const KIND_BY_EXTENSION = new Map<string, ArtifactKind>([
  ...["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg", "heic", "tif", "tiff"]
    .map((ext) => [ext, "image"] as const),
  ...["mp4", "mov", "webm", "mkv", "avi", "m4v", "ogv"].map((ext) => [ext, "video"] as const),
  ...["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "aiff"].map((ext) => [ext, "audio"] as const),
  ...["html", "htm"].map((ext) => [ext, "page"] as const),
  ["pdf", "pdf"],
] as const satisfies readonly (readonly [string, ArtifactKind])[]);

export function kindOf(path: string): ArtifactKind | null {
  return KIND_BY_EXTENSION.get(extname(path).replace(/^\./, "").toLowerCase()) ?? null;
}

// 扫被忽略的目录时绕开的那些：依赖树、构建缓存、IDE 自留地，以及**别的任务的隔离工作
// 区**（`.worktrees/<任务>`、`.claude/worktrees/`）。前几类本来就塞满 .svg/.png，一个都
// 不是「这个任务做出来的」；最后一类更直接——那里面每一个文件都属于另一个任务。
const SKIP_DIRS = new Set([
  ".git", "node_modules", "bower_components", ".yarn", ".pnpm-store",
  "__pycache__", "site-packages", ".tox", ".mypy_cache", ".pytest_cache",
  ".cache", ".parcel-cache", ".turbo", ".next", ".nuxt", ".svelte-kit", ".angular", ".astro",
  ".gradle", ".m2", "Pods", "DerivedData", ".stack-work", "elm-stuff", ".bundle",
  ".terraform", ".idea", ".vscode", ".expo", ".dart_tool",
  "coverage", ".nyc_output",
  // 别的任务的隔离工作区：ash 自己建的在 `.worktrees/<任务>`，EnterWorktree 建的在
  // `.claude/worktrees/`——`.claude` 整个跳过（里面是 agent 的配置、技能和临时工作区，
  // 没有一样是「这一趟做出来给人看的东西」）。
  ".worktrees", ".claude",
  "venv", "env",
]);

/**
 * 虚拟环境**目录**：实际命名远不止 `.venv`（`.venv-melotts`、`venv3.11`…），它们一家就有
 * 几万个文件，字典序还排在最前面——实测 daily-report 上整个扫描预算在这里烧光，真产物一条
 * 都轮不到（面板空着，看起来像「什么都没做出来」）。
 *
 * 边界要卡住，不能一个 `startsWith("venv")` 了事：`.venv` 开头的点目录一律是约定的隐藏
 * 环境目录（`.venv-melotts` 就是这么来的），而**不带点**的只认 `venv` 本体和跟着版本号的
 * 那几种（`venv3`、`venv3.11`）——`venv-report/` 这样正经的目录不能挡（第 1 轮审查 N3）。
 * 漏挡一个叫 `venv-xxx` 的真环境目录不要紧：它只是少一层护栏，还有预算和排序兜着；而挡掉
 * 一个真目录是直接漏报，用户看不见自己的东西。
 */
const isVirtualEnvDir = (name: string) => name.startsWith(".venv") || /^venv[\d._]*$/.test(name);

/** 这几段目录名里有要绕开的吗。**只用于目录段**——文件名不吃目录规则。 */
const skipsDirSegments = (parts: readonly string[]) =>
  parts.some((part) => SKIP_DIRS.has(part) || isVirtualEnvDir(part));

/** 一条目录路径（`a/b/c` 全是目录）要不要整棵绕开。 */
export const skipsDirPath = (rel: string) => skipsDirSegments(rel.split("/").filter(Boolean));

/**
 * 一条文件路径要不要绕开：只看它的**祖先目录**。
 *
 * 最后一段是文件名，不能拿目录规则去套——单独被 `*.png` 忽略的 `venv.png`、`coverage.png`
 * 本身就是一张图，挡掉它就是漏报（第 1 轮审查 N3）。
 */
export const skipsFilePath = (rel: string) => {
  const parts = rel.split("/").filter(Boolean);
  return skipsDirSegments(parts.slice(0, -1));
};

/**
 * Chrome/Chromium 的 profile 根有两样专有的东西：带空格的 `Local State` 文件和 `Default/`
 * 子目录。认它们、不认目录名——profile 根叫什么全凭起它的人（`x-browser-profile`、
 * `user-data-dir`…），而里面躺着成千上万个扩展图标、favicon 和 manifest 图标，一条都不是
 * 产出，数量却能把真产物整个压下去（实测一个 CDP 任务的面板 113 条里 107 条是图标）。
 */
const BROWSER_PROFILE_MARKERS = ["Local State", "Default"];

async function looksLikeBrowserProfile(absDir: string): Promise<boolean> {
  const checks = await Promise.all(BROWSER_PROFILE_MARKERS
    .map((marker) => access(join(absDir, marker)).then(() => true, () => false)));
  return checks.every(Boolean);
}

/**
 * 这条路径**落在某个浏览器 profile 里面**吗——逐级祖先问，不是只看当前目录。
 *
 * 忽略规则决定了 git 把入口折到哪一层：`*.png` 这种写法会让它直接交出
 * `profile/Default/Extensions/…/icon.png` 这样的深路径，扫描从 profile 根**以下**开始，
 * 永远见不到同层的那两个标志（第 1 轮审查 N2）。缓存按目录记，一个 profile 只问一次。
 */
export async function insideBrowserProfile(
  rootPath: string,
  rel: string,
  cache: Map<string, boolean>,
): Promise<boolean> {
  const parts = rel.split("/").filter(Boolean);
  // 最后一段可能是文件名；多问一层目录不会错（文件名不会同时有 Local State 和 Default）。
  // `depth === 0` 是**工作目录自己**：它本身就是个 profile 目录（用户把任务目录开在
  // `Chrome/User Data/` 里）时，祖先只查到 `Default` 就停了，根上那两个标志一次都没问过，
  // 扩展图标照样进产物（第 2 轮审查 N2）。单文件入口和目录入口都走这个函数，一起覆盖。
  for (let depth = parts.length; depth >= 0; depth -= 1) {
    const dir = parts.slice(0, depth).join("/");
    let hit = cache.get(dir);
    if (hit === undefined) {
      hit = await looksLikeBrowserProfile(join(rootPath, dir));
      cache.set(dir, hit);
    }
    if (hit) return true;
  }
  return false;
}

/** 遍历被忽略目录时最多看这么多条目——目录再深再宽，也不让一次面板刷新拖垮服务端。 */
const MAX_WALK_ENTRIES = 40000;
const MAX_WALK_DEPTH = 8;
/**
 * 排序前问文件属性的条目数上限。这一步在扫描预算**之外**，所以自己也得有个封顶：一个
 * 单文件忽略规则写得很碎的大仓能吐出几万条路径，为了返回三张图先发起几万次属性查询，
 * 而面板每八秒就再来一轮（第 1 轮审查 N5）。
 */
const MAX_RANK_STATS = 4000;
const RANK_STAT_BATCH = 256;

export interface ScanOutcome {
  /** 扫到的候选路径（相对工作区根）。 */
  paths: Set<string>;
  /** 清单可能不全：预算用满、目录读不动、或者深到看不下去。 */
  incomplete: string[];
}

/**
 * 被 .gitignore 挡着的那些条目，**按跟运行区间的相关性排序**。`--directory` 让整个被忽略
 * 的目录折成一条 `dir/`，否则 node_modules 一家就能吐十万条路径。
 *
 * 排序不是锦上添花：扫描有预算上限，而 git 给出的是**字典序**——实测一个 1300+ 被忽略
 * 目录的项目里，预算在排前面的那几棵大树上烧光，真产物一条都轮不到。拿目录自己的 mtime
 * 排一下，预算就先花在最可能装着这一趟产出的地方；预算真不够时，丢掉的也是最不相关的
 * 那些，而不是「字典序靠后的那些」。
 *
 * 目录 mtime 只是**优先级**，不能当剪枝用：它只记直接子项的增删，深一层新建文件不会把
 * 它顶上来。所以三档都要扫，只是顺序不同。
 */
async function orderedIgnoredEntries(
  rootPath: string,
  windows: readonly RunWindow[],
  incomplete: string[],
): Promise<string[]> {
  const { stdout } = await exec("git", [
    "--no-optional-locks", "-C", rootPath, "ls-files",
    "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory", "-z",
  ], { maxBuffer: 16 * 1024 * 1024 });

  // **先做廉价排除再问属性**：被排除的子树根本不该为它发起文件查询。
  const candidates: { rel: string; dir: boolean }[] = [];
  for (const raw of stdout.split("\0")) {
    if (!raw) continue;
    const dir = raw.endsWith("/");
    const rel = dir ? raw.slice(0, -1) : raw;
    if (dir ? skipsDirPath(rel) : (skipsFilePath(rel) || !kindOf(rel))) continue;
    candidates.push({ rel, dir });
  }

  const latestEnd = windows.length ? Math.max(...windows.map((window) => window.end)) : 0;
  const ranked: { rel: string; rank: number; mtime: number }[] = [];
  const stated = candidates.slice(0, MAX_RANK_STATS);
  if (candidates.length > stated.length) {
    incomplete.push(`被忽略的条目太多（${candidates.length} 条），只对最前面 ${MAX_RANK_STATS} 条排过序`);
  }
  for (let at = 0; at < stated.length; at += RANK_STAT_BATCH) {
    const batch = await Promise.all(stated.slice(at, at + RANK_STAT_BATCH).map(async ({ rel }) => {
      const info = await stat(join(rootPath, rel)).catch(() => null);
      const mtime = info && Number.isFinite(info.mtimeMs) ? info.mtimeMs : 0;
      // 0 = 这一档自己就在区间里动过；1 = 区间之后才动过（仍可能装着区间里的文件）；
      // 2 = 区间之前就没再动过（只可能装着后来被改写的旧文件）。
      const rank = withinWindows(mtime, windows) ? 0 : (mtime > latestEnd ? 1 : 2);
      return { rel, rank, mtime };
    }));
    ranked.push(...batch);
  }
  // 没排过序的那些接在后面：宁可排在最后，也不要整个丢掉。
  for (const { rel } of candidates.slice(stated.length)) ranked.push({ rel, rank: 3, mtime: 0 });
  ranked.sort((a, b) => a.rank - b.rank || b.mtime - a.mtime);
  return ranked.map((entry) => entry.rel);
}

/** 走一棵子树，把能看的文件挑出来。带深度、条数双上限，撞上就记一句、停。 */
async function walkForArtifacts(
  rootPath: string,
  relDir: string,
  budget: { entries: number },
  found: Set<string>,
  profiles: Map<string, boolean>,
  incomplete: string[],
): Promise<void> {
  const queue: { rel: string; depth: number }[] = [{ rel: relDir, depth: 0 }];
  let unreadable = 0;
  let tooDeep = 0;
  while (queue.length) {
    const current = queue.shift()!;
    if (budget.entries <= 0) break;
    if (current.depth > MAX_WALK_DEPTH) {
      tooDeep += 1;
      continue; // 这一枝太深；别的枝还要走完
    }
    let dirents;
    try {
      dirents = await readdir(join(rootPath, current.rel), { withFileTypes: true });
    } catch {
      unreadable += 1; // 目录没了 / 读不动：跳过这一枝，但要留账
      continue;
    }
    const names = new Set(dirents.map((dirent) => dirent.name));
    if (BROWSER_PROFILE_MARKERS.every((marker) => names.has(marker))) continue; // 浏览器 profile，整棵不要
    for (const dirent of dirents) {
      if (budget.entries-- <= 0) break;
      const rel = current.rel ? `${current.rel}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) {
        if (skipsDirPath(rel)) continue;
        queue.push({ rel, depth: current.depth + 1 });
      } else if (dirent.isFile() && kindOf(dirent.name)) {
        if (await insideBrowserProfile(rootPath, current.rel || ".", profiles)) break; // 整个目录都在 profile 里
        found.add(rel);
      }
    }
  }
  if (unreadable) incomplete.push(`有 ${unreadable} 个目录读不动（权限或刚被删），里面的东西没数进来`);
  if (tooDeep) incomplete.push(`有 ${tooDeep} 枝目录超过 ${MAX_WALK_DEPTH} 层，更深的没往下看`);
}

/**
 * 扫出「被 .gitignore 挡着 / 根本不在 git 管辖里」的那些候选。
 *
 * `windows` 只用来排优先级（预算花在最可能有产出的地方），**不在这里做时间筛选**：独占
 * 工作区整个不吃时间判据，筛不筛由调用方按归属证据决定。
 */
export async function scanIgnoredArtifacts(
  rootPath: string,
  gitRepo: boolean,
  windows: readonly RunWindow[],
): Promise<ScanOutcome> {
  const paths = new Set<string>();
  const incomplete: string[] = [];
  const profiles = new Map<string, boolean>();
  const budget = { entries: MAX_WALK_ENTRIES };

  if (!gitRepo) {
    // 不是 git 仓库：没有任何 git 线索，整棵树都得自己走。
    await walkForArtifacts(rootPath, "", budget, paths, profiles, incomplete);
    if (budget.entries <= 0) incomplete.push("工作目录太大，只扫了一部分");
    return { paths, incomplete };
  }

  for (const entry of await orderedIgnoredEntries(rootPath, windows, incomplete)) {
    if (budget.entries <= 0) break;
    const isDir = await stat(join(rootPath, entry)).then((info) => info.isDirectory(), () => false);
    if (isDir) {
      await walkForArtifacts(rootPath, entry, budget, paths, profiles, incomplete);
      continue;
    }
    budget.entries -= 1;
    if (!kindOf(entry)) continue;
    if (await insideBrowserProfile(rootPath, entry, profiles)) continue;
    paths.add(entry);
  }
  if (budget.entries <= 0) {
    incomplete.push("工作目录太大，被 .gitignore 挡着的那一档只扫了一部分（已按最近改动优先）");
  }
  return { paths, incomplete };
}
