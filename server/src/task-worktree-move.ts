// 把一条**没有独立工作区**的任务改到它自己的 worktree（`navi/<id8>`）里，作为 Navi 的正式操作。
//
// 为什么不从智能体的 git 命令里猜它在哪干活：验收、清理、diff 这整条链只认 Navi 自己建的工作区
// （任务分支 + 冻结的开工点 + 合入目标），智能体自己 `git worktree add` 出来的目录不会被合并、不会被
// 清理；把它显示成任务的工作区，等于对「验收会合什么」撒谎。所以换目录只有这一条路，办完之后任务行
// 和建任务时就开了 worktree 的任务长得一模一样，信息格、diff、验收、清理不用另认一种。
//
// 起点、合入目标的规则跟新建任务是同一份（task-branch-plan.ts `initializeBranchPlan`）：本地分支、
// 远端分支、提交都按那边的口径冻结起点、定合入目标，这里不另写一套 —— 远端分支先拉那一条再冻结，
// 没给合入分支时合进本地同名分支（本地没有就照远端建一条跟踪分支）。
//
// 两个入口，同一个动作（`moveTaskToWorktree`，调用方必须握着这条任务的回合锁）：
//   · 用户在信息格里点：任务没在跑，路由当场占锁办完（task-worktree-move-routes.ts）；
//   · 智能体在自己回合里调 MCP `move_to_worktree`：这一回合还在跑、目录换不得，于是只登记
//     （`worktree_move_request`）并留一段续跑交代，回合结束后由 Navi 叫起下一回合；下一回合开头、
//     挑会话行之前办（turn-session-pick.ts），办完这一回合就在新目录里续同一个 CLI 会话。
//
// 换目录续跑的两件事：会话行上记的目录改成新目录（下一回合按它定 cwd）；claude 的会话文件按目录存在
// `~/.claude/projects/<cwd slug>/`，复制一份到新目录对应的位置（定位口径跟接力搬会话文件同一份，
// handoff-collect.ts）。codex 的会话不随目录走，不用搬。下一回合开头告诉智能体目录换了
// （`workspace_note`，turn-workspace-pick.ts 取走）。
//
// 登记、撤回、办成、办不成四种写法改的是同一格（`worktree_move_request`），一律按「此刻还是我读到的那一份」
// 比对着写；撤回和办都在仓库锁里做，办的一方进锁后重读一遍，于是撤回成功和办成只能有一方成立。
// 建好工作区之后任何一步失败（复制会话文件、落库），都把这次建出来的 worktree、分支、冻结 ref 和复制出的
// 会话文件收回，任务原样留在项目目录里，可以直接重试。
//
// 项目目录里有未提交的改动时一律不办：新工作区从起点的提交开出，那些改动带不过去；悄悄留在原地，
// 智能体换了目录就再也看不见它们，替用户搬走或丢掉更不行。拒绝的话里列出是哪几个文件、该怎么处理。
import { cpSync, copyFileSync, existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, eq, exists, inArray, isNotNull, isNull, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { HTTPException } from "hono/http-exception";
import { db } from "./db/index.js";
import { projects, sessions, tasks } from "./db/schema.js";
import {
  countsAsProjectChange, expandHome, isGitRepo, listFiles, localBranchExists, porcelainFiles, prepareWorktree, repoKey,
  resolveWorktreeBranchName, worktreePathFor,
} from "./git.js";
import { execFileText as exec } from "./exec.js";
import { withRepoLock } from "./repo-lock.js";
import { branchName, commitAt, initializeBranchPlan, undoBranchPlanSideEffects, type BranchPlanSideEffects } from "./task-branch-plan.js";
import { remoteBranchOf } from "./git-remote-branch.js";
import { claudeSessionFilePath } from "./handoff-collect.js";
import { sessionCliConfigDir } from "./auth/run-env.js";
import { appendTaskTimeline, alertLine } from "./task-timeline.js";
import { publishTaskUpdated } from "./task-store.js";
import { parseWorktreeMoveRequest } from "./worktree-move-request.js";
import { now } from "./util.js";

type TaskRow = typeof tasks.$inferSelect;

export class WorktreeMoveError extends Error {
  constructor(message: string, readonly status: 400 | 409 = 409) {
    super(message);
  }
}

/** 进了锁才发现登记已经被撤回或换掉：不办，也不另留话（撤回那边已经说过了）。 */
export class WorktreeMoveWithdrawn extends WorktreeMoveError {
  constructor() {
    super("改到独立工作区的请求已经撤回");
  }
}

export type WorktreeMoveInput = { base: string; mergeTargetBranch?: string | null };

export type WorktreeMoved = {
  from: string;
  path: string;
  branch: string;
  base: string;
  startCommit: string;
  mergeTargetBranch: string | null;
  /** 从远端分支开工、本地没有同名分支时，照远端新建的那条（它就是合入目标）。 */
  trackingBranch: string | null;
  /** 会话文件没能带过去的那几条（下一回合接不上、会另开会话）。 */
  notes: string[];
};

/** 这条任务现在能不能改到独立工作区：不能就给出原因。只读，不看项目目录脏不脏（那一条见 `dirtyProjectError`）。 */
export async function worktreeMoveBlocker(task: TaskRow, repoPath: string): Promise<WorktreeMoveError | null> {
  if (task.useWorktree) return new WorktreeMoveError("本任务已经在独立工作区里了");
  if (task.reviewOf) return new WorktreeMoveError("审查任务跟着被审任务的工作区走，不能单独改");
  if (task.mode !== "single") return new WorktreeMoveError("只有普通任务能改到独立工作区");
  if (task.archived) return new WorktreeMoveError("任务已归档，先取回再改");
  if (task.stage === "accepted" || task.stage === "merged") {
    return new WorktreeMoveError("任务已经验收合并过了，改动早已落在项目里；要接着做请新建一条任务");
  }
  if (task.handoff && (JSON.parse(task.handoff) as { direction?: string }).direction === "out") {
    return new WorktreeMoveError("任务已经接力到别的机器，这里的记录只是存档");
  }
  if (task.parentId) {
    const parent = (await db.select({ mode: tasks.mode }).from(tasks).where(eq(tasks.id, task.parentId))).at(0);
    if (parent?.mode === "team") return new WorktreeMoveError("团队执行者跟着调度台的工作区走，不能单独改");
  }
  const repo = expandHome(repoPath);
  if (!(await isGitRepo(repo))) return new WorktreeMoveError("项目目录不是 git 仓库，建不了独立工作区", 400);
  const branch = await resolveWorktreeBranchName(repo, task.id);
  if (await localBranchExists(repo, branch)) {
    return new WorktreeMoveError(`仓库里已经有分支 ${branch}（本任务的分支名），先把它改名或删掉再改`);
  }
  if (existsSync(worktreePathFor(repo, task.id))) {
    return new WorktreeMoveError(`目录 ${worktreePathFor(repo, task.id)} 已经存在，先把它挪走再改`);
  }
  return null;
}

/** 起点和合入目标此刻读不读得出来（建工作区之前先说清楚，免得建到一半才失败）。 */
export async function worktreeMoveInputError(repoPath: string, input: WorktreeMoveInput): Promise<WorktreeMoveError | null> {
  const base = input.base.trim();
  if (!base) return new WorktreeMoveError("要给出起点（分支、远端分支或提交）", 400);
  // 远端分支（`origin/x`、`refs/remotes/origin/x`）此刻在本地没有记录也放过去：分支计划会先拉那一条再冻结
  // （initializeBranchPlan），这里只拦一眼就知道不成的。
  if (!(await commitAt(repoPath, base)) && !(await remoteBranchOf(repoPath, base))) {
    return new WorktreeMoveError(`起点 ${base} 读不出提交（不是本地分支、远端分支、tag 或提交）。远端分支请先刷新远端分支`, 400);
  }
  const target = input.mergeTargetBranch?.trim();
  if (target && !(await localBranchExists(repoPath, branchName(target)))) {
    return new WorktreeMoveError(`合入分支 ${target} 不在本地，请选一条本地分支`, 400);
  }
  return null;
}

/** 项目目录里有未提交的改动 → 不办，并说清楚是哪几个、该怎么处理。 */
export async function dirtyProjectError(repoPath: string, base: string): Promise<WorktreeMoveError | null> {
  const repo = expandHome(repoPath);
  let lines: string[];
  try {
    lines = (await exec("git", ["-C", repo, "status", "--porcelain"])).stdout.split("\n").filter(countsAsProjectChange);
  } catch {
    return new WorktreeMoveError("读不出项目目录的 git 状态，没法确认有没有未提交的改动");
  }
  if (!lines.length) return null;
  const files = porcelainFiles(lines.join("\n"));
  return new WorktreeMoveError(
    `项目目录 ${repo} 里有未提交的改动（${listFiles(files)}）。新工作区从 ${base} 的提交开出，带不上这些改动；`
    + "Navi 不会替你搬走或丢掉它们。先提交、收起（git stash）或撤销，再改到独立工作区。",
  );
}

/** initializeBranchPlan 用 HTTPException 报「起点 / 合入目标不对」：换成这里的错误，原话照用。 */
async function planError(error: unknown): Promise<WorktreeMoveError | null> {
  if (!(error instanceof HTTPException)) return null;
  const body = await error.getResponse().clone().json().catch(() => null) as { error?: string } | null;
  return new WorktreeMoveError(body?.error || error.message, error.status === 400 ? 400 : 409);
}

/**
 * claude 按进程的真实工作目录分会话目录：macOS 上 `/tmp/x` 起的进程，cwd 是 `/private/tmp/x`。
 * 库里记的是用户写的那种拼法，所以找旧文件两种都试，新文件按真实路径放（新目录这时已经建好了）。
 */
const realDir = (path: string) => { try { return realpathSync(path); } catch { return path; } };
const spellings = (path: string) => [...new Set([realDir(path), path])];

type SessionMove = { rows: string[]; created: string[]; notes: string[] };

/**
 * 这条任务（和挂在它身上的老式审查任务）记在项目目录上的会话行：claude 的会话文件复制一份到新目录对应的
 * 位置，返回要改指新目录的会话行。只动记在**项目目录**上的那几条 —— 记在别处的（比如用户手动指定过目录）
 * 不归这里管。会话行本身不在这里改：跟任务行一起原子落库（`moveTaskToWorktree`）。
 * 复制出来的每个文件、目录都记进 `created`，后面哪一步失败都按它收回；已经在那儿的不记、不碰。
 */
async function carrySessions(taskId: string, from: string, to: string, move: SessionMove): Promise<void> {
  const reviewers = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.reviewOf, taskId));
  const rows = await db.select().from(sessions).where(inArray(sessions.taskId, [taskId, ...reviewers.map((row) => row.id)]));
  const key = repoKey(from);
  for (const row of rows) {
    const dir = row.cwd || row.worktreePath;
    if (!dir || repoKey(expandHome(dir)) !== key) continue;
    move.rows.push(row.id);
    if (row.agentType !== "claude" || !row.cliSessionId) continue;
    const configDir = await sessionCliConfigDir(row, "claude");
    const source = [row.cwd, row.worktreePath].filter((cwd): cwd is string => !!cwd)
      .flatMap((cwd) => spellings(expandHome(cwd)))
      .map((cwd) => claudeSessionFilePath(cwd, row.cliSessionId!, configDir)).find((path) => existsSync(path));
    const target = claudeSessionFilePath(realDir(to), row.cliSessionId, configDir);
    if (!source) {
      move.notes.push(`会话 ${row.id} 的 claude 会话文件没找到，下一回合接不上原来的对话`);
      continue;
    }
    if (existsSync(target)) continue;
    if (!existsSync(dirname(target))) {
      mkdirSync(dirname(target), { recursive: true });
      move.created.push(dirname(target));
    }
    move.created.push(target);
    copyFileSync(source, target);
    // 子智能体、大段工具输出这类旁挂内容存在同名目录里（`<会话号>/`），一并带上。
    const sidecar = join(dirname(source), row.cliSessionId);
    const sidecarTarget = join(dirname(target), row.cliSessionId);
    if (existsSync(sidecar) && !existsSync(sidecarTarget)) {
      move.created.push(sidecarTarget);
      cpSync(sidecar, sidecarTarget, { recursive: true });
    }
  }
}

/**
 * 收回这次建出来的东西：复制出的会话文件（倒着删，先文件后目录）、worktree、任务分支，再交给分支计划收回它
 * 留下的冻结开工点和从远端开工时顺手建的跟踪分支（task-branch-plan.ts `undoBranchPlanSideEffects`）。
 */
async function undoMove(repo: string, made: { path: string; branch: string }, plan: BranchPlanSideEffects, created: string[]) {
  for (const path of [...created].reverse()) rmSync(path, { recursive: true, force: true });
  const git = (...args: string[]) => exec("git", ["-C", repo, ...args]).catch(() => {});
  await git("worktree", "remove", "--force", made.path);
  if (existsSync(made.path)) rmSync(made.path, { recursive: true, force: true });
  await git("worktree", "prune");
  await git("branch", "-D", "--end-of-options", made.branch);
  await undoBranchPlanSideEffects(repo, plan);
}

/** 「登记此刻还是我读到的那一份」：没有登记的那条路（用户点）要求此刻也没有。 */
export const requestIs = (expected: string | null): SQL =>
  expected === null ? isNull(tasks.worktreeMoveRequest) : eq(tasks.worktreeMoveRequest, expected);

const movedNote = (moved: WorktreeMoved) =>
  `〔工作目录已更换〕本任务已改到独立工作区：目录 ${moved.path}，分支 ${moved.branch}，`
  + `从 ${moved.base}（${moved.startCommit.slice(0, 7)}）开出${moved.mergeTargetBranch ? `，验收时合入 ${moved.mergeTargetBranch}` : ""}。`
  + `原来的目录 ${moved.from} 不再是你的工作目录：之后读写文件、跑 git 都在新目录里，别回原目录改东西，也别自己再建 worktree。`;

const movedLine = (moved: WorktreeMoved) =>
  `已改到独立工作区 ${moved.path}（分支 ${moved.branch}，从 ${moved.base} 的 ${moved.startCommit.slice(0, 7)} 开出`
  + `${moved.mergeTargetBranch ? `，验收合入 ${moved.mergeTargetBranch}` : ""}`
  + `${moved.trackingBranch ? `；本地原来没有 ${moved.trackingBranch}，已照 ${moved.base} 建了一条跟踪它的` : ""}）。`
  + `原项目目录 ${moved.from} 里的东西没有动。`
  + (moved.notes.length ? ` ${moved.notes.join("；")}。` : "");

/**
 * 办：建 worktree、改任务行、改会话行、搬会话文件、留记录。**调用方必须握着这条任务的回合锁**
 * （用户入口当场占，智能体那条路在下一回合开头办），否则一个正在起跑的回合会落在旧目录里。
 *
 * `expected` 是调用方读到的那份登记原文（用户点的那条路是 null）：进了仓库锁重读一遍，对不上就是被撤回或
 * 换掉了，抛 `WorktreeMoveWithdrawn`、什么都不动。撤回也在这把锁里做（task-worktree-move-routes.ts）。
 */
export async function moveTaskToWorktree(taskId: string, input: WorktreeMoveInput, expected: string | null = null): Promise<WorktreeMoved> {
  const before = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!before) throw new WorktreeMoveError("任务不存在", 400);
  const project = (await db.select().from(projects).where(eq(projects.id, before.projectId))).at(0);
  if (!project) throw new WorktreeMoveError("任务所在的项目不存在", 400);
  const repo = expandHome(project.repoPath);
  const moved = await withRepoLock(repo, async () => {
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task) throw new WorktreeMoveError("任务不存在", 400);
    if ((task.worktreeMoveRequest ?? null) !== expected) {
      if (expected !== null) throw new WorktreeMoveWithdrawn();
      const pending = parseWorktreeMoveRequest(task.worktreeMoveRequest);
      throw new WorktreeMoveError(`智能体已经登记了一次改到独立工作区（起点 ${pending?.base ?? "?"}），先撤回它再改`);
    }
    const refused = await worktreeMoveBlocker(task, repo) ?? await worktreeMoveInputError(repo, input)
      ?? await dirtyProjectError(repo, input.base.trim());
    if (refused) throw refused;
    // 交给分支计划的是一份按「新建任务」摆的副本：它对已经结束的任务（导入的历史任务）不联网、不建跟踪分支，
    // 而这里改的多半正是停下来的任务，状态照实传进去就会把远端起点当成历史记录跳过。只取它算出来的那几格。
    const row = {
      ...task, status: "backlog" as const, stage: null, useWorktree: true, worktreeBase: input.base.trim(), worktreeStartCommit: null,
      worktreeBaseBranch: null, mergeTargetBranch: input.mergeTargetBranch?.trim() || null, baseTaskId: null,
    };
    let plan: BranchPlanSideEffects;
    try {
      plan = await initializeBranchPlan(row, repo);
    } catch (error) {
      throw await planError(error) ?? error;
    }
    const startCommit = row.worktreeStartCommit as string | null;
    if (!startCommit) {
      await undoBranchPlanSideEffects(repo, plan);
      throw new WorktreeMoveError(`起点 ${row.worktreeBase} 读不出提交`, 400);
    }
    let made: { path: string; branch: string };
    try {
      const ws = await prepareWorktree(repo, task.id, startCommit, true);
      made = { path: ws.path, branch: ws.branch ?? await resolveWorktreeBranchName(repo, task.id) };
    } catch (error) {
      await undoBranchPlanSideEffects(repo, plan);
      throw new WorktreeMoveError(error instanceof Error ? error.message : String(error));
    }
    const carried: SessionMove = { rows: [], created: [], notes: [] };
    try {
      await carrySessions(task.id, repo, made.path, carried);
      const result: WorktreeMoved = {
        from: repo, path: made.path, branch: made.branch, base: row.worktreeBaseBranch || row.worktreeBase || startCommit, startCommit,
        mergeTargetBranch: row.mergeTargetBranch ?? null, trackingBranch: plan.trackingBranch?.name ?? null, notes: carried.notes,
      };
      // 会话行和任务行一批落：中间没有 await，要么全改指新目录、要么一行不动。每条都带着「登记还是那一份」。
      const unchanged = and(eq(tasks.id, task.id), requestIs(expected), eq(tasks.useWorktree, false));
      const stillMine = exists(db.select({ id: tasks.id }).from(tasks).where(unchanged));
      const sessionWrites: BatchItem<"sqlite">[] = carried.rows.map((id) => db.update(sessions)
        .set({ cwd: made.path, worktreePath: made.path, branch: made.branch }).where(and(eq(sessions.id, id), stillMine)));
      const taskWrite = db.update(tasks).set({
        useWorktree: true, worktreeBase: row.worktreeBase, worktreeStartCommit: startCommit,
        worktreeBaseBranch: row.worktreeBaseBranch ?? null, mergeTargetBranch: row.mergeTargetBranch ?? null,
        baseTaskId: row.baseTaskId ?? null, worktreeMoveRequest: null, workspaceNote: movedNote(result), updatedAt: now(),
      }).where(unchanged).returning({ id: tasks.id });
      // 任务行那条排最后：它会把登记清掉，排在它后面的会话行就看不到「还是那一份」了。
      const written = await db.batch([...sessionWrites, taskWrite] as unknown as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
      if (!(written.at(-1) as unknown[]).length) throw expected === null ? new WorktreeMoveError("任务在办的过程中被改动了，没有改成，再试一次") : new WorktreeMoveWithdrawn();
      return result;
    } catch (error) {
      await undoMove(repo, made, plan, carried.created);
      if (error instanceof WorktreeMoveError) throw error;
      throw new WorktreeMoveError(`改到独立工作区半路失败，已经收回这次建的工作区和分支：${error instanceof Error ? error.message : String(error)}`);
    }
  });
  await appendTaskTimeline(taskId, alertLine(movedLine(moved)));
  await publishTaskUpdated(taskId);
  return moved;
}

/**
 * 回合开头：智能体上一回合登记过「改到独立工作区」就在这里办（这一回合握着锁、还没定会话行和目录）。
 * 办不成也要清掉登记，并把原因同时告诉用户（时间线）和智能体（下一句提示），不让它反复撞同一堵墙。
 * 办成了把 `task` 就地刷成新值，调用方后面读到的就是改过的任务行。
 */
export async function applyPendingWorktreeMove(task: TaskRow): Promise<void> {
  const raw = task.worktreeMoveRequest;
  const request = parseWorktreeMoveRequest(raw);
  if (!raw || !request) return;
  try {
    await moveTaskToWorktree(task.id, request, raw);
  } catch (error) {
    if (!(error instanceof WorktreeMoveWithdrawn)) {
      const reason = error instanceof Error ? error.message : String(error);
      // 只清自己读到的那一份：这期间用户撤回了（撤回那边已经留了话），就不再盖一句「没做成」。
      const cleared = await db.update(tasks).set({
        worktreeMoveRequest: null, updatedAt: now(),
        workspaceNote: `〔改到独立工作区没做成〕${reason}。工作目录没变。把原因告诉用户，等他决定下一步，别自己建 worktree 代替。`,
      }).where(and(eq(tasks.id, task.id), requestIs(raw))).returning({ id: tasks.id });
      if (cleared.length) {
        await appendTaskTimeline(task.id, alertLine(`改到独立工作区没做成：${reason}`));
        await publishTaskUpdated(task.id);
      }
    }
  }
  const fresh = (await db.select().from(tasks).where(eq(tasks.id, task.id))).at(0);
  if (fresh) Object.assign(task, fresh);
}

/** 下一回合要告诉智能体的那句（工作目录换了 / 没换成），取走即清。只给任务自己的回合，审查旁路回合不取。 */
export async function takeWorkspaceNote(taskId: string): Promise<string> {
  const row = (await db.select({ note: tasks.workspaceNote }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!row?.note) return "";
  await db.update(tasks).set({ workspaceNote: null }).where(and(eq(tasks.id, taskId), eq(tasks.workspaceNote, row.note)));
  return `\n\n${row.note}`;
}

/** 有登记、停在检查点上的（智能体登记完回合就结束了）：叫起下一回合去办。开机补办和回合放锁时都走它。 */
export async function wakeForWorktreeMove(taskId: string): Promise<void> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task || task.status !== "paused" || !task.resumePrompt || !parseWorktreeMoveRequest(task.worktreeMoveRequest)) return;
  const { releaseLaunch, requestLaunch } = await import("./launch-request.js");
  await requestLaunch([taskId], { source: "hold", actingUserId: task.ownerUserId ?? null });
  await releaseLaunch(taskId);
}

/** 开机补办：重启前登记了、还没来得及叫起的那几条。 */
export async function recoverWorktreeMoves(): Promise<void> {
  const rows = await db.select({ id: tasks.id }).from(tasks)
    .where(and(eq(tasks.status, "paused"), eq(tasks.archived, false), isNotNull(tasks.worktreeMoveRequest)));
  for (const row of rows) await wakeForWorktreeMove(row.id).catch((error) =>
    console.error(`[navi] 补办改到独立工作区失败 ${row.id}:`, error));
}
