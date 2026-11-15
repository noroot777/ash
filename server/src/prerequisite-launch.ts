// 有前置的任务怎么起跑：被要求起跑而前置没站齐时记下「等齐就起」，前置全部站稳的那一刻自动起跑，
// 起点按起跑那一刻全部前置的代码定（prerequisite-start-point.ts）。
//
// ## 一道闸，几个入口各调一次
//
// `holdForPrerequisites` 是起跑前那一问：手动运行（/run）、分组运行（runParallel）、队列推进
// （advanceQueueAttempt）各在自己原有的闸上加这一处调用。它回 null 就照原路起跑；回一个原因就不起，
// 而且这一次「被要求起跑」已经持久地记下了（`task_prerequisite_launches.requested_at`）。队列和前置
// 两边都放行才起：队列不放行时根本走不到这里；走到这里而前置没齐，队首就停着等。
//
// 闸只管**第一次开工**：起点一旦按前置定下来（`launched_at`），之后的运行、续聊、重试都不再看前置 ——
// 代码已经在它手里了，前置后来再动也不打断它（页面上会说「开工后又有新提交」）。
//
// ## 「站稳了」的统一出口
//
// `notePrerequisiteProgress(前置 id)` 是唯一的出口：执行结算、审查结算（通过 / 轮数用尽）、用户裁定、
// 验收、删除都调它，事件总线上这条前置的状态 / 审查一变也调它。它做两件事：下游页面上那一格重发；
// 挂着「等齐就起」的下游重判一遍，齐了就起。判定本身幂等，多调几次不会多起一次（真正起跑还要过回合锁
// 与队列占位）。
//
// 重启之后：记账是持久的，开机补办扫一遍全部挂着的请求（重启期间站稳的就在这一趟起跑），之后每分钟
// 再扫一遍兜底 —— 哪个出口漏调了，最多晚一分钟。
//
// ## 起跑这一侧的规矩
//
// 前置失败、取消了：它不站稳，下游一直等，**不跳过**（跟队列透明跳过 failed 相反：下游要的是它的代码）。
// 分组暂停着的不起。一次放开好几条时照分组运行的并发上限。下游自己被移进队列的，交给队列推进。
import { existsSync } from "node:fs";
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "./db/index.js";
import { groups, projects, queueItems, taskPrerequisiteLaunches, taskPrerequisites, tasks } from "./db/schema.js";
import { bus } from "./bus.js";
import { execFileText as exec } from "./exec.js";
import { expandHome, worktreePathFor } from "./git.js";
import { withRepoLock } from "./repo-lock.js";
import { baseRef } from "./task-branch-plan.js";
import { prerequisiteStandings } from "./prerequisite-standing.js";
import { prerequisiteStepText } from "@ash/shared/prerequisites";
import { dependentEdges, launchRecord, prerequisiteEdges } from "./prerequisite-store.js";
import { prerequisiteStart } from "./prerequisite-start-point.js";
import { forgetStanding, isRepublishingView, republishPrerequisiteView } from "./prerequisite-view.js";
import { alertLine, appendTaskTimeline, receiptLine } from "./task-timeline.js";
import { now } from "./util.js";

type TaskRow = typeof tasks.$inferSelect;

/** 谁要求它起跑。`release` = 等齐之后由这里自己起，结果由这里负责到底。 */
export type LaunchSource = "run" | "queue" | "group" | "release";
export type PrerequisiteHold = { reason: string };

/** 同一时刻经由「等齐就起」放出来、还在跑的上限，跟分组运行的并发上限同一个数。 */
const MAX_RELEASED = 4;
const released = new Set<string>();

// 同一条任务的闸串行过：放行与用户点运行同时到时，起点只算一次。
const gateChains = new Map<string, Promise<unknown>>();
function serialized<T>(taskId: string, work: () => Promise<T>): Promise<T> {
  const previous = gateChains.get(taskId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  gateChains.set(taskId, next);
  void next.finally(() => { if (gateChains.get(taskId) === next) gateChains.delete(taskId); }).catch(() => undefined);
  return next;
}

async function recordRequest(taskId: string, request: { source: LaunchSource; actingUserId?: string | null }, blocked: string | null) {
  const existing = await launchRecord(taskId);
  await db.insert(taskPrerequisiteLaunches)
    .values({ taskId, requestedAt: now(), source: request.source, actingUserId: request.actingUserId ?? null, blocked })
    .onConflictDoUpdate({
      target: taskPrerequisiteLaunches.taskId,
      set: {
        requestedAt: existing?.requestedAt ?? now(),
        // 等齐之后由这里替原来那个人起跑：别让放行这一笔把「谁要求的」覆盖掉。
        ...(request.source === "release" ? {} : { source: request.source, actingUserId: request.actingUserId ?? null }),
        blocked,
      },
    });
  const changed = !existing?.requestedAt || existing.blocked !== blocked;
  if (changed && blocked && blocked !== existing?.blocked) {
    await appendTaskTimeline(taskId, alertLine(`前置都站稳了，但没能开工：${blocked}。处理好之后会自动开工。`));
  }
  if (changed) await republishPrerequisiteView([taskId]);
}

/**
 * 起跑前那一问（见文件头）。回 null = 照原路起跑（第一次开工时起点已经按前置定好了）；回原因 = 不起，
 * 这一次「被要求起跑」已经记下，等齐就起。
 */
export function holdForPrerequisites(task: TaskRow, request: { source: LaunchSource; actingUserId?: string | null }): Promise<PrerequisiteHold | null> {
  return serialized(task.id, () => gate(task.id, request));
}

async function gate(taskId: string, request: { source: LaunchSource; actingUserId?: string | null }): Promise<PrerequisiteHold | null> {
  const edges = await prerequisiteEdges(taskId);
  if (!edges.length) return null;
  const launch = await launchRecord(taskId);
  if (launch?.launchedAt) return null;
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return null;
  const standings = await prerequisiteStandings(edges.map((edge) => edge.prerequisiteId));
  const open = edges.flatMap((edge) => {
    const found = standings.get(edge.prerequisiteId);
    return found && found.standing.step !== "settled" ? [found] : [];
  });
  if (open.length) {
    await recordRequest(taskId, request, null);
    return { reason: `在等前置：${open.map(({ task: p, standing }) => `「${p.title || p.id}」${prerequisiteStepText({ ...standing, movedOn: false })}`).join("；")}` };
  }
  const prerequisites = edges.flatMap((edge) => standings.get(edge.prerequisiteId)?.task ?? []);
  const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
  const inherited = new Map<string, string>();
  if (task.useWorktree && project && !existsSync(worktreePathFor(project.repoPath, task.id))) {
    const start = await withRepoLock(project.repoPath, async () => {
      const result = await prerequisiteStart(project.repoPath, task, prerequisites);
      if (result.ok) {
        await exec("git", ["-C", expandHome(project.repoPath), "update-ref", baseRef(task.id), result.commit]);
        await db.update(tasks).set({ worktreeStartCommit: result.commit, worktreeBaseBranch: result.baseBranch, updatedAt: now() })
          .where(eq(tasks.id, taskId));
      }
      return result;
    });
    if (!start.ok) {
      await recordRequest(taskId, request, start.reason);
      return { reason: start.reason };
    }
    for (const [id, commit] of start.inherited) inherited.set(id, commit);
  }
  for (const edge of edges) {
    await db.update(taskPrerequisites).set({ inheritedCommit: inherited.get(edge.prerequisiteId) ?? null })
      .where(and(eq(taskPrerequisites.taskId, taskId), eq(taskPrerequisites.prerequisiteId, edge.prerequisiteId)));
  }
  // 起点定下了。别的入口起跑时，起不起得来由它自己负责（用户看得到结果、队列自己会重试），这一笔请求
  // 就此了结；由这里自己放出来的，要等真起跑了才了结（见 releaseOne）。
  await db.insert(taskPrerequisiteLaunches)
    .values({ taskId, launchedAt: now(), blocked: null, requestedAt: request.source === "release" ? launch?.requestedAt ?? now() : null })
    .onConflictDoUpdate({
      target: taskPrerequisiteLaunches.taskId,
      set: { launchedAt: now(), blocked: null, ...(request.source === "release" ? {} : { requestedAt: null }) },
    });
  await appendTaskTimeline(taskId, receiptLine(`前置都站稳了，从 ${prerequisites.map((p) => `「${p.title || p.id}」`).join("、")} 的代码开工。`));
  await republishPrerequisiteView([taskId]);
  return null;
}

// ── 放行 ─────────────────────────────────────────────────────────────────────

const pending = new Map<string, NodeJS.Timeout>();

/**
 * 「这条前置可能变了」的统一出口（见文件头）。短暂合并一下：一次结算往往连着发好几个事件。
 * 前置被删时调用方自己带上下游名单（删完就查不到谁建在它上面了）。
 */
export function notePrerequisiteProgress(prerequisiteId: string, dependents?: string[]): void {
  forgetStanding(prerequisiteId);
  const key = dependents ? `${prerequisiteId}:${dependents.join(",")}` : prerequisiteId;
  if (pending.has(key)) return;
  pending.set(key, setTimeout(() => {
    pending.delete(key);
    void progress(prerequisiteId, dependents).catch((error) => console.error(`[ash] 前置 ${prerequisiteId} 推进下游失败:`, error));
  }, 150).unref());
}

async function progress(prerequisiteId: string, known?: string[]): Promise<void> {
  const dependents = known ?? (await dependentEdges(prerequisiteId)).map((edge) => edge.taskId);
  if (!dependents.length) return;
  await republishPrerequisiteView(dependents);
  for (const taskId of dependents) await releaseOne(taskId);
}

/** 一条挂着「等齐就起」的下游：齐了就起。不齐、分组暂停、已经起过的都原样留着。 */
async function releaseOne(taskId: string): Promise<void> {
  const launch = await launchRecord(taskId);
  if (!launch?.requestedAt) return;
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task || task.archived || task.status !== "backlog") {
    // 已经从别处起跑了（或者没了）：这笔请求了结。
    await db.update(taskPrerequisiteLaunches).set({ requestedAt: null }).where(eq(taskPrerequisiteLaunches.taskId, taskId));
    if (task) await republishPrerequisiteView([taskId]);
    return;
  }
  if (task.groupId && (await db.select({ paused: groups.paused }).from(groups).where(eq(groups.id, task.groupId))).at(0)?.paused) return;
  if (released.size >= MAX_RELEASED) return;
  const edges = await prerequisiteEdges(taskId);
  if (edges.length && !launch.launchedAt) {
    const standings = await prerequisiteStandings(edges.map((edge) => edge.prerequisiteId));
    if (edges.some((edge) => standings.get(edge.prerequisiteId)?.standing.step !== "settled")) return;
  }
  const queue = (await db.select().from(queueItems).where(eq(queueItems.taskId, taskId))).at(0);
  if (queue) {
    const { advanceQueueInBackground } = await import("./scheduler.js");
    advanceQueueInBackground(queue.queueId);
    return;
  }
  const hold = await holdForPrerequisites(task, { source: "release", actingUserId: launch.actingUserId });
  if (hold) return;
  const { claimOwnTurn, releaseTurn } = await import("./runs.js");
  const { isAcceptingTask } = await import("./acceptance-lock.js");
  const turn = claimOwnTurn(taskId, "single");
  if (!turn) return;
  if (isAcceptingTask(taskId)) { releaseTurn(taskId, turn); return; }
  const { seatThenStart } = await import("./queue-seat.js");
  const { resumeOrRunTask } = await import("./task-resume.js");
  released.add(taskId);
  let run: Promise<void> | null = null;
  const started = await seatThenStart(taskId, turn, () => {
    run = resumeOrRunTask(taskId, { reason: "wake", turnHeld: turn, actingUserId: launch.actingUserId });
    return run;
  });
  if (!started.ok) {
    released.delete(taskId);
    return;
  }
  await db.update(taskPrerequisiteLaunches).set({ requestedAt: null }).where(eq(taskPrerequisiteLaunches.taskId, taskId));
  const settle = () => { released.delete(taskId); sweepSoon(); };
  if (run) void (run as Promise<void>).then(settle, settle);
  else settle();
}

/** 全部挂着的请求扫一遍：开机补办、定时兜底、有一条放出来的跑完腾出位置时都走这里。 */
export async function sweepPrerequisiteLaunches(): Promise<void> {
  const rows = await db.select({ taskId: taskPrerequisiteLaunches.taskId }).from(taskPrerequisiteLaunches)
    .where(isNotNull(taskPrerequisiteLaunches.requestedAt));
  for (const { taskId } of rows) {
    await releaseOne(taskId).catch((error) => console.error(`[ash] 等齐就起补办失败 task=${taskId}:`, error));
  }
}

let sweepTimer: NodeJS.Timeout | null = null;
function sweepSoon(): void {
  if (sweepTimer) return;
  sweepTimer = setTimeout(() => {
    sweepTimer = null;
    void sweepPrerequisiteLaunches().catch((error) => console.error("[ash] 等齐就起扫描失败:", error));
  }, 500);
  sweepTimer.unref();
}

let started = false;
/** 开机调一次：补办重启期间站稳的、挂上事件总线、每分钟兜底扫一遍。 */
export async function startPrerequisiteLaunches(intervalMs = 60_000): Promise<void> {
  if (started) return;
  started = true;
  bus.subscribe((event) => {
    if (event.type === "task.status" || event.type === "task.review") notePrerequisiteProgress(event.taskId);
    else if (event.type === "task.updated" && !isRepublishingView(event.task.id)) notePrerequisiteProgress(event.task.id);
  });
  await sweepPrerequisiteLaunches();
  setInterval(() => void sweepPrerequisiteLaunches().catch((error) => console.error("[ash] 等齐就起扫描失败:", error)), intervalMs).unref();
}
