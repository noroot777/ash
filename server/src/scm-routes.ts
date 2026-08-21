import type { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { taskFileRoot, type WorkspaceRoot } from "./file-browser.js";
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
import { claimIdleWorkspaceTurns, claimWorkspaceTurn, isTurnClaimed } from "./runs.js";
import { isolatedWorkspaceOwner, workspaceParticipants, type WorkspacePeer } from "./task-workspace.js";
import { assertInsideRoot, assertPathShape, gateScmPaths, scmNestedPaths } from "./scm-paths.js";

// 任务工作区的「源代码管理」面板。工作目录的解析**复用 taskFileRoot**（会话 cwd >
// 约定 worktree 目录 > 归属任务的工作区 > 项目仓库），绝不调 prepareWorktree：为了看一眼
// git 状态而凭空建出 worktree 和分支来，是 file-browser.ts 顶部那条注释写死的禁忌，这里
// 同样适用。
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
// （`task-accept-guard.ts` 因为同一个原因也是这么判的）。团队调度台的常驻回合根本不占
// turn 锁，它的 status 是唯一凭据，少看一样就漏掉整类共用者。
//
// 而**问的对象是「这个目录」而不是「这个任务」**：工作目录不是一个任务的私产，调度台、
// 跟随它的执行者、它们各自的审查任务都落在同一个 worktree 里，同一个仓库被登记成两个
// 项目时两边的就地任务也共用主仓。只问当前这个 task id，兄弟执行者正写着文件，用户从这
// 一位的面板上无 force 就能把它的成果丢掉（第 4 轮审查在页面上真实复现，跨项目那一档见
// 第 1 轮）。
//
// 「这个目录」的准星必须是 `taskFileRoot` **最终选中的那个 root**，不是项目登记的
// `repoPath`：展示解析第一优先级是会话 cwd，而项目的 repoPath 随时能被 PATCH 改掉，两者
// 一分家，圈出来的共用者和上的锁就都落在一个跟眼前这份 git 状态无关的仓库上（第 2 轮
// 审查复现）。所以 `workspaceParticipants` 收 `root.path`（哪些任务下次会落进这个目录），
// 写型 git 操作收 `root.repo`（这个目录**自己**属于哪个仓库，linked worktree 记主仓）。
//
// 进门时的结论到动手时可能早过期了（排 `withRepoLock` 可能等上几秒），所以**真正动手
// 之前还要再来一道**——而那一道不能是「再查一次」：查完到 git 命令跑起来之间，一次启动
// 仍能合法插进来。锁内那道是 `claimWorkspaceTurn`：用启动同一把回合锁**原子占住全部
// 共用者**，占住期间他们的启动、归档、验收、派审都会被各自既有的守卫挡回去（它们查的
// 都是这把锁）。归档同理在占住之后复查。


const RUNNING_STATES = new Set(["running", "queued"]);

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

const ARCHIVED_REFUSAL = "任务已归档。归档 = 冻结，工作区在归档期间只读；要改先取消归档。";
const NOT_CREATED_REFUSAL = "这个任务应该在自己的独立工作区里干活，但那个目录还没建出来（任务还没跑过）。"
  + "现在看到的是项目主仓，只读——在这里写会改到项目主工作区上，那不是这个任务的东西。"
  + "要对主仓切分支 / 拉取 / 推送，用侧栏项目名下面那颗分支胶囊。";

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
  const loadTask = async (taskId: string) =>
    (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0) ?? null;

  type TaskRow = NonNullable<Awaited<ReturnType<typeof loadTask>>>;

  /**
   * 这个工作目录此刻有没有任务在飞——有就回那一位，没有回 null。
   *
   * 判据见顶部注释：DB status 和 turn 锁哪个说「在」都算在，问的对象是**共用这个目录的
   * 全部任务**而不是当前这一个。
   */
  const busyPeer = (peers: WorkspacePeer[]): WorkspacePeer | null =>
    peers.find((peer) => isTurnClaimed(peer.id) || RUNNING_STATES.has(peer.status ?? "")) ?? null;

  /** 「谁在飞」这句话：兄弟任务得报出名字，不然用户只会以为是自己这个任务在跑。 */
  const busyLabel = (taskId: string, peer: WorkspacePeer): string =>
    peer.id === taskId
      ? "任务正在运行"
      : `共用这个工作目录的另一个任务「${peer.title?.trim() || peer.id}」正在运行`;

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
    const peers = await workspaceParticipants(task, root.path);
    return { task, root, peers, busy: busyPeer(peers) } as const;
  };

  api.get("/tasks/:id/scm", async (c) => {
    const context = await gitRootOr(c.req.param("id"));
    if ("error" in context) return c.json({ error: context.error }, context.status);
    try {
      const [status, commits, remotes, readOnly] = await Promise.all([
        readScmStatus(context.root.path),
        readScmCommits(context.root.path),
        readScmRemotes(context.root.path),
        readOnlyReason(context.task, context.root),
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
      const readOnly = await readOnlyReason(context.task, context.root);
      if (readOnly) return c.json({ error: readOnly, readOnly }, 409);
      if (context.busy && !forced) {
        return c.json({ error: new ScmBusyError(busyLabel(taskId, context.busy)).message, needsForce: true }, 409);
      }
      // 锁内这一道是**占位**不是复查（见顶部注释）：占住之后启动会被 claimTurn 挡回，
      // 归档会被 task-archive-routes 的 isTurnClaimed 挡回，于是接下来读到的归档位和
      // 在飞状态到 git 命令跑完为止都不会再变。占的是**全部共用者**——只占自己那把，
      // 兄弟执行者照样能在我们跑 git 的同一时刻起跑。带 force 的也照样占，只是**占不到
      // 的那几位跳过**（那正是用户明知故犯要覆盖的那一档），闲置的同伴仍然要锁住；但
      // 归档不受 force 影响，一律复查。
      const guard: ScmGuard = async () => {
        const claimed = new Set(context.peers.map((peer) => peer.id));
        // 带 force 时占的是「能占到的全部」而不是全有或全无：一位共用者在跑就把整组锁
        // 还回去的话，**还没起跑的闲置同伴照样能在这次 git 期间起跑**——用户确认放行的
        // 是已经在写这个目录的那一位，不是整组（第 1 轮审查函数级复现）。
        const release = (forced
          ? claimIdleWorkspaceTurns([...claimed])
          : claimWorkspaceTurn([...claimed])) ?? undefined;
        try {
          const fresh = await loadTask(taskId);
          if (!fresh) throw new ScmOperationError("这个任务已经不在了", 404);
          if (fresh.archived) throw new ScmOperationError(ARCHIVED_REFUSAL, 409);
          if (!forced) {
            if (!release) throw new ScmBusyError("有任务正在这个工作目录里运行");
            // 占住之后再过一遍共用者名单：**占住的那批只看 DB status**（turn 锁此刻在
            // 我们自己手里，问它只会得到「在飞」），团队调度台的常驻回合又根本不占锁，
            // status 是它唯一的凭据；名单是刚重读的，占位之后才建出来的任务两样都看。
            const busy = (await workspaceParticipants(fresh, context.root.path)).find((peer) =>
              RUNNING_STATES.has(peer.status ?? "") || (!claimed.has(peer.id) && isTurnClaimed(peer.id)));
            if (busy) throw new ScmBusyError(busyLabel(taskId, busy));
          }
          return release;
        } catch (error) {
          release?.();
          throw error;
        }
      };
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
    pushWorkspace(root.path, root.repo, typeof body.remote === "string" ? body.remote : null, guard));
}
