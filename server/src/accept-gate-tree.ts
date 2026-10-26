import { createHash } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, readlink, realpath, stat, symlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type GateTree = {
  /** 快照根（源树一侧）：软链落点在树内还是树外、以及树内链怎么映射到副本，全以它为参照。 */
  root: string;
  /** 给出就边摘要边拷贝；副本按 root→destinationRoot 镜像同一层级结构。 */
  destinationRoot?: string;
  filter?: (path: string) => boolean;
};
type Copy = { root: string; path: string };
/**
 * 沿路径带下去的遍历上下文。ancestors 防跟随成环；relocated 记「这一段子树是从别处搬来的」
 * （按源码冻结的外部目录，见 freezeEntry）——搬迁过的子树里，相对原文不能再照抄。
 */
type Frame = { ancestors: Set<string>; relocated: boolean };
type Walk = GateTree & { realRoot: string };

export const insideTree = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};
const portable = (path: string) => path.split(sep).join("/");
const treeRealPath = async (root: string) => await realpath(root).catch(() => root);

// Win32 长路径形式（\\?\D:\...）剥掉前缀再用：path.relative 认不出它其实在树内（实测
// relative("D:\\repo", "\\\\?\\D:\\repo\\nm") 原样返回长路径），不规范化会让同一个落点在两种写法
// 下摘出两个值。注意**不能**拿这个前缀当「原链接是 junction」的标记：192.168.1.187 真机实测
// (node 22.20、2026-10-26)，junction 的 readlink 回来就是干净的 "D:\path\target"，libuv 已经把
// \??\ 前缀剥掉了；junction / 目录软链 / 文件软链三种悬空链的 lstat、stat、readlink 结果完全
// 一致，node 不暴露 reparse tag，**悬空链的种类无从得知**（copyLink 据此取舍）。
// 尾部分隔符**必须原样留着**:它在 Win32 上是有语义的,同一台真机实测(2026-10-26) entry.mjs\
// 是 ENOENT、entry.mjs\. 照样读到那个文件。曾经在这里一起剥掉,于是源树里读不到的那条链被照抄
// 成副本里读得通的一条——交付的副本和工作区行为相反,正是本模块要防的那件事。落点不需要这层
// 规范化:它由原生 realpath 给出(见 linkLanding ②),尾部语法在那条调用里各平台自行成立。
const longPath = /^\\\\\?\\(?=[A-Za-z]:\\)/;
async function linkTarget(path: string): Promise<string> {
  const raw = await readlink(path);
  return process.platform === "win32" ? raw.replace(longPath, "") : raw;
}

// 可达性和落点都必须由**原生访问**给出,不能自己切分路径、也不能逐段 realpath 代替平台解析:
// 路径语法是平台的,自己解释一定会和运行时真正打开的那个文件分叉。第 3 轮审查实测的三处分叉:
//  · 末尾的 `/`、`/.` 是有意义的——entry.mjs/ 原生读出来是 ENOTDIR,不是 entry.mjs;自己切分时
//    把空段和 `.` 滤掉,一条读得通的链和一条读不通的链就摘出同一个身份;
//  · POSIX 上的 `\` 是**普通字符**,literal\file.txt 和 literal/file.txt 是两个不同的文件,拿
//    `\` 当分隔符会让它们同身份(实测切链接之后原生内容 LITERAL->NESTED,指纹不变);
//  · Win32 的路径解析器在碰文件系统之前就按字面消掉 `..`(这正是 `\\?\` 前缀存在的理由):
//    bridge 是指向 store/deep 的 junction 时,bridge\..\entry.mjs 原生读到的是**同级**
//    entry.mjs(192.168.1.187 真机 node 22.20 实测 WIN_NATIVE_BEFORE=SIBLING),先 realpath(bridge)
//    再解释 `..` 得到的是 store/entry.mjs——另一个文件。macOS 同一份脚本读到 store/entry.mjs,
//    两个平台各自正确,所以判据只能交给原生调用,不能由本模块复刻。
// 于是:
//  ① 可达性 = stat(链自身)。它走的就是运行时那条路径,平台语义、尾部语法、`..` 顺序全在里面。
//  ② 落点 = 原生 realpath(原文的父路径) + 末段。末段故意不解析,多级链每级各自成身份;父路径
//     交给原生 realpath,Win32 的词法消 `..` 与 POSIX 的逐段跟随各自成立(fs/promises 的
//     realpath 是原生 uv;fs.realpathSync 是 JS 实现、入口就 path.resolve 消 `..`,**不能**用它)。
//     末段是 `.`/`..` 这种不命名条目的成分时整条交给 realpath——它们不是「链的一级」,而 join 对
//     它们是词法的。
//  ③ 到不了的链没有落点可言,身份只能由「它自己在树里的位置 + 原文」承担(见 walkTree)。这同时
//     让源树与副本对一条无害的断链算出同一个值:源树里落点的父目录在、副本里还没拷到它时(没装
//     的可选依赖 node_modules/optional -> ../.cache/not-installed 就是这个形状),两侧**都读不到**
//     这条链,于是两侧都走这一支、拼出同一个身份——node_modules 里的断链是常态,它绝不能把整次
//     快照判成「没能按原样复现」。原文不做任何归一:改成读不通的写法必须改掉身份,否则上一张绿
//     结果会被直接复用。
type LinkLanding = {
  /** 原生跟随这条链到不到得了一个东西。到不了就没有落点,身份改由原文承担。 */
  reachable: boolean;
  /** reachable 时是落点(末段不解析);否则是链自己所在的目录——源树与副本在结构上互为镜像。 */
  landing: string;
};
async function linkLanding(path: string, target: string): Promise<LinkLanding> {
  const unreachable = { reachable: false, landing: dirname(path) };
  if (!await stat(path).then(() => true, () => false)) return unreachable;
  const full = isAbsolute(target) ? target : `${dirname(path)}${sep}${target}`;
  const tail = basename(full);
  const landing = tail === "." || tail === ".."
    ? await realpath(full).catch(() => null)
    : await realpath(dirname(full)).then(parent => join(parent, tail), () => null);
  return landing === null ? unreachable : { reachable: true, landing };
}

// 这条判断必须和 walkTree 的软链分支逐字一致:登记(listInputs)、摘要(digestInputs)和复制
// (walkTree)三处对同一条链必须选同一种语义,否则副本里是真文件、清单里却按链登记,摘要立刻对
// 不上,快照在什么也没改的情况下被判定「源码或依赖已变化」。
export async function freezesAsSource(root: string, path: string): Promise<boolean> {
  const realRoot = await treeRealPath(root);
  const { reachable, landing } = await linkLanding(path, await linkTarget(path));
  return reachable && !insideTree(realRoot, landing);
}

// 目的地一律是空的:源码树整棵从空目录拷起,依赖目录走借用(建不出链才退回 copyTree,那也是空的)。
// 导出给依赖的深拷退路用(accept-gate-deps 的 copyTree):那条路同样必须按链重建、绝不跟随。
export async function copyLink(source: string, destination: string, target: string): Promise<void> {
  if (process.platform !== "win32") return await symlink(target, destination);
  // Windows 有两种目录链：junction 不要权限、只认绝对路径，包管理器（pnpm 等）在那边就是用它把
  // 包连进 node_modules 的，所以目录链首选它（node 同样把 junction 报成 isSymbolicLink()，两侧
  // 摘要仍然对得上）；普通软链——包括所有文件链——要 SeCreateSymbolicLinkPrivilege，即开发者
  // 模式或管理员（实测 node 的 symlink 带 ALLOW_UNPRIVILEGED_CREATE，开发者模式下能建，而
  // PowerShell 的 New-Item 仍然要提权，别拿它的失败当本机结论）。
  // 种类只能按「目标解析得开不开」判：node 不暴露 reparse tag，悬空链三种种类长得一模一样
  // （见 linkTarget 上面那段真机实测）。所以悬空时先试文件链——node_modules 里的断链绝大多数
  // 是 .bin 下的文件链——失败再退 junction：开发者模式下第一次就成，没开发者模式时退到免权限
  // 的 junction，两种环境都不会让一条断链拖垮整次快照，代价只是悬空链的种类可能与原件不同。
  const resolved = await stat(source).then(info => info.isDirectory() ? "dir" : "file", () => null);
  const attempts: [string, "junction" | "dir" | "file"][] = resolved === "dir"
    ? [[resolve(dirname(destination), target), "junction"], [target, "dir"]]
    : resolved === "file" ? [[target, "file"]]
      : [[target, "file"], [resolve(dirname(destination), target), "junction"]];
  let failure: unknown;
  for (const [attempt, type] of attempts) {
    try { return await symlink(attempt, destination, type); }
    catch (error) { failure = error; }
  }
  // 文件链没有退路：拷成真文件正是本模块要修的那个 bug（靠自身位置做相对解析的运行时会当场
  // 死），所以宁可停在这里把原因说清楚，而不是悄悄交出一份跑不起来的快照。
  throw new Error(`无法在测试快照中重建符号链接 ${source}（${(failure as Error).message}）；`
    + "Windows 上请开启开发者模式或以管理员身份运行 ash，或改用不含文件软链的依赖安装方式");
}

async function entryStats(path: string): Promise<Stats | null> {
  try { return await lstat(path); }
  catch (error) {
    // 读完目录到读条目之间文件被删掉（依赖树随时在被包管理器改）不该崩掉整次快照；
    // ELOOP 留着兜中间路径成分成环的极端情况。悬空软链不再走这条路——lstat 不解析末端成分。
    if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw error;
  }
}

// 跟随语义（stat + copyFile）：只给「非 Git 项目的源码外链」用，把目标的内容冻进快照。这是本次
// 改动之前对所有输入的行为，这里把它保留给源码外链这一处，换来的是「改了项目外的源码仍然直接
// 复用上次通过」「测试写穿到项目外」两件事都不会发生。只有跟随才会成环，所以环的防护也只留在
// 这条路上。
// 目录的递归**回到 walkTree**，不是在这里一路跟随到底：冻结的是「这份源码」，不是「它里面每一
// 条链的目标」。里面的依赖链、指回项目内的链仍然按链保留，于是登记(listInputs)、摘要和复制对
// 每一个逻辑输入都选同一种语义——否则顶层一致、子项被拍平，副本重新登记得到的是真文件而不是
// 同一条叶子链，来源与副本指纹必然不等，快照在什么也没改的情况下被判「源码或依赖已变化」。
async function freezeEntry(path: string, hash: ReturnType<typeof createHash>, walk: Walk, copy: Copy | undefined,
  frame: Frame): Promise<boolean> {
  let canonical: string;
  try { canonical = await realpath(path); }
  catch (error) {
    if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
  if (frame.ancestors.has(canonical)) return false;
  let info: Stats;
  try { info = await stat(path); } catch { return false; }
  if (info.isFile()) {
    hash.update(`file:${info.mode & 0o111}:`);
    if (copy) {
      await copyFile(path, copy.path);
      await chmod(copy.path, info.mode);
    }
    for await (const chunk of createReadStream(copy?.path ?? path)) hash.update(chunk);
  } else if (info.isDirectory()) {
    if (copy) await mkdir(copy.path, { recursive: true });
    hash.update("directory:");
    const next = { ancestors: new Set(frame.ancestors).add(canonical), relocated: frame.relocated };
    for (const name of (await readdir(path)).sort()) {
      const childHash = createHash("sha256");
      const child = copy && { root: copy.root, path: join(copy.path, name) };
      if (await walkTree(join(path, name), childHash, walk, child, next)) {
        hash.update(JSON.stringify(name)).update(childHash.digest());
      }
    }
  } else throw new Error(`测试输入不是普通文件或目录：${path}`);
  hash.update("\0");
  return true;
}

async function walkTree(path: string, hash: ReturnType<typeof createHash>, walk: Walk, copy: Copy | undefined,
  frame: Frame): Promise<boolean> {
  if (walk.filter && !walk.filter(path)) return false;
  const info = await entryStats(path);
  if (info === null) return false;
  if (info.isSymbolicLink()) {
    const target = await linkTarget(path);
    const { reachable, landing } = await linkLanding(path, target);
    const within = reachable && insideTree(walk.realRoot, landing);
    // 只有原生到得了的外链才有「可冻的内容」:读不到的链既不知道落在哪、也没有内容可跟随,
    // 只能按链保留。
    if (reachable && !within) {
      return await freezeEntry(path, hash, walk, copy, { ancestors: frame.ancestors, relocated: true });
    }
    // 摘要只记落点、不记目标内容：落点在树内的话那条路径本身已经被摘要过，在树外的话它本就
    // 不是快照冻住的输入。树内落点一律归一成「相对快照根的路径」，所以原文写相对还是绝对，
    // 源树与副本都算出同一个值（createGateSnapshot 的回算对账要求两侧严格相等）。
    const landed = portable(relative(walk.realRoot, landing));
    // 读不到的链:身份 =「它自己在树里的位置 + 原文」。两段都不能少——只看位置会让「改成读不通
    // 的另一种写法」沿用上次通过,只看原文会让同一条原文在两个位置上同身份。位置用的是**结构
    // 路径**(不是 realpath),源树与副本按构造互为镜像,所以两侧必然相等(见 linkLanding ③)。
    hash.update(!reachable ? `link-unreachable:${portable(relative(walk.root, dirname(path)))}|${portable(target)}`
      : within ? `link:${landed}` : `link-outside:${landing}`);
    // 一律重建成软链、绝不跟随：拷成真文件会让「靠自身所在位置做相对解析」的运行时在快照里
    // 一启动就死（node_modules/.bin/tsx 找不到同胞 package-*.mjs、.venv/bin/python3 的
    // @executable_path 落到快照里没有的 ../lib）。不跟随之后目录软链成的环也自然消失了。
    // 读不到的链一律原文照抄:身份就是原文,改写它(哪怕只是去掉末尾那个 `/`)会让副本的行为与
    // 源树相反——实测过一次:绝对原文 <repo>/node_modules/entry.mjs/ 在源树里是 ENOTDIR,被重写
    // 成不带 `/` 的副本路径之后在快照里读得通,于是交付的副本和工作区不是同一份行为。
    if (copy) await copyLink(path, copy.path, !reachable ? target : !within
      // 树外：改写成绝对落点原样保留。相对原文照抄会因为快照与项目目录深度不同而指错地方
      // （worktree 借主仓 node_modules 就是这个形状）。保留而不是跳过或拒绝建快照，是因为
      // .venv/bin/python -> /opt/homebrew/... 这类链本身就是解释器，跳过等于把 venv 弄残、
      // 拒绝等于每台装了 homebrew/uv venv 的机器都过不了门禁；而被指向的 pnpm store、uv
      // cache、homebrew 前缀在实践中是内容寻址或只读的。代价是快照对这部分依赖不再是冻住的
      // 输入（git 跟踪的源码软链指向快照外仍然直接拒绝，见 createGateSnapshot）。
      ? landing
      // 树内：相对原文照抄即可——副本层级一致，于是它自然指向副本自己那份（顺带修掉「worktree 里
      // node_modules/@ash/shared 解析到主仓」那条老坑），而且原文里的 `..` 继续按副本自己的链接
      // 结构解析；绝对原文必须改写到副本，否则测试会被拉回活动工作区。
      // 搬迁过的子树(relocated)也必须改写:它在副本里的位置与源树不同,照抄的相对原文会从新位置
      // 重新解析、指到另一个文件上去——external/back.py -> ../loose/inside/data.py 被冻进
      // <快照>/src 之后,原文落到 <快照>/loose/inside/data.py,而副本里那份其实在 <快照>/inside。
      : (isAbsolute(target) || frame.relocated) ? join(copy.root, landed) : target);
  } else if (info.isFile()) {
    hash.update(`file:${info.mode & 0o111}:`);
    if (copy) {
      await copyFile(path, copy.path);
      await chmod(copy.path, info.mode);
    }
    for await (const chunk of createReadStream(copy?.path ?? path)) hash.update(chunk);
  } else if (info.isDirectory()) {
    if (copy) await mkdir(copy.path, { recursive: true });
    hash.update("directory:");
    for (const name of (await readdir(path)).sort()) {
      const childHash = createHash("sha256");
      const child = copy && { root: copy.root, path: join(copy.path, name) };
      if (await walkTree(join(path, name), childHash, walk, child, frame)) {
        hash.update(JSON.stringify(name)).update(childHash.digest());
      }
    }
  } else throw new Error(`测试输入不是普通文件或目录：${path}`);
  hash.update("\0");
  return true;
}

export async function gateTreeDigest(path: string, tree: GateTree): Promise<string | null> {
  if (!insideTree(tree.root, path)) throw new Error(`测试输入不在快照根内：${path}`);
  const hash = createHash("sha256");
  const walk: Walk = { ...tree, realRoot: await treeRealPath(tree.root) };
  // 副本落点由两侧根推算，而不是由调用方再传一遍，这样「副本严格镜像源树层级」是结构上成立的
  // ——树内软链的原文照抄依赖这一点。
  const copy = tree.destinationRoot === undefined ? undefined
    : { root: tree.destinationRoot, path: join(tree.destinationRoot, relative(tree.root, path)) };
  if (!await walkTree(path, hash, walk, copy, { ancestors: new Set(), relocated: false })) return null;
  return hash.digest("hex");
}
