import type { Context, Hono } from "hono";
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
import {
  checkSshKeyPath,
  readGitIdentity,
  sshCommandFor,
  writeGitIdentity,
  type WritableGitConfigKey,
} from "./git-identity.js";
import {
  deleteProjectGitCredential,
  readProjectGitCredential,
  saveProjectGitCredential,
} from "./git-credentials.js";
import { IS_PREVIEW_INSTANCE, previewRefusal } from "./preview-instance.js";
import { ScmOperationError } from "./scm-paths.js";
import { actorOf, authErrorResponse } from "./auth/context.js";
import { requireProjectAdmin } from "./auth/visibility.js";

// 项目主仓的 git 面板（侧栏那颗分支胶囊）。跟任务面板的
// `scm-routes.ts` 是**两个尺度**：那边的工作目录由 taskFileRoot 一路推导出来，这边的
// 目标永远只有一个——项目行上登记的 `repoPath`，没有回退档，也就没有「以为在改自己的
// worktree、其实在改主仓」那类错位。语义在 `git-project-ops.ts` 顶部。
//
// 写侧两道门禁：
//  ① **预览实例一律拒绝**。预览连的是主库快照，项目行里的 `repo_path` 指向的是真仓库
//     （`preview-instance.ts` 顶部），在沙盒里点一下切分支会真的把用户主仓的 HEAD 挪走。
//  ② **项目管理员/实例管理员**（多人模式，§四 权限表「项目设置」那一行）。这一屏改的是
//     整个项目共用的提交署名、SSH key、HTTPS 令牌，以及主仓自己的分支和工作树 —— 都是
//     项目设置,不是「在可见项目里派任务/回复」。普通成员改一次,所有人所有任务的
//     worktree 都跟着变(第 1 轮审查 P1)。自用模式下 `projectRoleOf` 恒为 admin,行为不变。
//
// **读侧不拦**：看仓库状态是安全的，凭证读回来也只有用户名（`git-credentials.ts` 里
// 令牌只写不读）。能不能改和能不能看是两件事，不捆在一起。
//
// 这里没有任务面板那三道（只读回退 / 归档冻结 / 任务在飞）：主仓不属于任何一个任务，
// 归档与否是任务的属性。至于「别的任务此刻正踩在主仓上」，挡它的是 `withRepoLock` 排队
// 加上锁内重读的脏检查，不是这一层。
//
// 后半段是**项目的 git 配置**（`/projects/:id/git-config`、`/git-credential`）：提交署名
// 和 SSH key 落在仓库自己的 .git/config（`git-identity.ts`），HTTPS 用户名/令牌落在 ash
// 的库里且只写不读（`git-credentials.ts`）。两个模块的顶部注释解释了为什么分开存。

const errorStatus = (error: unknown) => (error instanceof ScmOperationError ? error.status : 500);
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function repoPathOf(id: string): Promise<string | null> {
  const row = (await db.select().from(projects).where(eq(projects.id, id))).at(0);
  return row ? row.repoPath : null;
}

const PULL_STRATEGIES: PullStrategy[] = ["ff-only", "merge", "rebase"];

/** 读侧和写侧都返回这一份，前端存一个状态即可。 */
async function gitConfigView(projectId: string, repoPath: string | null) {
  const [identity, credential] = await Promise.all([
    readGitIdentity(repoPath),
    readProjectGitCredential(projectId),
  ]);
  return { identity, credential };
}

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

  api.get("/projects/:id/git-config", async (c) => {
    const id = c.req.param("id");
    const repoPath = await repoPathOf(id);
    if (repoPath === null) return c.json({ error: "not found" }, 404);
    try {
      return c.json(await gitConfigView(id, repoPath));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, errorStatus(error) as 400);
    }
  });

  /**
   * 写型请求共用的外壳：预览实例拒绝 → **项目管理员** → 项目存在性 → 解析 body →
   * 统一错误映射。`run` 拿得到项目 id，网络操作靠它取这个项目自己的凭证。
   *
   * 权限那一道走**共用外壳**而不是逐条挂:七条写路由(checkout/fetch/pull/push、
   * git-config、git-credential 的 PUT 与 DELETE)全从这里过,漏一条的可能性就没了。
   */
  const handler = (
    run: (repoPath: string, body: Record<string, unknown>, projectId: string) => Promise<unknown>,
  ) => async (c: Context) => {
    if (IS_PREVIEW_INSTANCE) return c.json({ error: previewRefusal("项目 Git 操作") }, 403);
    const id = c.req.param("id") ?? "";
    try {
      await requireProjectAdmin(actorOf(c), id);
    } catch (error) {
      const mapped = authErrorResponse(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
    const repoPath = await repoPathOf(id);
    if (repoPath === null) return c.json({ error: "not found" }, 404);
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    try {
      return c.json(await run(repoPath, body ?? {}, id));
    } catch (error) {
      return c.json({ error: errorMessage(error) }, errorStatus(error) as 400);
    }
  };

  const write = (
    path: string,
    run: (repoPath: string, body: Record<string, unknown>, projectId: string) => Promise<unknown>,
  ) => {
    api.post(path, handler(run));
  };

  write("/projects/:id/git/checkout", (repoPath, body) => {
    const branch = typeof body.branch === "string" ? body.branch.trim() : "";
    if (!branch) throw new ScmOperationError("branch required", 400);
    return checkoutProjectBranch(repoPath, branch);
  });

  write("/projects/:id/git/fetch", (repoPath, body, projectId) =>
    fetchProject(repoPath, typeof body.remote === "string" && body.remote ? body.remote : null, projectId));

  write("/projects/:id/git/pull", (repoPath, body, projectId) => {
    const strategy = typeof body.strategy === "string" ? body.strategy : "ff-only";
    if (!PULL_STRATEGIES.includes(strategy as PullStrategy)) {
      throw new ScmOperationError(`未知的拉取策略 ${strategy}`, 400);
    }
    return pullProject(repoPath, strategy as PullStrategy, projectId);
  });

  write("/projects/:id/git/push", (repoPath, body, projectId) =>
    pushProject(repoPath, typeof body.remote === "string" && body.remote ? body.remote : null, projectId));

  // 提交署名 / SSH key：只带上的字段才动，**空字符串是「清掉它，跟着全局走」**，
  // 跟「这次没提交这个字段」是两回事（`writeGitIdentity` 顶部）。
  api.put("/projects/:id/git-config", handler(async (repoPath, body, projectId) => {
    const patch: Partial<Record<WritableGitConfigKey, string>> = {};
    if (typeof body.userName === "string") patch["user.name"] = body.userName;
    if (typeof body.userEmail === "string") patch["user.email"] = body.userEmail;
    if (typeof body.sshKeyPath === "string") {
      const keyPath = checkSshKeyPath(body.sshKeyPath);
      patch["core.sshCommand"] = keyPath ? sshCommandFor(keyPath) : "";
    }
    const identity = await writeGitIdentity(repoPath, patch);
    return { identity, credential: await readProjectGitCredential(projectId) };
  }));

  api.put("/projects/:id/git-credential", handler(async (repoPath, body, projectId) => {
    const username = typeof body.username === "string" ? body.username : "";
    const secret = typeof body.secret === "string" ? body.secret : "";
    const credential = await saveProjectGitCredential(projectId, username, secret);
    return { identity: await readGitIdentity(repoPath), credential };
  }));

  api.delete("/projects/:id/git-credential", handler(async (repoPath, _body, projectId) => {
    await deleteProjectGitCredential(projectId);
    return { identity: await readGitIdentity(repoPath), credential: null };
  }));
}
