// 输入框里 `@` 引用工作区文件时的候选来源：给一个根目录和一段查询，回一批路径。
//
// 为什么不复用 file-browser 的 listDirectory：那条是「一层一层点进去看」，而 `@` 要的是
// 「敲几个字母就把深处那个文件捞出来」——两者的取数方式完全不同（一层 readdir vs 整棵树），
// 混在一个函数里只会让两边都别扭。越界钳制那一半仍然共用（见 resolveInRoot 的同款判据：
// 这里根本不接受调用方给的相对路径，只吐我们自己枚举出来的，所以没有越狱面）。
//
// 取数按两条规矩：
//   1. **枚举始终是整棵树**（自己走 readdir），因为「工作区里的文件」就该全都能被 @ 到。
//   2. git 仓库另外问一次 git（`ls-files --cached --others --exclude-standard`），但那份
//      名单只用来**排序**：不在里面的就是 .gitignore 挡着的，排到所有未忽略候选之后。
//
// 第 2 条曾经是过滤而不是排序 —— .gitignore 挡住的直接不进候选。那等于替用户认定「被
// 忽略 = 不想引用」，可 `data/`、`output/`、`dist/` 里全是跑出来的产物和报告，正是会想
// 让 agent 去读的东西，而用户在界面上只会看到「敲了半天搜不出来」，也猜不到是 git 在挡。
// 现在改成分档：源码永远在前，忽略的在后但一定找得到，且界面上标出来它为什么靠后。
//
// 枚举结果按根目录缓存几秒：`@` 是边打边搜，不缓存的话每敲一个字母就重扫一遍整棵树，
// 大仓库上那是每次上百毫秒，而文件列表在几秒内几乎不会变。
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** 一条候选。`path` 一律是相对根目录、posix 分隔符的相对路径。 */
export interface FileSearchHit {
  path: string;
  /** 末段（文件名或目录名），界面上加粗的就是它。 */
  name: string;
  /** 除末段之外的部分，`""` 表示就在根下。界面上灰着显示，用来区分同名文件。 */
  dir: string;
  kind: "file" | "dir";
  /** .gitignore 挡着的（构建产物、本地数据…）。照样能选，但排在所有未忽略候选之后。 */
  ignored?: boolean;
}

/** 枚举上限。超过就截断并如实告诉前端（`truncated`），不假装列全了。 */
const MAX_FILES = 40_000;
/** 走 readdir 时的深度上限，防一条软链把扫描带进无底洞。 */
const MAX_DEPTH = 12;
/** 整棵树扫描的时间预算：根目录选到 home 这种地方时，宁可少列也不能把请求拖死。 */
const WALK_BUDGET_MS = 2_000;
/** 一次最多回多少条候选。 */
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 80;
/** 树里展开一层给多少条。比搜索结果宽松：浏览时用户是在「翻」，不是在「挑前几名」。 */
const DIR_LIMIT = 120;
const MAX_DIR_LIMIT = 300;
/** 枚举结果的缓存寿命。边打边搜期间够用，久到用户察觉不到文件列表旧了之前就过期。 */
const CACHE_TTL_MS = 5_000;

/**
 * 永不枚举的目录。判据只有一条：**体量大到能把整棵树淹掉几个数量级**。
 *
 * `dist` / `build` / `out` / `target` 这些**故意不在**这里 —— 它们多半被 .gitignore 挡着，
 * 现在按「已忽略」排到后面就够了，用户真要引用一份构建产物仍然找得到。
 */
const SKIP_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache",
  ".cache", ".turbo", ".gradle", "Pods", ".DS_Store",
]);

/**
 * 两种取法回同一个形状，但**必须自报是哪一种**：前端据此判断「这台服务端到底认不认
 * `dir`」。不报的话，旧服务端会把 `?dir=` 当没有、回一张平铺的搜索结果，前端照单全收
 * 渲染成一列没有层级的文件 —— 界面上看着就是「树没做出来」，而不是「服务端是旧的」。
 */
export interface SearchResult {
  mode: "search" | "dir";
  hits: FileSearchHit[];
  truncated: boolean;
  more: boolean;
}

interface Listing {
  files: string[];
  /** files 里哪些是 .gitignore 挡着的。非 git 目录下恒为空。 */
  ignored: Set<string>;
  truncated: boolean;
}

const cache = new Map<string, { at: number; value: Promise<Listing> }>();

interface Scan {
  files: string[];
  truncated: boolean;
}

/** `git ls-files`：已跟踪 + 未跟踪但没被 ignore 的，一次问全。回 null = 这儿问不出来。 */
function gitListFiles(root: string): Promise<Scan | null> {
  return new Promise((done) => {
    const child = spawn(
      "git",
      ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    let out = "";
    let overflow = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (overflow) return;
      out += chunk;
      // 极大仓库上先按字节数刹车，免得把整份索引读成一个 JS 字符串。
      if (out.length > MAX_FILES * 80) overflow = true;
    });
    child.once("error", () => done(null));
    child.once("close", (code) => {
      if (code !== 0 && !out) return done(null);
      const seen = new Set<string>();
      // `--cached --others` 会让同一个路径出现两次（索引里有、工作区也有），去重。
      for (const line of out.split("\0")) {
        if (!line) continue;
        // 以 `/` 收尾的是**目录**条目：`--others` 碰上一个嵌套仓库时报的就是这个。
        // 它不是文件，留着会变成一条名字为空的候选。
        if (line.endsWith("/")) continue;
        seen.add(line);
        if (seen.size >= MAX_FILES) { overflow = true; break; }
      }
      done({ files: [...seen], truncated: overflow });
    });
  });
}

/** 整棵树走一遍，按 SKIP_DIRS、深度和时间预算刹车。被 .gitignore 挡着的也照列。 */
async function walk(root: string): Promise<Scan> {
  const files: string[] = [];
  let truncated = false;
  const deadline = Date.now() + WALK_BUDGET_MS;
  const visit = async (rel: string, depth: number): Promise<void> => {
    if (truncated || depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(rel ? join(root, rel) : root, { withFileTypes: true });
    } catch {
      return; // 权限不足 / 刚被删：当作空目录，不让整次枚举塌掉
    }
    // 里面另有 `.git` 的是**另一个仓库**（子模块、别的 worktree、顺手 clone 在工作区里的
    // 东西）。它的文件归它自己那个根管，跟着列进来只会让同一份源码在候选里出现好几遍
    // —— harness 自己的 `.worktrees/` 下就躺着九个完整检出。
    if (rel && entries.some((entry) => entry.name === ".git")) return;
    for (const entry of entries) {
      if (truncated) return;
      if (Date.now() > deadline) { truncated = true; return; }
      if (SKIP_DIRS.has(entry.name)) continue;
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      // 软链不跟进：跟进就可能绕出根目录，也可能转圈。
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(next, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(next);
      if (files.length >= MAX_FILES) { truncated = true; return; }
    }
  };
  await visit("", 0);
  return { files, truncated };
}

async function listFiles(root: string, gitRepo: boolean): Promise<Listing> {
  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = (async (): Promise<Listing> => {
    // 两件事同时问：git 那份是「哪些没被忽略」，自己走的那份是「到底有哪些」。
    const [fromGit, walked] = await Promise.all([
      gitRepo ? gitListFiles(root) : Promise.resolve(null),
      walk(root),
    ]);
    // git 报了、自己却扫不到的也留着（SKIP_DIRS 里被 tracked 的文件就是这种），它们是
    // 正经源码，不该因为目录名撞上黑名单就消失。
    const visible = new Set(fromGit?.files ?? []);
    const files = [...visible];
    const ignored = new Set<string>();
    for (const path of walked.files) {
      if (visible.has(path)) continue;
      // 有 git 名单却没报这一条 = 被 .gitignore 挡着；没 git 名单就谈不上忽略。
      if (fromGit) ignored.add(path);
      files.push(path);
      if (files.length >= MAX_FILES) break;
    }
    const truncated = walked.truncated || (fromGit?.truncated ?? false) || files.length >= MAX_FILES;
    return { files, ignored, truncated };
  })();
  cache.set(root, { at: Date.now(), value });
  // 缓存只为「边打边搜的这几秒」，不是长驻内存的索引：根目录一多就把最老的挤掉。
  if (cache.size > 16) cache.delete([...cache.keys()][0]!);
  value.catch(() => cache.delete(root));
  return value;
}

/** 枚举缓存作废（工作区被删/换了地方时调用方主动清）。 */
export function forgetFileListing(root: string): void {
  cache.delete(root);
}

function splitPath(path: string): { name: string; dir: string } {
  const at = path.lastIndexOf("/");
  return at < 0 ? { name: path, dir: "" } : { name: path.slice(at + 1), dir: path.slice(0, at) };
}

/**
 * 子序列匹配：`ftr` 能命中 `FileTreeInspector`。回的是「命中有多散」——越紧凑越靠前，
 * 没命中回 null。
 */
function subsequenceSpread(haystack: string, needle: string): number | null {
  let at = 0;
  let first = -1;
  let last = -1;
  for (const ch of needle) {
    const found = haystack.indexOf(ch, at);
    if (found < 0) return null;
    if (first < 0) first = found;
    last = found;
    at = found + 1;
  }
  return last - first;
}

/**
 * 一条候选的得分，越大越靠前；null = 压根不匹配。
 *
 * 排序的核心判断是「用户敲的那几个字，更像在说文件名还是说路径」：文件名上的命中一律
 * 排在路径中段的命中前面，否则敲 `api` 时先跳出来的会是一串 `src/api/…/xxx.css`，而
 * 用户想要的 `api.ts` 被挤到看不见的地方。
 */
function scoreOf(path: string, name: string, query: string): number | null {
  const lowerPath = path.toLowerCase();
  const lowerName = name.toLowerCase();
  if (lowerName === query) return 1_000;
  if (lowerName.startsWith(query)) return 900 - lowerName.length;
  // 查询里带 `/` 说明用户在说一段路径，那就按路径尾部对齐来判，比文件名子串更贴意图。
  if (query.includes("/") && lowerPath.endsWith(query)) return 850 - lowerPath.length;
  const inName = lowerName.indexOf(query);
  if (inName > 0) return 700 - inName - lowerName.length / 10;
  const inPath = lowerPath.indexOf(query);
  if (inPath >= 0) return 500 - inPath / 10 - lowerPath.length / 10;
  const spread = subsequenceSpread(lowerName, query);
  if (spread !== null) return 300 - spread;
  const pathSpread = subsequenceSpread(lowerPath, query);
  if (pathSpread !== null) return 150 - pathSpread / 10;
  return null;
}

/**
 * 被忽略的候选统一往下压这么多分。压到「任何忽略项都低于任何未忽略项」是刻意的：
 * 分档比精细混排可预期得多 —— 用户敲 `report` 时先看到 docs 里那几篇，想要 `data/runs`
 * 里跑出来的那份就往下翻或者多敲两段路径，而不是每次都得猜这回排序会把谁提上来。
 */
const IGNORED_PENALTY = 1_000;

/** 路径深度：没查询词时用它排序，浅的先出来（README、package.json 这类）。 */
function depthOf(path: string): number {
  let depth = 0;
  for (const ch of path) if (ch === "/") depth += 1;
  return depth;
}

/**
 * 从文件列表里派生出目录候选。`@某个目录` 是有意义的引用（「看看这一整块」），而
 * git 只吐文件，不自己补一遍的话目录就永远选不到。
 */
function directoriesOf(files: string[]): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    let at = file.indexOf("/");
    while (at >= 0) {
      dirs.add(file.slice(0, at));
      if (dirs.size >= MAX_FILES) return [...dirs];
      at = file.indexOf("/", at + 1);
    }
  }
  return [...dirs];
}

export async function searchWorkspaceFiles(
  root: string,
  options: { gitRepo?: boolean; query?: string; limit?: number } = {},
): Promise<SearchResult> {
  const { files, ignored, truncated } = await listFiles(root, options.gitRepo !== false);
  const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const query = (options.query ?? "").trim().toLowerCase().replace(/\\/g, "/");

  if (!query) {
    // 还没敲字：给浅层的一把，按「目录层级浅 → 路径字典序」排，第一眼看到的是仓库门面
    // 那几个文件，而不是随机深处的某个 .svg。被忽略的这会儿一条都不给 —— 还没有查询词，
    // 它们只会把门面挤掉；敲出字来照样搜得到。
    const ranked = files
      .filter((path) => !ignored.has(path))
      .map((path) => ({ path, ...splitPath(path), kind: "file" as const }))
      .sort((a, b) => depthOf(a.path) - depthOf(b.path) || a.path.localeCompare(b.path));
    return { mode: "search", hits: ranked.slice(0, limit), truncated, more: ranked.length > limit };
  }

  const scored: { hit: FileSearchHit; score: number }[] = [];
  const consider = (path: string, kind: "file" | "dir", ignore: boolean) => {
    const { name, dir } = splitPath(path);
    const score = scoreOf(path, name, query);
    if (score === null) return;
    scored.push({
      hit: { path, name, dir, kind, ...(ignore ? { ignored: true } : {}) },
      // 目录略微让位给文件：同名时用户多半想要的是那个文件。
      score: score - (kind === "dir" ? 20 : 0) - (ignore ? IGNORED_PENALTY : 0),
    });
  };
  for (const path of files) consider(path, "file", ignored.has(path));
  // 目录的「忽略与否」跟着它底下的文件走：里面还有没被忽略的文件，它就不算忽略
  // （`web/` 底下有 `web/dist/`，但 `web/` 本身当然该跟源码排在一起）。
  const liveDirs = new Set(directoriesOf(files.filter((path) => !ignored.has(path))));
  for (const path of directoriesOf(files)) consider(path, "dir", !liveDirs.has(path));

  scored.sort((a, b) => b.score - a.score || a.hit.path.length - b.hit.path.length
    || a.hit.path.localeCompare(b.hit.path));
  return {
    mode: "search",
    hits: scored.slice(0, limit).map((entry) => entry.hit),
    truncated,
    more: scored.length > limit,
  };
}

/**
 * 列一个目录的**直接子项**：树形浏览用的那一半。
 *
 * 跟 searchWorkspaceFiles 共用同一份枚举缓存，所以展开一个目录不额外扫盘。目录在前、
 * 未忽略的在前，同档按名字排 —— 浏览时用户找的是「我知道它在哪」，相关度打分帮不上忙。
 */
export async function listWorkspaceDir(
  root: string,
  options: { gitRepo?: boolean; dir?: string; limit?: number } = {},
): Promise<SearchResult> {
  const { files, ignored, truncated } = await listFiles(root, options.gitRepo !== false);
  const limit = Math.min(Math.max(1, options.limit ?? DIR_LIMIT), MAX_DIR_LIMIT);
  const dir = (options.dir ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const prefix = dir ? `${dir}/` : "";

  const childFiles = new Map<string, boolean>(); // 名字 → 被忽略了吗
  const childDirs = new Map<string, boolean>(); // 名字 → 整块都被忽略了吗
  for (const path of files) {
    if (prefix && !path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const at = rest.indexOf("/");
    if (at < 0) {
      childFiles.set(rest, ignored.has(path));
      continue;
    }
    const name = rest.slice(0, at);
    // 里面还有一个没被忽略的文件，这个目录就不算忽略（`web/` 底下有 `web/dist/`，
    // 但 `web/` 当然该跟源码排在一起）。
    childDirs.set(name, (childDirs.get(name) ?? true) && ignored.has(path));
  }

  // 目录在前、未忽略的在前，同档按名字排 —— 一眼扫下去跟文件管理器一个样。
  const hits: FileSearchHit[] = [];
  const take = (from: Map<string, boolean>, kind: "file" | "dir", ignore: boolean) => {
    for (const name of [...from].filter(([, mine]) => mine === ignore).map(([name]) => name).sort(
      (a, b) => a.localeCompare(b),
    )) {
      hits.push({ path: prefix + name, name, dir, kind, ...(ignore ? { ignored: true } : {}) });
    }
  };
  take(childDirs, "dir", false);
  take(childFiles, "file", false);
  take(childDirs, "dir", true);
  take(childFiles, "file", true);

  return { mode: "dir", hits: hits.slice(0, limit), truncated, more: hits.length > limit };
}
