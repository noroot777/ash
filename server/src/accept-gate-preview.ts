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
// 物化（快照里检出这棵树）同一个口径：合并预览档的快照从克隆到收尾核验都在封好的环境里跑
// （`cloneSealedSnapshot` / `sealedGit`，说明在它们上方）—— 硬边界在**实际检出的那个环境**里，不在
// 别处扫描的结论上（第 1 轮复审 F1：主检出 info/attributes 里的本地覆盖能把扫描结果掩掉，克隆里
// 却没有那份覆盖）。`checkoutFilters` 只负责把「平时检出要过滤器、快照里写出来的就不一样」提前说清楚。
//
// 这几条都要 git 2.40 以上（`--attr-source`、`check-attr --source`），旧 git 结构化拒绝（`previewFailure`）。
import { existsSync } from "node:fs";
import { mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileText } from "./exec.js";
import { expandHome } from "./platform.js";

const MAX_BUFFER = 32 * 1024 * 1024;
/**
 * 在项目仓库里跑一条**只读**的 git。`diff-tree`、`check-attr`、`status` 这些看似只读的命令会读索引，
 * 读索引就会调起项目配的 `core.fsmonitor`（第 2 轮审查 F2 实测），顺手刷新索引还会写回、触发
 * post-index-change 钩子。所以一律关掉 fsmonitor、不拿可选锁（不刷新不写回）—— 两样都只是缓存，
 * 关掉不改变任何结果。门禁的准备（基准判定、预演、源码身份）都走这一个口子，别各写各的 `git`。
 */
export const readOnlyGit = (repo: string, args: string[], input?: string) =>
  execFileText("git", ["-C", expandHome(repo), "-c", "core.fsmonitor=false", ...args],
    { maxBuffer: MAX_BUFFER, input, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
const git = readOnlyGit;

/** 预演可以从项目配置里带过去的内置选项（只影响内置合并的算法，没有一项能指向程序）。 */
const MERGE_SETTINGS = /^(merge\.(renames|directoryrenames|renamelimit|renormalize)|diff\.(renames|renamelimit)|core\.(autocrlf|eol|ignorecase|precomposeunicode))$/;

let scratchRoot: Promise<{ root: string; empty: string }> | null = null;

/** 进程内共用的一个临时目录和里面的空文件（被清理掉了就重建）：空配置、空属性都指向它。 */
async function scratch(): Promise<{ root: string; empty: string }> {
  const current = await scratchRoot?.catch(() => null);
  if (current && existsSync(current.empty)) return current;
  scratchRoot = (async () => {
    const root = await mkdtemp(join(tmpdir(), "ash-merge-preview-"));
    const empty = join(root, "empty");
    await writeFile(empty, "");
    return { root, empty };
  })();
  return scratchRoot;
}

const isolated = new Map<string, Promise<{ gitDir: string; empty: string }>>();

/**
 * 进程内按对象格式（sha1 / sha256）各共用一份空 git 目录（被清理掉了就重建）。它只当「配置与属性的
 * 出处」，从不写入对象；格式必须与项目一致，否则借来的对象库在它眼里全是不认识的名字。
 */
async function isolatedGitDir(format: string): Promise<{ gitDir: string; empty: string }> {
  const current = await isolated.get(format)?.catch(() => null);
  if (current && existsSync(current.gitDir) && existsSync(current.empty)) return current;
  const created = (async () => {
    const { root, empty } = await scratch();
    const gitDir = join(root, `git-${format}`);
    if (!existsSync(gitDir)) {
      await execFileText("git", ["init", "--bare", "-q", "--template=", `--object-format=${format}`, gitDir], { env: cleanEnv(empty) });
    }
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

/** 项目有效配置里可以带进隔离环境的那几项（键已是 git 归一过的小写）。 */
async function carriedPairs(repo: string): Promise<[string, string][]> {
  const settings = (await git(repo, ["config", "--get-regexp", MERGE_SETTINGS.source]).catch(() => null))?.stdout ?? "";
  return settings.split("\n").filter(Boolean).map((line) => {
    const at = line.indexOf(" ");
    return at < 0 ? [line, "true"] : [line.slice(0, at), line.slice(at + 1)];
  });
}

const carriedSettings = async (repo: string): Promise<string[]> =>
  (await carriedPairs(repo)).flatMap(([key, value]) => ["-c", `${key}=${value}`]);

/** 隔离环境里那几条把「程序从哪来」全堵上的参数：属性文件、钩子目录指向空文件，fsmonitor 关掉。 */
const sealed = (empty: string) => ["-c", `core.attributesFile=${empty}`, "-c", `core.hooksPath=${empty}`, "-c", "core.fsmonitor=false"];

// ── 合并预览档的测试快照：从克隆到收尾核验，整段生命周期都在「只含核定配置」的环境里跑。
//
// 检出会跑过滤器（smudge/process），`git diff` 会跑 clean，所以门禁命令之外快照里的每一条 git 都
// 得是没有程序可调的。光把系统 / 全局配置置空不够：克隆自己的 `.git/config` 也是配置，而它的来源
// 不止 clone 本身（`init.templateDir` 能把模板里的 config 抄进去，第 2 轮复审 F1）。所以不去推断
// 「新克隆里应该有什么」，而是**克隆完就把它的本地配置整份换成 ash 写的那一份**：只留仓库格式
// 必需的几项（白名单），再加上从项目有效配置带过来的内置转换选项和封口的几项。之后这份快照里
// 跑的 git —— 物化预演树、收尾核验 —— 都用这一份配置，检出时的换行转换与核验时解释文件的口径
// 也就天然是同一份（第 2 轮复审 F2：检出临时 `-c` 带配置、核验却读另一份，CRLF 被判成改了源码）。
// 门禁命令自己在快照里跑 git 时读到的也是这份（加上用户的全局配置，本地这几项优先）。

/** 换掉快照本地配置时保留的那几项：没有它们这份仓库就打不开（格式、对象格式、引用存储）。 */
const KEPT_SETTINGS = /^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)|extensions\.(objectformat|compatobjectformat|refstorage))$/;
const SEAL_MARK = "ash.sealedsnapshot";

async function sealedExec(cwd: string, args: string[]): Promise<string> {
  const { empty } = await scratch();
  return (await execFileText("git", ["-C", cwd, ...sealed(empty), ...args],
    { maxBuffer: MAX_BUFFER, env: cleanEnv(empty) })).stdout;
}

/**
 * 建合并预览档的测试快照：不带模板克隆（`--template=`），随即把本地配置换成核定的那一份
 * （见上）。`repo` 是项目（读它的有效配置决定带哪几项内置转换），`source` 是被克隆的工作区。
 */
export async function cloneSealedSnapshot(repo: string, source: string, target: string): Promise<void> {
  await sealedExec(source, ["clone", "--template=", "--no-hardlinks", "--dissociate", "--no-checkout", "--", source, target]);
  const file = join(target, ".git", "config");
  const { empty } = await scratch();
  const env = cleanEnv(empty);
  const listed = (await execFileText("git", ["config", "--file", file, "--list"], { env })).stdout;
  const kept = listed.split("\n").filter(Boolean).map((line): [string, string] => {
    const at = line.indexOf("=");
    return at < 0 ? [line, "true"] : [line.slice(0, at), line.slice(at + 1)];
  }).filter(([key]) => KEPT_SETTINGS.test(key));
  const conversions = (await carriedPairs(repo)).filter(([key]) => key.startsWith("core."));
  const entries: [string, string][] = [...kept, ...conversions,
    ["core.hooksPath", join(target, ".git", "ash-no-hooks")],
    ["core.attributesFile", join(target, ".git", "ash-no-attributes")],
    ["core.fsmonitor", "false"], [SEAL_MARK, "true"]];
  const next = `${file}.ash-sealed`;
  await writeFile(next, "");
  for (const [key, value] of entries) await execFileText("git", ["config", "--file", next, key, value], { env });
  await rename(next, file);
}

/** 这份快照是不是 `cloneSealedSnapshot` 建的（收尾核验据此决定用哪套环境跑 git）。 */
export async function isSealedSnapshot(cwd: string): Promise<boolean> {
  const { empty } = await scratch();
  return (await execFileText("git", ["config", "--file", join(cwd, ".git", "config"), "--get", SEAL_MARK],
    { env: cleanEnv(empty) }).catch(() => null))?.stdout.trim() === "true";
}

/**
 * 在封好的快照里跑一条 git：系统 / 全局配置与属性置空、`GIT_*` 不继承，本地配置就是 ash 写的那一份，
 * 属性点名的过滤器一个都没有定义，git 按原样读写 blob —— 想执行也没有程序可执行。这是硬边界，
 * 不靠事先扫描；`checkoutFilters` 只负责把「这样写出来的跟平时检出的不一样」提前说清楚。
 */
export async function sealedGit(cwd: string, args: string[]): Promise<string> {
  if (!await isSealedSnapshot(cwd)) throw new Error(`不是封好的测试快照：${cwd}`);
  return sealedExec(cwd, args);
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
    const objects = await objectsDir(repo);
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

export const changedPaths = async (repo: string, from: string, to: string): Promise<string[]> =>
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

const treePaths = async (repo: string, tree: string): Promise<string[]> =>
  (await git(repo, ["ls-tree", "-r", "--name-only", "-z", tree])).stdout.split("\0").filter(Boolean);

const objectsDir = async (repo: string): Promise<string> =>
  join((await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim(), "objects");

/**
 * 预演树里有没有平时检出要经过项目过滤器的文件（返回过滤器名）。快照里检出不执行它们（`sealedGit`），
 * 写出来的就是未经过滤的 blob，跟真合并之后主检出里的文件不一样，所以提前拒绝。问的是**整棵树**
 * 的每一个路径，不只是这次合并改到的那些：封好的快照检出的是整棵树，一个从没改过、一直靠全局
 * smudge 生成内容的老文件同样会被写成另一份（第 1 轮审查 F3）。配置与属性读项目主检出的有效值，
 * 那正是真合并之后检出时生效的那一份。不承担安全（见文件头）。
 */
export async function checkoutFilters(repo: string, tree: string): Promise<string[]> {
  const defined = await definedPrograms(repo, "^filter\\..+\\.(clean|smudge|process)$");
  if (!defined.size) return [];
  const values = await attributeValues(repo, "filter", await treePaths(repo, tree), tree);
  return [...new Set(values.filter(value => defined.has(value)))];
}

/** 检出时由 git 内建完成、会改写文件字节的那几个属性。 */
const CONVERSIONS = ["text", "eol", "crlf", "working-tree-encoding", "ident"];

/**
 * 封好的快照里检出这棵树，内建转换（换行、编码、`$Id$` 展开）会不会跟平时检出不一样（返回对不上
 * 的路径）。快照只认树里的 `.gitattributes`，主检出的 `info/attributes`、全局 / 系统属性文件一概不读
 * （它们不进克隆，读进来也违背「环境只含核定配置」），所以那些文件给出的转换在快照里不生效 —— 树
 * 一样、字节不一样，门禁测的就不是合进去之后那份（第 1 轮审查 F1）。逐路径拿两边的属性对一遍：平时
 * 检出那边按项目有效属性问，快照那边在同样空的隔离环境里只按树问；有一处不同就提前拒绝。换行相关
 * 的配置（core.autocrlf / eol）两边是同一份（cloneSealedSnapshot 照项目有效值带过去），不用比。
 */
export async function conversionDrift(repo: string, tree: string): Promise<string[]> {
  const paths = await treePaths(repo, tree);
  if (!paths.length) return [];
  const input = paths.join("\0") + "\0";
  const args = ["check-attr", `--source=${tree}`, "-z", "--stdin", ...CONVERSIONS];
  const usual = (await git(repo, args, input)).stdout;
  const objects = await objectsDir(repo);
  const { gitDir, empty } = await isolatedGitDir(await objectFormat(repo));
  const snapshot = (await execFileText("git", [...sealed(empty), ...args],
    { maxBuffer: MAX_BUFFER, input, env: { ...cleanEnv(empty), GIT_DIR: gitDir, GIT_OBJECT_DIRECTORY: objects } })).stdout;
  if (usual === snapshot) return [];
  const left = usual.split("\0");
  const right = snapshot.split("\0");
  const drifted = new Set<string>();
  for (let i = 0; i + 2 < Math.max(left.length, right.length); i += 3) {
    if (left[i] !== right[i] || left[i + 2] !== right[i + 2]) drifted.add(left[i] ?? right[i] ?? "");
  }
  return [...drifted];
}
