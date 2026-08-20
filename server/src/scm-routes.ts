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
  ScmPartialError,
  stagePaths,
  unstagePaths,
  type ScmGuard,
} from "./git-workspace-ops.js";
import { IS_PREVIEW_INSTANCE, previewRefusal } from "./preview-instance.js";
import { claimWorkspaceTurn, isTurnClaimed } from "./runs.js";
import { isolatedWorkspaceOwner } from "./task-workspace.js";
import { assertInsideRoot, assertPathShape, gateScmPaths } from "./scm-paths.js";

// 任务工作区的「源代码管理」面板。工作目录的解析**复用 taskFileRoot**（会话 cwd >
// 约定 worktree 目录 > 项目仓库），绝不调 prepareWorktree：为了看一眼 git 状态而凭空
// 建出 worktree 和分支来，是 file-browser.ts 顶部那条注释写死的禁忌，这里同样适用。
//
// 读侧只要目录存在就给看。写侧多三道门禁，管的是四件不同的事：
//
//   • **预览实例一律拒绝**。预览连的是主库的快照，但库里那些任务行的 `worktree_path`
//     指向的是**真仓库**（`preview-instance.ts` 顶部）。用户以为自己在沙盒里点着玩，
//     一次 discard 就不可逆地删掉了真实工作区里没提交的东西。读侧不拦——看是安全的。
//   • **回退到项目主仓时只读**。`taskFileRoot` 的最后一档 fallback 是项目仓库本身，
//     一个「该有独立 worktree、但还没跑过所以目录不存在」的任务解出来的就是它。看没
//     问题，写就成了灾难：用户从一个还没开工的任务的面板上，不可逆地丢掉了项目主工作区
//     里属于他自己或别的任务的改动。判据是 `isolatedWorkspaceOwner`（跟执行路径同一棵
//     决策树），不是 `useWorktree` 那个在团队执行者身上语义相反的字段。
//   • **归档 = 冻结**，写接口一并冻住。任务树会把归档任务藏起来，但旧页面、别的客户端和
//     直接调 API 都绕得过去——冻结语义必须由后端守住（`task-archive-routes.ts` 顶部）。
//   • **任务在飞**时默认拒绝，要带 `force` 才放行。理由是 agent 此刻正在同一个工作
//     目录里写文件：这时候提交，提交进去的是它写到一半的中间状态；这时候丢弃，丢掉的
//     可能是它三秒前刚写出来、还没来得及提交的成果。这不是禁止，是要求用户明知故犯——
//     前端据此弹一次说明后果的确认框。
//
// 「在飞」的判据是 **DB status 或 turn 锁**，两个都要看：`claimTurn` 到 status 落
// `running` 之间有一段真实窗口，只看 status 会在 agent 已经开跑时放行不可逆的 discard
// （`task-accept-guard.ts` 因为同一个原因也是这么判的）。而且进门时的结论到动手时可能
// 早过期了（排 `withRepoLock` 可能等上几秒），所以**真正动手之前还要再来一道**——而那
// 一道不能是「再查一次」：查完到 git 命令跑起来之间，一次启动仍能合法插进来。锁内那道
// 是 `claimWorkspaceTurn`：用启动同一把回合锁**原子占住**，占住期间新的启动、归档、
// 验收、派审都会被各自既有的守卫挡回去（它们查的都是这把锁）。归档同理在占住之后复查。


const RUNNING_STATES = new Set(["running", "queued"]);

/**
 * 任务在飞时挡下写操作。**不是错误，是要求用户明知故犯**——路由把它翻译成
 * `needsForce`，前端弹一次说明后果的确认框，用户点了确认再带 `force` 重来。
 */
class ScmBusyError extends ScmOperationError {
  constructor() {
    super("任务正在运行，agent 此刻可能正在写这个工作目录；确认要继续请带 force", 409);
    this.name = "ScmBusyError";
  }
}

const ARCHIVED_REFUSAL = "任务已归档。归档 = 冻结，工作区在归档期间只读；要改先取消归档。";
const NOT_CREATED_REFUSAL = "这个任务应该在自己的独立工作区里干活，但那个目录还没建出来（任务还没跑过）。"
  + "现在看到的是项目主仓，只读——在这里写会改到项目主工作区上，那不是这个任务的东西。";

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
  const loadTask = async (taskId: string) =>
    (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0) ?? null;

  type TaskRow = NonNullable<Awaited<ReturnType<typeof loadTask>>>;

  /** 这个任务此刻在不在飞。DB status 和 turn 锁哪个说「在」都算在（见顶部注释）。 */
  const inFlight = (task: TaskRow) =>
    isTurnClaimed(task.id) || RUNNING_STATES.has(task.status ?? "");

  /**
   * 这个工作目录**能不能写**：不能写就回一句给用户看的话，能写回 null。
   *
   * 两条都是「只读」而不是「失败」——面板据此收起按钮，而不是让用户点下去再吃一个错。
   */
  const readOnlyReason = async (task: TaskRow, root: WorkspaceRoot): Promise<string | null> => {
    if (task.archived) return ARCHIVED_REFUSAL;
    if (root.source === "repo" && await isolatedWorkspaceOwner(task)) return NOT_CREATED_REFUSAL;
    return null;
  };

  /** 读侧的公共前奏：解析目录、确认是 git 仓库，两者任一不成立就把响应交出去。 */
  const gitRootOr = async (taskId: string) => {
    const task = await loadTask(taskId);
    if (!task) return { error: "这个任务还没有可浏览的工作目录", status: 404 as const } as const;
    const root = await taskFileRoot(taskId);
    if (!root) return { error: "这个任务还没有可浏览的工作目录", status: 404 as const } as const;
    if (!root.gitRepo) return { error: "这个工作目录不是 Git 仓库", status: 409 as const } as const;
    return { task, root, running: inFlight(task) } as const;
  };

  api.get("/tasks/:id/scm", async (c) => {
    const context = await gitRootOr(c.req.param("id"));
    if ("error" in context) return c.json({ error: context.error }, context.status);
    try {
      const [status, commits, readOnly] = await Promise.all([
        readScmStatus(context.root.path),
        readScmCommits(context.root.path),
        readOnlyReason(context.task, context.root),
      ]);
      return c.json({
        root: publicRoot(context.root),
        taskRunning: context.running,
        // 只读的理由要一起给：面板不光要收起按钮，还得说清楚为什么——「按钮不见了」
        // 和「按钮坏了」在用户那儿是同一件事。
        readOnly,
        status,
        commits,
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
      // 一个 `../` 就能把 harness 进程读得到的任何文本文件读出来。白名单闸挡住仓库外的
      // 路径，realpath 闸再挡住工作区里指向外面的软链。
      const targets = assertPathShape(origPath ? [path, origPath] : [path]);
      await gateScmPaths(context.root.path, { paths: targets });
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
      const readOnly = await readOnlyReason(context.task, context.root);
      if (readOnly) return c.json({ error: readOnly, readOnly }, 409);
      if (context.running && !forced) return c.json({ error: new ScmBusyError().message, needsForce: true }, 409);
      // 锁内这一道是**占位**不是复查（见顶部注释）：占住之后启动会被 claimTurn 挡回，
      // 归档会被 task-archive-routes 的 isTurnClaimed 挡回，于是接下来读到的归档位和
      // 在飞状态到 git 命令跑完为止都不会再变。带 force 的照样占（占不到就是有回合在
      // 跑，那正是用户明知故犯要覆盖的那一档），但归档不受 force 影响，一律复查。
      const guard: ScmGuard = async () => {
        const release = claimWorkspaceTurn(taskId) ?? undefined;
        try {
          const fresh = await loadTask(taskId);
          if (!fresh) throw new ScmOperationError("这个任务已经不在了", 404);
          if (fresh.archived) throw new ScmOperationError(ARCHIVED_REFUSAL, 409);
          if (!forced && (!release || RUNNING_STATES.has(fresh.status ?? ""))) throw new ScmBusyError();
          return release;
        } catch (error) {
          release?.();
          throw error;
        }
      };
      try {
        const result = await run(context.root, body, guard);
        // 每个写操作都把最新状态一起回去：面板不必再补一次请求，也不会出现
        // 「按钮已响应、列表还是旧的」那一帧。
        return c.json({ ...(result as object), status: await readScmStatus(context.root.path) });
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
    stagePaths(root.path, root.repoPath, stringList(body.paths), guard));

  write("/tasks/:id/scm/unstage", (root, body, guard) =>
    unstagePaths(root.path, root.repoPath, stringList(body.paths), guard));

  write("/tasks/:id/scm/discard", (root, body, guard) =>
    discardPaths(root.path, root.repoPath, stringList(body.paths), stringList(body.deleteUntracked), guard));

  write("/tasks/:id/scm/commit", (root, body, guard) =>
    commitWorkspace(root.path, root.repoPath, {
      message: typeof body.message === "string" ? body.message : "",
      stagePaths: stringList(body.stagePaths),
      amend: body.amend === true,
    }, guard));
}
