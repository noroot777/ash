import { asc, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { sessions, tasks } from "./db/schema.js";
import { execFileText as exec } from "./exec.js";
import type { WorkspaceRoot } from "./file-browser.js";
import { worktreePathFor } from "./git.js";
import { pathLens, type PathLens } from "./task-artifact-paths.js";
import { runWindows, type RunWindow } from "./task-artifact-windows.js";
import { isolatedWorkspaceOwner } from "./task-workspace.js";
import { isDiagnosticSession } from "./turn-failure.js";

// 「这个文件是这个任务弄出来的」凭什么成立——产物面板的**归属证据**都在这里。
// 扫描在 `task-artifact-scan.ts`，三档合成在 `task-artifacts.ts`。
//
// 证据分两种，强弱差一个数量级，别混着用：
//
//   ① **目录独占**（exclusive）：工作区就是这个任务（或它跟随的那个任务）专属的 worktree。
//      那个目录是这一趟检出出来的，除了它没人往里写——于是「在这个目录里」本身就是归属
//      证据，不需要时间。这一档必须**不设时间上限**：哨兵起的后台渲染可以在回合收尾二十
//      分钟后才落盘（`start_monitor` 的进程由 ash 拉起，活得过回合），拿「回合结束 + 宽限」
//      去卡它，真做出来的东西反而消失（第 1 轮审查 F3）。
//
//   ② **时间区间**（shared）：共享工作区（`useWorktree=false`，直接在项目主仓干活）上，
//      同一个目录先后乃至同时跑过很多任务，唯一能把它们分开的线索只有时间。这一档是
//      **候选归属**，不是确认：同时在跑的两个任务，谁写的那个文件，物理上问不出来。
//
// 时间区间那一档自己占一个文件：`task-artifact-windows.ts`（区间从哪来、为什么不能拿
// `sessions` 那一行当区间，都写在那儿）。路径怎么算「同一个目录」在
// `task-artifact-paths.ts`。

export type ArtifactTask = typeof tasks.$inferSelect;

export interface ArtifactScope {
  /** 目录独占：归属靠目录本身证明，不吃时间判据。 */
  exclusive: boolean;
  /** 共享目录下的时间判据。exclusive 时仍然算出来（UI 要知道它跑过没），但不用于筛选。 */
  windows: RunWindow[];
  /** 任务第一次开跑的时刻；null = 没跑过。 */
  firstRunAt: string | null;
  /** 归属链上的任务（自己 + 共用同一个目录、算得上同一摊活的那些）。 */
  owners: ArtifactTask[];
  /** 回合记录缺了哪些段——人话，面板直接显示。 */
  gaps: string[];
  problems: string[];
}

/**
 * 这个工作区是不是这个任务独占的。
 *
 * 判据是**路径核对**，不是 `root.source`：共享主仓任务的会话 cwd 就是主仓，`source` 照样
 * 是 `session`；反过来，一个该有 worktree 的任务在目录还没建出来时会回退到主仓。只有
 * 「root 正好是归属任务那个约定的 worktree 目录」才算独占。
 *
 * 光是路径对上还不够：`isolatedWorkspaceOwner` 答的是「该用哪份 worktree」，**团队执行者
 * 默认拿到的是领队的 id**——那只证明它隔离于项目主仓，不证明它隔离于**同组的兄弟执行者**。
 * 一个领队底下三个执行者在同一个目录里各画一张图，三页都报独占、三页都取消时间筛选，于是
 * 三页显示同样的三张图，「按任务区分」在团队上整个失效（第 2 轮审查 F2）。所以跟随**团队
 * 领队**目录的执行者一律算共享，由时间去分；领队自己那一页仍然独占——那一页的语义本来就是
 * 整组汇总。审查任务跟到被审任务（单飞）不受影响：那个目录里值得看的东西本来就全是被审
 * 任务做的，1 对 1，没有兄弟。
 */
export async function isExclusiveRoot(task: ArtifactTask, root: WorkspaceRoot, lens: PathLens = pathLens()): Promise<boolean> {
  const owner = await isolatedWorkspaceOwner(task);
  if (!owner || !root.repo) return false;
  if (!(await lens.sameDir(worktreePathFor(root.repo, owner), root.path))) return false;
  if (owner === task.id) return true;
  const ownerRow = (await db.select({ mode: tasks.mode }).from(tasks).where(eq(tasks.id, owner))).at(0);
  return ownerRow?.mode !== "team";
}

/**
 * 运行时间算在这个工作区头上的那些任务：自己，加上**跟它共用同一个目录的上游**。
 *
 * 为什么不直接用 `isolatedWorkspaceOwner`：那一个答的是「该落进哪个 worktree」，共享主仓
 * 时它返回 null，于是审查任务拿不到被审任务的 id——而审查任务工作区里值得看的东西，恰恰
 * 全是被审任务做出来的，只按审查自己那几分钟去卡，面板会一个不剩。这里答的是另一个问题：
 * 「这个目录里的东西，哪些任务的运行时间解释得通」，所以沿 `reviewOf`（审查跟到被审）
 * 往上收，但不要求目录隔离。
 *
 * **团队这条边只往下走，不往上走**：领队那一页汇总整组（owners = 自己 + 全部执行者），而
 * 执行者只认自己的区间。反过来把领队的区间下发给每个执行者是错的——领队是常驻调度台，它的
 * 回合横跨整组执行者的工作时间，每个执行者都继承一遍，等于把兄弟做的东西全认进来，两个
 * 时间上毫不重叠的执行者照样各看到对方的图（第 2 轮审查 F2）。
 *
 * 普通派生任务的 `parentId` 不算：那是「从父分支起步」的依赖关系，它有自己的工作目录。
 * 收来的区间最终还要过一遍工作目录核对（见 `runWindows`）。
 */
async function workspaceRunOwners(task: ArtifactTask): Promise<ArtifactTask[]> {
  const owners = [task];
  const seen = new Set([task.id]);
  for (let cursor = 0; cursor < owners.length; cursor += 1) {
    const current = owners[cursor]!;
    if (current.reviewOf && !seen.has(current.reviewOf)) {
      seen.add(current.reviewOf);
      const row = (await db.select().from(tasks).where(eq(tasks.id, current.reviewOf))).at(0);
      if (row && row.projectId === task.projectId) owners.push(row);
    }
    // 领队页面向下汇总它派出去的执行者（反过来不成立，见上面的注释）。
    if (current.mode === "team") {
      const crew = await db.select().from(tasks).where(eq(tasks.parentId, current.id));
      for (const row of crew) {
        if (seen.has(row.id) || row.projectId !== task.projectId) continue;
        seen.add(row.id);
        owners.push(row);
      }
    }
  }
  return owners;
}

/**
 * 任务第一次**真的开跑**的时刻。没有会话（还没跑过）时返回 null。
 *
 * **诊断会话不算跑过**：启动前就失败时会建一条只为把错误显示出来的会话行（`turn-failure.ts`
 * 的 `freshRunFailureTarget`）。拿它当「第一次开跑」,面板上一个压根没跑起来的任务就有了开跑
 * 时刻,跟区间那一档的判据还彼此矛盾。判据和 `runWindows` 用的是同一个,不另写一份
 * （第 1 轮审查 F4）。所以这里不能 `limit(1)` —— 第一条可能正是那条诊断行。
 */
async function firstRunAt(taskId: string): Promise<string | null> {
  const rows = await db.select({
    startedAt: sessions.startedAt,
    endedAt: sessions.endedAt,
    turnStartedAt: sessions.turnStartedAt,
    cliSessionId: sessions.cliSessionId,
    commandLine: sessions.commandLine,
    activeMs: sessions.activeMs,
    exitStatus: sessions.exitStatus,
  }).from(sessions)
    .where(eq(sessions.taskId, taskId))
    .orderBy(asc(sessions.startedAt));
  return rows.find((row) => !isDiagnosticSession(row))?.startedAt ?? null;
}

export async function resolveArtifactScope(task: ArtifactTask, root: WorkspaceRoot): Promise<ArtifactScope> {
  const owners = await workspaceRunOwners(task);
  // 路径判据的缓存只活这一次查询（理由见 `pathLens`）。
  const lens = pathLens();
  const [exclusive, runs, first] = await Promise.all([
    isExclusiveRoot(task, root, lens),
    runWindows(owners, root, lens),
    firstRunAt(task.id),
  ]);
  // 独占目录不按时间筛选，所以那些「这一段算不准」的话跟它无关，别白说一句让人紧张。
  return {
    exclusive,
    windows: runs.windows,
    firstRunAt: first,
    owners,
    gaps: exclusive ? [] : runs.gaps,
    problems: [],
  };
}

/** 一次 `git log` 最多回看这么多个提交；每段区间各算一次。 */
const MAX_WINDOW_COMMITS = 500;
/** 区间太多时只查最近这几段（每段一次 git log，不能无上限地 fork 进程）。 */
const MAX_WINDOW_QUERIES = 12;

/**
 * 共享工作区上的「已提交」那一档：**落在运行区间里的提交**动过哪些路径。
 *
 * 有任务分支时 committed 走 `merge-base..分支`，那是精确的；而共享工作区的任务直接在项目
 * 主仓的目标分支上提交，压根没有一条属于它的分支，`taskBranchChangedPaths` 一律报
 * `source_branch_missing`——于是这类任务**提交进仓库的产物一个都列不出来**（而仓库约定是
 * 改完立即提交，等于那一档全瞎）。
 *
 * **每段区间各查一次**，不查它们的外包络：一个任务几个月后再续聊，外包络里可能横着几百
 * 个无关提交，`--max-count` 先被它们吃掉，真正那次的图片提交反而进不了输出，而且结果看
 * 起来跟「本来就没有」一模一样（第 1 轮审查 F4）。额度真的用满了要如实上报。
 *
 * 路径走 `-z`：`--name-only` 的默认输出对带引号、制表符、换行的文件名会加引号转义，按行
 * 切会把它们解析坏（第 1 轮审查 N1）；仓库里其它读 git 的地方用的也都是 NUL 协议。
 * merge 提交默认不出 `--name-only` 内容，所以「事后把别的任务分支合进来」带来的那一大堆
 * 不会算到这里，正合判据。
 */
/**
 * `--since` 支不支持当「纯过滤器」用（`--since-as-filter`，git 2.37+）。只问一次。
 *
 * `--since` 本身是**遍历边界**：git 一碰到比它更早的提交就剪枝。而 committer date 并不保证
 * 沿历史单调（rebase、cherry-pick、改过系统时间都会让它回拨），于是祖先里真正落在运行区间
 * 内的那条提交会被整条剪掉——面板上少一张图，而且不触发任何额度提示，跟「本来就没有」长得
 * 一模一样（第 2 轮审查 N4）。`--since-as-filter` 把日期降级成输出过滤器，遍历照常往下走。
 */
let sinceAsFilter: Promise<boolean> | null = null;
const supportsSinceAsFilter = (root: string): Promise<boolean> => {
  sinceAsFilter ??= exec("git", ["-C", root, "log", "--since-as-filter=1970-01-01", "--max-count=0"])
    .then(() => true)
    .catch(() => false);
  return sinceAsFilter;
};

/**
 * 运行区间里的提交动过哪些路径。
 *
 * **按区间的强弱分两份返回**：精确区间（落账过的回合）里的提交是实打实的证据，估出来的区间
 * （没有逐回合记录的老会话、缺了收尾的那一轮）里的只是候选。原先两者合成一份平面清单,调用
 * 方一律记成「已提交 = 确定」,于是估算档的那几条既不计入「按估出来的时间段认的」计数、也不
 * 在面板上说一句——目录独占、分支差异、精确时间、估算时间这四档强弱在这里一起丢了
 * （第 4 轮审查 N2）。
 */
export async function committedInWindows(
  root: string,
  windows: readonly RunWindow[],
): Promise<{ exact: string[]; approx: string[]; truncated: boolean; skippedWindows: number; dateWalk: boolean }> {
  if (!windows.length) return { exact: [], approx: [], truncated: false, skippedWindows: 0, dateWalk: false };
  const asFilter = await supportsSinceAsFilter(root);
  // 区间太多时保最近的几段：旧的那些对「它刚做出了什么」贡献最小。
  const ordered = [...windows].sort((a, b) => b.start - a.start);
  const picked = ordered.slice(0, MAX_WINDOW_QUERIES);
  const exact = new Set<string>();
  const approx = new Set<string>();
  let truncated = false;

  for (const window of picked) {
    const args = [
      "--no-optional-locks", "-c", "core.quotePath=false", "-C", root, "log",
      `${asFilter ? "--since-as-filter" : "--since"}=${new Date(window.start).toISOString()}`,
      // 开着的那一段（还在写）不设上界：Infinity 塞进 Date 只会抛。
      ...(Number.isFinite(window.end) ? [`--until=${new Date(window.end).toISOString()}`] : []),
      // 提交头前面那个 `%x01` 是**哨兵**:光靠「NUL 开场 + 40 位十六进制」认提交头,一个名字
      // 恰好是 40 位十六进制、又躺在仓库根上的文件就会被认成提交号 —— 它自己从清单里消失,
      // 后面那一串路径还会被当成它的（`afterHeader` 跟着错位剥一个换行）。路径里出现 0x01
      // 这个控制字符在实践中不会发生,于是两类 token 从形状上就分得开（本轮审查不拦项）。
      `--max-count=${MAX_WINDOW_COMMITS}`, "--name-only", "-z", "--format=%x00%x01%H",
    ];
    const { stdout } = await exec("git", args, { maxBuffer: 16 * 1024 * 1024 });
    // `-z` 下提交头和路径一律以 NUL 分隔；`%x00%x01%H` 让提交头自己也以 NUL 开场、并且带上
    // 那个哨兵，于是「0x01 + 40 位十六进制」这一个 token 就是提交号，其余 token 都是路径。
    let commits = 0;
    // `-z` 只管用 NUL 分隔，**不管 git 在提交头和它的路径列表之间插的那个换行**——实测格式
    // 是 `\0<hash>\0\n<path>\0<path>\0`。那个换行只在**紧跟提交头的第一条路径**前面出现一
    // 次，所以只在那个位置剥、而且只剥一个：无条件剥掉每个 token 的全部前导 CR/LF，会把
    // 「文件名真的以换行开头」的路径改写掉，`stat` 跟着查错地方（第 2 轮审查 N1）。
    let afterHeader = false;
    for (const raw of stdout.split("\0")) {
      if (/^[\r\n]*\x01[0-9a-f]{40}$/.test(raw)) {
        commits += 1;
        afterHeader = true;
        continue;
      }
      const token = afterHeader ? raw.replace(/^\r?\n/, "") : raw;
      afterHeader = false;
      if (!token) continue;
      (window.approx ? approx : exact).add(token);
    }
    if (commits >= MAX_WINDOW_COMMITS) truncated = true;
  }
  return {
    exact: [...exact],
    // 同一条路径在两档区间里都出现过,算强的那一档。
    approx: [...approx].filter((path) => !exact.has(path)),
    truncated,
    skippedWindows: ordered.length - picked.length,
    dateWalk: !asFilter,
  };
}
