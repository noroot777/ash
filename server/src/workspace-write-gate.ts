import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { taskFileRoot, type WorkspaceRoot } from "./file-browser.js";
import { claimIdleWorkspaceTurns, claimWorkspaceTurn, isTurnClaimed } from "./runs.js";
import { isolatedWorkspaceOwner, workspaceParticipants, type WorkspacePeer } from "./task-workspace.js";

// ── 「能不能动这个任务的工作目录」的公共门禁 ─────────────────────────────────
//
// 原来只长在 `scm-routes.ts` 里，但**它管的不是 git，是那个目录**：删一个文件和丢弃一次
// 改动对 agent 的伤害完全一样（都是趁它写到一半把东西抹掉），门禁却有四条各自独立的
// 理由，抄第二份必然漂移——`docs/incidents.md`「对称端点只改了一个」就是这么来的。所以
// 判据住在这里，路由各自决定怎么把它翻译成自己的错误和状态码。
//
//   • **只读档（force 也不解）**：任务已归档 = 冻结；解析回落到项目主仓（任务该有自己的
//     worktree、但目录还没建出来）时一律只读——在那儿写等于改到项目主工作区上。
//   • **在飞档（要用户明知故犯）**：这个目录上有任务在跑就先拒，前端弹一次说明后果的
//     确认框，用户确认后带 force 重来。
//   • 「在飞」的判据是 **DB status 或 turn 锁**，两个都要看（`claimTurn` 到 status 落
//     `running` 之间有真实窗口，而团队常驻调度台根本不占 turn 锁，status 是它唯一凭据）。
//   • **问的对象是「这个目录」而不是「这个任务」**：调度台、跟它的执行者、各自的审查任务
//     都落在同一个 worktree 里，只问当前这一位，兄弟执行者的成果就会被无声抹掉。
//
// 进门时的结论到真正动手时可能已经过期（排 `withRepoLock` 可能等上几秒），所以锁内还有
// `claimWorkspaceWrite` 那一道：它不是「再查一次」（查完到动手之间仍能插进来一次启动），
// 而是**用启动同一把回合锁原子占住全部共用者**，占住期间他们的启动、归档、验收、派审都
// 会被各自既有的守卫挡回去。

const RUNNING_STATES = new Set(["running", "queued"]);

export const ARCHIVED_REFUSAL = "任务已归档。归档 = 冻结，工作区在归档期间只读；要改先取消归档。";
export const NOT_CREATED_REFUSAL = "这个任务应该在自己的独立工作区里干活，但那个目录还没建出来（任务还没跑过）。"
  + "现在看到的是项目主仓，只读——在这里写会改到项目主工作区上，那不是这个任务的东西。"
  + "要对主仓切分支 / 拉取 / 推送，用侧栏项目名下面那颗分支胶囊。";

export type WorkspaceTaskRow = typeof tasks.$inferSelect;

export interface WorkspaceWriteContext {
  task: WorkspaceTaskRow;
  root: WorkspaceRoot;
  /** 下一轮会落进这个目录的全部任务——门禁问的是他们，不是当前这一位。 */
  peers: WorkspacePeer[];
  /** 此刻真有在飞的那一位，没有就是 null。 */
  busy: WorkspacePeer | null;
}

export async function loadWorkspaceTask(taskId: string): Promise<WorkspaceTaskRow | null> {
  return (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0) ?? null;
}

/** 这个目录此刻有没有任务在飞——有就回那一位。 */
export function busyWorkspacePeer(peers: WorkspacePeer[]): WorkspacePeer | null {
  return peers.find((peer) => isTurnClaimed(peer.id) || RUNNING_STATES.has(peer.status ?? "")) ?? null;
}

/** 「谁在飞」这句话：兄弟任务得报出名字，不然用户只会以为是自己这个任务在跑。 */
export function workspaceBusyLabel(taskId: string, peer: WorkspacePeer): string {
  return peer.id === taskId
    ? "任务正在运行"
    : `共用这个工作目录的另一个任务「${peer.title?.trim() || peer.id}」正在运行`;
}

/**
 * 这个工作目录**能不能写**：不能写就回一句给用户看的话，能写回 null。
 *
 * 两条都是「只读」而不是「失败」——面板据此收起按钮，而不是让用户点下去再吃一个错。
 */
export async function workspaceReadOnlyReason(
  task: WorkspaceTaskRow,
  root: WorkspaceRoot,
): Promise<string | null> {
  if (task.archived) return ARCHIVED_REFUSAL;
  if (root.source === "repo" && await isolatedWorkspaceOwner(task)) return NOT_CREATED_REFUSAL;
  return null;
}

/** 解析目录并圈出共用者。解析不出来时把响应交给调用方。 */
export async function resolveWorkspaceContext(
  taskId: string,
): Promise<WorkspaceWriteContext | { error: string; status: 404 }> {
  const task = await loadWorkspaceTask(taskId);
  if (!task) return { error: "这个任务还没有可浏览的工作目录", status: 404 };
  const root = await taskFileRoot(taskId);
  if (!root) return { error: "这个任务还没有可浏览的工作目录", status: 404 };
  const peers = await workspaceParticipants(task, root.path);
  return { task, root, peers, busy: busyWorkspacePeer(peers) };
}

export interface WorkspaceClaimOptions {
  taskId: string;
  context: WorkspaceWriteContext;
  /** 用户已经在「有任务在跑」的确认框上点过继续。 */
  forced: boolean;
  /** 复查挡下时抛什么——各路由的状态码与 `needsForce` 翻译不同，错误类型留给调用方。 */
  busyError: (who: string) => Error;
  archivedError: (message: string) => Error;
  missingError: () => Error;
}

/**
 * 锁内**占位**（不是复查）：占住之后启动会被 `claimTurn` 挡回、归档会被
 * `task-archive-routes` 的 `isTurnClaimed` 挡回，于是接下来读到的归档位和在飞状态到动手
 * 做完为止都不会再变。占的是**全部共用者**——只占自己那把，兄弟执行者照样能在同一时刻
 * 起跑。
 *
 * 带 force 时占的是「能占到的全部」而不是全有或全无：一位共用者在跑就把整组锁还回去的
 * 话，**还没起跑的闲置同伴照样能在这次操作期间起跑**——用户确认放行的是已经在写这个目录
 * 的那一位，不是整组。归档不受 force 影响，一律复查。
 *
 * 返回释放函数，调用方必须在 finally 里调它。
 */
export async function claimWorkspaceWrite(options: WorkspaceClaimOptions): Promise<(() => void) | undefined> {
  const { taskId, context, forced } = options;
  const claimed = new Set(context.peers.map((peer) => peer.id));
  const release = (forced
    ? claimIdleWorkspaceTurns([...claimed])
    : claimWorkspaceTurn([...claimed])) ?? undefined;
  try {
    const fresh = await loadWorkspaceTask(taskId);
    if (!fresh) throw options.missingError();
    if (fresh.archived) throw options.archivedError(ARCHIVED_REFUSAL);
    if (!forced) {
      if (!release) throw options.busyError("有任务正在这个工作目录里运行");
      // 占住之后再过一遍共用者名单：**占住的那批只看 DB status**（turn 锁此刻在我们自己
      // 手里，问它只会得到「在飞」），团队调度台的常驻回合又根本不占锁，status 是它唯一的
      // 凭据；名单是刚重读的，占位之后才建出来的任务两样都看。
      const busy = (await workspaceParticipants(fresh, context.root.path)).find((peer) =>
        RUNNING_STATES.has(peer.status ?? "") || (!claimed.has(peer.id) && isTurnClaimed(peer.id)));
      if (busy) throw options.busyError(workspaceBusyLabel(taskId, busy));
    }
    return release;
  } catch (error) {
    release?.();
    throw error;
  }
}
