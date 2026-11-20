// 认出「智能体自己 `git worktree add` 出来、Navi 不知道的工作区」，好在信息格里提示并收编（task-worktree-adopt.ts）。
//
// 只对没有独立工作区的任务问。候选是仓库登记里的每个 linked worktree，去掉这几类：
//   · 主工作区、项目目录本身、裸仓库、目录已经没了的（prunable）；
//   · Navi 自己的：`<repo>/.worktrees/` 底下的任务工作区，以及验收、审查、更新基线用的临时 worktree
//     （那几种一律是 detached 检出，下一条顺手就排除了）；
//   · detached 检出的：收编要把它落到任务分支上，没有分支就得替它新开一条，这种少见的情况不兜；
//   · 别的任务的：分支是别的任务的任务分支，或者别的任务的会话就在那个目录里跑。
// 剩下的还要有**这条任务自己的证据**：它会话的执行轨迹（工具调用的参数，所有执行器同一种格式）或正文里
// 出现过这个目录（绝对路径，或相对项目目录的写法，比如 `../x`、`.claude/worktrees/x`）。没有证据的
// worktree 可能是用户自己开的，不归这条任务，一律不提。
//
// 只读：不建、不改、不加锁。真要收编时在仓库锁里再认一遍（task-worktree-adopt.ts）。
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { eq, ne } from "drizzle-orm";
import { taskIdPrefixOfBranch, isTaskBranchOf } from "@navi/shared/task-branch";
import { db } from "./db/index.js";
import { sessions, tasks } from "./db/schema.js";
import { expandHome } from "./git.js";
import { execFileText as exec } from "./exec.js";
import { physicalPath, samePath, worktreePorcelain } from "./git-worktree-state.js";
import { readableRunPath, sessionTracePath, sessionTranscriptPath } from "./transcript.js";

type TaskRow = typeof tasks.$inferSelect;

/** 仓库登记里的一个 worktree（`git worktree list --porcelain` 的一条）。 */
export type WorktreeRecord = {
  path: string;
  head: string | null;
  branch: string | null;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
};

/**
 * 一个智能体自建、Navi 没管到的工作区。`path` 是 git 登记的真实路径（拿它做 git 操作），`seenAs` 是会话里
 * 写的那种拼法（给人和智能体看：macOS 上 `/tmp/x` 登记成 `/private/tmp/x`，原样说出来对方认不出）。
 */
export type ForeignWorktree = { path: string; seenAs: string; branch: string; head: string; locked: boolean };

export async function worktreeRecords(repo: string): Promise<WorktreeRecord[]> {
  const stdout = await worktreePorcelain(async (args) => (await exec("git", ["-C", repo, ...args])).stdout);
  return stdout.split("\0\0").filter(Boolean).map((record) => {
    const fields = record.split("\0");
    const field = (name: string) => fields.find((line) => line === name || line.startsWith(`${name} `));
    return {
      path: field("worktree")!.slice(9),
      head: field("HEAD")?.slice(5) ?? null,
      branch: fields.find((line) => line.startsWith("branch refs/heads/"))?.slice(18) ?? null,
      bare: !!field("bare"),
      locked: !!field("locked"),
      prunable: !!field("prunable"),
    };
  });
}

/** 结构上就不可能是智能体自建工作区的那几类（见文件头），不看证据。 */
async function structuralCandidates(task: TaskRow, repo: string, records: WorktreeRecord[]): Promise<Omit<ForeignWorktree, "seenAs">[]> {
  const navi = physicalPath(join(repo, ".worktrees")) + sep;
  const others = await db.select({ cwd: sessions.cwd, worktreePath: sessions.worktreePath }).from(sessions)
    .where(ne(sessions.taskId, task.id));
  const claimed = others.flatMap((row) => [row.cwd, row.worktreePath]).filter((dir): dir is string => !!dir).map(expandHome);
  const out: Omit<ForeignWorktree, "seenAs">[] = [];
  for (const [index, record] of records.entries()) {
    if (index === 0 || record.bare || record.prunable || !record.branch || !record.head) continue;
    if (samePath(record.path, repo) || physicalPath(record.path).startsWith(navi) || !existsSync(record.path)) continue;
    if (taskIdPrefixOfBranch(record.branch) && !isTaskBranchOf(record.branch, task.id)) continue;
    if (claimed.some((dir) => samePath(dir, record.path))) continue;
    out.push({ path: record.path, branch: record.branch, head: record.head, locked: record.locked });
  }
  return out;
}

/**
 * 这个目录在文本里可能的写法：git 登记的是真实路径（macOS 上 `/private/tmp/...`），智能体多半照项目目录的拼法写；
 * 嵌在项目目录里、或跟它同级的，还常写成相对路径。只有一段名字的相对写法（`wt`）太容易撞上别的东西，不算。
 */
function spellingsOf(path: string, repo: string): string[] {
  const real = physicalPath(path);
  const repoReal = physicalPath(repo);
  const rel = relative(repoReal, real);
  const abs = [real, resolve(path), ...[repo, repoReal].map((dir) => join(dir, rel))];
  return [...new Set([...abs, ...(rel.includes(sep) ? [rel] : [])])];
}

const NAME_CHAR = /[\w.-]/;

/** `text` 里出现了 `needle` 这个路径本身（前后不是路径名里的字符，免得 `/a/wt` 认成 `/a/wt2`）。 */
export function mentionsPath(text: string, needle: string): boolean {
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    const before = text[at - 1] ?? "";
    const after = text[at + needle.length] ?? "";
    if (!/[\w-]/.test(before) && !NAME_CHAR.test(after)) return true;
  }
  return false;
}

/** 这条任务自己的会话记录（执行轨迹 + 正文），读不到的跳过。 */
async function taskSessionTexts(taskId: string): Promise<string[]> {
  const rows = await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.taskId, taskId));
  const files = rows.flatMap((row) => [sessionTracePath(taskId, row.id), sessionTranscriptPath(taskId, row.id)]).map(readableRunPath);
  const texts = await Promise.all(files.map((file) => readFile(file, "utf8").catch(() => "")));
  return texts.filter(Boolean);
}

/** 这条任务会话里用到过、却不归 Navi 管的 worktree（见文件头）。仓库读不出来时当没有。 */
export async function foreignWorktreesOf(task: TaskRow, repoPath: string): Promise<ForeignWorktree[]> {
  if (task.useWorktree) return [];
  const repo = expandHome(repoPath);
  const records = await worktreeRecords(repo).catch(() => [] as WorktreeRecord[]);
  const candidates = await structuralCandidates(task, repo, records);
  if (!candidates.length) return [];
  const texts = await taskSessionTexts(task.id);
  return candidates.flatMap((candidate) => {
    const seen = spellingsOf(candidate.path, repo).find((needle) => texts.some((text) => mentionsPath(text, needle)));
    return seen ? [{ ...candidate, seenAs: isAbsolute(seen) ? seen : join(repo, seen) }] : [];
  });
}
