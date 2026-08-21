import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { projects, tasks } from "./db/schema.js";
import {
  acceptedCommitDiff,
  acceptedCommitFileDiff,
  taskBranchDiff,
  taskBranchFileDiff,
} from "./git-diff.js";
import { assertPathShape, ScmOperationError } from "./scm-paths.js";

// 「这条任务分支相对合入目标改了什么」——**已经提交**的那一份，只读。
//
// 跟 `scm-routes.ts` 是两个问题，别混：那边读的是工作目录里此刻还没落进提交的东西
// （索引 + 工作树），这边读的是提交历史上的一段区间。同一个文件两边的内容可以完全不同，
// 所以两套接口各走各的，路径也不通用（工作区那套的路径闸是「必须出现在当前 git status
// 里」，一个提交过、工作区已经干净的文件在那儿一律被拒）。
//
// 两档数据源由任务自己的状态决定，且**清单与单文件必须同源**：验收之后原分支和 worktree
// 都清掉了，只能按冻结下来的 commit 区间读；没验收就按 `merge-base(target, 任务分支)`
// 到分支头读。清单那一档给了 A、点进去按 B 比，用户看到的是一份对不上的 diff。

export function mountTaskDiffRoutes(api: Hono): void {
  /** 任务 + 它的项目 + 「按哪一档区间读」。两张表任一缺失都给 404。 */
  const diffContext = async (taskId: string) => {
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task) return { error: "not found", status: 404 as const } as const;
    const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
    if (!project) return { error: "project not found", status: 404 as const, projectId: task.projectId } as const;
    const accepted = task.stage === "accepted" && task.acceptedTargetBranch
      && task.acceptedBaseCommit && task.acceptedMergeCommit
      ? {
        branch: task.acceptedTargetBranch,
        baseCommit: task.acceptedBaseCommit,
        mergeCommit: task.acceptedMergeCommit,
      }
      : null;
    return { task, project, accepted } as const;
  };

  api.get("/tasks/:id/diff", async (c) => {
    const context = await diffContext(c.req.param("id"));
    if ("error" in context) return c.json({ error: context.error, projectId: context.projectId }, context.status);
    if (context.accepted) {
      return c.json(await acceptedCommitDiff(
        context.project.repoPath,
        context.accepted.branch,
        context.accepted.baseCommit,
        context.accepted.mergeCommit,
      ));
    }
    return c.json(await taskBranchDiff(context.project.repoPath, context.task.id, context.task.worktreeBase));
  });

  api.get("/tasks/:id/diff/file", async (c) => {
    const taskId = c.req.param("id");
    const path = c.req.query("path") ?? "";
    const origPath = c.req.query("origPath") || null;
    const context = await diffContext(taskId);
    if ("error" in context) return c.json({ error: context.error, projectId: context.projectId }, context.status);
    try {
      // 形状闸而已，没有白名单可用（提交历史里的路径不在 git status 里）。挡的是绝对路径
      // 和 `..`——真正的越界防线是 git 自己：pathspec 带 `--` 且加 `:(literal)`，读的是
      // 对象库里的那两个提交，不碰文件系统，所以 `../` 在这里既走不出仓库也读不到别的盘。
      assertPathShape(origPath ? [path, origPath] : [path]);
      const diff = context.accepted
        ? await acceptedCommitFileDiff(
          context.project.repoPath,
          context.accepted.baseCommit,
          context.accepted.mergeCommit,
          path,
          origPath,
        )
        : await taskBranchFileDiff(context.project.repoPath, taskId, context.task.worktreeBase, path, origPath);
      return c.json(diff);
    } catch (error) {
      const status = error instanceof ScmOperationError ? error.status : 500;
      return c.json({ error: error instanceof Error ? error.message : String(error) }, status as 400);
    }
  });
}
