// 合并预览档：快照里的文件与「合进去之后目标检出磁盘上的文件」是不是同一份。
//
// 快照是按现在的检出语义把整棵树全新写出来的；真合并却只重写这次改到的文件 —— 目标检出里没被
// 改到的那些，磁盘上还是它们当初检出时的样子（比如换行设置改之前写下的 LF，`git status` 照样干净）。
// 树一样、配置身份一样，字节却不一样，门禁测的就不是合进去之后那份（第 4 轮复审 F2）。这一层不去
// 枚举「哪些设置会造成这种差」，直接比结果：没被这次改到的每个文件，类型、链接目标、可执行位、字节。
// 目录也算（第 6 轮审查 F1：目标检出里一个源码目录改成 0111，文件照样按路径读得到，目录却列不出来，
// 快照里 `readdirSync` 过、合进去之后报 EACCES）：树里的每个目录连同检出根本身，记它能不能读、能不能进。
// 也记能不能写（第 6 轮审查第 2 轮 F1：源码目录 0555，快照里构建往里写被忽略的缓存成功，合进去之后
// 同一条命令报 EACCES —— 源码一个字节没变，门禁环境与落地环境却不等价）。文件同理。
//
// 这份不变量要从起跑一直守到落地（第 5 轮复审 F2：只在起跑前比一次，门禁跑着时另一个窗口把文件存成
// 另一种换行再暂存，树、配置、`git status` 全没变，旧绿照样合了进去）。所以起跑时把测过的那份记成
// 摘要（GatePhysical）存进凭据：复用旧绿前（gateBaselineMatches）按目标检出现在的字节重算一遍，
// 最终落地前后（git-accept-tested.ts）再各核一遍。
//
// 只读文件和只读的 git 查询（readOnlyGit），不调起项目程序。目标分支没检出在任何地方就没有磁盘状态可比
// （之后谁检出都是全新写的，与快照同一份）；检出着但不在被测提交上，最终合并会拒，这里也不比。
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, constants, lstat, readlink } from "node:fs/promises";
import { join, sep } from "node:path";
import { readOnlyGit } from "./accept-gate-preview.js";
import { registeredCheckout } from "./git-worktree-state.js";

/**
 * 凭据里那份被测物理内容。`preserved` = 合并不重写的那些文件的摘要（目标没检出在被测提交上时为 null），
 * 复用与落地前比它；`full` = 整棵树的摘要，落地之后比它；`skip` = 快照里借自任务工作区的依赖目录
 * （故意与目标检出不同，不比）；`materialization` = 快照实际用的检出语义身份（snapshotMaterialization），
 * 最终发布照它复现检出语义前先核目标检出现在还是这一份。
 */
export type GatePhysical = { skip: string[]; preserved: string | null; full: string; materialization: string };

const digest = (path: string) => new Promise<string>((resolve, reject) => {
  const hash = createHash("sha256");
  createReadStream(path).on("error", reject).on("data", chunk => hash.update(chunk)).on("end", () => resolve(hash.digest("hex")));
});

const zList = async (repo: string, args: string[]) => (await readOnlyGit(repo, args)).stdout.split("\0").filter(Boolean);

/**
 * 一个路径在磁盘上是什么：不存在、链接（目标）、目录（能不能读 / 写 / 进）、文件（读与执行权限位、
 * 能不能读 / 写 / 执行 + 字节）。两边相等才算同一份。
 * 文件的读、执行位按拥有者 / 组 / 其他各自记（第 5 轮复审第 2 轮 F1：只记「有没有执行位」时 0755 与
 * 0654 是同一个值）；位相等也不等于跑得起来 —— 访问控制列表（ACL）可以单独禁掉某个用户执行，位一个
 * 没变（第 6 轮审查第 3 轮 F2）。所以另记门禁那个用户**实际**能不能读、写、执行（access），与目录同一口径。
 */
async function entryOf(path: string): Promise<string> {
  const stat = await lstat(path).catch(() => null);
  if (!stat) return "missing";
  if (stat.isSymbolicLink()) return `link:${await readlink(path)}`;
  const can = (mode: number, flag: string) => access(path, mode).then(() => flag, () => "-");
  // 目录记的是**门禁那个用户**实际能不能列出、写入、进入（access），不是权限位：快照根是 ash 新建的
  // 临时目录（0700），目标检出根通常是 0755，按位比就永远对不上，对跑起来的程序却没有分别。
  // 子模块（gitlink）同样只是个目录，里面装什么不归这棵树管。
  if (stat.isDirectory()) {
    return `dir:${await can(constants.R_OK, "r")}${await can(constants.W_OK, "w")}${await can(constants.X_OK, "x")}`;
  }
  if (!stat.isFile()) return "other";
  const able = `${await can(constants.R_OK, "r")}${await can(constants.W_OK, "w")}${await can(constants.X_OK, "x")}`;
  return `file:${(stat.mode & 0o555).toString(8)}:${able}:${stat.size}:${await digest(path)}`;
}

const skipOf = (borrowed: readonly string[]) => borrowed.map(dep => dep.split(sep).join("/")).sort();
const skipped = (skip: readonly string[], path: string) => skip.some(dep => path === dep || path.startsWith(`${dep}/`));

/** 树里的每个路径，含各级目录（`-t`），打头是检出根本身（`.`）。 */
async function treePaths(repo: string, tree: string, skip: readonly string[]) {
  return [".", ...(await zList(repo, ["ls-tree", "-r", "-t", "--name-only", "-z", tree])).filter(path => !skipped(skip, path))];
}

/**
 * 合并（目标在 `base`、落下 `tree`）不会重写的那些路径：没改到的文件，以及合并之前就有的目录（合并
 * 只往里面写文件，不重建它；新增的目录是这次建的，与快照一样是全新的）。
 */
async function preservedPaths(repo: string, base: string, tree: string, skip: readonly string[]) {
  const rewritten = new Set(await zList(repo, ["diff-tree", "-r", "--name-only", "-z", base, tree]));
  const dirs = new Set(await zList(repo, ["ls-tree", "-r", "-d", "--name-only", "-z", base]));
  const resultDirs = new Set(await zList(repo, ["ls-tree", "-r", "-d", "--name-only", "-z", tree]));
  return (await treePaths(repo, tree, skip))
    .filter(path => path === "." || (resultDirs.has(path) ? dirs.has(path) : !rewritten.has(path)));
}

async function digestOf(root: string, paths: readonly string[], skip: readonly string[]): Promise<string> {
  const hash = createHash("sha256").update(`${JSON.stringify(skip)}\n`);
  for (const path of paths) hash.update(`${path}\0${await entryOf(join(root, path))}\n`);
  return hash.digest("hex");
}

/** 目标分支检出在哪、而且正停在 `head` 上；否则 null（没有磁盘状态可比，或者落地会另行拒）。 */
async function checkoutAt(repo: string, targetBranch: string, head: string): Promise<string | null> {
  const checkout = (await registeredCheckout(repo, targetBranch).catch(() => null))?.path;
  if (!checkout) return null;
  return (await readOnlyGit(checkout, ["rev-parse", "HEAD"]).catch(() => null))?.stdout.trim() === head ? checkout : null;
}

/**
 * 目标检出里那些合并不会重写、却和快照里不是同一份的文件（相对路径）。`base` 是被测时的目标提交，
 * `tree` 是测过的那棵；`borrowed` 是快照里借自任务工作区的依赖目录（故意不同，不比）。
 */
export async function checkoutDivergence(repo: string, targetBranch: string, base: string, tree: string,
  snapshot: string, borrowed: readonly string[]): Promise<string[]> {
  const checkout = await checkoutAt(repo, targetBranch, base);
  if (!checkout) return [];
  const drifted: string[] = [];
  for (const path of await preservedPaths(repo, base, tree, skipOf(borrowed))) {
    if (await entryOf(join(checkout, path)) !== await entryOf(join(snapshot, path))) drifted.push(path);
  }
  return drifted;
}

/** 起跑时记下快照里被测的那份（存进凭据的 preview_physical）。 */
export async function snapshotPhysical(repo: string, targetBranch: string, base: string, tree: string,
  snapshot: string, borrowed: readonly string[], materialization: string): Promise<GatePhysical> {
  const skip = skipOf(borrowed);
  const preserved = await checkoutAt(repo, targetBranch, base)
    ? await digestOf(snapshot, await preservedPaths(repo, base, tree, skip), skip) : null;
  return { skip, preserved, full: await digestOf(snapshot, await treePaths(repo, tree, skip), skip), materialization };
}

/** 目标检出**现在**那份「合并不重写的文件」的摘要，与凭据的 `preserved` 同一口径；没检出在 `base` 上为 null。 */
export async function targetPreserved(repo: string, targetBranch: string, base: string, tree: string,
  borrowed: readonly string[]): Promise<string | null> {
  const checkout = await checkoutAt(repo, targetBranch, base);
  const skip = skipOf(borrowed);
  return checkout ? await digestOf(checkout, await preservedPaths(repo, base, tree, skip), skip) : null;
}

/** 落地用：检出 `checkout` 里那份与凭据比。`whole` = 落地之后比整棵树，否则比合并不重写的那些。 */
export async function checkoutMatches(repo: string, checkout: string, physical: GatePhysical, base: string, tree: string,
  whole: boolean): Promise<boolean> {
  if (whole) return await digestOf(checkout, await treePaths(repo, tree, physical.skip), physical.skip) === physical.full;
  return physical.preserved !== null
    && await digestOf(checkout, await preservedPaths(repo, base, tree, physical.skip), physical.skip) === physical.preserved;
}

export const encodePhysical = (physical: GatePhysical) => JSON.stringify(physical);

export function decodePhysical(text: string | null | undefined): GatePhysical | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as GatePhysical;
    return Array.isArray(value.skip) && typeof value.full === "string" ? value : null;
  } catch { return null; }
}
