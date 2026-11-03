// 封好的发布（git-accept-publish.ts）改目标检出文件的那一步不是事务：`read-tree -m -u` 逐个文件写，
// 写到一半失败（某个目录没有写权限、磁盘满）就以非零退出，之前那些文件已经是新内容了（第 6 轮审查 F1
// 实测：`a.txt` 成了新的、`locked/z.txt` 还是旧的，回执却说「工作区都没动」）。git 自己不撤，也不说
// 写了哪些。
//
// 所以写之前把这次要改的每个路径**原样备份**（字节、权限、链接目标、不存在），失败后按备份逐个核：
//  · 和备份一样 —— 没写到，不动；
//  · 正是要落下的那份（按封好的语义比，见 git-accept-publish.ts 的 atTree），或者没了 —— 是这次写的，
//    按备份放回去；
//  · 第三种内容 —— 不是这次写下的（或者写了一半），不替人做主，原样留着、报出来。
// 放回之后再核一遍。没能回到备份那份的路径全部交给调用方，回执据此如实说。只碰这次要改的路径，
// 不用 `reset --hard` 这类会把期间别人的改动一并撤掉的做法。
import { chmod, copyFile, lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { entryOf } from "./accept-gate-physical.js";

type Saved = { path: string; entry: string } & (
  | { kind: "missing" } | { kind: "file"; copy: string; mode: number } | { kind: "link"; target: string } | { kind: "other" });

export type Backup = Saved[];

/** 把 `checkout` 里这些路径现在的样子存进 `dir`。 */
export async function backupPaths(checkout: string, paths: readonly string[], dir: string): Promise<Backup> {
  await mkdir(dir, { recursive: true });
  const saved: Saved[] = [];
  for (const [index, path] of paths.entries()) {
    const full = join(checkout, path);
    const entry = await entryOf(full);
    const stat = await lstat(full).catch(() => null);
    if (!stat) saved.push({ path, entry, kind: "missing" });
    else if (stat.isSymbolicLink()) saved.push({ path, entry, kind: "link", target: await readlink(full) });
    else if (stat.isFile()) {
      const copy = join(dir, String(index));
      await copyFile(full, copy);
      saved.push({ path, entry, kind: "file", copy, mode: stat.mode & 0o7777 });
    } else saved.push({ path, entry, kind: "other" });
  }
  return saved;
}

async function putBack(full: string, saved: Saved): Promise<void> {
  if (saved.kind === "other") return;
  await rm(full, { force: true });
  if (saved.kind === "missing") return;
  await mkdir(dirname(full), { recursive: true });
  if (saved.kind === "link") return symlink(saved.target, full);
  await copyFile(saved.copy, full);
  await chmod(full, saved.mode);
}

/**
 * 失败之后：把这次写下的路径放回备份那份。`landed` = 现在正是要落下那份的路径。返回没能回到备份
 * 那份的路径（空 = 检出和改之前一样）。
 */
export async function restoreOwned(checkout: string, backup: Backup, landed: ReadonlySet<string>): Promise<string[]> {
  const left: string[] = [];
  for (const saved of backup) {
    const full = join(checkout, saved.path);
    const now = await entryOf(full).catch(() => "unreadable");
    if (now === saved.entry) continue;
    if (now === "missing" || landed.has(saved.path)) await putBack(full, saved).catch(() => undefined);
    if (await entryOf(full).catch(() => "unreadable") !== saved.entry) left.push(saved.path);
  }
  return left;
}
