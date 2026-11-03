// 封好的发布（git-accept-publish.ts）改目标检出文件的那一步不是事务：`read-tree -m -u` 逐个文件写，
// 写到一半失败（某个目录没有写权限、磁盘满）就以非零退出，之前那些文件已经是新内容了（第 6 轮审查 F1
// 实测：`a.txt` 成了新的、`locked/z.txt` 还是旧的，回执却说「工作区都没动」）。git 自己不撤，也不说
// 写了哪些。
//
// 所以写之前把这次要改的每个路径**原样留住**，失败后逐个核：
//  · 还是原来那个文件（同一个 inode）—— 没写到，不动；
//  · 正是这次写下的那个条目（按封好的语义比过内容、身份前后没变，见 landedIdentities），或者没了 ——
//    放回原来那个；
//  · 第三种 —— 不是这次写下的（或者写了一半），不替人做主，原样留着、报出来。
// 没能回到原样的路径全部交给调用方，回执据此如实说。只碰这次要改的路径，不用 `reset --hard` 这类会把
// 期间别人的改动一并撤掉的做法。
//
// 「原样」是整个文件，不只是字节和权限位（第 6 轮审查第 3 轮 F3：只拷字节、只 chmod，访问控制列表在
// 放回时丢了）。所以文件不拷贝，而是**硬链接**留住原来那个 inode（git 改文件是先删再建，原 inode 由这条
// 链接留着），放回就是再链回原位：字节、权限、ACL、扩展属性、属主一个不差，核对也按 inode 比。同一个
// 文件系统里留不了硬链接就在写之前拒。目录也算：这次新建的目录删掉；原有目录被删了重建的，权限位按原样
// 补回，但已不是原来那个，照实报。
//
// 放回只许改**这个检出里、这次写下的**条目（第 6 轮审查第 4、5 轮 F1：失败前或放回途中另一个窗口把
// `src` 挪走、原地换成指向项目外的链，按字符串路径「先查、再动」—— 不论动前查还是动后再查 —— 都会动到
// 项目外的文件，动后的补救本身也按变了的路径搬走了别人的文件）。查与动之间不能隔着一次路径解析，所以
// 放回整段在一个子进程里做（git-accept-rollback-child.ts）：逐级 chdir 进去、每一级核对身份（留备份时记下
// 的那一个，或者这次放回时自己建的那一个），之后只按相对名字动当前目录这个**目录对象**里的条目，路径
// 再被换也带不偏；删只删核过身份的、放用不覆盖的 link。核不过就不动、记成没回到原样，原样备份留给人。
// chdir 是整个进程共享的，所以不能在 ash 主进程里做。
import { link, lstat, mkdir, readlink, realpath, stat, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { execFileText } from "./exec.js";
import { RESTORE_CHILD } from "./git-accept-rollback-child.js";

/** `dev:ino`（bigint 读出，Windows 的文件号超过 2^53 也不丢精度）。 */
type Identity = string;
type Saved = { path: string } & (
  | { kind: "missing" }
  | { kind: "file"; keep: string; id: Identity }
  | { kind: "link"; target: string; id: Identity }
  | { kind: "other"; id: Identity });
type Dir = { path: string } & ({ existed: false } | { existed: true; id: Identity; mode: number });

/** `root` / `rootId` = 检出根（留备份那一刻）解析后的真实位置与它的身份。 */
export type Backup = { root: string; rootId: Identity; saved: Saved[]; dirs: Dir[] };

const idOf = (stats: { dev: bigint; ino: bigint }): Identity => `${stats.dev}:${stats.ino}`;
const at = async (path: string) => lstat(path, { bigint: true }).catch(() => null);

/**
 * 把 `checkout` 里这些路径（及它们的各级父目录）现在的样子留进 `dir`（须与检出同一个文件系统）。
 * `dir` 里另写一份 `MANIFEST.json`（备份文件名 → 检出里的路径），放不回时交给人手动取。
 */
export async function backupPaths(checkout: string, paths: readonly string[], dir: string): Promise<Backup> {
  await mkdir(dir, { recursive: true });
  const saved: Saved[] = [];
  const manifest: Record<string, string> = {};
  for (const [index, path] of paths.entries()) {
    const full = join(checkout, path);
    const stats = await at(full);
    if (!stats) saved.push({ path, kind: "missing" });
    else if (stats.isSymbolicLink()) saved.push({ path, kind: "link", target: await readlink(full), id: idOf(stats) });
    else if (stats.isFile()) {
      const keep = join(dir, String(index));
      const kept = await link(full, keep).then(() => at(keep), (error: unknown) => {
        throw new Error(`没法给 ${path} 留一份原样备份（${error instanceof Error ? error.message : String(error)}），`
          + "写坏了就放不回原样，所以这次一个文件都没写");
      });
      if (!kept || idOf(kept) !== idOf(stats)) throw new Error(`${path} 在留备份的时候被换掉了，这次一个文件都没写`);
      saved.push({ path, kind: "file", keep, id: idOf(stats) });
      manifest[String(index)] = path;
    } else saved.push({ path, kind: "other", id: idOf(stats) });
  }
  await writeFile(join(dir, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const parents = new Set<string>();
  for (const path of paths) for (let up = posix.dirname(path); up !== "."; up = posix.dirname(up)) parents.add(up);
  const dirs: Dir[] = [];
  for (const path of parents) {
    const stats = await at(join(checkout, path));
    if (!stats) dirs.push({ path, existed: false });
    else if (stats.isDirectory()) dirs.push({ path, existed: true, id: idOf(stats), mode: Number(stats.mode & 0o7777n) });
  }
  const root = await realpath(checkout);
  return { root, rootId: idOf(await stat(root, { bigint: true })), saved, dirs };
}

/**
 * 这次写下的条目各是哪一个：`check` 按封好的语义核出现在正是要落下那份的路径，核之前与之后各记一次
 * 身份（inode、ctime、大小），没变的才算 —— 内容核的就是这个条目。放回时只许拿走这些身份的条目。
 */
export async function landedIdentities(checkout: string, paths: readonly string[],
  check: () => Promise<ReadonlySet<string>>): Promise<Record<string, Identity>> {
  const before = new Map(await Promise.all(paths.map(async path => [path, await at(join(checkout, path))] as const)));
  const landed = await check();
  const ids: Record<string, Identity> = {};
  for (const path of landed) {
    const first = before.get(path);
    const now = await at(join(checkout, path));
    if (first && now && !first.isDirectory() && idOf(first) === idOf(now)
      && first.ctimeNs === now.ctimeNs && first.size === now.size) ids[path] = idOf(now);
  }
  return ids;
}

/**
 * 失败之后：把这次写下的路径放回原样（子进程里锚定目录对象做，见文件头）。返回没能回到原样的路径
 * （目录带结尾的 `/`；空 = 检出和改之前一样）。不抛：子进程起不来或说不清，就全部当成没回到原样。
 */
export async function restoreOwned(backup: Backup, landed: Record<string, Identity>): Promise<string[]> {
  const everything = [...backup.saved.map(saved => saved.path), ...backup.dirs.map(dir => `${dir.path}/`)];
  try {
    const { stdout } = await execFileText(process.execPath, ["-e", RESTORE_CHILD],
      { input: JSON.stringify({ ...backup, landed }), maxBuffer: 32 * 1024 * 1024 });
    const left: unknown = JSON.parse(stdout.trim().split("\n").pop() ?? "");
    return Array.isArray(left) && left.every(item => typeof item === "string") ? left : everything;
  } catch {
    return everything;
  }
}
