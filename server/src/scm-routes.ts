import type { Hono } from "hono";
import { type WorkspaceRoot } from "./file-browser.js";
import {
  readScmCommits,
  readScmFileDiff,
  readScmRemotes,
  readScmStatus,
  type ScmDiffSource,
} from "./git-status.js";
import {
  commitWorkspace,
  discardPaths,
  pushWorkspace,
  ScmOperationError,
  ScmPartialError,
  stagePaths,
  unstagePaths,
  type ScmGuard,
} from "./git-workspace-ops.js";
import { IS_PREVIEW_INSTANCE, previewRefusal } from "./preview-instance.js";
import { assertInsideRoot, assertPathShape, gateScmPaths, scmNestedPaths } from "./scm-paths.js";
import {
  ARCHIVED_REFUSAL,
  claimWorkspaceWrite,
  resolveWorkspaceContext,
  workspaceBusyLabel,
  workspaceReadOnlyReason,
} from "./workspace-write-gate.js";

// 任务工作区的「源代码管理」面板。工作目录的解析**复用 taskFileRoot**（会话 cwd >
// 约定 worktree 目录 > 归属任务的工作区 > 项目仓库），绝不调 prepareWorktree：为了看一眼
// git 状态而凭空建出 worktree 和分支来，是 file-browser.ts 顶部那条注释写死的禁忌，这里
// 同样适用。
//
// 读侧只要目录存在就给看。**写侧的门禁不长在这个文件里**——归档冻结、回落主仓只读、
// 目录上有任务在飞要 force、以及锁内那道原子占位，四条判据连同各自的理由都在
// `workspace-write-gate.ts`（删文件那条路走的是同一套，判据抄第二份必然漂移）。这里只
// 留三件 scm 自己的事：
//
//   • **预览实例一律拒绝**。预览连的是主库的快照，但库里那些任务行的 `worktree_path`
//     指向的是**真仓库**（`preview-instance.ts` 顶部）。用户以为自己在沙盒里点着玩，
//     一次 discard 就不可逆地删掉了真实工作区里没提交的东西。读侧不拦——看是安全的。
//   • 把门禁的结论翻译成 scm 的错误：只读回 409 + `readOnly`，在飞回 409 + `needsForce`
//     （前端据此弹一次说明后果的确认框，用户确认再带 force 重来）。
//   • 「这个目录」的准星必须是 `taskFileRoot` **最终选中的那个 root**，不是项目登记的
//     `repoPath`：两者一分家，圈出来的共用者和上的锁就都落在一个跟眼前这份 git 状态无关
//     的仓库上（第 2 轮审查复现）。所以 `workspaceParticipants` 收 `root.path`，写型
//     git 操作收 `root.repo`（这个目录**自己**属于哪个仓库，linked worktree 记主仓）。


/**
 * 有任务在飞时挡下写操作。**不是错误，是要求用户明知故犯**——路由把它翻译成
 * `needsForce`，前端弹一次说明后果的确认框，用户点了确认再带 `force` 重来。
 */
class ScmBusyError extends ScmOperationError {
  constructor(who: string) {
    super(`${who}，agent 此刻可能正在写这个工作目录；确认要继续请带 force`, 409);
    this.name = "ScmBusyError";
  }
}

interface ScmRequestBody {
  paths?: unknown;
  deleteUntracked?: unknown;
  message?: unknown;
  stagePaths?: unknown;
  amend?: unknown;
  force?: unknown;
  remote?: unknown;
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
  /** 读侧的公共前奏：解析目录、确认是 git 仓库，两者任一不成立就把响应交出去。 */
  const gitRootOr = async (taskId: string) => {
    const context = await resolveWorkspaceContext(taskId);
    if ("error" in context) return { error: context.error, status: context.status } as const;
    if (!context.root.gitRepo) return { error: "这个工作目录不是 Git 仓库", status: 409 as const } as const;
    return context;
  };

  api.get("/tasks/:id/scm", async (c) => {
    const context = await gitRootOr(c.req.param("id"));
    if ("error" in context) return c.json({ error: context.error }, context.status);
    try {
      const [status, commits, remotes, readOnly] = await Promise.all([
        readScmStatus(context.root.path),
        readScmCommits(context.root.path),
        readScmRemotes(context.root.path),
        workspaceReadOnlyReason(context.task, context.root),
      ]);
      return c.json({
        root: publicRoot(context.root),
        taskRunning: !!context.busy,
        // 只读的理由要一起给：面板不光要收起按钮，还得说清楚为什么——「按钮不见了」
        // 和「按钮坏了」在用户那儿是同一件事。
        readOnly,
        status,
        commits,
        remotes,
      });
    } catch (error) {
      return c.json({ error: errorMessage(error) }, 500);
    }
  });

  api.get("/tasks/:id/scm/diff", async (c) => {
    const context = await gitRootOr(c.req.param("id"));
    if ("error" in context) return c.json({ error: context.error }, context.status);
    const path = c.req.query("path") ?? "";
    const source = c.req.query("source") ?? "";
    const origPath = c.req.query("origPath") || null;
    if (!path) return c.json({ error: "缺少 path" }, 400);
    if (source !== "staged" && source !== "unstaged" && source !== "untracked") {
      return c.json({ error: "source 必须是 staged / unstaged / untracked" }, 400);
    }
    try {
      // 读也要过路径闸。`source=untracked` 的预览走 `git diff --no-index -- /dev/null
      // <path>`，是四条路里唯一绕开 git pathspec、直接按文件系统路径读盘的——不挡的话
      // 一个 `../` 就能把 ash 进程读得到的任何文本文件读出来。白名单闸挡住仓库外的
      // 路径，realpath 闸再挡住工作区里指向外面的软链。
      const targets = assertPathShape(origPath ? [path, origPath] : [path]);
      const status = await gateScmPaths(context.root.path, { paths: targets });
      // 嵌套仓（自带 `.git` 的子目录）在白名单里，但没有可预览的内容：未跟踪预览走的
      // `git diff --no-index -- /dev/null <dir>` 会以 1 退出并报 `Could not access`，
      // 而 1 正是「有差异」的正常码，于是面板收到一份**空 diff**，看着像「这个文件没
      // 内容」。宁可明说不能预览。
      if (scmNestedPaths(status).has(path)) {
        throw new ScmOperationError(
          `${path} 是嵌套 Git 仓库（自带 .git 的子目录），这里预览不了它——请到它自己的仓库里看。`,
          409,
        );
      }
      if (source === "untracked") await assertInsideRoot(context.root.path, path);
      const diff = await readScmFileDiff(context.root.path, path, source as ScmDiffSource, origPath);
      return c.json(diff);
    } catch (error) {
      return c.json({ error: errorMessage(error) }, errorStatus(error) as 400);
    }
  });

  /** 写操作的公共外壳：预览门禁 → 解析目录 → 只读/在飞门禁 → 锁内原子占位 → 跑。 */
  const write = (
    path: string,
    run: (root: WorkspaceRoot, body: ScmRequestBody, guard: ScmGuard) => Promise<unknown>,
  ) => {
    api.post(path, async (c) => {
      if (IS_PREVIEW_INSTANCE) return c.json({ error: previewRefusal("改任务的工作区") }, 403);
      // 路径是变量，Hono 推不出参数名，取值补一个空串兜底（空 id 走 taskFileRoot 的 404）。
      const taskId = c.req.param("id") ?? "";
      const context = await gitRootOr(taskId);
      if ("error" in context) return c.json({ error: context.error }, context.status);
      const body = await c.req.json().catch(() => ({})) as ScmRequestBody;
      const forced = body.force === true;
      // 只读是**冻结**，不是「确认一下就能干」：force 不解这两道。
      const readOnly = await workspaceReadOnlyReason(context.task, context.root);
      if (readOnly) return c.json({ error: readOnly, readOnly }, 409);
      if (context.busy && !forced) {
        return c.json({
          error: new ScmBusyError(workspaceBusyLabel(taskId, context.busy)).message,
          needsForce: true,
        }, 409);
      }
      // 锁内那道是**占位**不是复查（为什么见 `workspace-write-gate.ts` 顶部）。
      const guard: ScmGuard = () => claimWorkspaceWrite({
        taskId,
        context,
        forced,
        busyError: (who) => new ScmBusyError(who),
        archivedError: () => new ScmOperationError(ARCHIVED_REFUSAL, 409),
        missingError: () => new ScmOperationError("这个任务已经不在了", 404),
      });
      try {
        const result = await run(context.root, body, guard);
        // 每个写操作都把最新状态一起回去：面板不必再补一次请求，也不会出现
        // 「按钮已响应、列表还是旧的」那一帧。**但这一读是 best-effort**：写操作已经
        // 落地了（提交尤其不可逆），再让一次只为显示服务的状态读取把它翻成 500，用户
        // 看到的就是「失败了，所以什么都没变」——那是假的。读不到就不带 status，前端
        // 自己补一次刷新。
        return c.json({ ...(result as object), status: await readScmStatus(context.root.path).catch(() => undefined) });
      } catch (error) {
        // 锁内复查挡下的，和进门时挡下的走同一条路：这不是失败，是要用户确认一次。
        if (error instanceof ScmBusyError) return c.json({ error: error.message, needsForce: true }, 409);
        // 改到一半停下的操作要额外回两样东西：**已经生效的清单**（`git clean` 删掉的文件
        // 找不回来、预暂存进索引的文件会被下一次提交带上，只回一句「失败」等于把它藏了），
        // 以及**刷新后的状态**——否则面板停在旧列表上，用户看到的是「操作失败了，所以
        // 什么都没变」。
        if (error instanceof ScmPartialError) {
          return c.json({
            error: errorMessage(error),
            partial: { done: error.done, pending: error.pending },
            status: await readScmStatus(context.root.path).catch(() => undefined),
          }, error.status as 409);
        }
        return c.json({ error: errorMessage(error) }, errorStatus(error) as 400);
      }
    });
  };

  write("/tasks/:id/scm/stage", (root, body, guard) =>
    stagePaths(root.path, root.repo, stringList(body.paths), guard));

  write("/tasks/:id/scm/unstage", (root, body, guard) =>
    unstagePaths(root.path, root.repo, stringList(body.paths), guard));

  write("/tasks/:id/scm/discard", (root, body, guard) =>
    discardPaths(root.path, root.repo, stringList(body.paths), stringList(body.deleteUntracked), guard));

  write("/tasks/:id/scm/commit", (root, body, guard) =>
    commitWorkspace(root.path, root.repo, {
      message: typeof body.message === "string" ? body.message : "",
      stagePaths: stringList(body.stagePaths),
      amend: body.amend === true,
    }, guard));

  write("/tasks/:id/scm/push", (root, body, guard) =>
    pushWorkspace(
      root.path,
      root.repo,
      typeof body.remote === "string" ? body.remote : null,
      guard,
      root.projectId,
    ));
}
