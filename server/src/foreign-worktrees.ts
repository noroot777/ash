// 认出「智能体自己 `git worktree add` 出来、Navi 不知道的工作区」，好在信息格里提示并收编（task-worktree-adopt.ts）。
//
// 只对没有独立工作区的任务问。候选是仓库登记里的每个 linked worktree，去掉这几类：
//   · 主工作区、项目目录本身、裸仓库、目录已经没了的（prunable）；
//   · Navi 管着的：开了独立工作区（`useWorktree`）的任务的 `.worktrees/<任务号>`。按登记认，不按路径长相：
//     智能体自己建在 `.worktrees/manual` 的、甚至恰好建在本任务标准位置上的，照样是候选；验收、审查、
//     更新基线用的临时 worktree 一律是 detached 检出，下一条顺手就排除了；
//   · detached 检出的：收编要把它落到任务分支上，没有分支就得替它新开一条，这种少见的情况不兜；
//   · 别的任务的：分支是别的任务的任务分支，或者别的任务的会话就在那个目录（或它底下）里跑。
//
// 剩下的还要有**这条任务在里面干过活的事实**。只认执行器已经确认过、结构化记下来的东西，不从展示用的文本
// 里抠命令：展示文本分不清执行、引用、注释和失败的调用（`echo 'cd <目录>'` 也长得像进了那个目录），
// 而且工具参数在那里被截断过（claude 的长 Write 截完就不是合法 JSON）。三种事实：
//   · 写入账（`task_writes`，executors/tool-writes.ts 记）：写成了的文件落在那个目录里，或者 codex 一条
//     命令真实的工作目录在里面。各个执行器的写文件形状由记账那一侧统一，这里只读归一后的路径；
//   · 会话行：本任务的会话就记在那个目录（或它底下）上（`cwd` / `worktreePath`）；
//   · claude 会话文件：claude 每条记录都带着它当时的工作目录（顶层 `cwd`），落在那个目录里。
// 这几种都只说明「在里面干过活」，说明不了是谁建的，所以提示里也不说「智能体建了它」。
//
// 只读：不建、不改、不加锁。真要收编时在仓库锁里再认一遍（task-worktree-adopt.ts）。
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { and, eq, inArray, ne } from "drizzle-orm";
import { taskIdPrefixOfBranch, isTaskBranchOf } from "@navi/shared/task-branch";
import { db } from "./db/index.js";
import { sessions, taskWrites, tasks } from "./db/schema.js";
import { expandHome } from "./git.js";
import { execFileText as exec } from "./exec.js";
import { insidePath, physicalPath, samePath, worktreePorcelain } from "./git-worktree-state.js";
import { claudeSessionFilePath } from "./handoff-collect.js";
import { sessionCliConfigDir } from "./auth/run-env.js";

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
 * 一个智能体在里面干过活、Navi 没管到的工作区。`path` 是 git 登记的真实路径（拿它做 git 操作），`seenAs` 是
 * 给人和智能体看的写法：会话行记着它就照会话行，否则照项目目录那种拼法（macOS 上 `/tmp/x` 登记成
 * `/private/tmp/x`，原样说出来对方认不出）。
 */
export type ForeignWorktree = { path: string; seenAs: string; branch: string; head: string; locked: boolean };

type Candidate = Omit<ForeignWorktree, "seenAs">;

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
async function structuralCandidates(task: TaskRow, repo: string, records: WorktreeRecord[]): Promise<Candidate[]> {
  const navi = physicalPath(join(repo, ".worktrees"));
  const others = await db.select({ cwd: sessions.cwd, worktreePath: sessions.worktreePath }).from(sessions)
    .where(ne(sessions.taskId, task.id));
  const claimed = others.flatMap((row) => [row.cwd, row.worktreePath]).filter((dir): dir is string => !!dir).map(expandHome);
  // `.worktrees/` 底下哪几个目录是开了独立工作区的任务的（任务号全局唯一，不限本项目）。没开的不算受管：
  // 本任务自己就是这种，智能体恰好把目录建在了它的标准位置上，正该收编。
  const underNavi = records.filter((record) => physicalPath(dirname(record.path)) === navi).map((record) => basename(record.path));
  const owned = new Set(underNavi.length
    ? (await db.select({ id: tasks.id }).from(tasks).where(and(inArray(tasks.id, underNavi), eq(tasks.useWorktree, true)))).map((row) => row.id)
    : []);
  const out: Candidate[] = [];
  for (const [index, record] of records.entries()) {
    if (index === 0 || record.bare || record.prunable || !record.branch || !record.head) continue;
    if (samePath(record.path, repo) || !existsSync(record.path)) continue;
    if (physicalPath(dirname(record.path)) === navi && owned.has(basename(record.path))) continue;
    if (taskIdPrefixOfBranch(record.branch) && !isTaskBranchOf(record.branch, task.id)) continue;
    if (claimed.some((dir) => insidePath(dir, record.path))) continue;
    out.push({ path: record.path, branch: record.branch, head: record.head, locked: record.locked });
  }
  return out;
}

type TaskEvidence = { dirs: string[]; writes: string[]; claudeCwds: string[] };

/** 这条任务自己留下的事实（见文件头）：会话行的目录、写入账、claude 会话文件里逐条记的工作目录。 */
async function taskEvidence(taskId: string): Promise<TaskEvidence> {
  const rows = await db.select().from(sessions).where(eq(sessions.taskId, taskId));
  const dirs = rows.flatMap((row) => [row.cwd, row.worktreePath]).filter((dir): dir is string => !!dir).map(expandHome);
  const writes = (await db.select({ path: taskWrites.path }).from(taskWrites).where(eq(taskWrites.taskId, taskId))).map((row) => row.path);
  const claudeCwds = new Set<string>();
  for (const row of rows) {
    if (row.agentType !== "claude" || !row.cliSessionId) continue;
    const configDir = await sessionCliConfigDir(row, "claude");
    const starts = new Set([row.cwd, row.worktreePath].filter((dir): dir is string => !!dir)
      .flatMap((dir) => [expandHome(dir), physicalPath(expandHome(dir))]));
    for (const start of starts) {
      const text = await readFile(claudeSessionFilePath(start, row.cliSessionId, configDir), "utf8").catch(() => "");
      for (const line of text.split("\n")) {
        if (!line.includes('"cwd"')) continue;
        try {
          const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
          if (typeof cwd === "string" && cwd) claudeCwds.add(cwd);
        } catch { /* 坏行跳过 */ }
      }
    }
  }
  return { dirs, writes, claudeCwds: [...claudeCwds] };
}

/** 这条任务在 `candidate` 里干过活的事实；没有就 null，有就给出该怎么写这个目录给人看。 */
function seenAs(candidate: Candidate, repo: string, evidence: TaskEvidence): string | null {
  const session = evidence.dirs.find((dir) => samePath(dir, candidate.path));
  const worked = !!session || [...evidence.dirs, ...evidence.writes, ...evidence.claudeCwds].some((path) => insidePath(path, candidate.path));
  if (!worked) return null;
  return session ?? join(repo, relative(physicalPath(repo), physicalPath(candidate.path)));
}

/** 这条任务在里面干过活、却不归 Navi 管的 worktree（见文件头）。仓库读不出来时当没有。 */
export async function foreignWorktreesOf(task: TaskRow, repoPath: string): Promise<ForeignWorktree[]> {
  if (task.useWorktree) return [];
  const repo = expandHome(repoPath);
  const records = await worktreeRecords(repo).catch(() => [] as WorktreeRecord[]);
  const candidates = await structuralCandidates(task, repo, records);
  if (!candidates.length) return [];
  const evidence = await taskEvidence(task.id);
  return candidates.flatMap((candidate) => {
    const seen = seenAs(candidate, repo, evidence);
    return seen ? [{ ...candidate, seenAs: seen }] : [];
  });
}
