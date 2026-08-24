import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { DATA_DIR } from "../paths.js";
import type { AppOpener, OpenerProbe } from "./types.js";
import { execFileText as exec } from "../exec.js";

// LaunchServices 没有可直接调用的命令行入口（`lsregister -dump` 是几十 MB 的
// 内部格式，且 Apple 明确说它不是 API）。所以这里走一条纯文件系统的路：把每个
// .app 的 Info.plist 里 CFBundleDocumentTypes 声明的「我能开什么」读出来，自己
// 建一张 扩展名/UTI → 应用 的表。plutil 是系统自带的，二进制 plist 也读得动。
//
// 代价是一次全盘扫描要几百次 plutil（~1-3 秒），所以结果既进内存也落盘：
// 判据是各扫描根目录的 mtime（装/删应用都会改它）。
const SCAN_ROOTS = [
  "/Applications",
  "/Applications/Utilities",
  "/System/Applications",
  "/System/Applications/Utilities",
  "/System/Library/CoreServices/Applications",
  join(homedir(), "Applications"),
];

const CACHE_FILE = join(DATA_DIR, "app-openers.macos.json");
const CACHE_VERSION = 1;
const PLUTIL_CONCURRENCY = 24;

// 这几个 UTI 谁都能声明（文本编辑器普遍声明 public.data），命中它们只说明
// 「这个应用不挑食」，不能跟「专门开这种文件」排在一起。
const GENERIC_UTIS = new Set(["public.data", "public.item", "public.content"]);

interface AppRecord {
  /** .app 的绝对路径，也是打开时真正用的标识（bundle id 可能缺失）。 */
  path: string;
  name: string;
  bundleId: string | null;
  extensions: string[];
  utis: string[];
  generic: boolean;
}

interface Registry {
  version: number;
  roots: { path: string; mtimeMs: number }[];
  apps: AppRecord[];
}

let memo: Registry | null = null;
let building: Promise<Registry> | null = null;

async function rootStamps() {
  return (await Promise.all(SCAN_ROOTS.map(async (path) => {
    try {
      return { path, mtimeMs: Math.floor((await stat(path)).mtimeMs) };
    } catch {
      return { path, mtimeMs: -1 };
    }
  })));
}

function sameStamps(a: Registry["roots"], b: Registry["roots"]) {
  return a.length === b.length
    && a.every((row, index) => row.path === b[index]?.path && row.mtimeMs === b[index]?.mtimeMs);
}

/** 找出扫描根下的 .app：根目录直接放的，以及再往下一层（Adobe 那种子文件夹）。 */
async function findAppBundles(): Promise<string[]> {
  const found = new Set<string>();
  const scanDir = async (dir: string, depth: number) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.name.endsWith(".app")) {
        found.add(full);
        continue;
      }
      // 符号链接（比如 /System/Applications 里的兼容链接）也跟一层，isDirectory()
      // 对链接是 false，所以这里不按 dirent 类型判断而是直接试着读。
      if (depth > 0) await scanDir(full, depth - 1);
    }
  };
  await Promise.all(SCAN_ROOTS.map((root) => scanDir(root, 1)));
  return [...found];
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function readAppRecord(appPath: string): Promise<AppRecord | null> {
  const plist = join(appPath, "Contents", "Info.plist");
  let parsed: Record<string, unknown>;
  try {
    const { stdout } = await exec("plutil", ["-convert", "json", "-o", "-", plist], {
      maxBuffer: 8 * 1024 * 1024,
    });
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return null; // 没有 Info.plist / 不是有效 bundle / 读不了 —— 跳过就是了
  }
  const extensions = new Set<string>();
  const utis = new Set<string>();
  let generic = false;
  for (const raw of asArray(parsed.CFBundleDocumentTypes)) {
    if (typeof raw !== "object" || raw === null) continue;
    const docType = raw as Record<string, unknown>;
    for (const ext of asArray(docType.CFBundleTypeExtensions)) {
      const value = asString(ext)?.toLowerCase().replace(/^\./, "");
      if (!value) continue;
      if (value === "*") generic = true;
      else extensions.add(value);
    }
    for (const uti of asArray(docType.LSItemContentTypes)) {
      const value = asString(uti)?.toLowerCase();
      if (!value) continue;
      if (GENERIC_UTIS.has(value)) generic = true;
      else utis.add(value);
    }
  }
  if (!extensions.size && !utis.size && !generic) return null;
  return {
    path: appPath,
    name: asString(parsed.CFBundleDisplayName) ?? asString(parsed.CFBundleName) ?? basename(appPath, ".app"),
    bundleId: asString(parsed.CFBundleIdentifier),
    extensions: [...extensions],
    utis: [...utis],
    generic,
  };
}

async function buildRegistry(): Promise<Registry> {
  const bundles = await findAppBundles();
  const apps: AppRecord[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(PLUTIL_CONCURRENCY, bundles.length || 1) }, async () => {
    for (let index = cursor++; index < bundles.length; index = cursor++) {
      const record = await readAppRecord(bundles[index]!);
      if (record) apps.push(record);
    }
  });
  await Promise.all(workers);
  apps.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  return { version: CACHE_VERSION, roots: await rootStamps(), apps };
}

async function readDiskCache(): Promise<Registry | null> {
  try {
    const parsed = JSON.parse(await readFile(CACHE_FILE, "utf8")) as Registry;
    if (parsed.version !== CACHE_VERSION || !Array.isArray(parsed.apps)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeDiskCache(registry: Registry) {
  try {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(registry), "utf8");
  } catch {
    // 缓存写不进去只是下次再慢一轮，不该影响这次请求。
  }
}

async function registry(force: boolean): Promise<Registry> {
  if (building) return building;
  const stamps = await rootStamps();
  if (!force && memo && sameStamps(memo.roots, stamps)) return memo;
  if (!force && !memo) {
    const disk = await readDiskCache();
    if (disk && sameStamps(disk.roots, stamps)) {
      memo = disk;
      return disk;
    }
  }
  building = buildRegistry()
    .then(async (built) => {
      memo = built;
      await writeDiskCache(built);
      return built;
    })
    .finally(() => { building = null; });
  return building;
}

/**
 * 这个文件在 macOS 眼里是什么类型。mdls 给的是完整 UTI 继承链
 * （public.plain-text → public.text → public.data …），拿它跟应用声明的
 * LSItemContentTypes 对，比只按扩展名匹配准得多。
 *
 * Spotlight 被关掉的卷上 mdls 会返回 `(null)`，这时退回纯扩展名匹配。
 */
async function contentTypeTree(absPath: string): Promise<string[]> {
  try {
    const { stdout } = await exec("mdls", ["-name", "kMDItemContentTypeTree", "-raw", absPath], {
      timeout: 5000,
    });
    return [...stdout.matchAll(/"([^"]+)"/g)].map((match) => match[1]!.toLowerCase());
  } catch {
    return [];
  }
}

/** 用户在「显示简介 → 打开方式」里设过的默认应用（UTI → bundle id）。 */
async function userDefaultHandlers(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const plist = join(homedir(), "Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist");
  try {
    const { stdout } = await exec("plutil", ["-convert", "json", "-o", "-", plist], {
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    for (const raw of asArray(parsed.LSHandlers)) {
      if (typeof raw !== "object" || raw === null) continue;
      const handler = raw as Record<string, unknown>;
      const uti = asString(handler.LSHandlerContentType)?.toLowerCase();
      const bundle = asString(handler.LSHandlerRoleAll)
        ?? asString(handler.LSHandlerRoleViewer)
        ?? asString(handler.LSHandlerRoleEditor);
      if (uti && bundle) out.set(uti, bundle.toLowerCase());
    }
  } catch {
    // 从没改过默认应用的机器上这个文件不存在，属正常。
  }
  return out;
}

export async function probeMacOpeners(absPath: string, ext: string, force: boolean): Promise<OpenerProbe> {
  const [{ apps }, tree, defaults] = await Promise.all([
    registry(force),
    contentTypeTree(absPath),
    userDefaultHandlers(),
  ]);
  const treeSet = new Set(tree);
  const specific = tree.filter((uti) => !GENERIC_UTIS.has(uti));
  // 继承链是从具体到宽泛排的，所以第一个设过默认值的 UTI 就是生效的那条。
  const defaultBundle = specific.map((uti) => defaults.get(uti)).find(Boolean) ?? null;

  const scored: (AppOpener & { score: number })[] = [];
  for (const app of apps) {
    const byExtension = ext.length > 0 && app.extensions.includes(ext);
    const byType = app.utis.some((uti) => treeSet.has(uti));
    const score = byExtension ? 3 : byType ? 2 : app.generic ? 1 : 0;
    if (score === 0) continue;
    scored.push({
      id: app.path,
      name: app.name,
      detail: app.bundleId ?? app.path,
      match: byExtension ? "extension" : byType ? "type" : "generic",
      isDefault: !!defaultBundle && app.bundleId?.toLowerCase() === defaultBundle,
      score,
    });
  }
  scored.sort((a, b) => (
    Number(b.isDefault) - Number(a.isDefault)
    || b.score - a.score
    || a.name.localeCompare(b.name, "zh-Hans-CN")
  ));
  return {
    platform: "darwin",
    canReveal: true,
    apps: scored.map(({ score: _score, ...app }) => app),
    note: apps.length ? null : "没扫到任何声明了文件类型的应用",
  };
}

export function macRevealCommand(absPath: string) {
  return { file: "open", args: ["-R", absPath] };
}

export function macOpenCommand(absPath: string, appId: string | null) {
  return appId
    ? { file: "open", args: ["-a", appId, absPath] }
    : { file: "open", args: [absPath] };
}
