import { statSync } from "node:fs";
import { desc, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { projects, sessions, tasks } from "./db/schema.js";
import {
  expandHome,
  prepareWorktree,
  repoKey,
  resolveWorkspace,
  staleBaseFallback,
  worktreePathFor,
  type Workspace,
} from "./git.js";
import { now } from "./util.js";

// `repoKey` 每次都要 realpath 一路走上去，`workspaceParticipants` 一次要问几百条路径，
// 同一个目录会被反复问到。**只在一次调用里记账**（下面每次调用现建两张表）：目录和软链
// 随时在增删，跨调用缓存等于拿上一秒的文件系统答这一秒的问题。
const memo = <T>(fn: (p: string) => T) => {
  const cache = new Map<string, T>();
  return (p: string): T => {
    const hit = cache.get(p);
    if (hit !== undefined) return hit;
    const value = fn(p);
    cache.set(p, value);
    return value;
  };
};

const isDirSync = (p: string) => {
  try { return statSync(p).isDirectory(); } catch { return false; }
};

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
 * 归属解析要查的「另一个任务」从哪来。默认查库；`workspaceParticipants` 要把整个项目
 * 的任务过一遍归属判定，用一次批查换掉 N 次单查（判定逻辑仍是同一份，不另写一套）。
 */
type OwnerLookup = (id: string) => Promise<OwnerTask | undefined>;

const lookupFromDb: OwnerLookup = async (id) =>
  (await db.select().from(tasks).where(eq(tasks.id, id))).at(0);

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
export async function isolatedWorkspaceOwner(
  task: OwnerTask,
  lookup: OwnerLookup = lookupFromDb,
): Promise<string | null> {
  if (task.reviewOf) {
    const target = await lookup(task.reviewOf);
    if (target && target.projectId === task.projectId && !target.reviewOf) {
      return isolatedWorkspaceOwner(target, lookup);
    }
  }
  if (task.useWorktree) return task.id;
  if (!task.parentId) return null;
  const parent = await lookup(task.parentId);
  if (!parent || parent.mode !== "team" || parent.projectId !== task.projectId) return null;
  return parent.useWorktree ? parent.id : null;
}

/** 共用同一个工作目录的一位任务：id 之外还带着判「在不在飞」和写提示要用的两列。 */
export type WorkspacePeer = { id: string; title: string | null; status: string | null };

/**
 * 一个任务**下一次跑起来会落进哪个目录**。判据抄的是 orchestrator 起跑时那段取值
 * （`opts.cwd || prev?.cwd || … `，路径没了才重新解析工作区），所以这里排在最前的也是
 * 「自己名下最新的、目录还在的那条会话 cwd」。
 *
 * 只看它自己的会话：orchestrator 也只看自己的。归属任务的会话是 `taskFileRoot` 为了
 * 「展示哪儿」额外查的一档，拿到这里会把还没跑过的执行者错判进领队的历史目录。
 *
 * 没跑过就按决策树推：有归属就是 `<repo>/.worktrees/<owner>`，否则项目仓库本身。这一档
 * **不要求目录已存在**——它答的是「会落在哪」，而 worktree 正是那次启动才建出来的；要求
 * 存在就会把一个还没起过的 worktree 任务算成主仓的共用者，凭空多出一个假在飞。
 */
function nextRunDirOf(
  row: WorkspaceTask,
  owner: string | null,
  repoOf: (projectId: string) => string,
  sessionDirs: Map<string, string[]>,
  dirExists: (p: string) => boolean,
): string {
  for (const dir of sessionDirs.get(row.id) ?? []) {
    if (dirExists(dir)) return dir;
  }
  const repo = repoOf(row.projectId);
  if (!repo) return "";
  return owner ? worktreePathFor(repo, owner) : repo;
}

/**
 * 跟这个任务**共用同一个工作目录**的全部任务（含它自己）。
 *
 * 为什么需要它：工作目录不是一个任务的私产。团队调度台和它那些 `useWorktree=false` 的
 * 执行者、以及它们各自的审查任务，真跑起来全落在同一个 worktree 里；就地干活的那批则
 * 共用项目主仓。按单个 task id 判「在不在飞」、按单个 task id 上锁，等于只看了共用者里
 * 的一个：兄弟执行者正在写文件，用户从这一位的面板上无 force 就能把它的成果丢掉
 * （第 4 轮审查在页面上真实复现）。
 *
 * **圈定的键是 `rootPath` 这个物理目录本身，不是项目登记的 `repoPath`。** 展示解析
 * （`taskFileRoot`）第一优先级是会话 cwd，而项目的 `repoPath` 随时可以被 PATCH 改掉：
 * 任务在旧仓库里干着活，项目已经改指新仓库，按项目圈候选就看不见旧仓库里正在跑的那些
 * 任务——面板不显示在飞横幅，无 force 的 discard 直接把对面的成果丢掉（第 2 轮审查复现）。
 * 传进来的 root 必须是 `taskFileRoot` 最终选中的那个目录，展示、busy、turn 占位、repo
 * lock 才会指向同一处。
 *
 * 判据是「**真跑起来**会落在哪」（`nextRunDirOf`，跟 `taskWorkspace` 同一棵决策树），
 * 不是「上一次跑在哪」：要挡的是接下来那次启动。归档任务不算——归档 = 冻结，它起不来
 * （`task-archive-routes.ts`）。归一按 `repoKey`：`~` 展开、尾斜杠、`.`/`..`、软链都算
 * 进去，所以同一个目录换一种合法写法登记的项目也照样圈得进来。
 */
export async function workspaceParticipants(task: OwnerTask, rootPath: string): Promise<WorkspacePeer[]> {
  const rows = await db.select().from(tasks);
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  const lookup: OwnerLookup = async (id) => byId.get(id) ?? await lookupFromDb(id);
  const keyOf = memo(repoKey);
  const dirExists = memo(isDirSync);

  const peers = new Map<string, WorkspacePeer>();
  const take = (row: { id: string; title: string | null; status: string | null }) =>
    peers.set(row.id, { id: row.id, title: row.title, status: row.status });
  // 自己一定在里面：哪怕它已归档（写侧另有冻结门禁），锁也该覆盖到自己身上。
  const self = byId.get(task.id);
  take({ id: task.id, title: self?.title ?? null, status: self?.status ?? null });

  const key = keyOf(rootPath);
  // 空 root 不跟任何人合并：`repoKey` 对空值返回空，拿它当键会把所有解析不出目录的任务
  // 糊成一堆。
  if (!key) return [...peers.values()];

  const projectRepos = new Map((await db.select().from(projects)).map((row) => [row.id, expandHome(row.repoPath)]));
  const sessionDirs = new Map<string, string[]>();
  for (const run of await db.select().from(sessions).orderBy(desc(sessions.startedAt))) {
    const dir = expandHome(run.cwd ?? run.worktreePath);
    if (!dir) continue;
    const list = sessionDirs.get(run.taskId);
    if (list) list.push(dir); else sessionDirs.set(run.taskId, [dir]);
  }
  const repoOf = (projectId: string) => projectRepos.get(projectId) ?? "";

  for (const row of rows) {
    if (row.archived || peers.has(row.id)) continue;
    const dir = nextRunDirOf(row, await isolatedWorkspaceOwner(row, lookup), repoOf, sessionDirs, dirExists);
    if (dir && keyOf(dir) === key) take(row);
  }
  return [...peers.values()];
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
