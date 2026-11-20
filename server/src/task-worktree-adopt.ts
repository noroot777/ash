// 收编：把智能体自己 `git worktree add` 出来的工作区（foreign-worktrees.ts 认出来的）接成这条任务的独立工作区。
//
// 为什么挪目录、改分支名，而不是让任务记一个自定义的分支名和目录：验收、清理、diff、前置、接力、信息格……
// 四十来处都按任务 id 推算分支（`navi/<id8>`，`resolveWorktreeBranchName`）和目录（`.worktrees/<id>`，
// `worktreePathFor`），网页端也一样。加一个「这条任务的分支其实叫 X」的字段，就得把每一处都改成先查它，
// 漏一处就是悄悄合错、删错、比错 —— 跟 task-worktree-move.ts 头上说的那条一样：办完之后任务行要跟建任务时
// 就开了 worktree 的任务长得一模一样，下游不用另认一种。所以收编就是把那个工作区**变成** Navi 的形状：
//   · `git worktree move` 到 `.worktrees/<id>`：整个目录原样挪过去，未提交的改动、未跟踪的文件都在。智能体
//     恰好就建在这个位置上的不挪，只登记；
//   · 分支改名成 `navi/<id8>`（已经叫这个名字就不动）。改名会影响到别人的情况一律不办，拒绝的话里说清楚：
//     分支还检出在别处、是合入目标、别的任务拿它当起点或合入目标、被 git worktree lock 锁着；
//   · 起点：合入分支（缺省是项目目录此刻检出的那条）跟这条分支的分叉点（merge-base），冻结成开工点 ——
//     「改动」从这里算，正好是智能体在那条分支上做的事；合入目标写合入分支。
// 其余跟改到独立工作区同一套（task-worktree-move.ts）：改会话行、搬 claude 会话文件（按真实路径算）、
// 时间线留一句、下一回合开头给智能体一句交代；项目目录里有未提交的改动不办（被收编的那个目录本身不算）。
//
// 只有用户入口（信息格里点，任务没在跑，路由占着回合锁）：智能体正在那个目录里跑的时候挪不得。
// 建出来、改过的东西记一本账，落库之前任何一步失败都按账倒着收回：会话文件删掉、目录挪回去、分支名改回去、
// 冻结 ref 删掉，仓库回到收编之前的样子；哪一项没还原（比如原位置被别的东西占了），照实说是哪几项、怎么手动还原。
// 预览实例一律不办：它的库是主库的快照，仓库却是真的。
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { projects, tasks } from "./db/schema.js";
import { ensureWorktreesIgnored, expandHome, listFiles, localBranchExists, resolveTaskMergeTarget, resolveWorktreeBranchName, worktreePathFor } from "./git.js";
import { execFileText as exec } from "./exec.js";
import { withRepoLock } from "./repo-lock.js";
import { IS_PREVIEW_INSTANCE, previewRefusal } from "./preview-instance.js";
import { baseRef, branchName, commitAt, initializeBranchPlan, undoBranchPlanSideEffects, type BranchPlanSideEffects } from "./task-branch-plan.js";
import { foreignWorktreesOf, worktreeRecords, type ForeignWorktree } from "./foreign-worktrees.js";
import { samePath } from "./git-worktree-state.js";
import { carrySessions, planError, projectDirtyFiles, taskMoveBlocker, writeMovedTask, WorktreeMoveError, type SessionMove } from "./task-worktree-move.js";
import { appendTaskTimeline, alertLine } from "./task-timeline.js";
import { publishTaskUpdated } from "./task-store.js";

type TaskRow = typeof tasks.$inferSelect;

export type AdoptInput = { path: string; mergeTargetBranch?: string | null };

export type WorktreeAdopted = {
  from: string;
  fromBranch: string;
  path: string;
  branch: string;
  mergeTargetBranch: string;
  startCommit: string;
  /** 改名之前那条分支跟踪的远端分支（改名不动远端）。 */
  upstream: string | null;
  notes: string[];
};

const git = (repo: string, ...args: string[]) => exec("git", ["-C", repo, ...args]).then((out) => out.stdout.trim());

/**
 * 合入分支：给了就用（必须是本地分支），没给按项目目录此刻检出的那条。跟着表单里选的那条变，所以单独
 * 一道，不进 `adoptionBlocker`（那里只放跟合入分支无关、选哪条都改变不了的条件）。
 */
export async function adoptTarget(repo: string, worktree: ForeignWorktree, requested: string | null | undefined): Promise<string | WorktreeMoveError> {
  const target = requested?.trim() ? branchName(requested) : await resolveTaskMergeTarget(repo, null);
  if (!target || target === "HEAD") return new WorktreeMoveError("项目目录没有检出分支，选一条合入分支再收编", 400);
  if (!(await localBranchExists(repo, target))) return new WorktreeMoveError(`合入分支 ${target} 不在本地，请选一条本地分支`, 400);
  if (target === worktree.branch) return new WorktreeMoveError(`合入分支不能是这个工作区自己的分支 ${target}`, 400);
  return target;
}

/**
 * 能不能收编这个工作区：不能就给出原因。只读。只放跟合入分支无关的条件（合入分支那一道是 `adoptTarget`，
 * 表单换一条分支就得重判）。信息格里提示时先问一遍（按钮旁边就写着为什么不行），真收编时在仓库锁里再问一遍。
 */
export async function adoptionBlocker(task: TaskRow, repoPath: string, worktree: ForeignWorktree): Promise<WorktreeMoveError | null> {
  // 预览库是主库的快照，项目路径指的却是真仓库：挪的是真仓库里不是预览建的目录、改的是真分支名，记录却只进快照。
  if (IS_PREVIEW_INSTANCE) return new WorktreeMoveError(previewRefusal("收编智能体自建的工作区"));
  const refused = await taskMoveBlocker(task, repoPath);
  if (refused) return refused;
  if (task.worktreeMoveRequest) return new WorktreeMoveError("智能体已经登记了一次改到独立工作区，先撤回它再收编");
  const repo = expandHome(repoPath);
  if (worktree.locked) {
    return new WorktreeMoveError(`工作区 ${worktree.path} 被 git worktree lock 锁着，先在项目目录运行 git worktree unlock 再收编`);
  }
  const ours = await resolveWorktreeBranchName(repo, task.id);
  if (worktree.branch !== ours) {
    if (await localBranchExists(repo, ours)) return new WorktreeMoveError(`仓库里已经有分支 ${ours}（本任务的分支名），先把它改名或删掉再收编`);
    const checkouts = (await worktreeRecords(repo)).filter((record) => record.branch === worktree.branch);
    if (checkouts.length > 1) return new WorktreeMoveError(`分支 ${worktree.branch} 还检出在别的目录里，改不了名，收编不了`);
    // 依赖口径跟删任务分支同一份（task-branch-plan.ts `dependentTasks`）：归档不等于不再依赖（取回之后照样
    // 要找这条分支），只有已经验收的那几条是历史记录、不算。
    const users = (await db.select({ id: tasks.id, title: tasks.title, stage: tasks.stage, worktreeBase: tasks.worktreeBase,
      mergeTargetBranch: tasks.mergeTargetBranch, worktreeBaseBranch: tasks.worktreeBaseBranch, acceptedTargetBranch: tasks.acceptedTargetBranch,
      archived: tasks.archived }).from(tasks).where(eq(tasks.projectId, task.projectId)))
      .filter((row) => row.id !== task.id && row.stage !== "accepted"
        && [row.worktreeBase, row.mergeTargetBranch, row.worktreeBaseBranch, row.acceptedTargetBranch].some((ref) => ref && branchName(ref) === worktree.branch));
    if (users.length) {
      const named = users.map((row) => `「${row.title || row.id}」${row.archived ? "［已归档］" : ""}`).join("、");
      return new WorktreeMoveError(`分支 ${worktree.branch} 是别的任务的起点或合入目标（${named}），`
        + `收编要把它改名成 ${ours}，那几条会找不到它。先处理那几条任务再收编`);
    }
  }
  const path = worktreePathFor(repo, task.id);
  if (!samePath(worktree.path, path) && existsSync(path)) return new WorktreeMoveError(`目录 ${path} 已经存在，先把它挪走再收编`);
  const dirty = await projectDirtyFiles(repo, worktree.path);
  if (dirty instanceof WorktreeMoveError) return dirty;
  if (dirty.length) {
    return new WorktreeMoveError(`项目目录 ${repo} 里有未提交的改动（${listFiles(dirty)}）。收编之后智能体只在 ${path} 里做，`
      + "项目目录里的这些改动它就看不见了；Navi 不会替你搬走或丢掉它们。先提交、收起（git stash）或撤销，再收编。");
  }
  return null;
}

/** 给手动还原的命令用：路径、分支名按 shell 单引号包起来，带空格、引号的照样能直接粘贴运行。 */
const quoted = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** 收编要改动的东西的账（见文件头）。 */
export type AdoptLedger = {
  plan: BranchPlanSideEffects;
  renamed: { from: string; to: string } | null;
  moved: { from: string; to: string } | null;
  created: string[];
};

/**
 * 按账倒着收回，每一项收完都看一眼实际状态：没还原的那几项连同手动还原的办法一起返回，调用方照实说，
 * 不能一律报「已经收回原样」。
 */
export async function undoAdopt(repo: string, ledger: AdoptLedger): Promise<string[]> {
  const left: string[] = [];
  for (const path of [...ledger.created].reverse()) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* 下面按实际状态核对 */ }
    if (existsSync(path)) left.push(`复制出来的会话文件 ${path} 没删掉（可以手动删：rm -r ${quoted(path)}）`);
  }
  if (ledger.moved) {
    const { from, to } = ledger.moved;
    // 原位置已经被别的东西占了就不挪：目标是个已有目录时 git 会挪进它里面，那就更乱了。挪没挪回去按 git 登记认。
    if (!existsSync(from)) await git(repo, "worktree", "move", to, from).catch(() => {});
    const records = await worktreeRecords(repo).catch(() => []);
    if (!records.some((record) => samePath(record.path, from))) {
      const occupied = existsSync(from) ? `原位置 ${from} 已经被别的东西占了，先把它挪开，再` : "";
      left.push(`工作区还在 ${to}，没挪回 ${from}（${occupied}在项目目录运行 git worktree move ${quoted(to)} ${quoted(from)}）`);
    }
  }
  if (ledger.renamed) {
    const { from, to } = ledger.renamed;
    await git(repo, "branch", "-m", to, from).catch(() => {});
    if (!(await localBranchExists(repo, from)) || await localBranchExists(repo, to)) {
      left.push(`分支还叫 ${to}，没改回 ${from}（运行 git branch -m ${quoted(to)} ${quoted(from)}）`);
    }
  }
  await undoBranchPlanSideEffects(repo, ledger.plan);
  if (ledger.plan.frozenRef && await commitAt(repo, ledger.plan.frozenRef.ref)) {
    left.push(`冻结的开工点 ${ledger.plan.frozenRef.ref} 没删掉（运行 git update-ref -d ${ledger.plan.frozenRef.ref}）`);
  }
  if (ledger.plan.trackingBranch && await localBranchExists(repo, ledger.plan.trackingBranch.name)) {
    left.push(`顺手建的分支 ${ledger.plan.trackingBranch.name} 没删掉`);
  }
  return left;
}

const adoptedNote = (done: WorktreeAdopted) =>
  `〔工作目录已更换〕你自己建的工作区 ${done.from}（分支 ${done.fromBranch}）已由 Navi 接管，成了本任务的独立工作区：`
  + `目录挪到 ${done.path}${done.branch !== done.fromBranch ? `，分支改名为 ${done.branch}` : ""}，验收时合入 ${done.mergeTargetBranch}`
  + `（改动从它跟 ${done.mergeTargetBranch} 的分叉点 ${done.startCommit.slice(0, 7)} 算起）。`
  + `原来的路径 ${done.from} 已经不在了：之后读写文件、跑 git 都在新目录里，别回项目目录改东西，也别再自己建 worktree。`;

const adoptedLine = (done: WorktreeAdopted) =>
  `已收编智能体自建的工作区：${done.from} 挪到 ${done.path}`
  + `${done.branch !== done.fromBranch ? `，分支 ${done.fromBranch} 改名为 ${done.branch}` : ""}`
  + `，验收合入 ${done.mergeTargetBranch}，改动从分叉点 ${done.startCommit.slice(0, 7)} 算起。`
  + (done.upstream && done.branch !== done.fromBranch ? ` 远端上的 ${done.upstream} 没有动。` : "")
  + (done.notes.length ? ` ${done.notes.join("；")}。` : "");

/** 办。**调用方必须握着这条任务的回合锁**（task-worktree-move-routes.ts 当场占）。 */
export async function adoptForeignWorktree(taskId: string, input: AdoptInput): Promise<WorktreeAdopted> {
  const before = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!before) throw new WorktreeMoveError("任务不存在", 400);
  const project = (await db.select().from(projects).where(eq(projects.id, before.projectId))).at(0);
  if (!project) throw new WorktreeMoveError("任务所在的项目不存在", 400);
  const repo = expandHome(project.repoPath);
  const done = await withRepoLock(repo, async () => {
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task) throw new WorktreeMoveError("任务不存在", 400);
    // 进锁之后重新认一遍：这期间目录可能被删、被挪，或者已经有别的任务在里面跑。
    const worktree = (await foreignWorktreesOf(task, repo)).find((candidate) => samePath(candidate.path, input.path));
    if (!worktree) throw new WorktreeMoveError(`${input.path} 不是这条任务会话里用到过的、Navi 没管到的工作区（可能已经被挪走或删掉了）`);
    const refused = await adoptionBlocker(task, repo, worktree);
    if (refused) throw refused;
    const target = await adoptTarget(repo, worktree, input.mergeTargetBranch);
    if (target instanceof WorktreeMoveError) throw target;
    const start = await git(repo, "merge-base", target, worktree.head).catch(() => "");
    if (!start) throw new WorktreeMoveError(`分支 ${worktree.branch} 跟 ${target} 没有共同的祖先提交，算不出改动从哪里起，收编不了`);
    const upstream = await git(repo, "rev-parse", "--abbrev-ref", `${worktree.branch}@{upstream}`).catch(() => "") || null;

    // 分支计划按「从合入分支开工」摆（父任务、合入目标的规则跟新建任务同一份），算完把冻结的开工点挪到分叉点。
    const row = {
      ...task, status: "backlog" as const, stage: null, useWorktree: true, worktreeBase: target, worktreeStartCommit: null,
      worktreeBaseBranch: null, mergeTargetBranch: target, baseTaskId: null,
    };
    let plan: BranchPlanSideEffects;
    try {
      plan = await initializeBranchPlan(row, repo);
    } catch (error) {
      throw await planError(error) ?? error;
    }
    const ledger: AdoptLedger = { plan, renamed: null, moved: null, created: [] };
    try {
      if (!plan.frozenRef) {
        await git(repo, "update-ref", baseRef(task.id), start, "");
        plan.frozenRef = { ref: baseRef(task.id), commit: start };
      } else if (plan.frozenRef.commit !== start) {
        await git(repo, "update-ref", plan.frozenRef.ref, start, plan.frozenRef.commit);
        plan.frozenRef.commit = start;
      }
      const branch = await resolveWorktreeBranchName(repo, task.id);
      if (worktree.branch !== branch) {
        await git(repo, "branch", "-m", worktree.branch, branch);
        ledger.renamed = { from: worktree.branch, to: branch };
      }
      const path = worktreePathFor(repo, task.id);
      // 会话文件先搬、目录后挪：会话本来就在被收编的目录里跑的，claude 的会话文件按那个目录的真实路径存，
      // 目录一挪走就认不出它的真实路径了。记在项目目录上的会话，和记在被收编目录（或它底下哪一层）上的会话
      // 一起改指新目录；后一种按相对位置映射，原来在子目录里跑的挪完还在同一个子目录里。
      const carried: SessionMove = { rows: [], created: ledger.created, notes: [] };
      await carrySessions(task.id, [{ dir: repo, match: "exact" }, { dir: worktree.path, match: "inside" }], path, carried);
      mkdirSync(join(repo, ".worktrees"), { recursive: true });
      await ensureWorktreesIgnored(repo);
      if (!samePath(worktree.path, path)) {
        await git(repo, "worktree", "move", worktree.path, path);
        ledger.moved = { from: worktree.path, to: path };
      }
      const result: WorktreeAdopted = {
        from: worktree.seenAs, fromBranch: worktree.branch, path, branch, mergeTargetBranch: target, startCommit: start, upstream, notes: carried.notes,
      };
      const written = await writeMovedTask(task.id, null, carried.rows, { path, branch }, {
        worktreeBase: target, worktreeStartCommit: start, worktreeBaseBranch: row.worktreeBaseBranch ?? target,
        mergeTargetBranch: row.mergeTargetBranch ?? target, baseTaskId: row.baseTaskId ?? null,
      }, adoptedNote(result));
      if (!written) throw new WorktreeMoveError("任务在办的过程中被改动了，没有收编，再试一次");
      return result;
    } catch (error) {
      const left = await undoAdopt(repo, ledger);
      const reason = error instanceof WorktreeMoveError ? error.message
        : (error as { stderr?: string }).stderr?.trim() || (error instanceof Error ? error.message : String(error));
      if (left.length) throw new WorktreeMoveError(`收编半路失败：${reason}。收回时有几处没能还原，需要手动处理：${left.join("；")}`);
      if (error instanceof WorktreeMoveError) throw error;
      throw new WorktreeMoveError(`收编半路失败，已经把目录、分支名和冻结的开工点收回原样：${reason}`);
    }
  });
  await appendTaskTimeline(taskId, alertLine(adoptedLine(done)));
  await publishTaskUpdated(taskId);
  return done;
}
