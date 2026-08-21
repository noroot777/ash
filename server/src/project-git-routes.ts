import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { projects } from "./db/schema.js";
import {
  checkoutProjectBranch,
  fetchProject,
  pullProject,
  pushProject,
  readProjectGitState,
  type PullStrategy,
} from "./git-project-ops.js";
import { IS_PREVIEW_INSTANCE, previewRefusal } from "./preview-instance.js";
import { ScmOperationError } from "./scm-paths.js";

// 项目主仓的 git 面板（侧栏那颗分支胶囊）。跟任务面板的
// `scm-routes.ts` 是**两个尺度**：那边的工作目录由 taskFileRoot 一路推导出来，这边的
// 目标永远只有一个——项目行上登记的 `repoPath`，没有回退档，也就没有「以为在改自己的
// worktree、其实在改主仓」那类错位。语义在 `git-project-ops.ts` 顶部。
//
// 写侧只有一道门禁：**预览实例一律拒绝**。预览连的是主库快照，项目行里的 `repo_path`
// 指向的是真仓库（`preview-instance.ts` 顶部），在沙盒里点一下切分支会真的把用户主仓的
// HEAD 挪走。读侧不拦——看是安全的。
//
// 这里没有任务面板那三道（只读回退 / 归档冻结 / 任务在飞）：主仓不属于任何一个任务，
// 归档与否是任务的属性。至于「别的任务此刻正踩在主仓上」，挡它的是 `withRepoLock` 排队
// 加上锁内重读的脏检查，不是这一层。

const errorStatus = (error: unknown) => (error instanceof ScmOperationError ? error.status : 500);
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function repoPathOf(id: string): Promise<string | null> {
  const row = (await db.select().from(projects).where(eq(projects.id, id))).at(0);
  return row ? row.repoPath : null;
}

const PULL_STRATEGIES: PullStrategy[] = ["ff-only", "merge", "rebase"];

export function mountProjectGitRoutes(api: Hono) {
  api.get("/projects/:id/git", async (c) => {
    const repoPath = await repoPathOf(c.req.param("id"));
    if (repoPath === null) return c.json({ error: "not found" }, 404);
    try {
      return c.json(await readProjectGitState(repoPath));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, errorStatus(error) as 400);
    }
  });

  const write = (
    path: string,
    run: (repoPath: string, body: Record<string, unknown>) => Promise<unknown>,
  ) => {
    api.post(path, async (c) => {
      if (IS_PREVIEW_INSTANCE) return c.json({ error: previewRefusal("项目 Git 操作") }, 403);
      const repoPath = await repoPathOf(c.req.param("id") ?? "");
      if (repoPath === null) return c.json({ error: "not found" }, 404);
      const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
      try {
        return c.json(await run(repoPath, body ?? {}));
      } catch (error) {
        return c.json({ error: errorMessage(error) }, errorStatus(error) as 400);
      }
    });
  };

  write("/projects/:id/git/checkout", (repoPath, body) => {
    const branch = typeof body.branch === "string" ? body.branch.trim() : "";
    if (!branch) throw new ScmOperationError("branch required", 400);
    return checkoutProjectBranch(repoPath, branch);
  });

  write("/projects/:id/git/fetch", (repoPath, body) =>
    fetchProject(repoPath, typeof body.remote === "string" && body.remote ? body.remote : null));

  write("/projects/:id/git/pull", (repoPath, body) => {
    const strategy = typeof body.strategy === "string" ? body.strategy : "ff-only";
    if (!PULL_STRATEGIES.includes(strategy as PullStrategy)) {
      throw new ScmOperationError(`未知的拉取策略 ${strategy}`, 400);
    }
    return pullProject(repoPath, strategy as PullStrategy);
  });

  write("/projects/:id/git/push", (repoPath, body) =>
    pushProject(repoPath, typeof body.remote === "string" && body.remote ? body.remote : null));
}
