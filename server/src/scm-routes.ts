import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { taskFileRoot, type WorkspaceRoot } from "./file-browser.js";
import {
  readScmCommits,
  readScmFileDiff,
  readScmStatus,
  type ScmDiffSource,
} from "./git-status.js";
import {
  commitWorkspace,
  discardPaths,
  ScmOperationError,
  stagePaths,
  unstagePaths,
} from "./git-workspace-ops.js";

// 任务工作区的「源代码管理」面板。工作目录的解析**复用 taskFileRoot**（会话 cwd >
// 约定 worktree 目录 > 项目仓库），绝不调 prepareWorktree：为了看一眼 git 状态而凭空
// 建出 worktree 和分支来，是 file-browser.ts 顶部那条注释写死的禁忌，这里同样适用。
//
// 写操作在任务**正在跑**时默认拒绝，要带 `force` 才放行。理由是 agent 此刻正在同一个
// 工作目录里写文件：这时候提交，提交进去的是它写到一半的中间状态；这时候丢弃，丢掉的
// 可能是它三秒前刚写出来、还没来得及提交的成果。这不是禁止，是要求用户明知故犯——
// 前端据此弹一次说明后果的确认框。

const RUNNING_STATES = new Set(["running", "queued"]);

interface ScmRequestBody {
  paths?: unknown;
  deleteUntracked?: unknown;
  message?: unknown;
  stagePaths?: unknown;
  amend?: unknown;
  force?: unknown;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function errorStatus(error: unknown): number {
  return error instanceof ScmOperationError ? error.status : 500;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publicRoot(root: WorkspaceRoot) {
  return { path: root.path, branch: root.branch, gitRepo: root.gitRepo, source: root.source };
}

export function mountScmRoutes(api: Hono) {
  /** 工作目录 + 这个任务此刻在不在跑。两件事都要，合成一次数据库读。 */
  const contextFor = async (taskId: string) => {
    const root = await taskFileRoot(taskId);
    if (!root) return { root: null, running: false } as const;
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    return { root, running: RUNNING_STATES.has(task?.status ?? "") } as const;
  };

  /** 读侧的公共前奏：解析目录、确认是 git 仓库，两者任一不成立就把响应交出去。 */
  const gitRootOr = async (taskId: string) => {
    const context = await contextFor(taskId);
    if (!context.root) return { error: "这个任务还没有可浏览的工作目录", status: 404 as const } as const;
    if (!context.root.gitRepo) return { error: "这个工作目录不是 Git 仓库", status: 409 as const } as const;
    return context;
  };

  api.get("/tasks/:id/scm", async (c) => {
    const context = await gitRootOr(c.req.param("id"));
    if ("error" in context) return c.json({ error: context.error }, context.status);
    try {
      const [status, commits] = await Promise.all([
        readScmStatus(context.root.path),
        readScmCommits(context.root.path),
      ]);
      return c.json({ root: publicRoot(context.root), taskRunning: context.running, status, commits });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 500);
    }
  });

  api.get("/tasks/:id/scm/diff", async (c) => {
    const context = await gitRootOr(c.req.param("id"));
    if ("error" in context) return c.json({ error: context.error }, context.status);
    const path = c.req.query("path") ?? "";
    const source = c.req.query("source") ?? "";
    if (!path) return c.json({ error: "缺少 path" }, 400);
    if (source !== "staged" && source !== "unstaged" && source !== "untracked") {
      return c.json({ error: "source 必须是 staged / unstaged / untracked" }, 400);
    }
    try {
      const diff = await readScmFileDiff(
        context.root.path,
        path,
        source as ScmDiffSource,
        c.req.query("origPath") || null,
      );
      return c.json(diff);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 500);
    }
  });

  /** 写操作的公共外壳：解析目录 → running 门禁 → 跑 → 回一份刷新后的状态。 */
  const write = (
    path: string,
    run: (root: WorkspaceRoot, body: ScmRequestBody) => Promise<unknown>,
  ) => {
    api.post(path, async (c) => {
      // 路径是变量，Hono 推不出参数名，取值补一个空串兜底（空 id 走 taskFileRoot 的 404）。
      const context = await gitRootOr(c.req.param("id") ?? "");
      if ("error" in context) return c.json({ error: context.error }, context.status);
      const body = await c.req.json().catch(() => ({})) as ScmRequestBody;
      if (context.running && body.force !== true) {
        return c.json({
          error: "任务正在运行，agent 此刻可能正在写这个工作目录；确认要继续请带 force",
          needsForce: true,
        }, 409);
      }
      try {
        const result = await run(context.root, body);
        // 每个写操作都把最新状态一起回去：面板不必再补一次请求，也不会出现
        // 「按钮已响应、列表还是旧的」那一帧。
        return c.json({ ...(result as object), status: await readScmStatus(context.root.path) });
      } catch (error) {
        return c.json({ error: errorMessage(error) }, errorStatus(error) as 400);
      }
    });
  };

  write("/tasks/:id/scm/stage", (root, body) =>
    stagePaths(root.path, root.repoPath, stringList(body.paths)));

  write("/tasks/:id/scm/unstage", (root, body) =>
    unstagePaths(root.path, root.repoPath, stringList(body.paths)));

  write("/tasks/:id/scm/discard", (root, body) =>
    discardPaths(root.path, root.repoPath, stringList(body.paths), stringList(body.deleteUntracked)));

  write("/tasks/:id/scm/commit", (root, body) =>
    commitWorkspace(root.path, root.repoPath, {
      message: typeof body.message === "string" ? body.message : "",
      stagePaths: stringList(body.stagePaths),
      amend: body.amend === true,
    }));
}
