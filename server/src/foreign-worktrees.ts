// 认出「智能体自己 `git worktree add` 出来、Navi 不知道的工作区」，好在信息格里提示并收编（task-worktree-adopt.ts）。
//
// 只对没有独立工作区的任务问。候选是仓库登记里的每个 linked worktree，去掉这几类：
//   · 主工作区、项目目录本身、裸仓库、目录已经没了的（prunable）；
//   · Navi 自己的：`<repo>/.worktrees/<任务号>`（按任务登记认，不按父目录一刀切：智能体自己建在
//     `.worktrees/manual` 的照样是候选），以及验收、审查、更新基线用的临时 worktree（那几种一律是
//     detached 检出，下一条顺手就排除了）；
//   · detached 检出的：收编要把它落到任务分支上，没有分支就得替它新开一条，这种少见的情况不兜；
//   · 别的任务的：分支是别的任务的任务分支，或者别的任务的会话就在那个目录里跑。
//
// 剩下的还要有**这条任务在里面干过活的证据**，路径在记录里出现过不算（「这是用户的目录，别用」也会出现路径）。
// 只认这几种结构化的证据：
//   · 会话行：本任务的会话就记在那个目录上（`cwd` / `worktreePath`）；
//   · claude 会话文件：每条记录带着当时的工作目录（`"cwd":"..."`），落在那个目录或它底下；
//   · 执行轨迹（工具调用的参数，所有执行器同一种格式）里的动作：`git worktree add` 建它、`cd` 进去、
//     `git -C` 对它跑命令、工具参数的工作目录（`cwd` / `workdir`）落在里面、改写类工具（Edit / Write /
//     apply_patch）改了里面的文件。读、列目录、echo 这些不算。
// 路径的写法：绝对路径（git 登记的真实路径，或项目目录那种拼法），或相对项目目录的写法（`../x`、`.claude/worktrees/x`）。
//
// 只读：不建、不改、不加锁。真要收编时在仓库锁里再认一遍（task-worktree-adopt.ts）。
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { eq, inArray, ne } from "drizzle-orm";
import { taskIdPrefixOfBranch, isTaskBranchOf } from "@navi/shared/task-branch";
import { db } from "./db/index.js";
import { sessions, tasks } from "./db/schema.js";
import { expandHome } from "./git.js";
import { execFileText as exec } from "./exec.js";
import { physicalPath, samePath, worktreePorcelain } from "./git-worktree-state.js";
import { readableRunPath, sessionTracePath } from "./transcript.js";
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
 * 一个智能体自建、Navi 没管到的工作区。`path` 是 git 登记的真实路径（拿它做 git 操作），`seenAs` 是会话里
 * 写的那种拼法（给人和智能体看：macOS 上 `/tmp/x` 登记成 `/private/tmp/x`，原样说出来对方认不出）。
 * `created`：轨迹里有智能体 `git worktree add` 它的那一步（没有就只知道它在里面干过活）。
 */
export type ForeignWorktree = { path: string; seenAs: string; branch: string; head: string; locked: boolean; created: boolean };

type Candidate = Omit<ForeignWorktree, "seenAs" | "created">;

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
  // `.worktrees/` 底下哪几个目录名是登记过的任务（任务号全局唯一，不限本项目）。
  const underNavi = records.filter((record) => physicalPath(dirname(record.path)) === navi).map((record) => basename(record.path));
  const owned = new Set(underNavi.length
    ? (await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.id, underNavi))).map((row) => row.id) : []);
  const out: Candidate[] = [];
  for (const [index, record] of records.entries()) {
    if (index === 0 || record.bare || record.prunable || !record.branch || !record.head) continue;
    if (samePath(record.path, repo) || !existsSync(record.path)) continue;
    if (physicalPath(dirname(record.path)) === navi && owned.has(basename(record.path))) continue;
    if (taskIdPrefixOfBranch(record.branch) && !isTaskBranchOf(record.branch, task.id)) continue;
    if (claimed.some((dir) => samePath(dir, record.path))) continue;
    out.push({ path: record.path, branch: record.branch, head: record.head, locked: record.locked });
  }
  return out;
}

/**
 * 这个目录在记录里可能的写法：git 登记的是真实路径（macOS 上 `/private/tmp/...`），智能体多半照项目目录的拼法写；
 * 嵌在项目目录里、或跟它同级的，还常写成相对路径。只有一段名字的相对写法（`wt`）太容易撞上别的东西，不算。
 * 绝对写法排在前面（给人看时优先用它）。
 */
function spellingsOf(path: string, repo: string): string[] {
  const real = physicalPath(path);
  const repoReal = physicalPath(repo);
  const rel = relative(repoReal, real);
  const abs = [real, resolve(path), ...[repo, repoReal].map((dir) => join(dir, rel))];
  return [...new Set([...abs, ...(rel.includes(sep) ? [rel] : [])])];
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** 路径到这里为止，或者接着是它底下的东西（`/`）、引号、分隔符：免得 `/a/wt` 认成 `/a/wt2`。 */
const END = String.raw`(?=$|[\s'"/;&|)\\])`;

/** 一个路径参数落在 `dir`（某种写法）上或它底下。 */
const insideDir = (value: unknown, dir: string): boolean =>
  typeof value === "string" && (value === dir || value.startsWith(`${dir}/`));

/** 一条命令文本里，对这个目录做了「干活」的动作（建、进、对它跑 git、改它里面的文件）。返回是不是在建它。 */
export function commandWorksIn(command: string, dir: string): "created" | "worked" | null {
  const d = escape(dir);
  if (new RegExp(String.raw`\bworktree\s+add\b[^\n;&|]*?(?<=[\s'"=])${d}${END}`).test(command)) return "created";
  const worked = [
    String.raw`(?:^|[\s;&|('"])cd\s+['"]?${d}${END}`,
    String.raw`\bgit\s+-C\s+['"]?${d}${END}`,
    String.raw`^\*\*\* (?:Add|Update|Delete) File: ${d}/`,
  ];
  return worked.some((pattern) => new RegExp(pattern, "m").test(command)) ? "worked" : null;
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** 一条工具调用（轨迹里的 `{name, detail}`）对这个目录做了什么。detail 是参数：JSON，或者一整条命令。 */
export function toolWorksIn(name: string, detail: string, dir: string): "created" | "worked" | null {
  let args: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(detail);
    if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
  } catch { /* 不是 JSON：整条就是命令 */ }
  if (!args) return commandWorksIn(detail, dir);
  if (insideDir(args.cwd, dir) || insideDir(args.workdir, dir)) return "worked";
  if (EDIT_TOOLS.has(name) && (insideDir(args.file_path, dir) || insideDir(args.notebook_path, dir))) return "worked";
  for (const key of ["command", "cmd", "input", "patch"]) {
    const value = args[key];
    const text = Array.isArray(value) ? value.join(" ") : value;
    if (typeof text === "string") {
      const found = commandWorksIn(text, dir);
      if (found) return found;
    }
  }
  return null;
}

type TaskEvidence = { dirs: string[]; tools: { name: string; detail: string }[]; claudeCwds: Set<string> };

/** 这条任务自己的会话留下的证据：会话行的目录、执行轨迹里的工具调用、claude 会话文件里记的工作目录。 */
async function taskEvidence(taskId: string): Promise<TaskEvidence> {
  const rows = await db.select().from(sessions).where(eq(sessions.taskId, taskId));
  const dirs = rows.flatMap((row) => [row.cwd, row.worktreePath]).filter((dir): dir is string => !!dir).map(expandHome);
  const tools: TaskEvidence["tools"] = [];
  const claudeCwds = new Set<string>();
  for (const row of rows) {
    const trace = await readFile(readableRunPath(sessionTracePath(taskId, row.id)), "utf8").catch(() => "");
    for (const line of trace.split("\n")) {
      if (!line.includes('"tool"')) continue;
      try {
        const event = (JSON.parse(line) as { event?: { kind?: string; name?: string; detail?: unknown } }).event;
        if (event?.kind === "tool" && typeof event.detail === "string") tools.push({ name: event.name ?? "", detail: event.detail });
      } catch { /* 坏行跳过 */ }
    }
    if (row.agentType !== "claude" || !row.cliSessionId) continue;
    const configDir = await sessionCliConfigDir(row, "claude");
    for (const cwd of new Set([row.cwd, row.worktreePath].filter((dir): dir is string => !!dir).flatMap((dir) => [expandHome(dir), physicalPath(expandHome(dir))]))) {
      const text = await readFile(claudeSessionFilePath(cwd, row.cliSessionId, configDir), "utf8").catch(() => "");
      for (const match of text.matchAll(/"cwd":"((?:[^"\\]|\\.)*)"/g)) {
        try { claudeCwds.add(JSON.parse(`"${match[1]}"`) as string); } catch { /* 跳过 */ }
      }
    }
  }
  return { dirs, tools, claudeCwds };
}

/** 这条任务在 `candidate` 里干过活的证据；没有就 null。`seen` 是证据里那个目录的写法。 */
function evidenceFor(candidate: Candidate, repo: string, evidence: TaskEvidence): { seen: string; created: boolean } | null {
  const spellings = spellingsOf(candidate.path, repo);
  const absolute = spellings.filter((spelling) => isAbsolute(spelling));
  const shown = (spelling: string) => isAbsolute(spelling) ? spelling : join(repo, spelling);
  // 每种写法都看一遍：建它的那一步常写相对路径（`git worktree add ../x`），之后干活又写绝对路径。
  const hits = spellings.map((spelling) => ({ spelling, found: evidence.tools.map((tool) => toolWorksIn(tool.name, tool.detail, spelling)) }))
    .filter((hit) => hit.found.some(Boolean));
  if (hits.length) return { seen: shown(hits[0]!.spelling), created: hits.some((hit) => hit.found.includes("created")) };
  const session = evidence.dirs.find((dir) => samePath(dir, candidate.path));
  if (session) return { seen: session, created: false };
  const cwd = absolute.find((spelling) => [...evidence.claudeCwds].some((dir) => insideDir(dir, spelling)));
  return cwd ? { seen: cwd, created: false } : null;
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
    const found = evidenceFor(candidate, repo, evidence);
    return found ? [{ ...candidate, seenAs: found.seen, created: found.created }] : [];
  });
}
