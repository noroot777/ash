import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { execFileText } from "./exec.js";
import { physicalPath, samePath, worktreePorcelain } from "./git-worktree-state.js";
import { recordedLinks } from "./accept-gate-deps.js";
import { projectSources } from "./accept-gate-project.js";
import { optionalRead } from "./accept-gate-fs.js";
import { insideTree } from "./accept-gate-tree.js";

// 「任务工作区压根没有依赖目录时，这一次的依赖从哪来」。
//
// 这是**标准路径**，不是边角：worktree 全局默认开启，而 `node_modules` 被 gitignore，所以
// 一份新建的任务 worktree 必然是「源码齐全、依赖为零」。
//
// 不补这一块的后果不是「依赖缺失」那么温和，而是**隔离证明必然失败**，链条只有三步：
//   ① 快照自己没有依赖树；
//   ② node 于是按**快照所在位置**一级级往上找 —— 那是 `ASH_RUNS_DIR` 的落点，一个与被测项目
//      毫无语义关系的偶然位置（默认 `<仓库>/data/runs/<任务>/`，于是祖先链正好经过主检出的
//      `node_modules`）；
//   ③ 解析根落在快照之外，`confineOwnPackages` 的不变量③（消费者闭包）于是**正确地**拒绝：
//      主检出那棵树里既摆着本项目自己的包、又摆着第三方包，往快照根补的绑定管不到那些第三方包
//      自己向上解析的那一条边。
//
// 所以根因在①，②③都是下游。两例现场（`data/runs/pSOUguRfv-Ie`、`data/runs/W54czudPJ9Q9`）都停在
// ③，而③的说明里那条「把 ASH_RUNS_DIR 移出解析祖先链」实测**不是**出路：移出去之后②的偶然继承
// 也一并消失，快照里一个包都解析不到，门禁从「证明不了隔离」变成「找不到模块」—— 同样是红的，
// 而且在非 monorepo 项目上它还把一条本来能跑的路径弄坏了（2026-10-31 两个夹具实测，结论与数字
// 写在 docs/accept-gate.md）。
//
// 补法只能是**给快照自己一棵依赖树**，而树从哪来有两条路，这里取后者：
//
//   · 按 lockfile 哈希建共享存储、`npm ci` 装一份再克隆进快照。实测 `npm ci --offline`（本机
//     8 GB 缓存）2.45 秒装完 349 个包，很快；但它**实占 336 MB**（npm 从缓存逐个拷，不共享数据
//     块），而且只覆盖 npm 一家 —— `DEPENDENCY_DIRS` 还有 `.venv`/`vendor`/`target`，每多一个
//     生态就要多一条安装命令、多一套缓存与网络前提，Python/Go/Rust 的 worktree 仍旧卡在同一处。
//     它还要求门禁在准备阶段执行项目自己的 `postinstall`（本仓就有一条，为 node-pty 编原生模块），
//     那是把「跑测试」之外的项目代码执行提前到建快照阶段，并且依赖本机工具链。
//   · **取这个仓库自己已经装好的那一份**（下面的实现）。它与生态无关 —— 只是复制目录，`.venv`、
//     `vendor`、`target` 一视同仁；不执行任何项目代码；而且用的就是开发者自己跑测试时用的那棵树。
//     克隆走 clonefile（数据块共享），实测整套五棵树 858 MB 表观 / **18 MB 实占**，2.2 秒。代价是
//     「主检出必须装过依赖」—— 装不出来时如实拒绝并点名出路，而不是悄悄交一份没隔离的快照。
//
// 取来的树一律**克隆**、绝不借用：借一条链出去等于把解析根放回参考检出，正是②③要消掉的那件事。
// 树里指回源码的链由 `relocationFor` 按安装记录改写到快照自己那份源码（`projectSources` 按 Git
// common directory 对齐同仓的不同检出，所以参考检出里的 `shared/` 认得出是本项目的自有源码）。
//
// **不校验参考树与本次提交的 lockfile 是否一致**，这是有意的：门禁管的是源码一致性，依赖是
// lockfile 的产物、身份取安装声明（见 accept-gate-deps 的 dependencyDigest）。参考树的身份进
// 指纹，所以主检出装/删/升级任何一个包都会让旧的通过记录失效、重跑一次；但门禁不会因为「主检出
// 比本次提交多装了一个包」就拒绝，那是开发者本地的正常状态，也正是他自己跑测试时的那棵树。

/**
 * 只补 `node_modules`，不补 `.venv`/`vendor`/`target`。
 *
 * 判据是**逃逸机制**而不是「哪些目录装着依赖」：要修的那件事是 node 按**目录层级一级级往上**找
 * `node_modules/<包名>`，所以快照里缺一棵树，解析就会爬到快照外面去。另外三种没有这个形状 ——
 * Python 的虚拟环境由解释器路径显式指定、Go 的 `vendor` 只认模块根下那一个、Rust 的 `target` 是
 * 构建产物而不是解析输入；它们缺了就是当场报错，不会悄悄解析到另一个检出上去。
 *
 * 这个收窄不是「省事」，它拦住了一个实际的缺口：`vendor` 同时是 `DEPENDENCY_DIRS` 的成员和 Go 的
 * 官方源码目录，而项目可以把**自己的包**放在被 gitignore 的 `vendor/lib` 里（`file:vendor/lib`
 * 依赖，test-accept-gate-plan 的 nested-source 用例就是这个布局）。照「参考检出有就补」来做会把
 * 那份**未入库**的源码整个拷进快照，于是门禁拿着一份提交号凭据，报绿的却是没进过 Git 的代码。
 * 门禁对这种布局的既定答复是拒绝并给两条出路（纳入 Git 提交，或停止把它当安装来源），补依赖
 * 不该把那道拒绝绕过去。
 */
const SUPPLIED_DIRS = ["node_modules"];

/** 这次要补的一个依赖目录：`path` 相对项目根，`from` 是取来源的绝对路径。 */
export type DependencySupply = { path: string; from: string };

/**
 * 这次补给把哪几个**消费者位置**带进了解析图。身份计算（ambientDigest）要按它们再枚举一遍：
 * 补来的树连同树里外链指出去的独立安装树，都是这一次实际跑的东西，必须进身份。给的是包目录
 * （树的上一级）而不是树本身，因为 resolutionInputs 的根是「从哪里开始解析」。
 */
export const supplyRoots = (supplied: DependencySupply[] = []): string[] =>
  [...new Set(supplied.map(item => dirname(item.from)))].sort();

/**
 * 同一仓库的**主工作树**。worktree 任务按它取依赖；任务本身就在主工作树里时回 null。
 *
 * 判据取 Git 自己的登记而不是「`.worktrees` 的上一级」这类路径形状：`git worktree list` 的第一条
 * 就是主工作树（git 文档明确保证），而路径形状在 `--separate-git-dir`、改过名的仓库上都不成立。
 * 读不出登记（不是 Git 仓库、git 不可用）时回 null —— 这一层只做加法，拿不到参考检出就什么都不补，
 * 由隔离证明那一层照旧拒绝并说明。
 */
export async function referenceCheckout(cwd: string): Promise<string | null> {
  const stdout = await (async () => {
    try {
      return await worktreePorcelain(async args =>
        (await execFileText("git", ["-C", cwd, ...args], { maxBuffer: 8 * 1024 * 1024 })).stdout);
    } catch { return null; }
  })();
  const first = stdout?.split("\0\0").filter(Boolean).at(0)?.split("\0")
    .find(field => field.startsWith("worktree "))?.slice(9);
  if (first === undefined || first === "") return null;
  if (samePath(first, cwd)) return null;
  // 项目根必须**就是**它所在工作树的根,否则不补。下面按 `join(reference, dep)` 把依赖位置原样
  // 映射过去,这一步只在两侧的相对位置一致时才成立;项目被配置成仓库的子目录(`<仓库>/subproject`)
  // 时,参考侧该取 `<主检出>/subproject/node_modules`,而这里会取成 `<主检出>/node_modules` ——
  // 拿错一棵树比不补更坏。子目录项目的完整契约要单独收口(快照本身也还是整仓 clone/checkout),
  // 在那之前这里如实弃权,由隔离证明那一层照旧处理。
  const top = await (async () => {
    try {
      return (await execFileText("git", ["-C", cwd, "rev-parse", "--show-toplevel"])).stdout.trim();
    } catch { return null; }
  })();
  if (top === null || top === "" || !samePath(top, cwd)) return null;
  return physicalPath(first);
}

/** 这个位置上摆着一棵能用的依赖树吗（真目录，或落点是真目录的一条链）。 */
async function installed(path: string): Promise<boolean> {
  return (await optionalRead(path, () => stat(path), ["ENOENT", "ENOTDIR", "ELOOP"]))?.isDirectory() === true;
}

/**
 * 任务工作区在这个位置上**什么都没有**吗。
 *
 * 只认 `ENOENT`：位置上有东西（真目录、悬空链、普通文件）一律不补 —— 那些形态各有自己的既定
 * 处理（登记成依赖、按原样重建成同样解析不通的一条、按源码冻结），补一份进去等于替用户改布局。
 */
async function vacant(path: string): Promise<boolean> {
  return await optionalRead(path, () => lstat(path), ["ENOENT"]) === null;
}

/**
 * 这棵参考树能不能在快照里被证明隔离。
 *
 * 判据只有一条：安装记录认下的**自有包**，它那条安装来源在任务工作区（= 本次提交，工作树已由
 * 上一层验过干净）里得真的在。不在就**不补**——克隆会把这些链改写到快照里的同一相对位置，而那个
 * 位置不存在时得到的是一条悬空绑定：对账两侧都解析不出东西来、于是判成「一致」，收口那一层又把
 * 不可达的入口当成「没有这个入口」跳过，两道都不响，门禁于是交出一份自有包压根解析不到的快照。
 *
 * 不补等于退回原来的那条路（解析爬到参考树上去），由隔离证明那一层按既定说法拒绝——「安装记录说
 * 它来自某个位置，但本次提交里没有这个位置」，并给出纳入 Git 或停用该安装来源两条出路。这一层
 * 只做加法，拿不准就不做，绝不替那道拒绝做决定。
 *
 * 这里不重做「包搬过位置」的声明兜底（`accept-gate-confine` 的 sourceFor 有那一手）：重做等于把
 * 同一个判据写两份。搬过位置而依赖没重装时这一层就不补，那条路上仍由收口按声明认出搬迁。
 */
async function provable(cwd: string, from: string, dep: string): Promise<boolean> {
  const treeRoot = await optionalRead(from, () => realpath(from), ["ENOENT", "ENOTDIR", "ELOOP"]);
  if (treeRoot === null) return false;
  const links = await recordedLinks(treeRoot, basename(dep), await projectSources(cwd), from);
  for (const owned of links.owned) {
    if ((await optionalRead(join(cwd, owned.inside), () => stat(join(cwd, owned.inside))))?.isDirectory() !== true) {
      return false;
    }
  }
  return true;
}

/**
 * 这次要补哪几个依赖目录。
 *
 * `packageDirs` 与 `registered` 由调用方给（它已经按本次提交的包清单枚举过一遍），所以这里不重复
 * 解释「哪些位置算包目录」；`registered` 是工作区自己已经登记上的那些，用来保持同一条「被已登记项
 * 包住就跳过」的去重规则。
 *
 * 补的集合取**参考检出实际装出来的那一套**，不按「这条测试命令大概用得到哪几棵」收窄：收窄要先
 * 证明命令用不到某一棵，而那要静态分析整条命令链 —— 证明不了的收窄恰好是不变量③拒绝的那一类猜测。
 * 少补一棵的后果是确定的：那个位置上的解析又会逃到祖先链上去，隔离重新变成不可证。本仓的账是
 * `mobile/node_modules` 占 440 MB / 40171 个文件（表观），而 clonefile 让它的实占接近于零。
 */
export async function dependencySupply(cwd: string, packageDirs: string[],
  registered: string[]): Promise<DependencySupply[]> {
  const reference = await referenceCheckout(cwd);
  if (reference === null) return [];
  const taken = [...registered];
  const supply: DependencySupply[] = [];
  for (const directory of [...packageDirs].sort()) {
    for (const name of SUPPLIED_DIRS) {
      const dep = join(directory, name);
      if (taken.some(other => insideTree(join(cwd, other), join(cwd, dep)))) continue;
      if (!await vacant(join(cwd, dep))) continue;
      const from = join(reference, dep);
      if (!await installed(from) || !await provable(cwd, from, dep)) continue;
      taken.push(dep);
      supply.push({ path: dep, from });
    }
  }
  return supply;
}
