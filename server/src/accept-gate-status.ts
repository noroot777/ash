// 源码身份的「工作区是不是就是这个提交」：门禁准备、批量预判、只是打开验收台都会问它，所以它也得守
// **门禁命令之外不执行任何项目程序**。直接在项目里跑 `git status` 守不住：stat 信息一旦失效（文件被
// 原样重写、touch、racy 时间戳），git 要逐个比内容，会按属性调起项目配的 clean / process 过滤器 ——
// 只是刷新一下验收台，项目的转换程序就跑了起来（审查 7Qs2TlBoFvbD 第 1 轮 F2 实测）。关 fsmonitor、
// 不拿可选锁（readOnlyGit）封不住它，按名字把过滤器逐个置空又是一份「扫完之后照样能改」的黑名单。
//
// 所以和最终发布同一个做法：在封好的临时 git 目录里跑（sealedGitDir —— 项目配置一项不带，过滤器、
// 驱动一个都没有定义），只把**决定比对结果、又不能指向程序**的那几项抄过去（换行 / 链接 / 权限 /
// 大小写 / stat 口径、排除与属性文件的位置），索引直接读项目那份（GIT_OPTIONAL_LOCKS=0，不写回）。
// 环境里没有程序，就无所谓「漏了哪一个」。
//
// 代价是带过滤器的文件：stat 失效时封好的环境只能拿未经过滤的字节去比，LFS 这类（工作区是真文件、
// 库里是指针）必然报「改了」。这一种不靠跑程序就判不了，按 git 自己的验证记录收口 —— 索引里记着
// 上一次 git（带着项目的过滤器）核过干净时那份工作区文件的大小：
//  · 大小变了 → 字节确实不是 git 核过的那份，照旧算改了；
//  · 大小没变、或者索引里没有记录 → 当没改（原样重写、touch 都落在这里）。漏掉的只有「同样大小的
//    改写」：门禁测的本来就是提交（快照从提交克隆），漏掉它不会让门禁测错东西，只少一句「先提交」的
//    提醒；验收后拆 worktree 那一步照常按 git 的完整口径核对，未提交改动会让它保留工作区而不是删掉。
import { lstat, mkdir, copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { attributeValues, definedPrograms, readOnlyGit, sealedGitDir } from "./accept-gate-preview.js";
import { execFileText } from "./exec.js";
import { optionalRead } from "./accept-gate-fs.js";

const MAX_BUFFER = 32 * 1024 * 1024;

/** 决定 `git status` 比对结果、又不能指向任何程序的配置（键是 git 归一过的小写）。 */
const STATUS_SETTINGS = /^core\.(autocrlf|eol|symlinks|filemode|ignorecase|precomposeunicode|trustctime|checkstat|checkroundtripencoding|longpaths)$/;

const ask = async (cwd: string, args: string[]) => (await readOnlyGit(cwd, args)).stdout.trim();
const optionalAsk = async (cwd: string, args: string[]) => (await readOnlyGit(cwd, args).catch(() => null))?.stdout.trim() || null;

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

/** 索引里记着的工作区文件大小（git 上一次核过它干净时的那份；索引只存低 32 位）。 */
async function indexedSizes(top: string, paths: string[]): Promise<Map<string, number>> {
  const out = (await readOnlyGit(top, ["ls-files", "-z", "--debug", "--", ...paths.map(path => `:(literal)${path}`)])).stdout;
  const sizes = new Map<string, number>();
  // 每一项：路径 NUL，接着五行以换行结尾的 stat 记录（ctime / mtime / dev ino / uid gid / size flags）。
  for (let at = 0; at < out.length;) {
    const end = out.indexOf("\0", at);
    if (end < 0) break;
    const path = out.slice(at, end);
    let cursor = end + 1;
    for (let line = 0; line < 5 && cursor < out.length; line++) {
      const next = out.indexOf("\n", cursor);
      const text = out.slice(cursor, next < 0 ? out.length : next);
      const size = /^\s*size:\s*(\d+)/.exec(text);
      if (size) sizes.set(path, Number(size[1]));
      cursor = next < 0 ? out.length : next + 1;
    }
    at = cursor;
  }
  return sizes;
}

/**
 * 「工作区 + 索引」相对提交 `commit` 的改动，`git status --porcelain=v1 -z --no-renames --untracked-files=all`
 * 的条目（`XY path`），在不执行任何项目程序的前提下得出（口径见文件头）。
 */
export async function worktreeChanges(cwd: string, commit: string): Promise<string[]> {
  const top = await ask(cwd, ["rev-parse", "--show-toplevel"]);
  const index = await ask(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  const sealed = await sealedGitDir(top, await statusSettings(cwd));
  let rows: string[];
  try {
    // 仓库级的排除与属性（info/exclude、info/attributes）只在项目 git 目录里，抄一份过去。
    await mkdir(join(sealed.gitDir, "info"), { recursive: true });
    for (const name of ["info/exclude", "info/attributes"]) {
      const from = await ask(cwd, ["rev-parse", "--path-format=absolute", "--git-path", name]);
      if (await optionalRead(from, () => lstat(from))) await copyFile(from, join(sealed.gitDir, name));
    }
    await writeFile(join(sealed.gitDir, "HEAD"), `${commit}\n`);
    rows = (await execFileText("git", ["-C", top, "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"],
      { maxBuffer: MAX_BUFFER, env: { ...sealed.env, GIT_INDEX_FILE: index, GIT_OPTIONAL_LOCKS: "0" } })).stdout
      .split("\0").filter(Boolean);
  } finally {
    await sealed.dispose();
  }
  // 只有「暂存区没动、工作区报改了」的已跟踪文件可能是过滤器造成的误报（暂存区对提交只比对象名）。
  const suspects = rows.filter(row => row.startsWith(" M")).map(row => row.slice(3));
  if (!suspects.length) return rows;
  const programs = await definedPrograms(cwd, "^filter\\..+\\.(clean|process)$");
  if (!programs.size) return rows;
  const filters = await attributeValues(top, "filter", suspects);
  const filtered = suspects.filter((_, i) => programs.has(filters[i] ?? ""));
  if (!filtered.length) return rows;
  const sizes = await indexedSizes(top, filtered);
  const unchanged = new Set<string>();
  for (const path of filtered) {
    const info = await optionalRead(join(top, path), () => lstat(join(top, path)), ["ENOENT", "ENOTDIR"]);
    const recorded = sizes.get(path);
    // 记成 0 是「没有记录」：--cacheinfo 刚放进来的项、git 写索引时把 racy 的项抹掉的大小（git 自己也
    // 当没核过，见 read-cache.c 的 ce_match_stat_basic）。没有记录就判不了，按文件头的口径不误报。
    if (info && recorded !== undefined && (recorded === 0 || info.size % 2 ** 32 === recorded)) unchanged.add(path);
  }
  return rows.filter(row => !(row.startsWith(" M") && unchanged.has(row.slice(3))));
}
