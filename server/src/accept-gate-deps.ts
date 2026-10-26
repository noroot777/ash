import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, readlink, realpath, symlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { copyLink, insideTree } from "./accept-gate-tree.js";

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
export type WorkspacePackages = { dirs: string[]; names: string[] };

/**
 * glob 展开。只认 npm / yarn / pnpm 实际写得出的那几种：字面目录、`前缀/*`、`前缀/**`。
 *
 * `**` 往下找有 package.json 的目录，深度上限 6 层——再深的 monorepo 没见过，而无上限的递归会在
 * 手铺的奇怪目录上变成全盘遍历。路径中段带通配（`a/*​/c`）不支持：npm 文档里没有这种写法。
 */
async function expandPattern(root: string, pattern: string): Promise<string[]> {
  const clean = pattern.replace(/\\/g, "/").replace(/\/+$/, "");
  const match = /^(.*?)\/?(\*\*?)$/.exec(clean);
  if (match === null) return (await exists(join(root, clean, "package.json"))) ? [clean] : [];
  const [, prefix, stars] = match;
  const found: string[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    for (const entry of await readdir(join(root, rel), { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || DEPENDENCY_DIRS.includes(entry.name)) continue;
      const next = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (await exists(join(root, next, "package.json"))) found.push(next);
      else if (stars === "**" && depth < 6) await walk(next, depth + 1);
    }
  };
  await walk(prefix, 0);
  return found;
}

export async function workspacePackages(root: string): Promise<WorkspacePackages> {
  const patterns = new Set<string>();
  const raw = await readFile(join(root, "package.json"), "utf8").catch(() => null);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as { workspaces?: unknown };
      const list = Array.isArray(parsed.workspaces)
        ? parsed.workspaces
        : (parsed.workspaces as { packages?: unknown } | undefined)?.packages;
      for (const pattern of Array.isArray(list) ? list : []) {
        if (typeof pattern === "string" && !pattern.startsWith("!")) patterns.add(pattern);
      }
    } catch { /* package.json 坏了不是门禁要管的事，当没声明处理 */ }
  }
  // pnpm 的声明在单独一份 YAML 里。不引 YAML 解析器：这里只要列表项那几行，多解析出几条无害
  // （下一步按「有没有 package.json」筛掉，pnpm-workspace.yaml 里别的键下面的列表项过不了这一
  // 关），漏解析才有害。
  const pnpm = await readFile(join(root, "pnpm-workspace.yaml"), "utf8").catch(() => null);
  for (const line of pnpm?.split(/\r?\n/) ?? []) {
    const item = /^\s*-\s*["']?([^"'#]+?)["']?\s*$/.exec(line);
    if (item !== null && !item[1].startsWith("!")) patterns.add(item[1]);
  }
  const dirs = new Set<string>();
  for (const pattern of patterns) {
    for (const dir of await expandPattern(root, pattern)) dirs.add(dir);
  }
  const names = new Set<string>();
  for (const dir of dirs) {
    const content = await readFile(join(root, dir, "package.json"), "utf8").catch(() => null);
    if (content === null) continue;
    try {
      const name = (JSON.parse(content) as { name?: unknown }).name;
      if (typeof name === "string" && name !== "") names.add(name);
    } catch { /* 同上 */ }
  }
  return { dirs: [...dirs].sort(), names: [...names].sort() };
}

/**
 * 这个依赖目录需要在快照里独立成一份吗。
 *
 * 只有 node 生态把 workspace 包**连进**依赖树（node_modules/<包名> -> 源码目录），于是整条借出去
 * 就等于没隔离（三个入口见顶部）。Go 的 vendor 是实拷、Rust 的 target 是构建产物、Python 的
 * editable install 走文件内容（顶部「检不出的同类问题」），都没有这个形状，照旧 O(1) 借用。
 */
export function needsIsolation(dep: string, workspace: WorkspacePackages): boolean {
  return workspace.names.length > 0 && basename(dep) === "node_modules";
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
 * 在快照里放上这份依赖。
 *
 * **写入外溢**（只发生在借用形态，也就是没声明 workspace 包的项目）：门禁跑测试时写进依赖目录的
 * 东西落在**用户的工作区**里——vite 的 node_modules/.vite、各种 .cache、Rust 的 target 增量编译
 * 都会。这里选择接受并写明，因为另一头做不到：改权限变成只读等于动用户的工作区（而且 .bin 还要
 * 可执行），bind-mount 一类方案被明确排除。实践上这些写入与用户自己跑一次测试产生的是同一类
 * 东西。克隆形态没有这个问题——快照有自己的一棵树。
 *
 * 借用建不出来就回 false，由调用方退回深拷（copyTree）——权限、跨设备、文件系统不支持都走这条
 * 路，门禁不因此失败。
 */
export async function provideDependency(root: string, target: string, dep: string,
  isolate: boolean): Promise<DependencyMode | false> {
  const destination = join(target, dep);
  await mkdir(dirname(destination), { recursive: true });
  const from = join(root, dep);
  const landing = await realpath(from).catch(() => null);
  if (landing === null) {
    // 不可达的依赖根：没装的可选依赖、指向还没建起来的目录的悬空链、环。它在快照里**照原样**
    // 重建（是链就建同原文的一条悬空链，什么都没有就什么都不建），于是「本来跑不通」在副本里
    // 仍然跑不通——而不是让整次快照失败。悬空链不该拖垮一次快照，这条在上一层就定过。
    const info = await lstat(from).catch(() => null);
    if (info !== null && info.isSymbolicLink()) await copyLink(from, destination, await readlink(from));
    return "absent";
  }
  // 根自己是链时按**落点**来：借用要指到真正那棵树上（junction 只认真实路径），克隆更要从那棵树
  // 开始拷——否则副本里仍是一条指向外面的链，解析根照旧在快照外，三个入口一个都没修掉。
  if (!isolate) return await linkWhole(landing, destination) ? "link" : false;
  const realRoot = await realpath(root).catch(() => root);
  await copyTree(landing, destination, { clone: true, rewrite: { realRoot, target } });
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
 *   · clone：依赖根必须落在快照内（证明树真的独立了），**而且**每个声明过的 workspace 包在快照
 *     里都解析到快照自己那份源码。后半句是克隆的全部理由，对错了就等于 monorepo 没被隔离，而它
 *     不会以任何别的方式报出来。
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
  return null;
}

export type CopyOptions = {
  /** 数据块共享（macOS clonefile / Linux reflink）。内核在不支持的文件系统上自动退回整块复制。 */
  clone?: boolean;
  /** 绝对原文指着项目内时，改写到快照里对应的位置。 */
  rewrite?: { realRoot: string; target: string };
};

// 绝对原文**指着项目内**时改写到快照里对应的位置：Windows 的 npm 给 workspace 包建的是绝对
// junction，照抄会让快照里的包解析回活动工作区——正是克隆要防的那件事。相对原文一律照抄，它在
// 快照里天然解析到快照自己那份。落在项目外的绝对原文（.venv/bin/python -> /opt/homebrew/…）也
// 照抄：那是系统的东西，不是这次要冻的源码。
async function rewritten(source: string, destination: string, options: CopyOptions): Promise<string> {
  const raw = await readlink(source);
  const rewrite = options.rewrite;
  if (rewrite === undefined || !isAbsolute(raw)) return raw;
  // 原文是字面路径、realRoot 是 realpath 过的：不把两边化到同一个口径，macOS 的
  // /var -> /private/var 这类别名会让 insideTree 永远判否。末段不解析——它可能本来就是悬空的。
  const landing = join(await realpath(dirname(raw)).catch(() => dirname(raw)), basename(raw));
  if (!insideTree(rewrite.realRoot, landing)) return raw;
  return relative(dirname(destination), join(rewrite.target, relative(rewrite.realRoot, landing)));
}

/**
 * 把一棵树复制一遍：克隆形态的实现，同时是借用建不出来时的退路。
 *
 * 不走 gateTreeDigest：那条路对**树外**的可达链是「跟随并把目标内容冻进快照」（源码外链该那么
 * 办），用在依赖目录上会把 .venv/bin/python -> /opt/homebrew/… 指向的整个解释器拷进来。这里
 * 一律按链重建、绝不跟随，原文照抄或按 rewritten 改写。
 *
 * 已知代价：依赖目录里那些指向**依赖目录之外**的树内链（node_modules -> ../.local-deps 这种形状）
 * 在副本里会断——借用模式下它们还在原地所以解析得通，复制就只覆盖了这一个目录。换句话说这里只
 * 保证「这棵树在快照里」，不保证它的树内链闭包。
 */
export async function copyTree(source: string, destination: string, options: CopyOptions = {}): Promise<void> {
  // 包管理器随时在改依赖树：读完目录到读条目之间文件被删掉不该崩掉整次快照。
  const info = await lstat(source).catch(() => null);
  if (info === null) return;
  if (info.isSymbolicLink()) return await copyLink(source, destination, await rewritten(source, destination, options));
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const name of (await readdir(source)).sort()) {
      await copyTree(join(source, name), join(destination, name), options);
    }
    return;
  }
  if (!info.isFile()) return;
  await copyFile(source, destination, options.clone === true ? constants.COPYFILE_FICLONE : 0);
  await chmod(destination, info.mode);
}
