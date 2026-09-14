// 输入框里 `@` 引用工作区文件时的候选来源：给一个根目录和一段查询，回一批路径。
//
// 为什么不复用 file-browser 的 listDirectory：那条是「一层一层点进去看」，而 `@` 要的是
// 「敲几个字母就把深处那个文件捞出来」——两者的取数方式完全不同（一层 readdir vs 整棵树），
// 混在一个函数里只会让两边都别扭。越界钳制那一半仍然共用（见 resolveInRoot 的同款判据：
// 这里根本不接受调用方给的相对路径，只吐我们自己枚举出来的，所以没有越狱面）。
//
// 取数按两条规矩：
//   1. **git 仓库一律问 git**（`ls-files --cached --others --exclude-standard`）：它自带
//      .gitignore 语义，node_modules / dist / 构建产物不会挤掉用户真正想引用的源码。
//   2. 非 git 目录才自己走 readdir，并且硬性跳过那几个已知会把树撑爆的目录。
//
// 枚举结果按根目录缓存几秒：`@` 是边打边搜，不缓存的话每敲一个字母就 spawn 一次 git，
// 大仓库上那是每次 100ms+ 的进程开销，而文件列表在几秒内几乎不会变。
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
}

/** 枚举上限。超过就截断并如实告诉前端（`truncated`），不假装列全了。 */
const MAX_FILES = 40_000;
/** 自己走 readdir 时的深度上限，防一条软链把扫描带进无底洞。 */
const MAX_DEPTH = 12;
/** 一次最多回多少条候选。 */
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 60;
/** 枚举结果的缓存寿命。边打边搜期间够用，久到用户察觉不到文件列表旧了之前就过期。 */
const CACHE_TTL_MS = 5_000;

/** 非 git 目录下自己扫时跳过的目录名：它们要么不是用户想引用的，要么能把树撑爆。 */
const SKIP_DIRS = new Set([
  ".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", "out",
  "target", ".next", ".nuxt", ".cache", ".turbo", ".gradle", ".idea", ".vscode",
  "vendor", "Pods", ".DS_Store",
]);

interface Listing {
  files: string[];
  truncated: boolean;
}

const cache = new Map<string, { at: number; value: Promise<Listing> }>();

/** `git ls-files`：已跟踪 + 未跟踪但没被 ignore 的，一次问全。 */
function gitListFiles(root: string): Promise<Listing | null> {
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
        seen.add(line);
        if (seen.size >= MAX_FILES) { overflow = true; break; }
      }
      done({ files: [...seen], truncated: overflow });
    });
  });
}

/** 非 git 目录的兜底：自己走一遍，按 SKIP_DIRS 和深度刹车。 */
async function walk(root: string): Promise<Listing> {
  const files: string[] = [];
  let truncated = false;
  const visit = async (rel: string, depth: number): Promise<void> => {
    if (truncated || depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(rel ? join(root, rel) : root, { withFileTypes: true });
    } catch {
      return; // 权限不足 / 刚被删：当作空目录，不让整次枚举塌掉
    }
    for (const entry of entries) {
      if (truncated) return;
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
  const value = (async () => {
    const fromGit = gitRepo ? await gitListFiles(root) : null;
    return fromGit ?? await walk(root);
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
): Promise<{ hits: FileSearchHit[]; truncated: boolean }> {
  const { files, truncated } = await listFiles(root, options.gitRepo !== false);
  const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const query = (options.query ?? "").trim().toLowerCase().replace(/\\/g, "/");

  if (!query) {
    // 还没敲字：给浅层的一把，按「目录层级浅 → 路径字典序」排，第一眼看到的是仓库门面
    // 那几个文件，而不是随机深处的某个 .svg。
    const hits = files
      .map((path) => ({ path, ...splitPath(path), kind: "file" as const }))
      .sort((a, b) => depthOf(a.path) - depthOf(b.path) || a.path.localeCompare(b.path))
      .slice(0, limit);
    return { hits, truncated };
  }

  const scored: { hit: FileSearchHit; score: number }[] = [];
  const consider = (path: string, kind: "file" | "dir") => {
    const { name, dir } = splitPath(path);
    const score = scoreOf(path, name, query);
    if (score === null) return;
    // 目录略微让位给文件：同名时用户多半想要的是那个文件。
    scored.push({ hit: { path, name, dir, kind }, score: kind === "dir" ? score - 20 : score });
  };
  for (const path of files) consider(path, "file");
  for (const path of directoriesOf(files)) consider(path, "dir");

  scored.sort((a, b) => b.score - a.score || a.hit.path.length - b.hit.path.length
    || a.hit.path.localeCompare(b.hit.path));
  return { hits: scored.slice(0, limit).map((entry) => entry.hit), truncated };
}
