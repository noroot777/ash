// 「入口不在被测的树里」那句话的后半句：它在**目标分支**上有没有。
//
// 快照那一侧问的是内核（accept-gate-entry.ts 的 entryOnDisk），这一侧问的是**目标提交的树**，不看
// 目标分支此刻的检出 —— 检出可能脏、可能不在磁盘上。两边必须回答同一个问题：「把这棵树检出来，
// shell 照这个原样路径去找，找得到吗」。git 树里的名字是精确字节，检出后的文件系统却会把不同的
// 字节认成同一个名字，所以这里守一条不变量，而不是逐个补特例：
//
//   **说「有」或「没有」，必须能证明它和检出后的路径查找是同一个答案；证明不了就是 null**
//   （卡片写「这次没读出来」）。
//
// 证明只在一个保守的子集里做：
//  · 路径按原样逐段走，**一个字符都不丢**。只认开头的 `./`；空段（`a//b`、末尾 `/`）、中间或末尾的
//    `.`、`..` 一律 null —— 末尾 `/` 和 `/.` 要求最后一级是目录，丢掉它们就把 ENOTDIR 说成了「有」
//    （第 2 轮审查 F1）；`..` 要靠前一级的真实落点才解释得了。
//  · 点名的每一段都得是**可移植的名字**（`portableName`：POSIX 可移植文件名字符集、不以 `.` 结尾），
//    另外不是 Windows 设备名、不是 `.git`（`plainSegment`）。可移植的名字之间在任何常见文件系统上被认成
//    同一个，只可能是 ASCII 大小写不同。
//  · 每一级把那个目录的全部条目列出来比：精确命中之外，只要还有一个条目**可能是它的别名**
//    （ASCII 大小写相同，或者它本身就不可移植 —— Unicode 规范等价 NFC/NFD、Unicode 大小写折叠、
//    Windows 末尾的点和空格、8.3 短名都在这一类里，第 2 轮审查 F1 实测的就是 NFC/NFD），有和没有
//    都说不准。不去模拟哪个文件系统怎么折叠：折叠规则跟平台、卷格式、git 配置都有关，模拟错一个
//    就又是一句假话。
//  · 软链（120000）、子模块（160000）：它们后面是什么得按检出语义另解，这里不解（第 1 轮审查 F2）。
// 读目录用 `git ls-tree -z <commit>:<dir>`：dir 只由可移植名字拼成，不会被当成 pathspec 魔法。
import { readOnlyGit } from "./accept-gate-preview.js";
import { entryCertainlyMissing, probeGateEntry, type GateEntryProbe } from "./accept-gate-entry.js";

type Plan = { command: string; repoPath: string; targetBranch: string | null; targetCommit: string | null };

/**
 * 起跑前那份入口事实。核得准、又不在快照里的时候，顺带核一眼它在目标分支上有没有，跟着这一行落盘。
 */
export async function probeGateEntryWithTarget(snapshotCwd: string, plan: Plan): Promise<GateEntryProbe | null> {
  const probe = probeGateEntry(snapshotCwd, plan.command);
  if (!probe || !entryCertainlyMissing(probe) || !plan.targetBranch || !plan.targetCommit) return probe;
  const has = await entryInCommit(plan.repoPath, plan.targetCommit, probe.file).catch(() => null);
  return { ...probe, target: { branch: plan.targetBranch, has } };
}

/** 这个原样路径在那次提交检出后找不找得到。true = 一个普通文件；false = 确定没有；null = 证明不了。 */
export async function entryInCommit(repo: string, commit: string, file: string): Promise<boolean | null> {
  const segments = file.split("/");
  while (segments.length > 1 && segments[0] === ".") segments.shift();
  if (!segments.every(plainSegment)) return null;
  for (let at = 0; at < segments.length; at++) {
    const part = segments[at]!;
    const entries = await treeEntries(repo, at ? `${commit}:${segments.slice(0, at).join("/")}` : commit);
    const entry = entries.find(row => row.name === part);
    if (entries.some(row => row !== entry && mayAlias(row.name, part))) return null;
    if (!entry) return false;
    if (entry.mode === "120000" || entry.mode === "160000") return null;
    // 中间那一级是个文件：内核报 ENOTDIR，跟「没有」同一回事。
    if (at < segments.length - 1) { if (entry.type !== "tree") return false; continue; }
    return entry.type === "blob" ? true : null;
  }
  return null;
}

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

/** 只有这一类名字之间，「检出后是不是同一个」能被证明：至多差 ASCII 大小写。 */
function portableName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !name.endsWith(".");
}

/** 点名要找的那一段：除了可移植，还得是检出时真会落成一个普通名字的（设备名、`.git` 不会）。 */
function plainSegment(name: string): boolean {
  return portableName(name) && !WINDOWS_DEVICE.test(name) && name.toLowerCase() !== ".git";
}

/** 这个条目检出后**可能**和 `part`（已知可移植）是同一个名字。宁可多认，不可漏认。 */
function mayAlias(name: string, part: string): boolean {
  return !portableName(name) || name.toLowerCase() === part.toLowerCase();
}

/** 那个目录下的全部条目（`<mode> <type> <oid>\t<name>`）。 */
async function treeEntries(repo: string, treeish: string): Promise<{ mode: string; type: string; name: string }[]> {
  const { stdout } = await readOnlyGit(repo, ["ls-tree", "-z", treeish]);
  return stdout.split("\0").filter(Boolean).map(row => {
    const tab = row.indexOf("\t");
    const [mode = "", type = ""] = row.slice(0, tab).split(" ");
    return { mode, type, name: row.slice(tab + 1) };
  });
}
