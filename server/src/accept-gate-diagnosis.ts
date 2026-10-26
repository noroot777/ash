// 门禁失败的**归类**这一层：把一次 rc≠0 翻译成「所以我该干什么」。
//
// 判定本身（哪些措辞算「命令不存在」）在 accept-gate-miss.ts，那边是纯函数、不碰
// git 也不碰库。这里负责两件 I/O：去仓库里核那几条 git 事实，以及把结论落到行上。
//
// 为什么核的是**仓库**而不是快照：快照里没有这条命令已经是既成事实，用户真正缺的那
// 条信息是「它在目标分支上是什么情形、我是不是只要把目标分支合进来就行」。这几条查询
// 全是只读（rev-parse / rev-list / grep / log），不动任何 ref，也不进仓库锁。
import { eq } from "drizzle-orm";
import type { AcceptGateFailure } from "@ash/shared/accept-gate";
import { db } from "./db/index.js";
import { acceptGateRuns, projects } from "./db/schema.js";
import { execFileText as exec } from "./exec.js";
import { acceptGateLogHead } from "./accept-gate-process.js";
import { classifyGateLaunch, gateCommandMissNotice, missFailure, type GateMissOrigin } from "./accept-gate-miss.js";

type GateRow = typeof acceptGateRuns.$inferSelect;

/** 日志开头读多少字节做判定。命令没启动时整份日志也就几百字节，这是宽松的上界。 */
const DIAGNOSIS_HEAD_BYTES = 16_000;

/** 最多报几个落点文件。再多就不是「缺一条命令」了，列表本身也没人读。 */
const MAX_HOLDERS = 5;

async function git(repo: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec("git", ["-C", repo, ...args], { maxBuffer: 4 * 1024 * 1024 });
    return stdout;
  } catch { return null; }
}

/** 这个名字在某棵树里出现在哪些文件。`git grep` 没命中时退出码非 0，等同空列表。 */
async function holdersIn(repo: string, commit: string, name: string): Promise<string[]> {
  const out = await git(repo, ["grep", "-l", "--fixed-strings", "-e", name, commit, "--", "."]);
  if (!out) return [];
  // 输出形如 `<commit>:<path>`，而 path 自己可能含冒号，所以只切第一个。
  return out.split("\n").filter(Boolean).map(line => line.slice(line.indexOf(":") + 1));
}

/** 这个路径在某棵树里是不是一个真实存在的文件。 */
async function blobExists(repo: string, commit: string, path: string): Promise<boolean> {
  return await git(repo, ["cat-file", "-e", `${commit}:${path}`]) !== null;
}

/** 某个落点在目标分支上**最早**是哪一次提交写进去的（从新往旧列，取最后一行）。 */
async function introducedBy(repo: string, targetCommit: string, sourceCommit: string | null,
  name: string | null, file: string, added: boolean): Promise<{ commit: string; date: string; subject: string } | null> {
  const log = await git(repo, ["log", "--format=%H%x09%cI%x09%s",
    ...(added ? ["--diff-filter=A"] : [`-S${name}`]),
    targetCommit, ...(sourceCommit ? ["--not", sourceCommit] : []), "--", file]);
  const oldest = (log ?? "").split("\n").filter(Boolean).at(-1);
  if (!oldest) return null;
  const [commit, date, ...subject] = oldest.split("\t");
  return { commit, date: date ?? "", subject: subject.join("\t") };
}

/**
 * 「它在目标分支上存不存在、是什么时候进去的」。
 *
 * 落点取的是**目标分支有、快照没有**的那些文件 —— 直接拿 pickaxe 搜全树会把无关的
 * 同名字串（`test:accept` 撞上既有的 `test:accept-merge`）也算进来，报出来的「什么
 * 时候进去的」就会指到一次毫无关系的提交上（实测如此）。
 */
async function readOrigin(repo: string, targetBranch: string, sourceCommit: string | null,
  name: string | null): Promise<GateMissOrigin | null> {
  const targetCommit = (await git(repo, ["rev-parse", "--verify", "--quiet", `${targetBranch}^{commit}`]))?.trim() || null;
  if (!targetCommit) return null;
  const behindOut = sourceCommit ? await git(repo, ["rev-list", "--count", `${sourceCommit}..${targetCommit}`]) : null;
  const behind = behindOut === null ? null : Number.parseInt(behindOut.trim(), 10);
  const origin: GateMissOrigin = { targetBranch, targetCommit,
    behind: Number.isFinite(behind as number) ? behind as number : null, holders: [], partial: !name };
  if (!name) return origin;
  // 先按**路径**认一次：`./kb.sh test full` 这种命令，缺的就是那个文件本身，而文件
  // 在不在一棵树里是 `cat-file -e` 一句话的事，比满树搜字串既准又便宜。
  const asPath = name.replace(/^\.\/+/, "");
  if (asPath && await blobExists(repo, targetCommit, asPath)
    && !(sourceCommit && await blobExists(repo, sourceCommit, asPath))) {
    const where = await introducedBy(repo, targetCommit, sourceCommit, name, asPath, true);
    if (where) origin.holders.push({ file: asPath, ...where });
    return origin;
  }
  const onTarget = await holdersIn(repo, targetCommit, name);
  const inSnapshot = sourceCommit ? new Set(await holdersIn(repo, sourceCommit, name)) : new Set<string>();
  const fresh = onTarget.filter(file => !inSnapshot.has(file)).slice(0, MAX_HOLDERS);
  for (const file of fresh) {
    const where = await introducedBy(repo, targetCommit, sourceCommit, name, file, false);
    if (where) origin.holders.push({ file, ...where });
  }
  return origin;
}

/**
 * 一次门禁红了之后的归类。返回 null = 认不出，照旧按「命令退出码非 0」处理。
 *
 * 只在 `exit_code` 这一档上问：超时、取消、被打断、起不来都已经有确切的理由了，再往
 * 上盖一层只会把那些更准的结论盖掉。
 */
export async function diagnoseGateFailure(row: GateRow, failure: AcceptGateFailure | null): Promise<
  { failure: AcceptGateFailure | null; diagnosis: string } | null
> {
  if (failure !== "exit_code") return null;
  const miss = classifyGateLaunch({ command: row.command, exitCode: row.exitCode ?? null,
    log: acceptGateLogHead(row.logPath, DIAGNOSIS_HEAD_BYTES) });
  if (!miss) return null;
  const repo = (await db.select().from(projects).where(eq(projects.id, row.projectId))).at(0)?.repoPath ?? null;
  const origin = repo && row.targetBranch
    ? await readOrigin(repo, row.targetBranch, row.sourceCommit ?? null, miss.name).catch(() => null)
    : null;
  return {
    failure: missFailure(miss) ?? failure,
    diagnosis: gateCommandMissNotice({ command: row.command, miss, sourceCommit: row.sourceCommit ?? null, origin }),
  };
}
