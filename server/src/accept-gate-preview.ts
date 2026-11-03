// 合并预览的执行层：预演那次合并、判断「物化它会不会调起项目自己的程序」。
//
// 硬边界是**门禁命令之外不执行任何项目程序**（任务硬约束；第 1、2 轮审查 F1/F2）。`git merge-tree`
// 虽然只往对象库写 blob/tree、不碰 ref 和工作区，但它是带着仓库配置和属性跑的：属性
// `merge=<name>` 会让它去执行 `merge.<name>.driver`，开了 merge.renormalize 还会跑过滤器。所以
// 安全不能靠「事先把属性文件找全」—— 第 1 轮那份文本扫描漏掉了被忽略的属性文件。这里换成
// **执行环境本身就没有程序可调**：
//
//  · 预演在一个 ash 自己建的空 git 目录里跑（GIT_DIR），对象库指向项目的那一份（GIT_OBJECT_DIRECTORY，
//    预演写出的树要留给快照用）；系统 / 全局配置、系统 / 全局属性文件一律换成空的，环境里继承来的
//    GIT_* 全部丢掉。这个目录的配置里**没有任何驱动和过滤器的定义**，属性点名一个没定义的驱动时
//    git 退回内置合并 —— 想执行程序也没有程序可执行；
//  · 属性取自目标分支那棵树（`--attr-source`），与真合并在目标分支检出里读到的那份相同；合并相关
//    的内置选项（重命名检测、换行规范化…）按白名单从项目配置抄过来，其余一律不带。
//
// 这样算出来的树在绝大多数仓库与真合并一模一样；对不上的那些（项目真配了外部驱动、主检出里有
// 不进版本库的属性文件…）由最终合并那一层兜住：落下来的树不是测过的那棵就撤回、不合
// （git-accept.ts 的 expectedTree）。下面 `mergeDrivers` 只为把「注定对不上」的情形提前说清楚，
// 不承担安全 —— 漏判的代价是合并时被拒，不是执行了程序。
//
// 物化（快照里检出这棵树）同一个口径：检出会跑过滤器（smudge/process），所以快照里那几条写工作区的
// git 命令走 `sealedGit`，环境里同样没有过滤器的定义 —— 硬边界在**实际检出的那个环境**里，不在
// 别处扫描的结论上（第 1 轮复审 F1：主检出 info/attributes 里的本地覆盖能把扫描结果掩掉，克隆里
// 却没有那份覆盖）。`checkoutFilters` 只负责把「平时检出要过滤器、快照里写出来的就不一样」提前说清楚。
//
// 这几条都要 git 2.40 以上（`--attr-source`、`check-attr --source`），旧 git 结构化拒绝（`previewFailure`）。
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileText } from "./exec.js";
import { expandHome } from "./platform.js";

const MAX_BUFFER = 32 * 1024 * 1024;
const git = (repo: string, args: string[], input?: string) =>
  execFileText("git", ["-C", expandHome(repo), ...args], { maxBuffer: MAX_BUFFER, input });

/** 预演可以从项目配置里带过去的内置选项（只影响内置合并的算法，没有一项能指向程序）。 */
const MERGE_SETTINGS = /^(merge\.(renames|directoryrenames|renamelimit|renormalize)|diff\.(renames|renamelimit)|core\.(autocrlf|eol|ignorecase|precomposeunicode))$/;

const isolated = new Map<string, Promise<{ gitDir: string; empty: string }>>();

/**
 * 进程内按对象格式（sha1 / sha256）各共用一份空 git 目录（被清理掉了就重建）。它只当「配置与属性的
 * 出处」，从不写入对象；格式必须与项目一致，否则借来的对象库在它眼里全是不认识的名字。
 */
async function isolatedGitDir(format: string): Promise<{ gitDir: string; empty: string }> {
  const current = await isolated.get(format)?.catch(() => null);
  if (current && existsSync(current.gitDir) && existsSync(current.empty)) return current;
  const created = (async () => {
    const root = await mkdtemp(join(tmpdir(), "ash-merge-preview-"));
    const empty = join(root, "empty");
    await writeFile(empty, "");
    const gitDir = join(root, "git");
    await execFileText("git", ["init", "--bare", "-q", `--object-format=${format}`, gitDir], { env: cleanEnv(empty) });
    return { gitDir, empty };
  })();
  isolated.set(format, created);
  return created;
}

function cleanEnv(empty: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith("GIT_")) env[key] = value;
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: empty, GIT_ATTR_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
}

export type PreviewMerge = { tree: string } | { conflicts: string[] } | { error: string };

/** 项目配置里可以带进隔离环境的那几项，摊成 `-c key=value`。 */
async function carriedSettings(repo: string): Promise<string[]> {
  const settings = (await git(repo, ["config", "--get-regexp", MERGE_SETTINGS.source]).catch(() => null))?.stdout ?? "";
  return settings.split("\n").filter(Boolean).flatMap((line) => {
    const at = line.indexOf(" ");
    return ["-c", at < 0 ? `${line}=true` : `${line.slice(0, at)}=${line.slice(at + 1)}`];
  });
}

/** 隔离环境里那几条把「程序从哪来」全堵上的参数：属性文件、钩子目录指向空文件，fsmonitor 关掉。 */
const sealed = (empty: string) => ["-c", `core.attributesFile=${empty}`, "-c", `core.hooksPath=${empty}`, "-c", "core.fsmonitor=false"];

/**
 * 在测试快照（`cwd`，一份新克隆）里跑一条会写工作区的 git 命令，环境与预演同样没有程序可调：
 * 系统 / 全局配置与属性置空、`GIT_*` 不继承，克隆自己的本地配置里本来就只有 clone 写的那几行。
 * 属性点名的过滤器因此一个都没有定义，git 按原样写出 blob —— 想执行也没有程序可执行。
 * 这是硬边界，不靠事先扫描；`checkoutFilters` 只负责把「这样写出来的跟平时检出的不一样」提前说清楚。
 * 换行这类内置转换照 `repo`（项目）的配置带过来，与快照里其余文件的检出口径一致。
 */
export async function sealedGit(repo: string, cwd: string, args: string[]): Promise<string> {
  const format = await objectFormat(repo);
  const { empty } = await isolatedGitDir(format);
  return (await execFileText("git", ["-C", cwd, ...sealed(empty), ...await carriedSettings(repo), ...args],
    { maxBuffer: MAX_BUFFER, env: cleanEnv(empty) })).stdout;
}

const objectFormat = async (repo: string): Promise<string> =>
  (await git(repo, ["rev-parse", "--show-object-format"])).stdout.trim() || "sha1";

/** 预演失败时那句「为什么」：只有 git 真的旧于 2.40 才把版本说出来，别的失败照原样报。 */
async function previewFailure(stderr: string): Promise<string> {
  const version = (await execFileText("git", ["version"]).catch(() => null))?.stdout.match(/(\d+)\.(\d+)/);
  const old = version && (Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 40));
  return old ? `${stderr}；这一档要 git 2.40 以上，这台机器上是 ${version[0]}` : stderr;
}

/** 预演「目标分支 ← 任务分支」那次合并。参数顺序与真合并一致（在目标分支上 `git merge` 任务分支）。 */
export async function previewMerge(repo: string, targetCommit: string, head: string): Promise<PreviewMerge> {
  try {
    const objects = join((await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim(), "objects");
    const carried = await carriedSettings(repo);
    const { gitDir, empty } = await isolatedGitDir(await objectFormat(repo));
    const { stdout } = await execFileText("git", [`--attr-source=${targetCommit}`, ...sealed(empty), ...carried,
      "merge-tree", "--write-tree", "--name-only", "--no-messages", targetCommit, head],
      { maxBuffer: MAX_BUFFER, env: { ...cleanEnv(empty), GIT_DIR: gitDir, GIT_OBJECT_DIRECTORY: objects } });
    return { tree: stdout.split("\n")[0]!.trim() };
  } catch (error) {
    const { code, stdout, stderr } = error as { code?: number; stdout?: string; stderr?: string };
    // 退出码 1 = 合得出来但有冲突：第一行是树，后面每行一个冲突文件，空行之后是说明（已用 --no-messages 关掉）。
    if (code === 1 && stdout) {
      const lines = stdout.split("\n");
      const end = lines.indexOf("", 1);
      return { conflicts: [...new Set(lines.slice(1, end < 0 ? undefined : end).map(line => line.trim()).filter(Boolean))] };
    }
    return { error: await previewFailure((stderr || String(error)).trim()) };
  }
}

/** 项目有效配置里定义了程序的那些名字（`<section>.<name>.<key>` 里的 name）。 */
async function definedPrograms(repo: string, pattern: string): Promise<Set<string>> {
  const listed = (await git(repo, ["config", "--name-only", "--get-regexp", pattern]).catch(() => null))?.stdout ?? "";
  const names = new Set<string>();
  for (const key of listed.split("\n")) {
    const match = /^[^.]+\.(.+)\.[^.]+$/.exec(key.trim());
    if (match) names.add(match[1]!);
  }
  return names;
}

/** `check-attr -z` 的输出：path NUL attr NUL value NUL …，按 path 收成 value。 */
async function attributeValues(repo: string, attr: string, paths: string[], source?: string): Promise<string[]> {
  if (!paths.length) return [];
  const args = [...(source ? [`--source=${source}`] : []), "-z", "--stdin", attr];
  const fields = (await git(repo, ["check-attr", ...args], paths.join("\0") + "\0")).stdout.split("\0");
  const values: string[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) values.push(fields[i + 2]!);
  return values;
}

const changedPaths = async (repo: string, from: string, to: string): Promise<string[]> =>
  (await git(repo, ["diff-tree", "-r", "--no-renames", "--name-only", "-z", from, to])).stdout.split("\0").filter(Boolean);

/**
 * 真合并会用到项目自配的合并驱动吗（返回驱动名）。两边改过的每一个路径，按目标分支、任务分支两棵
 * 树的属性，再按主检出里实际放着的属性（被忽略的属性文件只在那儿）各问一次 git；`merge.default`
 * 管没写 merge 属性的路径。只用来提前说清楚，不承担安全（见文件头）。
 */
export async function mergeDrivers(repo: string, targetCommit: string, head: string): Promise<string[]> {
  const defined = await definedPrograms(repo, "^merge\\..+\\.driver$");
  if (!defined.size) return [];
  const base = (await git(repo, ["merge-base", targetCommit, head]).catch(() => null))?.stdout.trim();
  if (!base) return [];
  const paths = [...new Set([...await changedPaths(repo, base, targetCommit), ...await changedPaths(repo, base, head)])];
  const fallback = (await git(repo, ["config", "merge.default"]).catch(() => null))?.stdout.trim() ?? "";
  const used = new Set<string>();
  const sources = [targetCommit, head, undefined];
  for (const values of await Promise.all(sources.map(source => attributeValues(repo, "merge", paths, source)))) {
    for (const value of values) {
      const name = value === "unspecified" ? fallback : value;
      if (defined.has(name)) used.add(name);
    }
  }
  return [...used];
}

/**
 * 预演树里有没有平时检出要经过项目过滤器的文件（返回过滤器名）。快照里检出不执行它们（`sealedGit`），
 * 写出来的就是未经过滤的 blob，跟真合并之后主检出里的文件不一样，所以提前拒绝。只算两棵树之间
 * 不同的那些路径；配置与属性读项目主检出的有效值，那正是真合并之后检出时生效的那一份。
 * 不承担安全（见文件头）。
 */
export async function checkoutFilters(repo: string, head: string, tree: string): Promise<string[]> {
  const defined = await definedPrograms(repo, "^filter\\..+\\.(clean|smudge|process)$");
  if (!defined.size) return [];
  const values = await attributeValues(repo, "filter", await changedPaths(repo, head, tree), tree);
  return [...new Set(values.filter(value => defined.has(value)))];
}
