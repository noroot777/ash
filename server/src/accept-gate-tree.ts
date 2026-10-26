import { createHash } from "node:crypto";
import { createReadStream, type Stats } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, readlink, realpath, rm, stat, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export type GateTree = {
  /** 快照根（源树一侧）：软链落点在树内还是树外、以及树内链怎么映射到副本，全以它为参照。 */
  root: string;
  /** 给出就边摘要边拷贝；副本按 root→destinationRoot 镜像同一层级结构。 */
  destinationRoot?: string;
  filter?: (path: string) => boolean;
  /**
   * true：整棵树都是依赖输入（Git 项目登记的依赖目录），里面的外链一律原样重建。
   * false：非 Git 项目的源码树，只有依赖目录（node_modules/.venv/vendor/target）内的外链按
   * 依赖策略保留，其余外链按**源码**冻结——跟随并把目标内容拷进快照。
   */
  dependency: boolean;
};
/**
 * requires 是这棵树里全部被原样保留的软链**在副本里必须存在才能解析**的树内路径，相对快照根、
 * `/` 分隔，交给输入规划层补闭包。两类都在里面，少一类副本就解析不到：
 * ① 落点——链最终指向的那个文件/目录（内容必须被复制）；
 * ② 原文路上的中间软链——`node_modules/cli -> ../bridge/cli` 这种借道布局里的 `bridge`
 *    （原文照抄之后，副本里没有它这条链就断在中途，光把最终落点拷进来没用）。
 */
export type GateTreeResult = { digest: string; requires: string[] };
type Copy = { root: string; path: string };
/**
 * 沿路径带下去的遍历上下文。ancestors 防跟随成环；relocated 记「这一段子树是从别处搬来的」
 * （按源码冻结的外部目录，见 freezeEntry）——搬迁过的子树里，相对原文不能再照抄。
 */
type Frame = { ancestors: Set<string>; relocated: boolean };
type Walk = GateTree & { realRoot: string; requires: Set<string> };

export const DEPENDENCY_DIRS = ["node_modules", ".venv", "vendor", "target"];
export const insideTree = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};
const portable = (path: string) => path.split(sep).join("/");
const isDependencyPath = (rel: string) => portable(rel).split("/").some(part => DEPENDENCY_DIRS.includes(part));
const treeRealPath = async (root: string) => await realpath(root).catch(() => root);

// Win32 长路径形式（\\?\D:\...）剥掉前缀和尾部分隔符再用：path.relative 认不出它其实在树内
// （实测 relative("D:\\repo", "\\\\?\\D:\\repo\\nm") 原样返回长路径），不规范化会让同一个落点
// 在两种写法下摘出两个值。注意**不能**拿这个前缀当「原链接是 junction」的标记：192.168.1.187
// 真机实测(node 22.20、2026-10-26)，junction 的 readlink 回来就是干净的 "D:\path\target"，
// libuv 已经把 \??\ 前缀剥掉了；junction / 目录软链 / 文件软链三种悬空链的 lstat、stat、
// readlink 结果完全一致，node 不暴露 reparse tag，**悬空链的种类无从得知**（copyLink 据此取舍）。
const longPath = /^\\\\\?\\(?=[A-Za-z]:\\)/;
async function linkTarget(path: string): Promise<string> {
  const raw = await readlink(path);
  if (process.platform !== "win32") return raw;
  const stripped = raw.replace(longPath, "");
  return stripped.length > 3 && stripped.endsWith(sep) ? stripped.slice(0, -1) : stripped;
}

// 落点必须按**文件系统语义**逐段解析，不能用 path.resolve 消 `..`：中间段是目录软链时，
// 「先跟随链接再解释 ..」与「先消掉 ..」落在两个不同的文件上（bridge -> store/deep 时
// bridge/../entry.mjs 落在 store/entry.mjs，不是同级的 entry.mjs）。摘要身份和重定位都以
// 落点为准，词法规范化会既漏判输入变化、又把链接重定向到别的文件。末段故意不解析，这样多级
// 链的每一级都保留自己的身份。
// 这里的 realpath 必须是 node:fs/promises 那个（原生 uv，POSIX 语义）：fs.realpathSync 是 JS
// 实现，入口就 path.resolve 把 `..` 按字面消掉，拿它算落点等于又回到词法规范化（实测
// promises.realpath("<t>/bridge/..") = <t>/store，realpathSync 同一个输入给 <t>）。
// 两个平台各自正确，不用分支：Win32 的路径解析器本来就在碰文件系统之前按字面消 `..`，所以
// 同一条 bridge/../entry.mjs 在那边读到的就是同级 entry.mjs（192.168.1.187 真机 node 22.20
// 实测：read-through-link=SIBLING，macOS 同一份脚本=INSIDE-STORE），原生 realpath 跟着
// 平台走，落点与运行时真正打开的那个文件始终一致。
// 解析不出来时**不能**退回 path.resolve 的词法结果:那正是上面整段否掉的判据,拿它当身份会让
// 「原本能跑的链改成跑不了的」摘出同一个值(cli.py -> entry.py 改成 cli.py -> missing/../entry.py
// 之后读取已经 ENOENT,词法归一后却还是同一个 entry.py,于是上一张绿结果被直接复用)。所以解析
// 走到哪算哪:走到最后一个**存在**的成分为止,余下的原文(rest)原封不动带进身份。
// 「余下的原文」同时是源树与副本算出同一个身份的前提。源树里落点的父目录在、副本里还没复制到
// 它时(没装的可选依赖 node_modules/optional -> ../.cache/not-installed 就是这个形状),源侧解析
// 到 .cache、副侧只解析到快照根,但两侧「已解析前缀 + 余下原文」拼出来都是 .cache/not-installed
// ——于是一条无害的断链不会把整次快照判成「没能按原样复现」(node_modules 里的断链是常态,它绝不
// 能拖垮验收)。rest 必须按**原文**拼,不能走 path.join:它会把 `..` 吃掉,上面那条「改成跑不了
// 的链」立刻又摘出同一个值。
type LinkLanding = {
  /** 原文逐段解析到的落点；rest 非空时就是最后一个解析得通的成分。 */
  landing: string;
  /** 余下没解析掉的原文，`/` 分隔；为空表示落点的父目录全程解析得通。 */
  rest: string;
  /**
   * 原文路上的树内中间软链（相对快照根、`/` 分隔）。原文照抄之后副本里还必须有它们：
   * node_modules/cli.py -> ../bridge/cli.py 配 bridge -> .actual 时，副本里缺了 bridge 这条链，
   * 光把最终落点拷进来命令依然不存在；它们各自的落点由同一轮闭包继续补齐。绝对原文不收集——
   * 树内落点会被重写成副本里的绝对路径，不经过原文那些中间段。
   */
  route: string[];
};
async function linkLanding(path: string, target: string, realRoot: string): Promise<LinkLanding> {
  // 基座:绝对原文从它自己的路径根起步,相对原文从链所在的目录起步(那个目录一定存在)。原文只按
  // 分隔符切、不做任何归一,逐段 lstat + realpath —— cursor 始终是真实路径,所以 `..` 由 realpath
  // 按平台语义解释。末段(leaf)故意不解析,这样多级链的每一级都保留自己的身份。
  const base = isAbsolute(target) ? parse(target).root : dirname(path);
  const parts = (isAbsolute(target) ? target.slice(parse(target).root.length) : target)
    .split(/[\\/]/).filter(part => part !== "" && part !== ".");
  const leaf = parts.pop() ?? "";
  const route: string[] = [];
  let cursor = await realpath(base).catch(() => null) ?? base;
  let rest: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const probe = `${cursor}${cursor.endsWith(sep) ? "" : sep}${parts[index]}`;
    const info = await lstat(probe).catch(() => null);
    if (info?.isSymbolicLink() && !isAbsolute(target) && insideTree(realRoot, probe)) {
      route.push(portable(relative(realRoot, probe)));
    }
    const next = info === null ? null : await realpath(probe).catch(() => null);
    if (next === null) { rest = parts.slice(index); break; } // 这一段不存在或自己就是断链
    cursor = next;
  }
  return rest.length === 0
    ? { landing: join(cursor, leaf), rest: "", route }
    : { landing: cursor, rest: [...rest, leaf].filter(Boolean).join("/"), route };
}

// 这条判断必须和 walkTree 的软链分支逐字一致:登记(listInputs)、摘要(digestInputs)和复制
// (walkTree)三处对同一条链必须选同一种语义,否则副本里是真文件、清单里却按链登记,摘要立刻对
// 不上,快照在什么也没改的情况下被判定「源码或依赖已变化」。
export async function freezesAsSource(root: string, path: string): Promise<boolean> {
  if (isDependencyPath(relative(root, path))) return false;
  const realRoot = await treeRealPath(root);
  const { landing, rest } = await linkLanding(path, await linkTarget(path), realRoot);
  return rest === "" && !insideTree(realRoot, landing);
}

// 目的地可能已经有东西了:Git 检出会先把**被跟踪的**软链写出来,而同一个路径往往又落在某个依赖
// 目录的复制计划里(vendor/ 里提交的软链就是这个形状)。symlink 不像 copyFile 那样幂等,第二次写
// 同一个目的地直接 EEXIST,整次快照在任何断言之前就废掉。所以这里按「目的地所有权」处理:已经
// 是同一条链就复用,是别的东西就换成本模块该写的那一条——而不是无条件忽略 EEXIST(那会把真正的
// 冲突一起咽掉,副本里留着与源树不同的内容却照样交付)。Windows 的 Git 在 core.symlinks=false
// 下把被跟踪的软链检出成普通文件,正好走「换掉」这一支,副本里才会是真链。
async function claimLink(destination: string, target: string): Promise<boolean> {
  const info = await lstat(destination).catch(() => null);
  if (info === null) return true;
  if (info.isSymbolicLink() && await readlink(destination).catch(() => null) === target) return false;
  await rm(destination, { recursive: true, force: true });
  return true;
}

async function copyLink(source: string, destination: string, target: string): Promise<void> {
  if (!await claimLink(destination, target)) return;
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
    const { landing, rest, route } = await linkLanding(path, target, walk.realRoot);
    const within = insideTree(walk.realRoot, landing);
    const withRest = (base: string) => rest === "" ? base : `${base}${sep}${rest.split("/").join(sep)}`;
    // 只有整条原文都解析得通(rest 为空)的外链才有「可冻的内容」:解析不到的链既不知道落在哪、
    // 也没有内容可跟随,只能按链保留。
    if (rest === "" && !within && !walk.dependency && !isDependencyPath(relative(walk.root, path))) {
      return await freezeEntry(path, hash, walk, copy, { ancestors: frame.ancestors, relocated: true });
    }
    // 摘要只记落点、不记目标内容：落点在树内的话那条路径本身已经被摘要过，在树外的话它本就
    // 不是快照冻住的输入。树内落点一律归一成「相对快照根的路径」，所以原文写相对还是绝对，
    // 源树与副本都算出同一个值（createGateSnapshot 的回算对账要求两侧严格相等）。
    const landed = portable(relative(walk.realRoot, landing));
    // 身份 =「已解析前缀 + 余下原文」,两段都不能少(见 linkLanding 顶部):只留前缀会让「改成跑
    // 不了的链」沿用上次通过,只留原文会让源树与副本因为解析深度不同而算出两个值。
    const identity = rest === "" ? landed : landed === "" ? rest : `${landed}/${rest}`;
    if (within) {
      // 落点解析得通才有内容要登记;解析不到就只有结构要登记——原文路上**已经存在**的中间链
      // 必须在副本里,否则两侧连「解析到哪一段」都不一致,无害的断链又会把快照判成没复现。
      if (rest === "") walk.requires.add(landed);
      for (const step of route) walk.requires.add(step);
    }
    hash.update(within ? `link:${identity}` : `link-outside:${withRest(landing)}`);
    // 一律重建成软链、绝不跟随：拷成真文件会让「靠自身所在位置做相对解析」的运行时在快照里
    // 一启动就死（node_modules/.bin/tsx 找不到同胞 package-*.mjs、.venv/bin/python3 的
    // @executable_path 落到快照里没有的 ../lib）。不跟随之后目录软链成的环也自然消失了。
    if (copy) await copyLink(path, copy.path, !within
      // 树外：改写成绝对落点原样保留。相对原文照抄会因为快照与项目目录深度不同而指错地方
      // （worktree 借主仓 node_modules 就是这个形状）。保留而不是跳过或拒绝建快照，是因为
      // .venv/bin/python -> /opt/homebrew/... 这类链本身就是解释器，跳过等于把 venv 弄残、
      // 拒绝等于每台装了 homebrew/uv venv 的机器都过不了门禁；而被指向的 pnpm store、uv
      // cache、homebrew 前缀在实践中是内容寻址或只读的。代价是快照对这部分依赖不再是冻住的
      // 输入（git 跟踪的源码软链指向快照外仍然直接拒绝，见 createGateSnapshot）。
      ? withRest(landing)
      // 树内：相对原文照抄即可——副本层级一致，于是它自然指向副本自己那份（顺带修掉「worktree 里
      // node_modules/@ash/shared 解析到主仓」那条老坑），而且原文里的 `..` 继续按副本自己的链接
      // 结构解析；绝对原文必须改写到副本，否则测试会被拉回活动工作区。
      // 搬迁过的子树(relocated)也必须改写:它在副本里的位置与源树不同,照抄的相对原文会从新位置
      // 重新解析、指到另一个文件上去——external/back.py -> ../loose/inside/data.py 被冻进
      // <快照>/src 之后,原文落到 <快照>/loose/inside/data.py,而副本里那份其实在 <快照>/inside。
      : (isAbsolute(target) || frame.relocated) ? withRest(join(copy.root, landed)) : target);
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

export async function gateTreeDigest(path: string, tree: GateTree): Promise<GateTreeResult | null> {
  if (!insideTree(tree.root, path)) throw new Error(`测试输入不在快照根内：${path}`);
  const hash = createHash("sha256");
  const walk: Walk = { ...tree, realRoot: await treeRealPath(tree.root), requires: new Set() };
  // 副本落点由两侧根推算，而不是由调用方再传一遍，这样「副本严格镜像源树层级」是结构上成立的
  // ——树内软链的原文照抄依赖这一点。
  const copy = tree.destinationRoot === undefined ? undefined
    : { root: tree.destinationRoot, path: join(tree.destinationRoot, relative(tree.root, path)) };
  if (!await walkTree(path, hash, walk, copy, { ancestors: new Set(), relocated: false })) return null;
  return { digest: hash.digest("hex"), requires: [...walk.requires] };
}
