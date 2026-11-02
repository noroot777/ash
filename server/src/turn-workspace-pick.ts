// **这一轮在哪个目录跑** —— 从 orchestrator.ts 拆出来(单文件 700 行的约定)。
//
// 拆的是一件独立的职责:记在会话行上的那个目录可能**已经不在了**(worktree 被清掉、项目
// 搬了家)。上一版把它原样交给 spawn,任务就永久卡在 running(docs/incidents.md);现在走
// fresh run 同一条解析路 —— 分支还在就把 worktree 恢复出来,分支也没了才建一个空的,并把
// 「上一轮的记忆对不上了」这件事交回去(调用方据此决定要不要贴 WORKSPACE_RESET)。
//
// 目录还在的那一侧也不是什么都不用做:可登记的**验收目标**照样可能已经没了(验收合并后
// 目标分支被删、worktree 却留着),所以那一支要刷一遍基线,否则这一轮跑得好好的、用户到
// 验收那头才撞墙。
import type { projects, tasks } from "./db/schema.js";
import { existsSync } from "node:fs";
import { refreshTaskBase, taskWorkspace } from "./task-workspace.js";
import type { Workspace } from "./git.js";

/**
 * 解析这一轮的工作目录。
 *
 * - `cwd`:真正交给 spawn 的那个目录。
 * - `workspaceReset`:**续上的会话**拿到了一个新建的空目录 —— 它脑子里的路径全不作数了,
 *   调用方要把这件事贴进本轮 prompt(只有续聊才需要:新会话本来就两手空空)。
 * - `freshWorkspace`:这个目录是这一轮新建出来的(基线快照要据此跳过比对)。
 * - `baseFallback`:登记的基线被换掉了 —— 说明由调用方在 spawn 之后补(见 base-fallback-notice.ts)。
 */
export async function pickTurnWorkspace(input: {
  task: typeof tasks.$inferSelect;
  project: typeof projects.$inferSelect | undefined;
  /** 会话行上记着的那个目录（调用方按 opts.cwd → prev → 任意会话的顺序取好）。 */
  recorded: string;
  resuming: boolean;
}): Promise<{ cwd: string; workspaceReset: boolean; freshWorkspace: boolean; baseFallback: Workspace["baseFallback"] }> {
  const { task, project, recorded, resuming } = input;
  let baseFallback: Workspace["baseFallback"];
  // A recorded cwd that has since vanished (worktree cleaned up, project moved)
  // used to be handed to spawn as-is — which stuck the task in 'running' forever.
  // Re-resolve through the same path a fresh run takes: it RESTORES the worktree
  // when the branch outlived the directory, and only rebuilds an empty one when
  // the branch is gone too.
  let cwd = recorded;
  let workspaceReset = false;
  let freshWorkspace = false;
  if (!existsSync(cwd)) {
    if (project) {
      const ws = await taskWorkspace(task, project.repoPath);
      cwd = ws.path;
      freshWorkspace = !!ws.fresh;
      baseFallback = ws.baseFallback;
      // Only a resumed session carries stale memory worth correcting; a fresh
      // session starts empty-handed and needs no warning.
      workspaceReset = freshWorkspace && resuming;
    } else if (!cwd) {
      cwd = ".";
    }
  } else if (project) {
    // 目录还在 = 这一轮不重新解析工作目录，可登记的**验收目标**照样可能已经没了
    //（验收合并后目标分支被删，worktree 却留着）。不查的话这一轮跑得好好的，用户
    // 到 diff / 验收那头才撞墙 —— 那正是上一轮修的「起得来但交不掉」。
    baseFallback = await refreshTaskBase(task, project.repoPath);
  }
  return { cwd, workspaceReset, freshWorkspace, baseFallback };
}
