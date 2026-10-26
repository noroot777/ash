import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, readlink, stat, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** 源树一侧的遍历参照系：软链指向树内还是树外、以及树内链怎么映射到副本，全以 root 为参照。 */
export type GateTree = { root: string; destinationRoot?: string; filter?: (path: string) => boolean };
/** 副本一侧：root 是副本根，path 是当前条目在副本里的落点；两侧层级结构严格镜像。 */
type Copy = { root: string; path: string };

export const insideTree = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
};

// junction 的 readlink 回来是 \\?\D:\...\ 这种 Win32 长路径形式，不剥掉前缀和尾部分隔符，
// path.relative 认不出它其实在树内（实测 relative("D:\\repo", "\\\\?\\D:\\repo\\nm") 原样返回长路径）。
const longPath = /^\\\\\?\\(?=[A-Za-z]:\\)/;
async function linkTarget(path: string): Promise<string> {
  const raw = await readlink(path);
  if (process.platform !== "win32") return raw;
  const stripped = raw.replace(longPath, "");
  return stripped.length > 3 && stripped.endsWith(sep) ? stripped.slice(0, -1) : stripped;
}

async function copyLink(source: string, destination: string, target: string): Promise<void> {
  if (process.platform !== "win32") return await symlink(target, destination);
  const directory = await stat(source).then(info => info.isDirectory(), () => false);
  try { return await symlink(target, destination, directory ? "dir" : "file"); }
  catch (error) {
    // Windows 上建文件软链要 SeCreateSymbolicLinkPrivilege（开发者模式或管理员）；目录可以退到
    // junction——它不要权限，只认绝对路径，而且 node 同样把它报成 isSymbolicLink()，于是
    // 副本与源树的摘要仍然对得上。文件软链退不了：拷成真文件正是本模块要修的那个 bug
    // （依赖自身位置做相对解析的运行时会当场死），所以宁可停在这里把原因说清楚。
    if (!directory || !["EPERM", "EACCES", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new Error(`无法在测试快照中重建符号链接 ${source}（${(error as Error).message}）；`
        + "Windows 上请开启开发者模式或以管理员身份运行 ash，或改用不含文件软链的依赖安装方式");
    }
  }
  await symlink(resolve(dirname(destination), target), destination, "junction");
}

async function walkTree(path: string, hash: ReturnType<typeof createHash>, tree: GateTree, copy?: Copy): Promise<boolean> {
  if (tree.filter && !tree.filter(path)) return false;
  let info: Awaited<ReturnType<typeof lstat>>;
  try { info = await lstat(path); }
  catch (error) {
    // 读完目录到读条目之间文件被删掉（依赖树随时在被包管理器改）不该崩掉整次快照；
    // ELOOP 留着兜中间路径成分成环的极端情况。悬空软链不再走这条路——lstat 不解析末端成分。
    if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
  if (info.isSymbolicLink()) {
    const target = await linkTarget(path);
    const resolved = resolve(dirname(path), target);
    const within = insideTree(tree.root, resolved);
    // 摘要只记落点、不记目标内容：落点在树内的话那条路径本身已经被摘要过，在树外的话它本就
    // 不是快照冻住的输入。树内落点一律归一成「相对快照根的路径」，所以原文写相对还是绝对，
    // 源树与副本都算出同一个值（createGateSnapshot 的回算对账要求两侧严格相等）。
    hash.update(within ? `link:${relative(tree.root, resolved).split(sep).join("/")}` : `link-outside:${resolved}`);
    // 一律重建成软链、绝不跟随：拷成真文件会让「靠自身所在位置做相对解析」的运行时在快照里
    // 一启动就死（node_modules/.bin/tsx 找不到同胞 package-*.mjs、.venv/bin/python3 的
    // @executable_path 落到快照里没有的 ../lib）。不跟随之后目录软链成的环也自然消失了。
    if (copy) await copyLink(path, copy.path, within
      // 树内：相对原文照抄即可——副本层级一致，于是它自然指向副本自己那份（顺带修掉「worktree 里
      // node_modules/@ash/shared 解析到主仓」那条老坑）；绝对原文必须改写到副本，否则测试会被
      // 拉回活动工作区。树内链指向的那份内容没进快照时（比如被 filter 排掉）副本里会留一条悬空
      // 链，这与「快照只装登记过的输入」一致，不另作补偿。
      ? (isAbsolute(target) ? join(copy.root, relative(tree.root, resolved)) : target)
      // 树外：改写成绝对落点原样保留。相对原文照抄会因为快照与项目目录深度不同而指错地方
      // （worktree 借主仓 node_modules 就是这个形状）。保留而不是跳过或拒绝建快照，是因为
      // .venv/bin/python -> /opt/homebrew/... 这类链本身就是解释器，跳过等于把 venv 弄残、
      // 拒绝等于每台装了 homebrew/uv venv 的机器都过不了门禁；而被指向的 pnpm store、uv
      // cache、homebrew 前缀在实践中是内容寻址或只读的。代价是快照对这部分依赖不再是冻住的
      // 输入（git 跟踪的源码软链指向快照外仍然直接拒绝，见 createGateSnapshot）。
      : resolved);
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
      if (await walkTree(join(path, name), childHash, tree, child)) {
        hash.update(JSON.stringify(name)).update(childHash.digest());
      }
    }
  } else throw new Error(`测试输入不是普通文件或目录：${path}`);
  hash.update("\0");
  return true;
}

export async function gateTreeDigest(path: string, tree: GateTree): Promise<string | null> {
  const hash = createHash("sha256");
  if (!insideTree(tree.root, path)) throw new Error(`测试输入不在快照根内：${path}`);
  // 副本落点由两侧根推算，而不是由调用方再传一遍，这样「副本严格镜像源树层级」是结构上成立的
  // ——树内软链的原文照抄依赖这一点。
  const copy = tree.destinationRoot === undefined ? undefined
    : { root: tree.destinationRoot, path: join(tree.destinationRoot, relative(tree.root, path)) };
  return await walkTree(path, hash, tree, copy) ? hash.digest("hex") : null;
}
