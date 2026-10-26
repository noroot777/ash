import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, readlink, realpath, symlink } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { copyLink } from "./accept-gate-tree.js";

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

/**
 * 在快照里放一条指向工作区那份依赖的链。
 *
 * Win32 用 junction：普通目录软链要 SeCreateSymbolicLinkPrivilege（没开开发者模式就建不出来），
 * junction 不要，pnpm 用的也是它，而且 node 把 junction 同样报成 isSymbolicLink()。junction 只
 * 认绝对路径，所以两个平台统一写绝对路径——快照和项目的目录深度本来就不同，相对原文没有意义。
 *
 * **写入外溢**：借用意味着门禁跑测试时写进去的东西落在**用户的工作区**里——vite 的
 * node_modules/.vite、各种 .cache、Rust 的 target 增量编译都会。这里选择接受并写明，因为另一头
 * 做不到：改权限变成只读等于动用户的工作区（而且 .bin 还要可执行），bind-mount 一类方案被明确
 * 排除。实践上这些写入与用户自己跑一次测试产生的是同一类东西。
 *
 * 建不出链就回 false，由调用方退回深拷——权限、跨设备、文件系统不支持都走这条路，门禁不因此失败。
 */
export async function borrowDependency(root: string, target: string, dep: string): Promise<boolean> {
  const destination = join(target, dep);
  await mkdir(dirname(destination), { recursive: true });
  try {
    await symlink(join(root, dep), destination, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch { return false; }
}

/**
 * 借用这一侧的对账：这条链到底落在哪。
 *
 * 不能再拿「重算一遍摘要」对账——借用之后两边读的是同一份文件，摘要恒等，它证明不了任何事。
 * 落点才是唯一能对的账：链在、而且 realpath 正好是工作区那个依赖目录。返回 null 表示它不是一
 * 条链（深拷退路走到了，由调用方按老办法回算）。
 */
export async function borrowedLanding(target: string, dep: string): Promise<string | null> {
  const path = join(target, dep);
  if (!(await lstat(path).catch(() => null))?.isSymbolicLink()) return null;
  return await realpath(path).catch(() => null);
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
