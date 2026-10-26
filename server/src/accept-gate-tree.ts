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
// 之后读取已经 ENOENT,词法归一后却还是同一个 entry.py,于是上一张绿结果被直接复用)。所以失败
// 分支只如实报告「没解析出来」,身份改由原文承担(walkTree 据此摘 link-unresolved:<原文>),
// 而且未解析的链一律不算树内输入——我们并不知道它落在哪,更没有内容可冻。
type LinkLanding = { landing: string; resolved: boolean };
async function linkLanding(path: string, target: string): Promise<LinkLanding> {
  const full = isAbsolute(target) ? target : `${dirname(path)}${sep}${target}`;
  try { return { landing: join(await realpath(dirname(full)), basename(full)), resolved: true }; }
  catch { return { landing: full, resolved: false }; }
}

// 原文照抄之后,副本里还必须有「解析这条原文要经过的中间软链」。只拷最终落点不够:
// node_modules/cli.py -> ../bridge/cli.py 配 bridge -> .actual 时,副本里缺了 bridge 这条链,
// 命令依然不存在。这里按文件系统语义逐段走(cursor 始终是真实路径,所以 `..` 由 realpath 按
// 平台语义解释),把路上遇到的树内软链报给规划层;它们各自的落点由同一轮闭包继续补齐。
// 绝对原文不走这条路:树内落点会被重写成副本里的绝对路径,不经过原文那些中间段。
async function linkRoute(path: string, target: string, realRoot: string): Promise<string[]> {
  if (isAbsolute(target)) return [];
  const parts = target.split(sep);
  parts.pop(); // 末段的身份就是落点本身,已经单独登记
  const route: string[] = [];
  let cursor = await realpath(dirname(path)).catch(() => null);
  for (const part of parts) {
    if (cursor === null) break;
    if (part === "" || part === ".") continue;
    const probe = `${cursor}${sep}${part}`;
    const info = await lstat(probe).catch(() => null);
    if (info === null) break;
    if (info.isSymbolicLink() && insideTree(realRoot, probe)) route.push(portable(relative(realRoot, probe)));
    cursor = await realpath(probe).catch(() => null);
  }
  return route;
}

// 这条判断必须和 walkTree 的软链分支逐字一致:登记(listInputs)、摘要(digestInputs)和复制
// (walkTree)三处对同一条链必须选同一种语义,否则副本里是真文件、清单里却按链登记,摘要立刻对
// 不上,快照在什么也没改的情况下被判定「源码或依赖已变化」。
export async function freezesAsSource(root: string, path: string): Promise<boolean> {
  if (isDependencyPath(relative(root, path))) return false;
  const target = await linkTarget(path);
  const { landing, resolved } = await linkLanding(path, target);
  return resolved && !insideTree(await treeRealPath(root), landing);
}

async function copyLink(source: string, destination: string, target: string): Promise<void> {
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
  ancestors: Set<string>): Promise<boolean> {
  let canonical: string;
  try { canonical = await realpath(path); }
  catch (error) {
    if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
  if (ancestors.has(canonical)) return false;
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
    const next = new Set(ancestors).add(canonical);
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
  ancestors: Set<string>): Promise<boolean> {
  if (walk.filter && !walk.filter(path)) return false;
  const info = await entryStats(path);
  if (info === null) return false;
  if (info.isSymbolicLink()) {
    const target = await linkTarget(path);
    const { landing, resolved } = await linkLanding(path, target);
    const within = resolved && insideTree(walk.realRoot, landing);
    if (resolved && !within && !walk.dependency && !isDependencyPath(relative(walk.root, path))) {
      return await freezeEntry(path, hash, walk, copy, ancestors);
    }
    // 摘要只记落点、不记目标内容：落点在树内的话那条路径本身已经被摘要过，在树外的话它本就
    // 不是快照冻住的输入。树内落点一律归一成「相对快照根的路径」，所以原文写相对还是绝对，
    // 源树与副本都算出同一个值（createGateSnapshot 的回算对账要求两侧严格相等）。
    if (within) {
      walk.requires.add(portable(relative(walk.realRoot, landing)));
      for (const step of await linkRoute(path, target, walk.realRoot)) walk.requires.add(step);
    }
    // 未解析的链只能以**原文**为身份(见 linkLanding):它既不是树内输入,也没有可冻的内容,
    // 改掉原文必须改掉摘要,否则一条已经断掉的命令会沿用上次通过。
    hash.update(!resolved ? `link-unresolved:${portable(target)}`
      : within ? `link:${portable(relative(walk.realRoot, landing))}` : `link-outside:${landing}`);
    // 一律重建成软链、绝不跟随：拷成真文件会让「靠自身所在位置做相对解析」的运行时在快照里
    // 一启动就死（node_modules/.bin/tsx 找不到同胞 package-*.mjs、.venv/bin/python3 的
    // @executable_path 落到快照里没有的 ../lib）。不跟随之后目录软链成的环也自然消失了。
    if (copy) await copyLink(path, copy.path, !resolved ? target : within
      // 树内：相对原文照抄即可——副本层级一致，于是它自然指向副本自己那份（顺带修掉「worktree 里
      // node_modules/@ash/shared 解析到主仓」那条老坑），而且原文里的 `..` 继续按副本自己的链接
      // 结构解析；绝对原文必须改写到副本，否则测试会被拉回活动工作区。
      ? (isAbsolute(target) ? join(copy.root, relative(walk.realRoot, landing)) : target)
      // 树外：改写成绝对落点原样保留。相对原文照抄会因为快照与项目目录深度不同而指错地方
      // （worktree 借主仓 node_modules 就是这个形状）。保留而不是跳过或拒绝建快照，是因为
      // .venv/bin/python -> /opt/homebrew/... 这类链本身就是解释器，跳过等于把 venv 弄残、
      // 拒绝等于每台装了 homebrew/uv venv 的机器都过不了门禁；而被指向的 pnpm store、uv
      // cache、homebrew 前缀在实践中是内容寻址或只读的。代价是快照对这部分依赖不再是冻住的
      // 输入（git 跟踪的源码软链指向快照外仍然直接拒绝，见 createGateSnapshot）。
      : landing);
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
      if (await walkTree(join(path, name), childHash, walk, child, ancestors)) {
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
  if (!await walkTree(path, hash, walk, copy, new Set())) return null;
  return { digest: hash.digest("hex"), requires: [...walk.requires] };
}
