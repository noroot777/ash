// 合并预览档：快照里的文件与「合进去之后目标检出磁盘上的文件」是不是同一份。
//
// 快照是按现在的检出语义把整棵树全新写出来的；真合并却只重写这次改到的文件 —— 目标检出里没被
// 改到的那些，磁盘上还是它们当初检出时的样子（比如换行设置改之前写下的 LF，`git status` 照样干净）。
// 树一样、配置身份一样，字节却不一样，门禁测的就不是合进去之后那份（第 4 轮复审 F2）。这一层不去
// 枚举「哪些设置会造成这种差」，直接比结果：没被这次改到的每个文件，类型、链接目标、可执行位、字节。
// 只读文件和只读的 git 查询（readOnlyGit），不调起项目程序。目标分支没检出在任何地方就没有磁盘状态可比
// （之后谁检出都是全新写的，与快照同一份）；检出着但不在被测提交上，最终合并会拒，这里也不比。
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { join, sep } from "node:path";
import { readOnlyGit } from "./accept-gate-preview.js";
import { registeredCheckout } from "./git-worktree-state.js";

const digest = (path: string) => new Promise<string>((resolve, reject) => {
  const hash = createHash("sha256");
  createReadStream(path).on("error", reject).on("data", chunk => hash.update(chunk)).on("end", () => resolve(hash.digest("hex")));
});

const zList = async (repo: string, args: string[]) => (await readOnlyGit(repo, args)).stdout.split("\0").filter(Boolean);

/** 两边同一路径是不是同一份文件（不存在、类型、链接目标、可执行位、字节，任一不同就不是）。 */
async function sameEntry(left: string, right: string): Promise<boolean> {
  const [a, b] = await Promise.all([lstat(left).catch(() => null), lstat(right).catch(() => null)]);
  if (!a || !b) return !a && !b;
  if (a.isSymbolicLink() || b.isSymbolicLink()) {
    return a.isSymbolicLink() && b.isSymbolicLink() && await readlink(left) === await readlink(right);
  }
  // 子模块（gitlink）两边都只是个目录，里面装什么不归这棵树管。
  if (a.isDirectory() && b.isDirectory()) return true;
  if (a.isFile() !== b.isFile() || (a.mode & 0o111) !== (b.mode & 0o111) || a.size !== b.size) return false;
  return !a.isFile() || await digest(left) === await digest(right);
}

/**
 * 目标检出里那些合并不会重写、却和快照里不是同一份的文件（相对路径）。`base` 是被测时的目标提交，
 * `tree` 是测过的那棵；`borrowed` 是快照里借自任务工作区的依赖目录（故意不同，不比）。
 */
export async function checkoutDivergence(repo: string, targetBranch: string, base: string, tree: string,
  snapshot: string, borrowed: readonly string[]): Promise<string[]> {
  const checkout = (await registeredCheckout(repo, targetBranch).catch(() => null))?.path;
  if (!checkout) return [];
  if ((await readOnlyGit(checkout, ["rev-parse", "HEAD"]).catch(() => null))?.stdout.trim() !== base) return [];
  const rewritten = new Set(await zList(repo, ["diff-tree", "-r", "--name-only", "-z", base, tree]));
  const skip = borrowed.map(dep => dep.split(sep).join("/"));
  const drifted: string[] = [];
  for (const path of await zList(repo, ["ls-tree", "-r", "--name-only", "-z", tree])) {
    if (rewritten.has(path) || skip.some(dep => path === dep || path.startsWith(`${dep}/`))) continue;
    if (!(await sameEntry(join(checkout, path), join(snapshot, path)))) drifted.push(path);
  }
  return drifted;
}
