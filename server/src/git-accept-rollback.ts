// 封好的发布（git-accept-publish.ts）改目标检出文件的那一步不是事务：`read-tree -m -u` 逐个文件写，
// 写到一半失败（某个目录没有写权限、磁盘满）就以非零退出，之前那些文件已经是新内容了（第 6 轮审查 F1
// 实测：`a.txt` 成了新的、`locked/z.txt` 还是旧的，回执却说「工作区都没动」）。git 自己不撤，也不说
// 写了哪些。
//
// 所以写之前把这次要改的每个路径**原样留住**，失败后逐个核：
//  · 还是原来那个文件（同一个 inode）—— 没写到，不动；
//  · 正是要落下的那份（按封好的语义比，见 git-accept-publish.ts 的 atTree），或者没了 —— 是这次写的，
//    放回原来那个；
//  · 第三种内容 —— 不是这次写下的（或者写了一半），不替人做主，原样留着、报出来。
// 放回之后再核一遍。没能回到原样的路径全部交给调用方，回执据此如实说。只碰这次要改的路径，
// 不用 `reset --hard` 这类会把期间别人的改动一并撤掉的做法。
//
// 「原样」是整个文件，不只是字节和权限位（第 6 轮审查第 3 轮 F3：只拷字节、只 chmod，访问控制列表在
// 放回时丢了，原先禁止执行的脚本放回后能跑了，回执却说原样）。所以文件不拷贝，而是**硬链接**留住原来
// 那个 inode（git 改文件是先删再建，原 inode 由这条链接留着），放回就是把它挪回原位：字节、权限、
// ACL、扩展属性、属主一个不差，核对也按 inode 比。同一个文件系统里留不了硬链接就在写之前拒。
// 目录也算：这次新建的目录失败后删掉；原有目录被删了重建的，权限位按原样补回，但已不是原来那个，照实报。
import { chmod, link, lstat, mkdir, readlink, rename, rm, rmdir, symlink } from "node:fs/promises";
import { dirname, join, posix } from "node:path";

type Identity = { dev: number; ino: number };
type Saved = { path: string } & (
  | { kind: "missing" }
  | { kind: "file"; keep: string; id: Identity }
  | { kind: "link"; target: string; id: Identity }
  | { kind: "other"; id: Identity });
type Dir = { path: string } & ({ existed: false } | { existed: true; id: Identity; mode: number });

export type Backup = { saved: Saved[]; dirs: Dir[] };

const idOf = (stat: { dev: number; ino: number }): Identity => ({ dev: stat.dev, ino: stat.ino });
const same = (stat: { dev: number; ino: number } | null, id: Identity) => !!stat && stat.dev === id.dev && stat.ino === id.ino;
const depth = (path: string) => path.split("/").length;
const at = async (path: string) => lstat(path).catch(() => null);

/** 把 `checkout` 里这些路径（及它们的各级父目录）现在的样子留进 `dir`（须与检出同一个文件系统）。 */
export async function backupPaths(checkout: string, paths: readonly string[], dir: string): Promise<Backup> {
  await mkdir(dir, { recursive: true });
  const saved: Saved[] = [];
  for (const [index, path] of paths.entries()) {
    const full = join(checkout, path);
    const stat = await at(full);
    if (!stat) saved.push({ path, kind: "missing" });
    else if (stat.isSymbolicLink()) saved.push({ path, kind: "link", target: await readlink(full), id: idOf(stat) });
    else if (stat.isFile()) {
      const keep = join(dir, String(index));
      await link(full, keep).catch((error: unknown) => {
        throw new Error(`没法给 ${path} 留一份原样备份（${error instanceof Error ? error.message : String(error)}），`
          + "写坏了就放不回原样，所以这次一个文件都没写");
      });
      saved.push({ path, kind: "file", keep, id: idOf(stat) });
    } else saved.push({ path, kind: "other", id: idOf(stat) });
  }
  const parents = new Set<string>();
  for (const path of paths) for (let up = posix.dirname(path); up !== "."; up = posix.dirname(up)) parents.add(up);
  const dirs: Dir[] = [];
  for (const path of parents) {
    const stat = await at(join(checkout, path));
    if (!stat) dirs.push({ path, existed: false });
    else if (stat.isDirectory()) dirs.push({ path, existed: true, id: idOf(stat), mode: stat.mode & 0o7777 });
  }
  return { saved, dirs };
}

async function clear(full: string): Promise<void> {
  const stat = await at(full);
  if (!stat) return;
  await (stat.isDirectory() ? rmdir(full) : rm(full, { force: true }));
}

async function putBack(full: string, saved: Saved): Promise<void> {
  if (saved.kind === "other") return;
  await clear(full);
  if (saved.kind === "missing") return;
  await mkdir(dirname(full), { recursive: true });
  if (saved.kind === "link") return symlink(saved.target, full);
  await rename(saved.keep, full);
}

async function isBack(full: string, saved: Saved): Promise<boolean> {
  const stat = await at(full);
  if (saved.kind === "missing") return !stat;
  if (saved.kind === "link") return !!stat?.isSymbolicLink() && await readlink(full).then(t => t === saved.target, () => false);
  return same(stat, saved.id);
}

/**
 * 失败之后：把这次写下的路径放回原样。`landed` = 现在正是要落下那份的路径。返回没能回到原样的路径
 * （目录带结尾的 `/`；空 = 检出和改之前一样）。
 */
export async function restoreOwned(checkout: string, backup: Backup, landed: ReadonlySet<string>): Promise<string[]> {
  const left: string[] = [];
  // 深的先放：文件改成目录时，目录里的东西得先清掉，原来那个文件才放得回去。
  for (const saved of [...backup.saved].sort((a, b) => depth(b.path) - depth(a.path))) {
    const full = join(checkout, saved.path);
    if (await isBack(full, saved)) continue;
    const now = await at(full);
    if (!now || landed.has(saved.path)) await putBack(full, saved).catch(() => undefined);
    if (!await isBack(full, saved)) left.push(saved.path);
  }
  for (const dir of [...backup.dirs].sort((a, b) => depth(b.path) - depth(a.path))) {
    const full = join(checkout, dir.path);
    const stat = await at(full);
    if (!dir.existed) {
      if (stat?.isDirectory() && !await rmdir(full).then(() => true, () => false)) left.push(`${dir.path}/`);
      continue;
    }
    if (same(stat, dir.id)) continue;
    if (stat?.isDirectory()) await chmod(full, dir.mode).catch(() => undefined);
    left.push(`${dir.path}/`);
  }
  return left;
}
