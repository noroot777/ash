import { resolve, sep } from "node:path";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "./db/index.js";
import { monitors } from "./db/schema-monitors.js";
import { sessionTurns, sessions, tasks } from "./db/schema.js";
import { execFileText as exec } from "./exec.js";
import type { WorkspaceRoot } from "./file-browser.js";
import { worktreePathFor } from "./git.js";
import { expandHome } from "./platform.js";
import { isolatedWorkspaceOwner } from "./task-workspace.js";

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
// 区间从哪来，三处，一处都不能少：
//   • `session_turns` —— 每个回合一行，精确。**首选**。
//   • 没有回合记录的会话（这张表之前的老行）—— 只能退回整条会话寿命。这是本表出现前
//     的老行为：宽，但不漏。
//   • `monitors` —— 哨兵的生命周期。回合结束不等于它所属的后台工作结束。
//
// 为什么不能拿 `sessions` 那一行当区间：它跨回合复用（续聊只刷新 `turn_started_at`、清
// `ended_at`），所以「第一次建立」到「最后一次收尾」之间可能空了四个钟头——那期间别的
// 任务在同一个目录里做出来的东西会全被收进它名下（第 1 轮审查 F1）。`active_ms` 也救不
// 了：它给得出各回合的总时长，给不出位置。

/** 一段「它在写这个目录」的时间（毫秒时间戳，闭区间；end 可以是 Infinity = 还在写）。 */
export interface RunWindow {
  start: number;
  end: number;
}

export type ArtifactTask = typeof tasks.$inferSelect;

export interface ArtifactScope {
  /** 目录独占：归属靠目录本身证明，不吃时间判据。 */
  exclusive: boolean;
  /** 共享目录下的时间判据。exclusive 时仍然算出来（UI 要知道它跑过没），但不用于筛选。 */
  windows: RunWindow[];
  /** 任务第一次开跑的时刻；null = 没跑过。 */
  firstRunAt: string | null;
  /** 归属链上的任务（自己 + 共用同一个目录的上游）。 */
  owners: ArtifactTask[];
  problems: string[];
}

/**
 * 回合收尾之后还可能继续落盘的一点宽限。**只用在没有回合记录的老会话上**：有记录的回合
 * 用自己的区间，独占目录根本不设上限。给宽限是为了不漏，给得短是为了不串——共享目录上，
 * 窗口每放宽一分钟就多吃一分钟别人的产出。
 */
const TURN_GRACE_MS = 10 * 60 * 1000;
/**
 * `ended_at` 是空的、任务却早已不在飞：那是**结算没留下收尾时刻**的老会话行（库里集中在
 * 2026-06，81/2355 条）。这种行按「从最后一个回合起算这么长」兜底。宁可宽一点多认几个，
 * 也不能当成「开放到现在」——那等于把这一档打回原形。
 */
const UNSETTLED_RUN_MS = 6 * 60 * 60 * 1000;

const sameDir = (a: string | null | undefined, b: string) => {
  const left = expandHome(a ?? "");
  return !!left && resolve(left) === resolve(b);
};

/** `child` 是不是 `parent` 自己或它底下的某一层。纯路径比较，不碰文件系统（目录可能已删）。 */
const underDir = (child: string, parent: string) => {
  const c = resolve(expandHome(child));
  const p = resolve(expandHome(parent));
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
};

/**
 * 这个工作区是不是这个任务独占的。
 *
 * 判据是**路径核对**，不是 `root.source`：共享主仓任务的会话 cwd 就是主仓，`source` 照样
 * 是 `session`；反过来，一个该有 worktree 的任务在目录还没建出来时会回退到主仓。只有
 * 「root 正好是归属任务那个约定的 worktree 目录」才算独占。
 */
async function isExclusiveRoot(task: ArtifactTask, root: WorkspaceRoot): Promise<boolean> {
  const owner = await isolatedWorkspaceOwner(task);
  if (!owner || !root.repo) return false;
  return sameDir(worktreePathFor(root.repo, owner), root.path);
}

/**
 * 运行时间算在这个工作区头上的那些任务：自己，加上**跟它共用同一个目录的上游**。
 *
 * 为什么不直接用 `isolatedWorkspaceOwner`：那一个答的是「该落进哪个 worktree」，共享主仓
 * 时它返回 null，于是审查任务拿不到被审任务的 id——而审查任务工作区里值得看的东西，恰恰
 * 全是被审任务做出来的，只按审查自己那几分钟去卡，面板会一个不剩。这里答的是另一个问题：
 * 「这个目录里的东西，哪些任务的运行时间解释得通」，所以沿 `reviewOf`（审查跟到被审）和
 * **团队**父任务（执行者跟到调度台）两条边往上收，但不要求目录隔离。
 *
 * 普通派生任务的 `parentId` 不算：那是「从父分支起步」的依赖关系，它有自己的工作目录。
 * 继承来的区间最终还要过一遍 cwd 核对（见 `runWindows`），所以上游在别的目录里跑的那些
 * 回合不会算进来（第 1 轮审查 N4）。
 */
async function workspaceRunOwners(task: ArtifactTask): Promise<ArtifactTask[]> {
  const owners = [task];
  const seen = new Set([task.id]);
  for (let cursor = 0; cursor < owners.length; cursor += 1) {
    const current = owners[cursor]!;
    const upstream: { id: string; teamOnly: boolean }[] = [];
    if (current.reviewOf) upstream.push({ id: current.reviewOf, teamOnly: false });
    if (current.parentId) upstream.push({ id: current.parentId, teamOnly: true });
    for (const { id, teamOnly } of upstream) {
      if (seen.has(id)) continue;
      seen.add(id);
      const row = (await db.select().from(tasks).where(eq(tasks.id, id))).at(0);
      if (!row || row.projectId !== task.projectId) continue;
      if (teamOnly && row.mode !== "team") continue;
      owners.push(row);
    }
  }
  return owners;
}

/** 合并重叠的区间（升序、互不相交）。 */
function mergeWindows(spans: RunWindow[]): RunWindow[] {
  spans.sort((a, b) => a.start - b.start);
  const merged: RunWindow[] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

/**
 * 「它在写这个目录」的那几段。
 *
 * 每条会话按三种精度取值，顺序是**先精确后兜底**：
 *   1. 这条会话落账过的回合 → 各自的区间（+宽限）；
 *   2. 回合记录没覆盖到的早期（这张表建立之前就已经跑过的回合）→ 补 `[会话起点, 最早
 *      那条回合记录的起点]`。宽，但那段里真有它的产出，不能漏；
 *   3. 一条记录都没有 → 整条会话寿命（本表出现前的老行为）。
 * 还在飞的回合（`ended_at` 为空且任务在 running/queued）一律**开到无穷**：它正在写，之后
 * 出现的东西只会是它写的；拿 `Date.now()` 当硬上限反而会漏掉刚落盘的文件（mtime 是亚毫秒
 * 浮点、`Date.now()` 是整毫秒，同一毫秒内读就判在窗口外）。
 *
 * **每条区间都要过 cwd 核对**：记下来的目录跟现在看的这个目录对不上，那段时间它在别处
 * 干活，跟这个目录里的东西无关。cwd 为空的（极老的行）只能接受。
 */
async function runWindows(owners: readonly ArtifactTask[], root: WorkspaceRoot): Promise<RunWindow[]> {
  const ids = owners.map((row) => row.id);
  const inFlight = new Set(owners
    .filter((row) => row.status === "running" || row.status === "queued")
    .map((row) => row.id));

  const [sessionRows, turnRows, monitorRows] = await Promise.all([
    db.select({
      id: sessions.id,
      taskId: sessions.taskId,
      cwd: sessions.cwd,
      worktreePath: sessions.worktreePath,
      startedAt: sessions.startedAt,
      endedAt: sessions.endedAt,
      turnStartedAt: sessions.turnStartedAt,
      activeMs: sessions.activeMs,
    }).from(sessions).where(inArray(sessions.taskId, ids)),
    db.select().from(sessionTurns).where(inArray(sessionTurns.taskId, ids)).orderBy(asc(sessionTurns.startedAt)),
    // 哨兵：回合结束不等于它所属的后台工作结束（第 1 轮审查 F3）。
    db.select({
      taskId: monitors.taskId,
      cwd: monitors.cwd,
      startedAt: monitors.startedAt,
      endedAt: monitors.endedAt,
      expiresAt: monitors.expiresAt,
      status: monitors.status,
    }).from(monitors).where(inArray(monitors.taskId, ids)),
  ]);

  /**
   * 这条记录说的目录，跟我们正在看的这个**算不算同一摊活**。
   *
   * 判据是「同一个仓库」而不是「同一个目录」：进程的 cwd 只证明它在哪儿启动，不证明它只
   * 往那儿写。daily-report 那条流水线写死了绝对路径，cwd 在 worktree、产物落主仓；worktree
   * 事后被删掉、面板降级到主仓展示时更是必然对不上——库里几个真实任务全是这样，按目录硬卡
   * 会把它们的会话整段丢掉，三档一起空（这是我第 2 轮改完的实测回归）。N4 真正要拦的是
   * **跨仓串台**（上游在另一个项目里跑的那些回合），那种路径不在本仓之下，照样拦得住。
   * 记不下目录的（极老的行）只能接受。
   */
  const dirMatches = (cwd: string | null | undefined, fallback?: string | null) => {
    const recorded = cwd ?? fallback;
    if (!recorded) return true;
    if (sameDir(recorded, root.path)) return true;
    // worktree 一律是 `<repo>/.worktrees/<id>`（`worktreePathFor`），所以同仓的 cwd 要么
    // 就是仓库根，要么在它底下；反过来看 worktree 视图时，上游在主仓跑的区间也算同仓。
    return !!root.repo && underDir(recorded, root.repo);
  };

  const spans: RunWindow[] = [];
  const turnsBySession = new Map<string, typeof turnRows>();
  for (const turn of turnRows) {
    if (!dirMatches(turn.cwd)) continue;
    const list = turnsBySession.get(turn.sessionId);
    if (list) list.push(turn);
    else turnsBySession.set(turn.sessionId, [turn]);
    const start = Date.parse(turn.startedAt);
    const end = Date.parse(turn.endedAt);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      spans.push({ start, end: Math.max(end + TURN_GRACE_MS, start) });
    }
  }

  for (const row of sessionRows) {
    if (!dirMatches(row.cwd, row.worktreePath)) continue;
    const start = Date.parse(row.startedAt ?? "");
    if (!Number.isFinite(start)) continue;
    const recorded = turnsBySession.get(row.id) ?? [];
    const live = !row.endedAt && inFlight.has(row.taskId);

    if (live) {
      // 还在飞：从这一回合的起点开到无穷。
      const turnStart = Date.parse(row.turnStartedAt ?? "");
      spans.push({ start: Number.isFinite(turnStart) ? turnStart : start, end: Number.POSITIVE_INFINITY });
    }
    if (!recorded.length) {
      // 一条回合记录都没有：退回整条会话寿命（这张表出现之前的老行为）。
      if (live) continue; // 开区间已经覆盖
      const ended = Date.parse(row.endedAt ?? "");
      if (Number.isFinite(ended)) {
        spans.push({ start, end: Math.max(ended + TURN_GRACE_MS, start) });
      } else {
        const lastTurn = Date.parse(row.turnStartedAt ?? "");
        const from = Number.isFinite(lastTurn) ? Math.max(start, lastTurn) : start;
        spans.push({ start, end: from + Math.max(row.activeMs ?? 0, UNSETTLED_RUN_MS) + TURN_GRACE_MS });
      }
      continue;
    }
    // 有记录，但最早那条明显晚于会话起点：中间这一段是本表建立之前跑的回合，补上。
    const earliest = Math.min(...recorded.map((turn) => Date.parse(turn.startedAt)).filter(Number.isFinite));
    if (Number.isFinite(earliest) && earliest - start > 1000) spans.push({ start, end: earliest });
  }

  const now = Date.now();
  for (const row of monitorRows) {
    if (!dirMatches(row.cwd)) continue;
    const start = Date.parse(row.startedAt ?? "");
    if (!Number.isFinite(start)) continue;
    // 还在盯着的哨兵开到无穷；停了的按它自己的收尾时刻，取不到就按到期时刻。
    const ended = Date.parse(row.endedAt ?? "");
    const expires = Date.parse(row.expiresAt ?? "");
    const end = row.status === "running" && !row.endedAt
      ? Number.POSITIVE_INFINITY
      : (Number.isFinite(ended) ? ended : (Number.isFinite(expires) ? expires : now)) + TURN_GRACE_MS;
    spans.push({ start, end: Math.max(end, start) });
  }

  return mergeWindows(spans);
}

/** 任务第一次开跑的时刻。没有会话（还没跑过）时返回 null。 */
async function firstRunAt(taskId: string): Promise<string | null> {
  const first = (await db.select({ startedAt: sessions.startedAt })
    .from(sessions)
    .where(eq(sessions.taskId, taskId))
    .orderBy(asc(sessions.startedAt))
    .limit(1)).at(0);
  return first?.startedAt ?? null;
}

export const withinWindows = (ms: number | null, windows: readonly RunWindow[]) =>
  ms !== null && Number.isFinite(ms) && windows.some((window) => ms >= window.start && ms <= window.end);

export async function resolveArtifactScope(task: ArtifactTask, root: WorkspaceRoot): Promise<ArtifactScope> {
  const owners = await workspaceRunOwners(task);
  const [exclusive, windows, first] = await Promise.all([
    isExclusiveRoot(task, root),
    runWindows(owners, root),
    firstRunAt(task.id),
  ]);
  return { exclusive, windows, firstRunAt: first, owners, problems: [] };
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
export async function committedInWindows(
  root: string,
  windows: readonly RunWindow[],
): Promise<{ paths: string[]; truncated: boolean; skippedWindows: number }> {
  if (!windows.length) return { paths: [], truncated: false, skippedWindows: 0 };
  // 区间太多时保最近的几段：旧的那些对「它刚做出了什么」贡献最小。
  const ordered = [...windows].sort((a, b) => b.start - a.start);
  const picked = ordered.slice(0, MAX_WINDOW_QUERIES);
  const paths = new Set<string>();
  let truncated = false;

  for (const window of picked) {
    const args = [
      "--no-optional-locks", "-c", "core.quotePath=false", "-C", root, "log",
      `--since=${new Date(window.start).toISOString()}`,
      // 开着的那一段（还在写）不设上界：Infinity 塞进 Date 只会抛。
      ...(Number.isFinite(window.end) ? [`--until=${new Date(window.end).toISOString()}`] : []),
      `--max-count=${MAX_WINDOW_COMMITS}`, "--name-only", "-z", "--format=%x00%H",
    ];
    const { stdout } = await exec("git", args, { maxBuffer: 16 * 1024 * 1024 });
    // `-z` 下提交头和路径一律以 NUL 分隔；`%x00%H` 让提交头自己也以 NUL 开场，于是
    // 「40 位十六进制」这一个 token 就是提交号，其余 token 都是路径。
    let commits = 0;
    for (const raw of stdout.split("\0")) {
      if (!raw) continue;
      // `-z` 只管用 NUL 分隔，**不管 git 在每个提交的 format 之后插的那个换行**——实测
      // 它落在紧跟其后那个路径 token 的开头（`\0<hash>\0\n<path>\0`）。不剥掉，`stat`
      // 就会拿着一条带前导换行的路径去找文件，然后一个都找不到。
      // 代价是「文件名本身以换行开头」会被改写，那种名字在任何界面里都显示不出来。
      const token = raw.replace(/^[\r\n]+/, "");
      if (!token) continue;
      if (/^[0-9a-f]{40}$/.test(token)) {
        commits += 1;
        continue;
      }
      paths.add(token);
    }
    if (commits >= MAX_WINDOW_COMMITS) truncated = true;
  }
  return { paths: [...paths], truncated, skippedWindows: ordered.length - picked.length };
}
