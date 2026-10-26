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
/** landings 是这棵树里全部软链落在**树内**的位置，相对快照根、`/` 分隔，交给输入规划层补闭包。 */
export type GateTreeResult = { digest: string; landings: string[] };
type Copy = { root: string; path: string };
type Walk = GateTree & { realRoot: string; landings: Set<string> };

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
async function linkLanding(path: string, target: string): Promise<string> {
  const full = isAbsolute(target) ? target : `${dirname(path)}${sep}${target}`;
  try { return join(await realpath(dirname(full)), basename(full)); }
  catch { return resolve(dirname(path), target); }
}

export async function freezesAsSource(root: string, path: string): Promise<boolean> {
  if (isDependencyPath(relative(root, path))) return false;
  const target = await linkTarget(path);
  return !insideTree(await treeRealPath(root), await linkLanding(path, target));
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

// 跟随语义（stat + copyFile）：只给「非 Git 项目的源码外链」用，整棵拷成真文件/真目录，所以
// 目标里的软链也会被拍平。这是本次改动之前对所有输入的行为，这里把它保留给源码外链这一处，
// 换来的是「改了项目外的源码仍然直接复用上次通过」「测试写穿到项目外」两件事都不会发生。
// 只有跟随才会成环，所以环的防护也只留在这条路上。
async function freezeTree(path: string, hash: ReturnType<typeof createHash>, walk: Walk, copy: Copy | undefined,
  ancestors: Set<string>): Promise<boolean> {
  if (walk.filter && !walk.filter(path)) return false;
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
      if (await freezeTree(join(path, name), childHash, walk, child, next)) {
        hash.update(JSON.stringify(name)).update(childHash.digest());
      }
    }
  } else throw new Error(`测试输入不是普通文件或目录：${path}`);
  hash.update("\0");
  return true;
}

async function walkTree(path: string, hash: ReturnType<typeof createHash>, walk: Walk, copy?: Copy): Promise<boolean> {
  if (walk.filter && !walk.filter(path)) return false;
  const info = await entryStats(path);
  if (info === null) return false;
  if (info.isSymbolicLink()) {
    const target = await linkTarget(path);
    const landing = await linkLanding(path, target);
    const within = insideTree(walk.realRoot, landing);
    if (!within && !walk.dependency && !isDependencyPath(relative(walk.root, path))) {
      return await freezeTree(path, hash, walk, copy, new Set());
    }
    // 摘要只记落点、不记目标内容：落点在树内的话那条路径本身已经被摘要过，在树外的话它本就
    // 不是快照冻住的输入。树内落点一律归一成「相对快照根的路径」，所以原文写相对还是绝对，
    // 源树与副本都算出同一个值（createGateSnapshot 的回算对账要求两侧严格相等）。
    if (within) walk.landings.add(portable(relative(walk.realRoot, landing)));
    hash.update(within ? `link:${portable(relative(walk.realRoot, landing))}` : `link-outside:${landing}`);
    // 一律重建成软链、绝不跟随：拷成真文件会让「靠自身所在位置做相对解析」的运行时在快照里
    // 一启动就死（node_modules/.bin/tsx 找不到同胞 package-*.mjs、.venv/bin/python3 的
    // @executable_path 落到快照里没有的 ../lib）。不跟随之后目录软链成的环也自然消失了。
    if (copy) await copyLink(path, copy.path, within
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
      if (await walkTree(join(path, name), childHash, walk, child)) {
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
  const walk: Walk = { ...tree, realRoot: await treeRealPath(tree.root), landings: new Set() };
  // 副本落点由两侧根推算，而不是由调用方再传一遍，这样「副本严格镜像源树层级」是结构上成立的
  // ——树内软链的原文照抄依赖这一点。
  const copy = tree.destinationRoot === undefined ? undefined
    : { root: tree.destinationRoot, path: join(tree.destinationRoot, relative(tree.root, path)) };
  if (!await walkTree(path, hash, walk, copy)) return null;
  return { digest: hash.digest("hex"), landings: [...walk.landings] };
}
