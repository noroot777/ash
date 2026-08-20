import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { prepareWorktree, resolveWorkspace, staleBaseFallback, type Workspace } from "./git.js";
import { now } from "./util.js";

type WorkspaceTask = Pick<
  typeof tasks.$inferSelect,
  "id" | "projectId" | "parentId" | "useWorktree" | "worktreeBase" | "reviewOf"
>;

// base 降级(登记的基线分支已经没了，这次按仓库当前 HEAD 起的)必须**落回任务行**，
// 不能只在返回值里说一句：diff 和验收各自拿 `task.worktreeBase` 再解析一次目标分支
// (`git-diff.ts` 的 resolveTaskMergeTarget、`task-accept.ts` 冻结验收目标)，库里还留着
// 那个已删的名字的话，这一轮是起来了，用户下一步看 diff 会得到 target_branch_missing、
// 点验收被「目标本地分支不存在」挡回 —— 等于把「起不来」换成了「起得来但交不掉」。
//
// 两处不写：
//   · 降级的不是这个任务自己登记的那个 base(团队执行者那条路传的是共享分支)——那不是
//     它的登记值，写进去等于凭空给它按了个显式基线。
//   · 仓库处于 detached HEAD，`used` 是 "HEAD" 而不是分支名 —— 写进去只会把一个解析
//     不出分支的值固化下来。
async function persistBaseFallback(task: WorkspaceTask, ws: Workspace): Promise<void> {
  const fallback = ws.baseFallback;
  if (!fallback || fallback.used === "HEAD") return;
  if ((task.worktreeBase ?? "").trim() !== fallback.requested) return;
  await db
    .update(tasks)
    .set({ worktreeBase: fallback.used, updatedAt: now() })
    .where(eq(tasks.id, task.id));
  fallback.persisted = true;
}

/**
 * 工作目录还在、这一轮压根没经过 `taskWorkspace` 的续聊，同样要查一遍登记的基线还在不在。
 *
 * 续聊只在 cwd 消失时才重新解析工作目录（见 orchestrator.ts），而「worktree 好端端地在、
 * 登记的 base 分支被删了」正是最常见的一档：这一轮跑得好好的，直到用户去看 diff 或点验收
 * 才撞上 target_branch_missing。降级决策跟 `prepareWorktree` 是同一套（`staleBaseFallback`），
 * 这次没有重建任何目录，所以工作目录那两件事实都取默认的 false。
 */
export async function refreshTaskBase(task: WorkspaceTask, repoPath: string): Promise<Workspace["baseFallback"]> {
  if (!task.useWorktree) return undefined;
  const fallback = await staleBaseFallback(repoPath, task.worktreeBase);
  if (!fallback) return undefined;
  await persistBaseFallback(task, { path: "", branch: null, isWorktree: true, baseFallback: fallback });
  return fallback;
}

/** `isolatedWorkspaceOwner` 要读 mode（团队执行者是否跟随调度台），比执行路径多一个字段。 */
type OwnerTask = WorkspaceTask & Pick<typeof tasks.$inferSelect, "mode">;

/**
 * 这个任务真跑起来时会落在**谁的独立工作区**里：返回那个 worktree 的归属任务 id，
 * 直接在项目仓库里干活则返回 null。**只读，绝不建目录**。
 *
 * 判据必须跟下面 `taskWorkspace` 是同一棵决策树，不能拿 `task.useWorktree` 当答案：
 * 那个字段在单飞任务和团队执行者身上语义相反（执行者的 false = 跟随调度台的工作区，
 * 而调度台自己可能正开着 worktree）。审查任务同理，要跟到被审任务身上去。
 *
 * 用途是给只读解析（`taskFileRoot`）配一个「它本来该在哪」的对照：两者对不上——该有
 * 独立工作区、实际却回退到了项目主仓——说明那个目录还没建出来，此时任何写操作都会打在
 * 项目主工作区上。
 */
export async function isolatedWorkspaceOwner(task: OwnerTask): Promise<string | null> {
  if (task.reviewOf) {
    const target = (await db.select().from(tasks).where(eq(tasks.id, task.reviewOf))).at(0);
    if (target && target.projectId === task.projectId && !target.reviewOf) {
      return isolatedWorkspaceOwner(target);
    }
  }
  if (task.useWorktree) return task.id;
  if (!task.parentId) return null;
  const parent = (await db.select().from(tasks).where(eq(tasks.id, task.parentId))).at(0);
  if (!parent || parent.mode !== "team" || parent.projectId !== task.projectId) return null;
  return parent.useWorktree ? parent.id : null;
}

async function directWorkspace(task: WorkspaceTask, repoPath: string): Promise<Workspace> {
  if (!task.useWorktree) return resolveWorkspace(repoPath, task.id);
  const ws = await prepareWorktree(repoPath, task.id, task.worktreeBase);
  await persistBaseFallback(task, ws);
  return ws;
}

// Resolve the cwd for every executable task through one path.
//
// A team task may opt into its own worktree. Its workers default to the exact
// same workspace, so lead and workers see one filesystem. A worker that opts
// into worktree isolation still gets the conventional project-level
// `.worktrees/<workerId>` path (so detection/cleanup keeps working), but branches
// from the team's shared branch by default.
export async function taskWorkspace(task: WorkspaceTask, repoPath: string): Promise<Workspace> {
  // Reviewers operate on the exact files under review. Re-resolving the target
  // through this same function covers isolated worker worktrees and team-shared
  // workspaces without copying or creating a reviewer-owned worktree.
  if (task.reviewOf) {
    const target = (await db.select().from(tasks).where(eq(tasks.id, task.reviewOf))).at(0);
    if (target && target.projectId === task.projectId && !target.reviewOf) {
      return taskWorkspace(target, repoPath);
    }
  }
  if (!task.parentId) return directWorkspace(task, repoPath);

  const parent = (await db.select().from(tasks).where(eq(tasks.id, task.parentId))).at(0);
  if (!parent || parent.mode !== "team" || parent.projectId !== task.projectId) {
    return directWorkspace(task, repoPath);
  }

  const shared = await directWorkspace(parent, repoPath);
  if (!task.useWorktree) return shared;

  const explicitBase = task.worktreeBase?.trim();
  const ws = await prepareWorktree(repoPath, task.id, explicitBase || shared.branch);
  await persistBaseFallback(task, ws);
  return ws;
}
