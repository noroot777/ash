// 源码身份的「工作区是不是就是这个提交」：门禁准备、批量预判、只是打开验收台都会问它，所以它也得守
// **门禁命令之外不执行任何项目程序**。直接在项目里跑 `git status` 守不住：stat 信息一旦失效（文件被
// 原样重写、touch、racy 时间戳），git 要逐个比内容，会按属性调起项目配的 clean / process 过滤器 ——
// 只是刷新一下验收台，项目的转换程序就跑了起来（审查 7Qs2TlBoFvbD 第 1 轮 F2 实测）。关 fsmonitor、
// 不拿可选锁（readOnlyGit）封不住它，按名字把过滤器逐个置空又是一份「扫完之后照样能改」的黑名单。
//
// 所以和最终发布同一个做法：在封好的临时 git 目录里跑（sealedGitDir —— 项目配置一项不带，过滤器、
// 驱动一个都没有定义），只把**决定比对结果、又不能指向程序**的那几项抄过去（换行 / 链接 / 权限 /
// 大小写 / stat 口径、排除与属性文件的位置），索引直接读项目那份（GIT_OPTIONAL_LOCKS=0，不写回）。
// 环境里没有程序，就无所谓「漏了哪一个」。嵌套仓库是另一个配置域：git 会进去按**它自己的**配置比
// 内容，所以一律不进（`--ignore-submodules=all`），索引里出现子模块就直接拒（审查 oGZEQlZvnW1N F1）。
//
// 带过滤器的文件是唯一判不全的一种：stat 失效时封好的环境只能拿未经过滤的字节去比，LFS 这类（工作区
// 是真文件、库里是指针）必然报「改了」。结论分三档，不把「没证据」当「没改」（同一审查 F2）：
//  · 证明改了 —— 文件类型、执行位和索引对不上，或者大小和索引里记着的（上一次 git 带着过滤器核过
//    干净时那份）不同；
//  · 证明没改 —— stat 与索引的记录一致，封好的环境根本不会报它；或者它只是 racy（文件和索引在同一个
//    时间刻度里写下，git 按秒比 stat 不敢信，刚写完就提交的文件都是这样），而记录里的修改 / 变更时间
//    连纳秒都与磁盘上的一致 —— 那份记录是 git 带着过滤器核过内容时记下的，之后再写过它纳秒时间就会变；
//  · 判不了 —— 其余（原样重写、touch、同样大小的改写、索引里没有记录）。如实交给调用方，由它说清楚
//    怎么办：用户自己在工作区跑一次 `git status`（按项目配置核对并刷新索引记录）就落回前两档。
import { lstat, mkdir, copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { attributeValues, definedPrograms, outputLine, readOnlyGit, sealedGitDir } from "./accept-gate-preview.js";
import { execFileText } from "./exec.js";
import { optionalRead } from "./accept-gate-fs.js";

const MAX_BUFFER = 32 * 1024 * 1024;

/** 决定 `git status` 比对结果、又不能指向任何程序的配置（键是 git 归一过的小写）。 */
const STATUS_SETTINGS = /^core\.(autocrlf|eol|symlinks|filemode|ignorecase|precomposeunicode|trustctime|checkstat|checkroundtripencoding|longpaths)$/;

const ask = async (cwd: string, args: string[]) => outputLine((await readOnlyGit(cwd, args)).stdout);
const optionalAsk = async (cwd: string, args: string[]) => outputLine((await readOnlyGit(cwd, args).catch(() => null))?.stdout ?? "") || null;
/** 项目有效配置里要抄进封好环境的那几项（含排除 / 属性文件的位置：它们是被读的文件，不是程序）。 */
async function statusSettings(cwd: string): Promise<[string, string][]> {
  const listed = (await readOnlyGit(cwd, ["config", "-z", "--get-regexp", STATUS_SETTINGS.source]).catch(() => null))?.stdout ?? "";
  const settings = listed.split("\0").filter(Boolean).map((entry): [string, string] => {
    const at = entry.indexOf("\n");
    return at < 0 ? [entry, "true"] : [entry.slice(0, at), entry.slice(at + 1)];
  });
  for (const key of ["core.excludesFile", "core.attributesFile"]) {
    const path = await optionalAsk(cwd, ["config", "--type=path", "--get", key]);
    if (path) settings.push([key, path]);
  }
  // 没设 core.attributesFile 时 git 读 XDG 下那一份；封好环境的缺省是空文件，所以显式指回同一处。
  if (!settings.some(([key]) => key === "core.attributesFile")) {
    const xdg = process.env.XDG_CONFIG_HOME || (process.env.HOME ? join(process.env.HOME, ".config") : null);
    if (xdg) settings.push(["core.attributesFile", join(xdg, "git", "attributes")]);
  }
  return settings;
}

/** 一次命令行最多带多少字节的路径（Windows 整条命令行上限 32767 字符，留足余量）。 */
const ARGV_BUDGET = 16 * 1024;

/** 把路径切成命令行装得下的几批。 */
function batches(paths: string[]): string[][] {
  const out: string[][] = [];
  let size = 0;
  for (const path of paths) {
    const cost = path.length * 3 + 16;
    if (!out.length || size + cost > ARGV_BUDGET) { out.push([]); size = 0; }
    out.at(-1)!.push(path);
    size += cost;
  }
  return out;
}

/** 索引里一项的模式与 stat 记录（时间为纳秒；索引里秒、大小、inode 都只存低 32 位）。 */
type IndexEntry = { mode: string; size: bigint; mtime: bigint; ctime: bigint; ino: bigint };

const LOW32 = 2n ** 32n;
const nanos = (text: string | undefined): bigint => {
  const [sec, nsec] = (text ?? "0:0").split(":");
  return BigInt(sec ?? 0) * 1_000_000_000n + BigInt(nsec ?? 0);
};

/** 索引里这几项的模式和记着的工作区文件大小（git 上一次核过它干净时的那份；索引只存低 32 位）。 */
async function indexEntries(top: string, paths: string[]): Promise<Map<string, IndexEntry>> {
  const entries = new Map<string, IndexEntry>();
  for (const batch of batches(paths)) {
    const out = (await readOnlyGit(top, ["ls-files", "-z", "--stage", "--debug", "--",
      ...batch.map(path => `:(literal)${path}`)])).stdout;
    // 每一项：`<mode> <oid> <stage>\t<path>` NUL，接着五行以换行结尾的 stat 记录（ctime / mtime /
    // dev ino / uid gid / size flags）。
    for (let at = 0; at < out.length;) {
      const end = out.indexOf("\0", at);
      if (end < 0) break;
      const head = out.slice(at, end);
      const tab = head.indexOf("\t");
      const fields = new Map<string, string>();
      let cursor = end + 1;
      for (let line = 0; line < 5 && cursor < out.length; line++) {
        const next = out.indexOf("\n", cursor);
        for (const [, key, value] of out.slice(cursor, next < 0 ? out.length : next).matchAll(/(\w+):\s*(\d+(?::\d+)?)/g)) {
          fields.set(key!, value!);
        }
        cursor = next < 0 ? out.length : next + 1;
      }
      entries.set(head.slice(tab + 1), { mode: head.slice(0, head.indexOf(" ")), size: BigInt(fields.get("size") ?? 0),
        mtime: nanos(fields.get("mtime")), ctime: nanos(fields.get("ctime")), ino: BigInt(fields.get("ino") ?? 0) });
      at = cursor;
    }
  }
  return entries;
}

const falsy = new Set(["false", "no", "off", "0", ""]);

type Stat = Awaited<ReturnType<typeof statOf>>;
const statOf = (path: string) => optionalRead(path, () => lstat(path, { bigint: true }), ["ENOENT", "ENOTDIR"]);

/**
 * 一个封好环境里报「改了」的过滤文件，不跑过滤器能下的结论。顺序就是不变量：**证明得了的差异先判**，
 * 「证明没改」只在没有任何差异时才轮得到 —— stat 记录只说明内容没被重写过，不说明类型、执行位此刻
 * 也对得上（core.filemode 关着时刷新的记录，打开之后执行位的差异照样在，审查 oGZEQlZvnW1N 第 2 轮 F1）。
 *  · 差异：类型、执行位与内容无关，直接比；大小只在索引有记录时才作数 —— 记成 0 是「没有记录」
 *    （--cacheinfo 刚放进来的项、git 写索引时抹掉的 racy 项，git 自己也当没核过，见 read-cache.c 的
 *    ce_match_stat_basic）。
 *  · 没改：记录逐项对得上磁盘，修改 / 变更时间精确到纳秒（见文件头）。纳秒记成 0 说明文件系统只有粗
 *    粒度时间（或者根本没有记录），同一刻度里改过也看不出来，不作数。inode 记成 0 的平台不比它。
 */
function verdict(entry: IndexEntry | undefined, info: Stat, filemode: boolean): "changed" | "same" | "unverified" {
  if (!entry || !info || !info.isFile() || entry.mode !== "100644" && entry.mode !== "100755") return "changed";
  if (filemode && (entry.mode === "100755") !== ((info.mode & 0o100n) !== 0n)) return "changed";
  if (entry.size !== 0n && info.size % LOW32 !== entry.size) return "changed";
  const recorded = entry.size !== 0n && entry.mtime % 1_000_000_000n !== 0n
    && info.mtimeNs % (LOW32 * 1_000_000_000n) === entry.mtime && info.ctimeNs % (LOW32 * 1_000_000_000n) === entry.ctime
    && (entry.ino === 0n || info.ino % LOW32 === entry.ino);
  return recorded ? "same" : "unverified";
}

/** `diff-index --raw -z` 里各项的两个模式。按协议逐项读：元数据头一段、路径一段（--no-renames 下只有一个）。 */
function rawModes(stdout: string): [string, string][] {
  const fields = stdout.split("\0");
  const modes: [string, string][] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [src, dst] = fields[i]!.slice(1).split(" ");
    modes.push([src!, dst!]);
  }
  return modes;
}

export type WorktreeChanges = {
  /** 证明了的改动：`git status --porcelain=v1 -z --no-renames --untracked-files=all` 的条目（`XY path`）。 */
  rows: string[];
  /** 不跑项目的过滤器就判不了改没改的已跟踪文件，以及它们点名的过滤器。 */
  unverified: { paths: string[]; filters: string[] };
};

/** 「工作区 + 索引」相对提交 `commit` 的改动，在不执行任何项目程序的前提下得出（口径见文件头）。 */
export async function worktreeChanges(cwd: string, commit: string): Promise<WorktreeChanges> {
  const top = await ask(cwd, ["rev-parse", "--show-toplevel"]);
  const index = await ask(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  const settings = await statusSettings(cwd);
  const sealed = await sealedGitDir(top, settings);
  let rows: string[];
  try {
    // 仓库级的排除与属性（info/exclude、info/attributes）只在项目 git 目录里，抄一份过去。
    await mkdir(join(sealed.gitDir, "info"), { recursive: true });
    for (const name of ["info/exclude", "info/attributes"]) {
      const from = await ask(cwd, ["rev-parse", "--path-format=absolute", "--git-path", name]);
      if (await optionalRead(from, () => lstat(from))) await copyFile(from, join(sealed.gitDir, name));
    }
    await writeFile(join(sealed.gitDir, "HEAD"), `${commit}\n`);
    const run = async (args: string[]) => (await execFileText("git", ["-C", top, ...args],
      { maxBuffer: MAX_BUFFER, env: { ...sealed.env, GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: "0" } })).stdout;
    // 暂存区对提交只比对象名，不进子模块；`none` 盖过工作区 .gitmodules 里的 ignore，新加进来的也看得见。
    const staged = rawModes(await run(["diff-index", "--cached", "--raw", "-z", "--no-renames", "--ignore-submodules=none", commit]));
    if (staged.some(modes => modes.includes("160000"))) {
      throw new Error("验收快照暂不支持 Git 子模块，任务工作区的暂存区里加了子模块；请移除它后再验收");
    }
    rows = (await run(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--ignore-submodules=all"]))
      .split("\0").filter(Boolean);
  } finally {
    await sealed.dispose();
  }
  const none: WorktreeChanges = { rows, unverified: { paths: [], filters: [] } };
  // 只有「暂存区没动、工作区报改了」的已跟踪文件可能是过滤器造成的误报（暂存区对提交只比对象名）。
  const suspects = rows.filter(row => row.startsWith(" M")).map(row => row.slice(3));
  if (!suspects.length) return none;
  const programs = await definedPrograms(cwd, "^filter\\..+\\.(clean|process)$");
  if (!programs.size) return none;
  const values = await attributeValues(top, "filter", suspects);
  const filtered = new Map(suspects.flatMap((path, i) => programs.has(values[i] ?? "") ? [[path, values[i]!] as const] : []));
  if (!filtered.size) return none;
  const entries = await indexEntries(top, [...filtered.keys()]);
  const filemode = !falsy.has((settings.findLast(([key]) => key === "core.filemode")?.[1] ?? "true").toLowerCase());
  const same = new Set<string>();
  const unverified = new Set<string>();
  for (const path of filtered.keys()) {
    const found = verdict(entries.get(path), await statOf(join(top, path)), filemode);
    if (found === "same") same.add(path);
    else if (found === "unverified") unverified.add(path);
  }
  return {
    rows: rows.filter(row => !(row.startsWith(" M") && (same.has(row.slice(3)) || unverified.has(row.slice(3))))),
    unverified: { paths: [...unverified], filters: [...new Set([...unverified].map(path => filtered.get(path)!))] },
  };
}
