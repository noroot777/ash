import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, readlink, realpath, rm, symlink } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { copyLink, insideTree } from "./accept-gate-tree.js";

// 门禁快照冻住的是**源码**；依赖是 lockfile 的产物，按产物对待。
//
// 为什么不逐文件拷：本仓一份 node_modules = 563 MB / 45490 文件 / 37 条软链（2026-10-26 实测），
// 而每次门禁至少三遍全量摘要（登记一遍、边拷边算一遍、对账再算一遍）。拷它还得正确复刻软链、
// 权限位、断链、没装的可选依赖、Windows junction、平台二进制——每多一个生态多一类坑，而这些坑
// 被逐个咬出来的历史就是这个模块的提交史。反过来看：现存十来份**没装依赖**的快照从没走过这条
// 路，靠向上解析到主仓的 node_modules 把全量回归跑完了。真正被验证过的是「不拷」。
//
// 选链、不选 reflink（macOS clonefile / Linux cp --reflink）：reflink 共享的是数据块，目录项和
// 元数据还是要逐个建 4.5 万次，**那几遍摘要一遍都省不掉**；Windows 没有对应物，等于在那台机器
// 上退回深拷。链是 O(1)，三个平台都有退路（POSIX 目录软链 / Win32 junction，pnpm 同款）。
// 换来的两处代价各自写在 dependencyDigest（指纹口径变弱）和 borrowDependency（写入外溢）上方。
//
// 借用有一处**必须单独处理**的落点：monorepo 的 workspace 链接（本仓
// node_modules/@ash/shared -> ../../shared，npm workspaces 自己建的）。它指着项目**自己的源码**，
// 而相对原文是按链**真实所在的位置**解析的——整条 node_modules 借出去之后，它就落在活的工作区
// 源码上，于是 monorepo 里最常被改的那部分恰好没被冻住：改导出会红（看起来像门禁在工作），
// 改实现则静悄悄地绿。源码隔离在这类仓库上成了空话。实测见 AMEPL4pvlx-S 的两份门禁日志。
// 所以这一层只借到「含 workspace 链接的那一层」为止：那几层在快照里建成真目录，逐条目各借一条
// 链，workspace 链接则按落点重定向到**快照自己**那份源码。代价是 O(顶层包数) 条链（本仓 285 条）
// 而不是一条，仍然不是 O(文件数)，摘要照旧只读安装声明。
//
// 用户提过的另一条路（clonefile 整棵克隆）也能修掉它——克隆保留相对链，于是它在副本里自然落在
// 副本自己的源码上。没选它的理由仍是上面那两条：4.5 万个目录项照建、Windows 没有对应物。
//
// **检不出的同类问题**：Python 的 editable install（`pip install -e`）把项目源码路径写成
// site-packages 里一个 .pth / .egg-link 的**文件内容**（绝对路径），不是软链。借用它会解冻，但
// 深拷**也会**（照抄文件内容 = 照抄那条绝对路径），所以这不是借用引入的；要修得重写文件内容，
// 属于另一类工程，这一层不碰，写在这里是为了别让下一个人以为它已经被覆盖了。
export const DEPENDENCY_DIRS = ["node_modules", ".venv", "vendor", "target"];

// 各生态的**安装声明**。身份取它，不取 4 万个文件的字节：装、删、升级任何一个包都会改到这里。
// node_modules/.package-lock.json 是 npm 7+ 自己写的已安装树（本仓 353 条，含每个包的 version、
// resolved 和 integrity），所以它同时覆盖了「同版本不同内容」。
const MANIFESTS: Record<string, string[]> = {
  node_modules: [".package-lock.json", ".modules.yaml", ".yarn-state.yml"],
  vendor: ["modules.txt", join("composer", "installed.json")],
};

const exists = async (path: string) => await lstat(path).then(() => true, () => false);

// venv 的顶层只有 bin/lib/include，pyvenv.cfg 也只记 python 版本和 home——装包两者都不动，拿它
// 当声明等于一个包都检不出来。所以这里下到 site-packages 去列 *.dist-info / *.egg-info，那些
// 目录名本身就是 name-version。POSIX 是 lib/python3.x/site-packages，Win32 是 Lib\site-packages。
async function sitePackages(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const lib of ["lib", "lib64", "Lib"]) {
    const base = join(root, lib);
    if (await exists(join(base, "site-packages"))) {
      found.push(join(base, "site-packages"));
      continue;
    }
    for (const version of (await readdir(base).catch(() => [])).sort()) {
      if (await exists(join(base, version, "site-packages"))) found.push(join(base, version, "site-packages"));
    }
  }
  return found;
}

// 单个 npm 包的身份：name@version。读 353 个 package.json 仍比读 4.5 万个文件便宜两个数量级，
// 而且只在没有已安装树声明时才走到这里（npm 6 以前、手铺的 node_modules）。
async function packageIdentity(path: string, name: string): Promise<string> {
  const raw = await readFile(join(path, "package.json"), "utf8").catch(() => null);
  if (raw === null) return `${name}@absent`;
  try { return `${name}@${(JSON.parse(raw) as { version?: string }).version ?? "unversioned"}`; }
  catch { return `${name}@unparsable`; }
}

async function packageList(path: string, kind: string): Promise<string[]> {
  if (kind === ".venv") {
    const list: string[] = [];
    for (const site of await sitePackages(path)) {
      for (const entry of (await readdir(site).catch(() => [])).sort()) {
        if (/\.(?:dist-info|egg-info|egg-link)$/.test(entry)) list.push(entry);
      }
    }
    return list;
  }
  const entries = (await readdir(path, { withFileTypes: true }).catch(() => []))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const list: string[] = [];
  for (const entry of entries) {
    if (kind !== "node_modules") {
      list.push(`${entry.name}:${entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "link" : "file"}`);
      continue;
    }
    if (entry.name.startsWith(".")) continue; // .bin / .cache / .vite 不是包
    if (!entry.name.startsWith("@")) {
      list.push(await packageIdentity(join(path, entry.name), entry.name));
      continue;
    }
    for (const scoped of (await readdir(join(path, entry.name)).catch(() => [])).sort()) {
      list.push(await packageIdentity(join(path, entry.name, scoped), `${entry.name}/${scoped}`));
    }
  }
  return list;
}

/**
 * 依赖目录的身份。
 *
 * **检得出**：装、删、升级任何一个包（已安装树声明或包清单必然改），以及 npm 这边的「同版本
 * 不同内容」（.package-lock.json 带 integrity）。
 *
 * **检不出**：手改了依赖目录里的文件却没重装——patch-package 打完补丁没提交、`npm link` 指到
 * 本地检出、直接进 node_modules 改一行热修。代价是：依赖实际变了，门禁却会沿用上一张绿结果。
 * 这是换口径换来的实打实的检测力下降，比字节摘要弱。注意借用之后快照跑的**就是**工作区那一份
 * 依赖，所以后果不是「副本和工作区不一致」（那是旧口径才有的风险），而是「变了却没重跑」。
 *
 * 没有任何已知声明的目录（Rust 的 target 是构建产物、不是依赖；手铺的 vendor）退到浅层条目
 * 清单：名字 + 类型。那种目录的内容变化基本检不出来，但它们也不该靠门禁来冻。
 */
export async function dependencyDigest(root: string, dep: string): Promise<string> {
  const path = join(root, dep);
  const kind = dep.split(sep).pop() ?? dep;
  const hash = createHash("sha256").update("gate-dependency-v1\0");
  for (const manifest of MANIFESTS[kind] ?? []) {
    const content = await readFile(join(path, manifest)).catch(() => null);
    if (content === null) continue;
    return hash.update(`manifest:${manifest}\0`).update(content).digest("hex");
  }
  hash.update("packages\0");
  for (const entry of await packageList(path, kind)) hash.update(entry).update("\0");
  return hash.digest("hex");
}

/** 借用的形态：整条链借出去，还是把含 workspace 链接的那几层物化之后逐条目借。 */
export type BorrowMode = "link" | "materialized";

/**
 * 这条链指着项目**自己的源码**吗（monorepo 的 workspace 链接就是这个形状）。
 *
 * 判据：落点在项目目录内、又不在任何登记的依赖目录内——那就只能是源码。解析不到落点的链不算
 * （它本来也解析不出东西来），落在项目外的不算（那是依赖的事，照借）。
 */
async function pointsAtSource(realRoot: string, dependencies: string[], path: string): Promise<boolean> {
  const landing = await realpath(path).catch(() => null);
  if (landing === null || !insideTree(realRoot, landing)) return false;
  for (const dep of dependencies) {
    const real = await realpath(join(realRoot, dep)).catch(() => join(realRoot, dep));
    if (insideTree(real, landing)) return false;
  }
  return true;
}

/**
 * 依赖目录里指着项目源码的链，路径相对依赖目录本身。
 *
 * 只扫**顶层和一层 @scope**：npm / pnpm / yarn 都把 workspace 包连在这两层（本仓是
 * node_modules/@ash/*）。再往深处扫就回到「遍历 4.5 万个条目」，而这一层的全部意义就是不那么
 * 干。更深处的同类链检不出——那种布局是手铺出来的，本来也不该靠门禁来冻。
 */
async function workspaceLinks(root: string, dep: string, dependencies: string[]): Promise<string[]> {
  const realRoot = await realpath(root).catch(() => root);
  const base = join(root, dep);
  const found: string[] = [];
  const scan = async (prefix: string) => {
    for (const entry of await readdir(join(base, prefix), { withFileTypes: true }).catch(() => [])) {
      const rel = prefix === "." ? entry.name : join(prefix, entry.name);
      if (entry.isSymbolicLink()) {
        if (await pointsAtSource(realRoot, dependencies, join(base, rel))) found.push(rel);
      } else if (prefix === "." && entry.isDirectory() && entry.name.startsWith("@")) await scan(entry.name);
    }
  };
  await scan(".");
  return found;
}

// Win32 用 junction：普通目录软链要 SeCreateSymbolicLinkPrivilege（没开开发者模式就建不出来），
// junction 不要，pnpm 用的也是它，而且 node 把 junction 同样报成 isSymbolicLink()。junction 只
// 认绝对路径，所以两个平台统一写绝对路径——快照和项目的目录深度本来就不同，相对原文没有意义。
async function linkWhole(source: string, destination: string): Promise<boolean> {
  try {
    await symlink(source, destination, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch { return false; }
}

/**
 * 含 workspace 链接的那几层物化成真目录，逐条目借用。
 *
 * 要展开的是每条 workspace 链接的**全部祖先层**（依赖目录自己也算一层，否则它还是一条链，下面
 * 的层无从物化）。展开层里的条目分三种走法：workspace 链接按落点重定向到快照自己那份源码；
 * 普通目录/软链各借一条指向工作区那一个条目的链（绝对落点，所以依赖内部的相对链照旧在工作区
 * 原地解析）；文件直接拷（安装声明就在这一层，而 Win32 的文件软链要权限）。
 */
async function materializeBorrow(root: string, target: string, dep: string, links: string[]): Promise<boolean> {
  // 落点由 realpath 给出,所以**项目侧**要用 realpath 后的根去求相对路径;但快照侧必须用调用方
  // 给的 target 原样拼——目的地链的原文是相对 dirname(to) 的,而 to 就建在那个未解析的路径上。
  // 混用两种前缀会在任何「路径祖先里有软链」的机器上算出一条穿出快照的相对路径(macOS 的
  // /var -> /private/var 必然命中),于是 workspace 链接落回工作区,正是这段代码要防的那件事。
  const realRoot = await realpath(root).catch(() => root);
  const base = join(root, dep);
  const expand = new Set<string>(["."]);
  for (const rel of links) {
    for (let dir = dirname(rel); dir !== "."; dir = dirname(dir)) expand.add(dir);
  }
  const redirect = new Set(links);
  try {
    for (const dir of [...expand].sort()) await mkdir(join(target, dep, dir), { recursive: true });
    for (const dir of [...expand].sort()) {
      for (const entry of await readdir(join(base, dir), { withFileTypes: true })) {
        const rel = dir === "." ? entry.name : join(dir, entry.name);
        if (expand.has(rel)) continue; // 这一层自己要展开，交给它那一轮
        const from = join(base, rel);
        const to = join(target, dep, rel);
        if (redirect.has(rel)) {
          const landing = await realpath(from);
          await copyLink(from, to, relative(dirname(to), join(target, relative(realRoot, landing))));
          continue;
        }
        const info = await lstat(from);
        if (info.isFile()) {
          await copyFile(from, to);
          await chmod(to, info.mode);
          continue;
        }
        await copyLink(from, to, from);
      }
    }
    return true;
  } catch { return false; }
}

/**
 * 在快照里放上工作区那份依赖。
 *
 * 没有 workspace 链接时就是一条链，O(1)。有的话只物化到含它的那几层（见 materializeBorrow），
 * 理由写在本文件顶部——整条借出去会让 monorepo 的源码隔离变成空话。
 *
 * **写入外溢**：借用意味着门禁跑测试时写进去的东西落在**用户的工作区**里——vite 的
 * node_modules/.vite、各种 .cache、Rust 的 target 增量编译都会。这里选择接受并写明，因为另一头
 * 做不到：改权限变成只读等于动用户的工作区（而且 .bin 还要可执行），bind-mount 一类方案被明确
 * 排除。实践上这些写入与用户自己跑一次测试产生的是同一类东西。
 *
 * 建不出来就回 false，由调用方退回深拷——权限、跨设备、文件系统不支持都走这条路，门禁不因此失败。
 */
export async function borrowDependency(root: string, target: string, dep: string,
  dependencies: string[]): Promise<BorrowMode | false> {
  const destination = join(target, dep);
  await mkdir(dirname(destination), { recursive: true });
  const links = await workspaceLinks(root, dep, dependencies);
  if (links.length === 0) return await linkWhole(join(root, dep), destination) ? "link" : false;
  if (await materializeBorrow(root, target, dep, links)) return "materialized";
  await rm(destination, { recursive: true, force: true });
  return false;
}

/**
 * 借用这一侧的对账。返回第一处不一致的说明，全都对就回 null。
 *
 * 不能拿「重算一遍摘要」对账——借用之后两边读的是同一份文件，摘要恒等，它证明不了任何事。落点
 * 才是唯一能对的账，而且两种形态要对的是**两件相反的事**：整条借出去时，那条链必须正好落在工作
 * 区那个依赖目录上；物化之后，workspace 链接必须落在**快照自己**那份源码上（这正是物化的全部
 * 理由，对错了就等于 monorepo 没被隔离，而它不会以任何别的方式报出来）。
 */
export async function borrowMismatch(root: string, target: string, dep: string,
  dependencies: string[], mode: BorrowMode): Promise<string | null> {
  if (mode === "link") {
    const landing = await realpath(join(target, dep)).catch(() => null);
    const expected = await realpath(join(root, dep)).catch(() => null);
    return landing !== null && landing === expected ? null : `${dep} 的借用链没有落在工作区那一份上`;
  }
  const realRoot = await realpath(root).catch(() => root);
  for (const rel of await workspaceLinks(root, dep, dependencies)) {
    const source = await realpath(join(root, dep, rel)).catch(() => null);
    if (source === null) continue;
    const landing = await realpath(join(target, dep, rel)).catch(() => null);
    const expected = await realpath(join(target, relative(realRoot, source))).catch(() => null);
    if (landing === null || expected === null || landing !== expected) {
      return `${join(dep, rel)} 指着项目自己的源码，但快照里它没有落在快照那一份上`;
    }
  }
  return null;
}

/**
 * 借用建不出来时的退路：把依赖目录照原样复制一遍。
 *
 * 不走 gateTreeDigest：那条路对**树外**的可达链是「跟随并把目标内容冻进快照」（源码外链该那么
 * 办），用在依赖目录上会把 .venv/bin/python -> /opt/homebrew/... 指向的整个解释器拷进来。这里
 * 一律按链重建、绝不跟随，原文逐字照抄（照抄的理由见 accept-gate-tree 的 copyLink 上方）。
 *
 * 退路的已知代价：依赖目录里那些指向**依赖目录之外**的树内链（node_modules -> ../.local-deps
 * 这种形状）在副本里会断——借用模式下它们还在原地所以解析得通，深拷就只拷了这一个目录。换句话
 * 说退路只保证「这个目录本身在快照里」，不保证它的树内链闭包。真走到这条路的环境（建不出
 * junction 也建不出目录软链）本来也装不起这些依赖，所以不为它再补一套闭包机器。
 */
export async function copyTree(source: string, destination: string): Promise<void> {
  // 包管理器随时在改依赖树：读完目录到读条目之间文件被删掉不该崩掉整次快照。
  const info = await lstat(source).catch(() => null);
  if (info === null) return;
  if (info.isSymbolicLink()) return await copyLink(source, destination, await readlink(source));
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const name of (await readdir(source)).sort()) {
      await copyTree(join(source, name), join(destination, name));
    }
    return;
  }
  if (!info.isFile()) return;
  await copyFile(source, destination);
  await chmod(destination, info.mode);
}
