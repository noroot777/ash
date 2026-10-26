import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, readlink, realpath, rm, symlink } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { copyLink, insideTree } from "./accept-gate-tree.js";
import { copyTree, linkMismatch, type OwnedPackage, type Relocation } from "./accept-gate-relocate.js";

// 门禁快照冻住的是**源码**；依赖是 lockfile 的产物，按产物对待。
//
// 为什么不逐文件深拷：本仓一份 node_modules = 563 MB / 45490 文件 / 37 条软链（2026-10-26 实测），
// 而旧实现每次门禁至少三遍全量摘要（登记一遍、边拷边算一遍、对账再算一遍）。同一天在本仓实测的
// 数字：全量字节摘要**一遍** 6892 ms（三遍 ≈ 20.7 s，深拷那 563 MB 的 I/O 还在这之外），换成
// 安装声明后 <1 ms。摘要这一头的成本因此已经消掉了，剩下的只是「副本怎么放」。
//
// 副本有两种放法，判据是**项目有没有声明 workspace 包**（needsIsolation）：
//
// ① 没声明 —— 一条链整条借出去，O(1)（本仓实测 23 ms）。依赖不是源码，它在哪解析都一样。
//    代价是写入外溢，写在 provideDependency 上方。
//
// ② 声明了 —— 整棵克隆（copyFile 的 COPYFILE_FICLONE，macOS clonefile / Linux reflink，
//    内核在不支持的文件系统上自动退回整块复制）。本仓实测 9779 ms，实际占用 16 MB（对照：同一
//    棵树不带数据块共享是 5040 ms / 684 MB，所以这一项换的是「慢一倍、省 98% 空间」）。Windows
//    没有对应物，node 会退回普通复制，那台机器上就是真拷 684 MB——慢且占地方，但正确。
//
// 为什么 monorepo 必须克隆、借用不够（这一节是 2026-10-26 独立审查实测打回来的结论，三个入口都
// 有复现）：借用意味着**链那一侧的所有解析都发生在工作区**，而 node 的模块解析走 realpath。于是
//   · node_modules/.bin/demo-cli -> ../@demo/lib/cli.mjs：整条 .bin 借出去，CLI 从工作区的 .bin
//     位置解析，落在活的工作区包上。workspace 包声明 bin 是最普通的形状。
//   · 被借包的传递导入：node_modules/plain/index.mjs 里 `from "@demo/lib"`，plain 的 realpath 在
//     工作区，于是它按工作区的包映射解析，照样落在活的源码上。
//   · 整个 node_modules 指向**另一个检出**（worktree 借主仓那份，本仓就是这个形状）：主仓的
//     @ash/shared -> ../../shared 落在主仓源码上，于是快照里跑的是**主仓的旧代码**，而任务自己
//     的源码明明已经checkout 在快照里。这一条不需要任何并发修改就会把错的代码判成通过。
// 三条的共同根因是一个：**只要依赖树的解析根还在快照外，源码隔离就是空话**。靠「枚举指回源码的
// 链再逐条重定向」补不上——枚举只要漏一层就会把一份没隔离的副本判成合格，而 .bin 的 shim 和被借
// 包的传递导入恰好都在枚举不到的地方。克隆把解析根搬进快照，三条一起消失：目录项在快照里，相对
// 原文在快照内解析，文件是真文件所以 realpath 也在快照内。
//
// 这同时推翻了上一版在这里写下的「选链、不选 reflink」论证。那段的理由是「reflink 省不掉那几遍
// 摘要」——摘要换成安装声明之后这个前提就不成立了，而它当时掩盖了真正的代价（源码没被隔离）。
// 保留这段记述是为了说明判断为什么反转，不是为了留一份旧结论。
//
// **检不出的同类问题**：Python 的 editable install（`pip install -e`）把项目源码路径写成
// site-packages 里一个 .pth / .egg-link 的**文件内容**（绝对路径），不是软链。克隆照抄文件内容
// = 照抄那条绝对路径，所以它仍然指回工作区；深拷**也一样**，这不是这一层引入的。要修得重写文件
// 内容，属于另一类工程，这一层不碰，写在这里是为了别让下一个人以为它已经被覆盖了。
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
  // 不可达的依赖根（没装的可选依赖、指向还没建起来的目录的悬空链、环）有自己的身份，不跟「空
  // 目录」混成同一个摘要：它指向哪里也算进去，于是「悬空链被改指到别处」「装好了」都会改摘要。
  if (await realpath(path).catch(() => null) === null) {
    return hash.update("unreachable\0").update(await readlink(path).catch(() => "")).digest("hex");
  }
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
 * 项目**声明**的 workspace 包：目录（相对项目根）与包名。
 *
 * 判据只认声明，不认「扫一遍依赖目录看哪些链指着源码」。理由见顶部：扫描漏一层就会把没隔离的
 * 副本判成合格，而声明是项目自己写下的、不随安装状态变化的那一份事实。
 */
export type WorkspacePackages = {
  /** 展开出来的包目录（相对项目根）。可能不完整——判据不靠它，见 declared。 */
  dirs: string[];
  /** 展开出来的包名。dependencyMismatch 用它证明隔离。 */
  names: string[];
  /**
   * 项目**声明过** workspace 包吗。
   *
   * 这是隔离决策唯一的判据，而不是 `names.length > 0`。2026-10-26 独立审查用真实 npm 离线安装打
   * 回来过：`packages/*​/core` 这种中段带通配的声明 npm 认、照样装出 workspace 链，而上一版的
   * 展开只处理末段通配，于是 names 为空 → 判成「没有 workspace」→ 整条借用 → 快照跑的是活的
   * 工作区源码（快照文件本身是 FROZEN，执行输出却是 LIVE，而且验后自证照旧通过）。
   *
   * 「展开不出包名」绝不是「这个项目没有 workspace 包」的证明。所以三态要分开：没声明（借用）、
   * 声明了（隔离，不管展开出多少）、声明坏了（也算声明了，往安全那一侧倒）。
   */
  declared: boolean;
};

const DECLARED_GLOB_DEPTH = 8;

/**
 * glob 展开：按段匹配，`*` 吃一段内的任意字符，`**` 吃任意层数，两者都可出现在**任何位置**。
 *
 * 上一版只认末段通配（`packages/*`、`packages/**`），中段的 `packages/*​/core` 被当成字面路径 —— npm
 * 实际接受这种写法，实测见 declared 上方。深度上限 DECLARED_GLOB_DEPTH 层：无上限的 `**` 递归会
 * 在手铺的奇怪目录上变成全盘遍历。
 */
async function expandPattern(root: string, pattern: string): Promise<string[]> {
  const segments = pattern.replace(/\\/g, "/").split("/").filter(part => part !== "" && part !== ".");
  if (segments.length === 0) return [];
  const found = new Set<string>();
  const children = async (rel: string): Promise<string[]> =>
    (await readdir(join(root, rel), { withFileTypes: true }).catch(() => []))
      .filter(entry => entry.isDirectory() && !entry.name.startsWith(".") && !DEPENDENCY_DIRS.includes(entry.name))
      .map(entry => entry.name);
  const walk = async (rel: string, index: number, depth: number): Promise<void> => {
    if (index === segments.length) {
      if (rel !== "" && await exists(join(root, rel, "package.json"))) found.add(rel);
      return;
    }
    const segment = segments[index];
    if (segment === "**") {
      // `**` 可以吃零层,所以先原地往后匹配,再逐层下探。
      await walk(rel, index + 1, depth);
      if (depth >= DECLARED_GLOB_DEPTH) return;
      for (const name of await children(rel)) await walk(join(rel, name), index, depth + 1);
      return;
    }
    if (!segment.includes("*")) return await walk(join(rel, segment), index + 1, depth);
    const pieces = segment.split("*").map(piece => piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const matches = new RegExp(`^${pieces.join("[^/]*")}$`);
    for (const name of await children(rel)) {
      if (matches.test(name)) await walk(join(rel, name), index + 1, depth);
    }
  };
  await walk("", 0, 0);
  return [...found];
}

export async function workspacePackages(root: string): Promise<WorkspacePackages> {
  const patterns = new Set<string>();
  let declared = false;
  const raw = await readFile(join(root, "package.json"), "utf8").catch(() => null);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as { workspaces?: unknown };
      const list = Array.isArray(parsed.workspaces)
        ? parsed.workspaces
        : (parsed.workspaces as { packages?: unknown } | undefined)?.packages;
      if (parsed.workspaces !== undefined && parsed.workspaces !== null) declared = true;
      for (const pattern of Array.isArray(list) ? list : []) {
        if (typeof pattern === "string" && !pattern.startsWith("!")) patterns.add(pattern);
      }
    } catch {
      // package.json 读不出来时**不能**当成「没声明」:那会把一个可能有 workspace 的项目降级成
      // 借用。坏掉的 package.json 本来就跑不了测试,往隔离那一侧倒最多是多花一次克隆。
      declared = true;
    }
  }
  // pnpm 的声明在单独一份 YAML 里。不引 YAML 解析器:这里只要列表项那几行,解析得全不全不影响
  // 隔离决策(文件存在就算声明过),只影响 dirs 的完整度。
  const pnpm = await readFile(join(root, "pnpm-workspace.yaml"), "utf8").catch(() => null);
  if (pnpm !== null) declared = true;
  for (const line of pnpm?.split(/\r?\n/) ?? []) {
    const item = /^\s*-\s*["']?([^"'#]+?)["']?\s*$/.exec(line);
    if (item !== null && !item[1].startsWith("!")) patterns.add(item[1]);
    // 行内列表 `packages: ["a", "b"]`:同一行里把引号括起来的项都收进来。
    const inline = /^\s*(?:packages)?\s*:\s*\[(.+)\]\s*$/.exec(line);
    for (const piece of inline?.[1].split(",") ?? []) {
      const value = piece.trim().replace(/^["']|["']$/g, "");
      if (value !== "" && !value.startsWith("!")) patterns.add(value);
    }
  }
  const dirs = new Set<string>();
  for (const pattern of patterns) {
    for (const dir of await expandPattern(root, pattern)) dirs.add(dir);
  }
  // 只为算出 names。**不作为身份**导出:后缀相同、包名相同都不等于来源相同,改写归属一律
  // 走安装记录(ownedLinks)。
  const identity: Record<string, string> = {};
  for (const dir of dirs) {
    const content = await readFile(join(root, dir, "package.json"), "utf8").catch(() => null);
    if (content === null) continue;
    try {
      const name = (JSON.parse(content) as { name?: unknown }).name;
      if (typeof name === "string" && name !== "") identity[dir] = name;
    } catch { /* 同上 */ }
  }
  return {
    dirs: [...dirs].sort(),
    names: [...new Set(Object.values(identity))].sort(),
    declared,
  };
}

/**
 * 这个依赖目录需要在快照里独立成一份吗。
 *
 * 判据是**声明过**，不是「展开出了包名」——理由写在 WorkspacePackages.declared 上方。
 *
 * 只有 node 生态把 workspace 包**连进**依赖树（node_modules/<包名> -> 源码目录），于是整条借出去
 * 就等于没隔离（三个入口见顶部）。Go 的 vendor 是实拷、Rust 的 target 是构建产物、Python 的
 * editable install 走文件内容（顶部「检不出的同类问题」），都没有这个形状，照旧 O(1) 借用。
 */
export function declaresWorkspace(dep: string, workspace: WorkspacePackages): boolean {
  return workspace.declared && basename(dep) === "node_modules";
}

/**
 * 这棵依赖树里有链落在**项目源码**上吗？有就不能整条借出去。返回第一条这样的链（给说明用）。
 *
 * 判据必须是落点，不能是声明。`workspaces` 只是本地包进入依赖树的若干种写法之一：
 * `"aliased": "file:./packages/lib"`、`npm link`、lerna bootstrap、pnpm 的 `link:` 都会建出
 * `node_modules/<目录项名> -> <项目内的包目录>`，而**目录项名可以和包名毫无关系**。实测反例：
 * 别名依赖在旧判据下 `declared=false` → 整条借出去 → 快照里那条路径穿回工作区 → 跑的是活的
 * 工作区源码；快照建好之后改一行源码，同一份快照的执行输出当场跟着变，而自证仍为真。
 *
 * 曾经的论证是「扫描漏一层就会把没隔离的副本判成合格，所以只认声明」。但声明同样覆盖不全，
 * 区别只是漏法不同——而声明的漏法永远落后于包管理器的新写法，扫描的漏法可以靠「走遍每一个
 * 条目」消掉。这里不跟随链递归（每条链只算自己的落点，因此不会成环），遍历量就是树的条目数：
 * 本仓 47501 条目 / 1975 目录 / 37 条链，实测 166 ms，对照旧的全量字节摘要一遍 6892 ms。
 */
export async function linksIntoSource(treeRoot: string, realRoot: string): Promise<string | null> {
  const walk = async (sub: string): Promise<string | null> => {
    for (const entry of await readdir(join(treeRoot, sub), { withFileTypes: true }).catch(() => [])) {
      const path = sub === "" ? entry.name : join(sub, entry.name);
      if (entry.isSymbolicLink()) {
        const landing = await realpath(join(treeRoot, path)).catch(() => null);
        // 落在树内部的链是正常的（包之间互相引用）；落在项目源码上的才是「借出去就等于没隔离」。
        if (landing !== null && insideTree(realRoot, landing) && !insideTree(treeRoot, landing)) return path;
      } else if (entry.isDirectory()) {
        const found = await walk(path);
        if (found !== null) return found;
      }
    }
    return null;
  };
  return await walk("");
}

/** 副本的形态：整条借一条链、整棵克隆、或者源端本来就不可达。 */
export type DependencyMode = "link" | "clone" | "absent";

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
 * 搬迁这棵依赖树时的落点口径。**构造和对账必须共用这一份**，否则就是复制那一侧自己猜、对账那一
 * 侧另一套判据——2026-10-26 独立审查打回的三处链接失败都是这么来的。
 */
export async function relocationFor(root: string, target: string, dep: string): Promise<Relocation | null> {
  const treeRoot = await realpath(join(root, dep)).catch(() => null);
  if (treeRoot === null) return null;
  return {
    realRoot: await realpath(root).catch(() => root),
    target,
    treeRoot,
    treeDest: join(target, dep),
    owned: await ownedLinks(treeRoot, dep),
  };
}

/**
 * 安装记录认下的自有包：`.package-lock.json` 里每条 link 条目的 resolved 指到项目内哪个目录。
 *
 * 这是**来源身份**的唯一出处。npm 把 workspace 包和 `file:` 依赖都装成链，两者在路径形状和
 * package.json.name 上可以完全一样（实测反例见 accept-gate-relocate 顶部①），区别只在这一处：
 * workspace 包的 resolved 是项目内相对路径（`packages/lib`），`file:` 依赖的 resolved 指向项目
 * 外。所以判据是 resolved 落在项目内，而不是路径后缀或包名。
 *
 * 读不到记录就回空：那时一条都不改写。「不改写」在隔离失效时会被 linkMismatch 当场抓住并让门禁
 * 失败，而「改错」是把被测代码换成另一份还报绿——两种错的代价差着一个量级。
 *
 * pnpm/yarn 的 workspace 链是相对链、落点就在项目内，counterpart 的「项目源码」那一支本来就接
 * 住了，不靠这里。这里要管的是落点在项目**外**的那种：依赖树借自另一个检出（Windows 的 npm 把
 * workspace 链建成绝对 junction，指的就是那个检出的源码）。
 */
export async function ownedLinks(treeRoot: string, dep: string): Promise<OwnedPackage[]> {
  const raw = await readFile(join(treeRoot, ".package-lock.json"), "utf8").catch(() => null);
  if (raw === null) return [];
  let packages: Record<string, unknown> = {};
  try {
    packages = (JSON.parse(raw) as { packages?: Record<string, unknown> }).packages ?? {};
  } catch { return []; }
  const projectRoot = await realpath(dirname(treeRoot)).catch(() => dirname(treeRoot));
  // 键前缀取**登记名**而不是 realpath 后的 basename:依赖根自己是条链时(pnpm 的
  // `node_modules -> .store` 就是这个形状)realpath 后的 basename 是 `.store`,拼出来的前缀
  // 匹配不上记录里的 `node_modules/…`,整棵树的归属改写会一声不响地全部失效。
  const prefix = `${basename(dep).split(sep).join("/")}/`;
  const owned: OwnedPackage[] = [];
  for (const [key, value] of Object.entries(packages)) {
    const record = value as { link?: unknown; resolved?: unknown };
    if (record.link !== true || typeof record.resolved !== "string" || !key.startsWith(prefix)) continue;
    const where = resolve(projectRoot, record.resolved);
    if (!insideTree(projectRoot, where) || where === projectRoot) continue;
    const landing = await realpath(where).catch(() => null);
    if (landing === null) continue;
    owned.push({ entry: key.slice(prefix.length), inside: record.resolved.split("/").join(sep), landing });
  }
  return owned;
}

/**
 * 在快照里放上这份依赖。
 *
 * **写入外溢**（只发生在借用形态，也就是没声明 workspace 包的项目）：门禁跑测试时写进依赖目录的
 * 东西落在**用户的工作区**里——vite 的 node_modules/.vite、各类 .cache、Rust 的 target 增量编译
 * 都会。这里选择接受并写明，因为另一头做不到：改权限变成只读等于动用户的工作区（而且 .bin 还要
 * 可执行），bind-mount 一类方案被明确排除。实践上这些写入与用户自己跑一次测试产生的是同一类
 * 东西。克隆形态没有这个问题——快照有自己的一棵树。
 *
 * `skip` 是源码侧那份排除计划，克隆和深拷退路都要用它：运行产物目录可配，它落在依赖目录内时遍历
 * 会走进正在建的快照自己（见 copyTree 里那条「目标不进入输入闭包」）。
 *
 * 借用建不出来就回 false，由调用方退回深拷——权限、跨设备、文件系统不支持都走这条路，门禁不因此
 * 失败。
 */
export async function provideDependency(root: string, target: string, dep: string,
  workspace: WorkspacePackages, skip?: (path: string) => boolean): Promise<DependencyMode> {
  const destination = join(target, dep);
  await mkdir(dirname(destination), { recursive: true });
  const from = join(root, dep);
  const relocation = await relocationFor(root, target, dep);
  if (relocation === null) {
    // 不可达的依赖根：没装的可选依赖、指向还没建起来的目录的悬空链、环。它在快照里**照原样**
    // 重建（是链就建同原文的一条悬空链，什么都没有就什么都不建），于是「本来跑不通」在副本里
    // 仍然跑不通——而不是让整次快照失败。悬空链不该拖垮一次快照，这条在上一层就定过。
    const info = await lstat(from).catch(() => null);
    if (info !== null && info.isSymbolicLink()) await copyLink(from, destination, await readlink(from));
    return "absent";
  }
  // 根自己是链时按**落点**来：借用要指到真正那棵树上（junction 只认真实路径），克隆更要从那棵树
  // 开始拷——否则副本里仍是一条指向外面的链，解析根照旧在快照外，三个入口一个都没修掉。
  // 放法的判据是**落点**:这棵树里只要有一条链落在项目源码上,借出去就等于没隔离(理由与实测
  // 见 linksIntoSource)。声明过 workspace 的仍然直接克隆——那是项目自己写明的意图,不必等扫描。
  const offender = await linksIntoSource(relocation.treeRoot, relocation.realRoot);
  if (offender === null && !declaresWorkspace(dep, workspace)
    && await linkWhole(relocation.treeRoot, destination)) return "link";
  // 借用建不出来(权限、跨设备、文件系统不支持)时同样走克隆,而不是退回一条「不对账的深拷」:
  // 那条旧退路既没开数据块共享(本仓一次多拷 684 MB)、也不登记进 provided,于是一个字都不对账,
  // 静默交出一份没隔离的副本。克隆是正确的放法,代价只是慢一点。
  await copyTree(relocation.treeRoot, destination, {
    clone: true,
    relocate: relocation,
    skip,
    snapshotRoot: await realpath(target).catch(() => target),
  });
  return "clone";
}

/**
 * 副本这一侧的对账。返回第一处不一致的说明，全都对就回 null。
 *
 * 不能拿「重算一遍摘要」对账：借用之后两边读的是同一份文件，摘要恒等，它证明不了任何事。落点才是
 * 唯一能对的账，而三种形态要对的是三件不同的事——
 *   · link：那条链必须正好落在工作区那个依赖目录上；
 *   · absent：源端解析不出东西来，副本侧也必须解析不出来（而不是要求两边都非空，那会把一个合法
 *     状态判成复制失败，于是一个没装的可选依赖就能拖垮整次快照）；
 *   · clone：依赖根落在快照内（树真的独立了）、每个声明过的 workspace 包都解析到快照自己那份
 *     源码、**而且**整棵树的链闭包逐条落点等价（linkMismatch）。前两条都只看根和顶层，证不了
 *     树里每条链还指得对——猜错包身份、吃掉尾部分隔符、把相对外链照抄到不同深度都能从那里漏过去。
 *
 * 调用方必须在源码和依赖**都构造完**之后才调：clone 形态要解析快照里的 workspace 包，那条路径
 * 要等源码落盘；非 Git 分支曾经在源码之前对账，于是任何 monorepo 都会在门禁开跑前就失败。
 */
export async function dependencyMismatch(root: string, target: string, dep: string,
  mode: DependencyMode, workspace: WorkspacePackages): Promise<string | null> {
  const copy = join(target, dep);
  const landing = await realpath(copy).catch(() => null);
  if (mode === "absent") {
    return landing === null ? null : `${dep} 在工作区里解析不出东西来，快照里却落在了 ${landing}`;
  }
  if (mode === "link") {
    const expected = await realpath(join(root, dep)).catch(() => null);
    return landing !== null && landing === expected ? null : `${dep} 的借用链没有落在工作区那一份上`;
  }
  const realTarget = await realpath(target).catch(() => target);
  if (landing === null || !insideTree(realTarget, landing)) {
    return `${dep} 没有在快照里落成独立的一份（落点 ${landing ?? "解析不出来"}）`;
  }
  for (const name of workspace.names) {
    const resolved = await realpath(join(copy, name)).catch(() => null);
    if (resolved !== null && !insideTree(realTarget, resolved)) {
      return `${join(dep, name)} 在快照里解析到了 ${resolved}，不是快照自己那份源码`;
    }
  }
  const relocation = await relocationFor(root, target, dep);
  if (relocation === null) return `${dep} 在工作区里已经解析不出来了，无法核对副本的链落点`;
  const problem = await linkMismatch(relocation);
  return problem === null ? null : `${dep} 里 ${problem}`;
}

export { copyTree } from "./accept-gate-relocate.js";

/** 这个目录上摆的包叫什么。读不出来（没有、坏了、没有 name）就回 null。 */
async function manifestName(root: string): Promise<string | null> {
  const raw = await readFile(join(root, "package.json"), "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    const name = (JSON.parse(raw) as { name?: unknown }).name;
    return typeof name === "string" && name !== "" ? name : null;
  } catch { return null; }
}

/** node 会用哪棵依赖树：从这里一级级往上，第一个真实存在的 `node_modules`。 */
async function nearestTree(start: string): Promise<string | null> {
  let directory = start;
  for (;;) {
    const trunk = await realpath(join(directory, "node_modules")).catch(() => null);
    if (trunk !== null) return trunk;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

/**
 * 一棵依赖树里「属于它自己那个检出的本地包」有哪些：遍历解析入口（顶层 + 一层 scope，workspace
 * 链都在这两层），挑出**落点指回那个检出的源码**的条目。回 `目录项名 → 相对检出根的路径`。
 *
 * 判据是落点，和 linksIntoSource 同一条。不认名字（同名不等于同源，registry 下来的包和项目里
 * 一份同名副本可以并存）、也不扫源码树里的 package.json（源码树里摆着一份同名的包，不等于依赖
 * 树里那个名字就该解析到它）。
 */
async function localPackages(trunk: string, owner: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const scan = async (sub: string, depth: number): Promise<void> => {
    for (const entry of await readdir(join(trunk, sub), { withFileTypes: true }).catch(() => [])) {
      const name = sub === "" ? entry.name : `${sub}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        const landing = await realpath(join(trunk, name)).catch(() => null);
        if (landing !== null && insideTree(owner, landing) && !insideTree(trunk, landing)) {
          found.set(name, relative(owner, landing));
        }
      } else if (entry.isDirectory() && depth === 0 && entry.name.startsWith("@")) {
        await scan(entry.name, depth + 1);
      }
    }
  };
  await scan("", 0);
  return found;
}

/**
 * 让项目自己的包都解析到快照里那份冻结的源码。返回第一处收不住的说明，全都收住就回 null。
 *
 * 这是源码隔离的**收口**：克隆依赖树、改写树内落点都只管快照里已经有的东西，管不到 node 的
 * **向上查找**。快照建在 ash 的运行产物目录里、那个目录通常就在项目内，于是工作区没装依赖时
 * （worktree 的常态）node 从快照一级级往上找，用的是项目主检出那棵树——里面的 workspace 链指着
 * **活的**工作区源码。实测：快照自带 TASK_NEW、执行输出 MAIN_OLD，把工作区改成 MAIN_LIVE 同一份
 * 快照的输出也跟着变，而自证全程为真。
 *
 * 出发点是**那棵树里指回源码的条目**，不是源码树里有哪些 package.json。这个方向上一版搞反了，
 * 代价是两个：
 *   · 工作区装着 registry 下来的 `left-pad`、项目里另有一份 `patches/left-pad` 也叫 left-pad 时，
 *     按名字认会把装好的那个 `rm -r` 删掉换成指向补丁副本的链——**改坏用户的工作区**，而且重装
 *     之前恢复不了；
 *   · 这类项目的门禁一次也过不去：registry 包解析到工作区依赖树本来就是正常的（依赖按安装声明
 *     计身份），把它当成「没隔离的自有包」就只能报错。
 * 按落点认则两条都不成立：registry 包的落点就在那棵树里（不是指回源码），`file:` 外部依赖的落点
 * 在那个检出之外，两者都不是本地包，一个字都不动。
 *
 * 往快照里写之前还要证明落点：`join(target, "node_modules", …)` 是**字面拼接**，而借用形态下
 * `<快照>/node_modules` 本身就是一条指向工作区的链，`rm` 和建链会直接落到用户的工作区里去。
 * 所以先 realpath 那条主干、确认它在快照内（不存在则由我们 mkdir 出一个真目录），证不出来就让
 * 门禁失败。核验全部做完才开始写，不留「改了一半又失败」的状态。
 */
export async function confineOwnPackages(target: string): Promise<string | null> {
  const realTarget = await realpath(target).catch(() => target);
  const trunk = await nearestTree(realTarget);
  // 没有任何依赖树，或者 node 用的就是快照自己那棵（克隆形态）：树内落点由搬迁那一侧负责。
  if (trunk === null || insideTree(realTarget, trunk)) return null;
  const owner = dirname(trunk);
  const plan: { name: string; source: string }[] = [];
  for (const [name, rel] of await localPackages(trunk, owner)) {
    const source = join(target, rel);
    const inSnapshot = await manifestName(source);
    if (inSnapshot === null) {
      return `${name} 会解析到 ${join(owner, rel)}（快照之外的活动源码），而快照里 ${rel} 上没有包，`
        + "无法把它接到被认证的那一份源码上";
    }
    plan.push({ name, source });
  }
  if (plan.length === 0) return null;
  const trunkInSnapshot = join(target, "node_modules");
  const landed = await realpath(trunkInSnapshot).catch(() => null);
  if (landed !== null && !insideTree(realTarget, landed)) {
    return `需要在快照里重新绑定 ${plan.map(item => item.name).join("、")}，`
      + `但快照的 node_modules 落在 ${landed}（快照之外）——往那里写会改到工作区，拒绝`;
  }
  for (const { name, source } of plan) {
    const entry = join(trunkInSnapshot, name);
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
