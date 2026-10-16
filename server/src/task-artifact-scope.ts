import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
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

/**
 * 一段「它在写这个目录」的时间（毫秒时间戳，闭区间；end 可以是 Infinity = 还在写）。
 *
 * `approx` 是**这一段的来路**：落账过的回合是精确的（false），从会话行推断出来的是宽的
 * （true）。推断出来的区间里可能横着别人的产出，所以每一段 approx 都要在面板上说出来——
 * 「记录缺了」既不能当成「这段时间它一直在跑」（串台），也不能当成「它没跑过」（漏报），
 * 只能当成「这段算不准」（第 2 轮审查 F1）。
 */
export interface RunWindow {
  start: number;
  end: number;
  approx?: boolean;
}

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
/**
 * 比对两个时刻时允许的抖动。回合起点和会话行上的 `turn_started_at` 来自两次不同的写，差
 * 几百毫秒是正常的；超过这个数才算「是另一个回合」。
 */
const TURN_SKEW_MS = 1000;

/**
 * 路径归一：`resolve` 之外还要过一遍 `realpath`。
 *
 * macOS 上 `/var`、`/tmp` 都是软链（`/private/var`、`/private/tmp`），会话记下来的 cwd 和
 * git 报出来的仓库根很容易一个带 `/private` 一个不带——纯 `resolve` 比较会把**同一个目录**
 * 判成两个，于是独占目录被降级成共享、重新吃上时间上限，第 1 轮 F3 修好的延迟产物又漏回去
 * （第 2 轮审查 F2）。
 *
 * **目录已经不在了也要能归一**：worktree 删掉之后，它的路径仍然要跟仓库根比得上。所以问不到
 * 真身就沿祖先往上找最近那个还在的，把余下那几段接回去（`realpath -m` 的语义）——否则一个
 * 带 `/private` 一个不带，父子关系直接判没。
 */
const canonicalCache = new Map<string, Promise<string>>();
const canonical = (input: string): Promise<string> => {
  const key = resolve(expandHome(input));
  let hit = canonicalCache.get(key);
  if (!hit) {
    hit = realpath(key).catch(async () => {
      const parent = dirname(key);
      return parent === key ? key : join(await canonical(parent), basename(key));
    });
    canonicalCache.set(key, hit);
  }
  return hit;
};

const sameDir = async (a: string | null | undefined, b: string) => {
  const left = (a ?? "").trim();
  if (!left) return false;
  const [one, two] = await Promise.all([canonical(left), canonical(b)]);
  return one === two;
};

/** `child` 是不是 `parent` 自己或它底下的某一层（两边都先归一）。 */
const underDir = async (child: string, parent: string) => {
  const [c, p] = await Promise.all([canonical(child), canonical(parent)]);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
};

/**
 * 这个目录现在还在不在。记录下来的工作目录已经没了，是「无从查证」而不是「不是它」。
 *
 * 缓存**只在一次查询内**（调用方传进来）：这个答案直接决定归属判据，而 worktree 随时会被
 * 验收清理掉。跨刷新缓存它，面板会拿着一个几小时前的「还在」一直判下去。`canonical` 那个
 * 可以是模块级的——路径到真身的映射删不删都是同一个值（问不到真身就按祖先归一，结果一样）。
 */
const dirExists = (input: string, cache: Map<string, Promise<boolean>>): Promise<boolean> => {
  const key = resolve(expandHome(input));
  let hit = cache.get(key);
  if (!hit) {
    hit = stat(key).then((info) => info.isDirectory()).catch(() => false);
    cache.set(key, hit);
  }
  return hit;
};

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
async function isExclusiveRoot(task: ArtifactTask, root: WorkspaceRoot): Promise<boolean> {
  const owner = await isolatedWorkspaceOwner(task);
  if (!owner || !root.repo) return false;
  if (!(await sameDir(worktreePathFor(root.repo, owner), root.path))) return false;
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
async function runWindows(
  owners: readonly ArtifactTask[],
  root: WorkspaceRoot,
): Promise<{ windows: RunWindow[]; gaps: string[] }> {
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
   * 这条记录说的目录，跟我们正在看的这个**算不算同一摊活**。三档，别只留两档：
   *
   *   `exact`     —— 就是这个目录。
   *   `stale`     —— 记录下来的目录**已经不在了**（worktree 被删，面板因此降级到主仓展示），
   *                  或者那条老行压根没记目录。谁也无从查证它当时往哪儿写，而这个降级后的
   *                  目录是唯一还能展示的地方：接受，但算**宽的**（approx）。
   *   `elsewhere` —— 目录还在，只是不是这个。那它当时在那儿干活，产物就该在那儿看：排除。
   *                  跨仓的一律落这一档。
   *
   * 为什么不是「同仓就算」（第 1 轮 N4 之后我一度放宽到这一步）：那等于认了「它可能往主仓
   * 写过」就把那段时间主仓里所有东西都判给它，同组里各开 worktree 的执行者、主仓上并行的
   * 别的任务会互相串（第 2 轮审查 F2）。也不能收紧回「同目录才算」：写死绝对路径的流水线
   * cwd 在 worktree、产物落主仓，worktree 事后被删时更是必然对不上——那才有 `stale` 这一档。
   */
  const liveDirs = new Map<string, Promise<boolean>>();
  const dirVerdict = async (
    cwd: string | null | undefined,
    fallback?: string | null,
  ): Promise<"exact" | "stale" | "elsewhere"> => {
    const recorded = (cwd ?? fallback ?? "").trim();
    if (!recorded) return "stale";
    if (await sameDir(recorded, root.path)) return "exact";
    if (!root.repo || !(await underDir(recorded, root.repo))) return "elsewhere";
    return (await dirExists(recorded, liveDirs)) ? "elsewhere" : "stale";
  };

  const spans: RunWindow[] = [];
  /** 各类缺口各记一次数：面板上要说清楚「哪一段算不准」，但不能一条会话刷一行。 */
  const counts = { stale: 0, legacy: 0, early: 0, lastTurn: 0 };

  const turnsBySession = new Map<string, typeof turnRows>();
  for (const turn of turnRows) {
    const verdict = await dirVerdict(turn.cwd);
    if (verdict === "elsewhere") continue;
    const list = turnsBySession.get(turn.sessionId);
    if (list) list.push(turn);
    else turnsBySession.set(turn.sessionId, [turn]);
    const start = Date.parse(turn.startedAt);
    const end = Date.parse(turn.endedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (verdict === "stale") counts.stale += 1;
    spans.push({ start, end: Math.max(end + TURN_GRACE_MS, start), approx: verdict === "stale" });
  }

  for (const row of sessionRows) {
    const verdict = await dirVerdict(row.cwd, row.worktreePath);
    if (verdict === "elsewhere") continue;
    const start = Date.parse(row.startedAt ?? "");
    if (!Number.isFinite(start)) continue;
    const recorded = turnsBySession.get(row.id) ?? [];
    const live = !row.endedAt && inFlight.has(row.taskId);
    const ended = Date.parse(row.endedAt ?? "");
    const turnStart = Date.parse(row.turnStartedAt ?? "");
    if (verdict === "stale") counts.stale += 1;

    if (live) {
      // 还在飞：从这一回合的起点开到无穷。它正在写，之后出现的东西只会是它写的。
      spans.push({ start: Number.isFinite(turnStart) ? turnStart : start, end: Number.POSITIVE_INFINITY });
      if (recorded.length) continue; // 开区间盖住了往后，前面的缺口下面照常补
    }
    if (!recorded.length) {
      // 一条回合记录都没有。**不能**把这解释成「它一直在跑」（中间歇的几个钟头里别人做的
      // 东西会全算进来），也不能解释成「它没跑过」（那就整页都看不见）——只能认成一整段
      // 宽的区间并明说算不准（第 2 轮审查 F1）。
      if (!live) {
        if (Number.isFinite(ended)) {
          spans.push({ start, end: Math.max(ended + TURN_GRACE_MS, start), approx: true });
        } else {
          const from = Number.isFinite(turnStart) ? Math.max(start, turnStart) : start;
          spans.push({ start, end: from + Math.max(row.activeMs ?? 0, UNSETTLED_RUN_MS) + TURN_GRACE_MS, approx: true });
        }
      }
      counts.legacy += 1;
      continue;
    }

    const starts = recorded.map((turn) => Date.parse(turn.startedAt)).filter((ms) => Number.isFinite(ms));
    // 有记录，但最早那条明显晚于会话起点：中间这一段是本表建立之前跑的回合，补上——同样是宽的。
    const earliest = Math.min(...starts);
    if (Number.isFinite(earliest) && earliest - start > TURN_SKEW_MS) {
      spans.push({ start, end: earliest, approx: true });
      counts.early += 1;
    }
    // **末回合没落账**：会话行自己是覆盖状态的权威——`turn_started_at` 是最新那个回合的起点，
    // 它比所有落账记录都晚，就说明最后一个回合没留下行（异常收尾、停止、写库失败都会这样）。
    // 「没有行」在这里绝不能读成「没跑过」：那一回合真做出来的东西会被静默滤掉，面板空着却
    // 什么也不说（第 2 轮审查 F1）。读端这样核对的另一个好处是**不依赖写端可靠**。
    const lastRecorded = Math.max(...starts);
    if (!live && Number.isFinite(turnStart) && turnStart - lastRecorded > TURN_SKEW_MS) {
      const end = Number.isFinite(ended)
        ? Math.max(ended + TURN_GRACE_MS, turnStart)
        : turnStart + UNSETTLED_RUN_MS + TURN_GRACE_MS;
      spans.push({ start: turnStart, end, approx: true });
      counts.lastTurn += 1;
    }
  }

  const now = Date.now();
  for (const row of monitorRows) {
    const verdict = await dirVerdict(row.cwd);
    if (verdict === "elsewhere") continue;
    const start = Date.parse(row.startedAt ?? "");
    if (!Number.isFinite(start)) continue;
    if (verdict === "stale") counts.stale += 1;
    // 还在盯着的哨兵开到无穷；停了的按它自己的收尾时刻，取不到就按到期时刻。
    const ended = Date.parse(row.endedAt ?? "");
    const expires = Date.parse(row.expiresAt ?? "");
    const end = row.status === "running" && !row.endedAt
      ? Number.POSITIVE_INFINITY
      : (Number.isFinite(ended) ? ended : (Number.isFinite(expires) ? expires : now)) + TURN_GRACE_MS;
    spans.push({ start, end: Math.max(end, start), approx: verdict === "stale" });
  }

  const gaps: string[] = [];
  if (counts.legacy) {
    gaps.push(`有 ${counts.legacy} 段运行只记下了会话的起止、没有逐回合记录，那几段里别人做的东西可能混进来`);
  }
  if (counts.early) {
    gaps.push(`有 ${counts.early} 段早期运行在逐回合记录之前，只能按整段会话算`);
  }
  if (counts.lastTurn) {
    gaps.push(`有 ${counts.lastTurn} 次运行的最后一个回合没留下记录（异常收尾），那一段只能按会话收尾时刻估`);
  }
  if (counts.stale) {
    // 量词刻意跟上面几条不一样：这一条数的是**记录条数**（会话、回合、哨兵各算一条），跟
    // 「几段运行」不是一个维度，同一批会话会同时出现在两条提示里。
    gaps.push(`有 ${counts.stale} 处运行记录指向的工作目录已经不在了（独立工作区被删），只能按这个目录算`);
  }

  return { windows: mergeWindows(spans), gaps };
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
  const [exclusive, runs, first] = await Promise.all([
    isExclusiveRoot(task, root),
    runWindows(owners, root),
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

export async function committedInWindows(
  root: string,
  windows: readonly RunWindow[],
): Promise<{ paths: string[]; truncated: boolean; skippedWindows: number; dateWalk: boolean }> {
  if (!windows.length) return { paths: [], truncated: false, skippedWindows: 0, dateWalk: false };
  const asFilter = await supportsSinceAsFilter(root);
  // 区间太多时保最近的几段：旧的那些对「它刚做出了什么」贡献最小。
  const ordered = [...windows].sort((a, b) => b.start - a.start);
  const picked = ordered.slice(0, MAX_WINDOW_QUERIES);
  const paths = new Set<string>();
  let truncated = false;

  for (const window of picked) {
    const args = [
      "--no-optional-locks", "-c", "core.quotePath=false", "-C", root, "log",
      `${asFilter ? "--since-as-filter" : "--since"}=${new Date(window.start).toISOString()}`,
      // 开着的那一段（还在写）不设上界：Infinity 塞进 Date 只会抛。
      ...(Number.isFinite(window.end) ? [`--until=${new Date(window.end).toISOString()}`] : []),
      `--max-count=${MAX_WINDOW_COMMITS}`, "--name-only", "-z", "--format=%x00%H",
    ];
    const { stdout } = await exec("git", args, { maxBuffer: 16 * 1024 * 1024 });
    // `-z` 下提交头和路径一律以 NUL 分隔；`%x00%H` 让提交头自己也以 NUL 开场，于是
    // 「40 位十六进制」这一个 token 就是提交号，其余 token 都是路径。
    let commits = 0;
    // `-z` 只管用 NUL 分隔，**不管 git 在提交头和它的路径列表之间插的那个换行**——实测格式
    // 是 `\0<hash>\0\n<path>\0<path>\0`。那个换行只在**紧跟提交头的第一条路径**前面出现一
    // 次，所以只在那个位置剥、而且只剥一个：无条件剥掉每个 token 的全部前导 CR/LF，会把
    // 「文件名真的以换行开头」的路径改写掉，`stat` 跟着查错地方（第 2 轮审查 N1）。
    let afterHeader = false;
    for (const raw of stdout.split("\0")) {
      if (/^[\r\n]*[0-9a-f]{40}$/.test(raw)) {
        commits += 1;
        afterHeader = true;
        continue;
      }
      const token = afterHeader ? raw.replace(/^\r?\n/, "") : raw;
      afterHeader = false;
      if (!token) continue;
      paths.add(token);
    }
    if (commits >= MAX_WINDOW_COMMITS) truncated = true;
  }
  return {
    paths: [...paths],
    truncated,
    skippedWindows: ordered.length - picked.length,
    dateWalk: !asFilter,
  };
}
