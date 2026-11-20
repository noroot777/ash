// 把一条**没有独立工作区**的任务改到它自己的 worktree（`navi/<id8>`）里，作为 Navi 的正式操作。
//
// 为什么不从智能体的 git 命令里猜它在哪干活：验收、清理、diff 这整条链只认 Navi 自己建的工作区
// （任务分支 + 冻结的开工点 + 合入目标），智能体自己 `git worktree add` 出来的目录不会被合并、不会被
// 清理；把它显示成任务的工作区，等于对「验收会合什么」撒谎。所以换目录只有这一条路，办完之后任务行
// 和建任务时就开了 worktree 的任务长得一模一样，信息格、diff、验收、清理不用另认一种。
//
// 起点、合入目标的规则跟新建任务是同一份（task-branch-plan.ts `initializeBranchPlan`）：本地分支、
// 远端分支、提交都按那边的口径冻结起点、定合入目标，这里不另写一套。
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
// 项目目录里有未提交的改动时一律不办：新工作区从起点的提交开出，那些改动带不过去；悄悄留在原地，
// 智能体换了目录就再也看不见它们，替用户搬走或丢掉更不行。拒绝的话里列出是哪几个文件、该怎么处理。
import { cpSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { db } from "./db/index.js";
import { projects, sessions, tasks } from "./db/schema.js";
import {
  countsAsProjectChange, expandHome, isGitRepo, listFiles, localBranchExists, porcelainFiles, prepareWorktree, repoKey,
  resolveWorktreeBranchName, worktreePathFor,
} from "./git.js";
import { execFileText as exec } from "./exec.js";
import { withRepoLock } from "./repo-lock.js";
import { baseRef, branchName, commitAt, initializeBranchPlan } from "./task-branch-plan.js";
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

export type WorktreeMoveInput = { base: string; mergeTargetBranch?: string | null };

export type WorktreeMoved = {
  from: string;
  path: string;
  branch: string;
  base: string;
  startCommit: string;
  mergeTargetBranch: string | null;
  /** 会话文件没能带过去的那几条（下一回合接不上、会另开会话）。 */
  notes: string[];
};

/** 这条任务现在能不能改到独立工作区：不能就给出原因。只读，不看项目目录脏不脏（那一条见 `dirtyProjectError`）。 */
export async function worktreeMoveBlocker(task: TaskRow, repoPath: string): Promise<WorktreeMoveError | null> {
  if (task.useWorktree) return new WorktreeMoveError("本任务已经在独立工作区里了");
  if (task.reviewOf) return new WorktreeMoveError("审查任务跟着被审任务的工作区走，不能单独改");
  if (task.mode !== "single") return new WorktreeMoveError("只有普通任务能改到独立工作区");
  if (task.archived) return new WorktreeMoveError("任务已归档，先取回再改");
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
  if (!(await commitAt(repoPath, base))) {
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
 * 这条任务（和挂在它身上的老式审查任务）记在项目目录上的会话行：改指新目录，claude 的会话文件复制一份
 * 到新目录对应的位置。只改记在**项目目录**上的那几条 —— 记在别处的（比如用户手动指定过目录）不归这里管。
 */
async function moveSessions(taskId: string, from: string, to: string, branch: string): Promise<string[]> {
  const reviewers = await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.reviewOf, taskId));
  const rows = await db.select().from(sessions).where(inArray(sessions.taskId, [taskId, ...reviewers.map((row) => row.id)]));
  const key = repoKey(from);
  const notes: string[] = [];
  for (const row of rows) {
    const dir = row.cwd || row.worktreePath;
    if (!dir || repoKey(expandHome(dir)) !== key) continue;
    if (row.agentType === "claude" && row.cliSessionId) {
      const configDir = await sessionCliConfigDir(row, "claude");
      const source = [row.cwd, row.worktreePath].filter((cwd): cwd is string => !!cwd)
        .map((cwd) => claudeSessionFilePath(expandHome(cwd), row.cliSessionId!, configDir)).find((path) => existsSync(path));
      const target = claudeSessionFilePath(to, row.cliSessionId, configDir);
      if (!source) notes.push(`会话 ${row.id} 的 claude 会话文件没找到，下一回合接不上原来的对话`);
      else if (!existsSync(target)) {
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(source, target);
        // 子智能体、大段工具输出这类旁挂内容存在同名目录里（`<会话号>/`），一并带上。
        const sidecar = join(dirname(source), row.cliSessionId);
        if (existsSync(sidecar)) cpSync(sidecar, join(dirname(target), row.cliSessionId), { recursive: true });
      }
    }
    await db.update(sessions).set({ cwd: to, worktreePath: to, branch }).where(eq(sessions.id, row.id));
  }
  return notes;
}

const movedNote = (moved: WorktreeMoved) =>
  `〔工作目录已更换〕本任务已改到独立工作区：目录 ${moved.path}，分支 ${moved.branch}，`
  + `从 ${moved.base}（${moved.startCommit.slice(0, 7)}）开出${moved.mergeTargetBranch ? `，验收时合入 ${moved.mergeTargetBranch}` : ""}。`
  + `原来的目录 ${moved.from} 不再是你的工作目录：之后读写文件、跑 git 都在新目录里，别回原目录改东西，也别自己再建 worktree。`;

const movedLine = (moved: WorktreeMoved) =>
  `已改到独立工作区 ${moved.path}（分支 ${moved.branch}，从 ${moved.base} 的 ${moved.startCommit.slice(0, 7)} 开出`
  + `${moved.mergeTargetBranch ? `，验收合入 ${moved.mergeTargetBranch}` : ""}）。原项目目录 ${moved.from} 里的东西没有动。`
  + (moved.notes.length ? ` ${moved.notes.join("；")}。` : "");

/**
 * 办：建 worktree、改任务行、改会话行、搬会话文件、留记录。**调用方必须握着这条任务的回合锁**
 * （用户入口当场占，智能体那条路在下一回合开头办），否则一个正在起跑的回合会落在旧目录里。
 */
export async function moveTaskToWorktree(taskId: string, input: WorktreeMoveInput): Promise<WorktreeMoved> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) throw new WorktreeMoveError("任务不存在", 400);
  const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
  if (!project) throw new WorktreeMoveError("任务所在的项目不存在", 400);
  const repo = expandHome(project.repoPath);
  const moved = await withRepoLock(repo, async () => {
    const refused = await worktreeMoveBlocker(task, repo) ?? await worktreeMoveInputError(repo, input)
      ?? await dirtyProjectError(repo, input.base.trim());
    if (refused) throw refused;
    const row = {
      ...task, useWorktree: true, worktreeBase: input.base.trim(), worktreeStartCommit: null,
      worktreeBaseBranch: null, mergeTargetBranch: input.mergeTargetBranch?.trim() || null, baseTaskId: null,
    };
    try {
      await initializeBranchPlan(row, repo);
    } catch (error) {
      throw await planError(error) ?? error;
    }
    const startCommit = row.worktreeStartCommit as string | null;
    if (!startCommit) throw new WorktreeMoveError(`起点 ${row.worktreeBase} 读不出提交`, 400);
    let path: string;
    let branch: string;
    try {
      const ws = await prepareWorktree(repo, task.id, startCommit, true);
      path = ws.path;
      branch = ws.branch ?? await resolveWorktreeBranchName(repo, task.id);
    } catch (error) {
      await exec("git", ["-C", repo, "update-ref", "-d", baseRef(task.id), startCommit]).catch(() => {});
      throw new WorktreeMoveError(error instanceof Error ? error.message : String(error));
    }
    const result: WorktreeMoved = {
      from: repo, path, branch, base: row.worktreeBaseBranch || row.worktreeBase || startCommit, startCommit,
      mergeTargetBranch: row.mergeTargetBranch ?? null, notes: [],
    };
    result.notes = await moveSessions(task.id, repo, path, branch);
    await db.update(tasks).set({
      useWorktree: true, worktreeBase: row.worktreeBase, worktreeStartCommit: startCommit,
      worktreeBaseBranch: row.worktreeBaseBranch ?? null, mergeTargetBranch: row.mergeTargetBranch ?? null,
      baseTaskId: row.baseTaskId ?? null, worktreeMoveRequest: null, workspaceNote: movedNote(result), updatedAt: now(),
    }).where(eq(tasks.id, task.id));
    return result;
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
  const request = parseWorktreeMoveRequest(task.worktreeMoveRequest);
  if (!request) return;
  try {
    await moveTaskToWorktree(task.id, request);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await db.update(tasks).set({
      worktreeMoveRequest: null, updatedAt: now(),
      workspaceNote: `〔改到独立工作区没做成〕${reason}。工作目录没变。把原因告诉用户，等他决定下一步，别自己建 worktree 代替。`,
    }).where(eq(tasks.id, task.id));
    await appendTaskTimeline(task.id, alertLine(`改到独立工作区没做成：${reason}`));
    await publishTaskUpdated(task.id);
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
