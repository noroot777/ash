import { lstat, mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { copyLink, insideTree } from "./accept-gate-tree.js";
import { DEPENDENCY_DIRS } from "./accept-gate-dirs.js";

// 源码隔离的**收口**:让项目自己的每个包都解析到快照里那份被认证的源码。
//
// 克隆依赖树、改写树内落点都只管快照里**已经有**的东西,管不到 node 的向上查找。快照建在 ash 的
// 运行产物目录里、那个目录通常就在项目内,于是 node 从快照一级级往上找,用的是项目主检出那棵树,
// 里面的 workspace 链指着**活的**工作区源码。
//
// 这一版的判据来自 2026-10-27 独立审查的两台机器实测:上一版从「node 会用哪棵树」出发——找到第
// 一个真实存在的 `node_modules` 就停,树在快照内就认为隔离完成。两条都不成立:
//   ① node 不是「先选一棵树,再在树里找所有包」,而是**按每个包名分别**从当前目录一级级往上找
//      `node_modules/<name>`,第一个命中的就是答案。于是「树在快照内」只证明了那棵树存在,证明不
//      了它**装齐了**本项目的包:任务只装了一部分依赖(很常见)时,缺掉的那个包会继续往祖先找,落
//      在主检出的活源码上。实测:快照自带 TASK_NEW,执行输出 MAIN_OLD,随后改主检出的源码,同一
//      份快照输出跟着变成 MAIN_LIVE,而快照自证与工作区新鲜度全程为真。
//   ② 「自有包有哪些」不能从另一个检出的布局推断。上一版从主检出那棵树的条目反推相对路径,再把
//      同一个相对路径套到快照上:任务把包从 `packages/lib` 搬到 `libs/lib`,快照那个位置上没有包,
//      门禁在开跑前就失败——一个合法的重构让验收不可用。
// 所以候选集只能来自**快照自己的源码**(它就是本次被认证的那一份),判据只能是**实际解析落点**。
//
// 为什么不从「源码树里每个 package.json 都必须解析到快照」出发:那会把一个合法地解析进工作区依赖
// 树的第三方包也要求「证明它指向快照」。这里的集合是**自有包**(快照源码里摆着的包),第三方包不在
// 其中,所以不会被要求证明。

/** 这个目录上摆的包叫什么。读不出来（没有、坏了、没有 name）就回 null。 */
export async function manifestName(root: string): Promise<string | null> {
  const raw = await readFile(join(root, "package.json"), "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    const name = (JSON.parse(raw) as { name?: unknown }).name;
    return typeof name === "string" && name !== "" ? name : null;
  } catch { return null; }
}

/**
 * 快照里本项目自己的包：包名 → 它在快照里的相对路径（项目根本身记作 `.`）。
 *
 * 只扫源码:依赖目录整棵跳过(那里面是第三方包,几万个 package.json),软链不跟随(`isDirectory()`
 * 对软链就是 false)。深度上限与声明展开那一侧一致。
 */
async function snapshotPackages(target: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const rootName = await manifestName(target);
  if (rootName !== null) found.set(rootName, ".");
  const walk = async (sub: string, depth: number): Promise<void> => {
    if (depth > 8) return;
    for (const entry of await readdir(join(target, sub), { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || entry.name === ".git" || DEPENDENCY_DIRS.includes(entry.name)) continue;
      const path = sub === "" ? entry.name : join(sub, entry.name);
      const name = await manifestName(join(target, path));
      if (name !== null && !found.has(name)) found.set(name, path);
      await walk(path, depth + 1);
    }
  };
  await walk("", 0);
  return found;
}

/**
 * node 解析这个包名时第一个命中的落点，解析不到回 null。
 *
 * 必须**按名字**一级级往上查,不能先找一棵树再看树里有没有:那正是上一版的错(见文件头①)。
 */
async function resolvesTo(start: string, name: string): Promise<string | null> {
  let directory = start;
  for (;;) {
    const landing = await realpath(join(directory, "node_modules", name)).catch(() => null);
    if (landing !== null) return landing;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/**
 * 快照自己的 `node_modules` 能不能往里写。可写回 null，不可写回拒绝的理由。
 *
 * 重绑定要往这个路径写,而它可能是一条**借用链**——落在用户工作区上。往那头写就是改用户的工作区:
 * 同名的第三方包会被换成项目自己那份,`file:` 来的外部依赖会被改写进快照,用户下次跑自己的东西才
 * 发现被动过,且改动不可逆。悬空链同样不许穿:`mkdir` 会在断链的落点上把目录造出来,那个落点在工
 * 作区里。所以这三种形态分开判,不是「解析不出来就当没事」。
 */
async function trunkWritable(target: string, realTarget: string): Promise<string | null> {
  const trunk = join(target, "node_modules");
  const info = await lstat(trunk).catch(() => null);
  if (info === null) return null; // 还不存在：mkdir 落在快照里
  const landing = await realpath(trunk).catch(() => null);
  if (landing === null) {
    return info.isSymbolicLink()
      ? "快照的 node_modules 是一条解析不通的链（往里写会在它落点那头造目录）"
      : "快照的 node_modules 读不出落点";
  }
  return insideTree(realTarget, landing) ? null : `快照的 node_modules 落在 ${landing}（快照之外）`;
}

/** 让项目自己的包都解析到快照里那份冻结的源码。返回第一处收不住的说明，全都收住就回 null。 */
export async function confineOwnPackages(target: string): Promise<string | null> {
  const realTarget = await realpath(target).catch(() => target);
  const plan: { name: string; source: string; where: string }[] = [];
  for (const [name, rel] of await snapshotPackages(target)) {
    const where = await resolvesTo(realTarget, name);
    // 解析不到:这个包压根没装。命令跑到它会自己报 ERR_MODULE_NOT_FOUND,那是项目自己的事
    // (在工作区里跑也一样),不是隔离出了问题——这里不替它装包。
    if (where === null) continue;
    if (insideTree(realTarget, where)) continue; // 已经指着快照自己那一份
    plan.push({ name, source: rel === "." ? target : join(target, rel), where });
  }
  if (plan.length === 0) return null;
  const refusal = await trunkWritable(target, realTarget);
  if (refusal !== null) {
    return `需要把 ${plan.map(item => `${item.name}（现在解析到 ${item.where}）`).join("、")}`
      + ` 绑回快照里被认证的那份源码，但${refusal}，拒绝`;
  }
  for (const { name, source } of plan) {
    const entry = join(target, "node_modules", name);
    await mkdir(dirname(entry), { recursive: true });
    await rm(entry, { recursive: true, force: true });
    await copyLink(source, entry, relative(dirname(entry), source));
    const bound = await realpath(entry).catch(() => null);
    if (bound === null || !insideTree(realTarget, bound)) {
      return `${name} 仍然解析到 ${bound ?? "解析不出来"}，不是快照自己那份源码`;
    }
  }
  return null;
}
