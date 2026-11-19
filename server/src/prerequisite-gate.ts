// 有前置的任务第一次开工前那一问（`holdForPrerequisites`）：前置没站齐就记下「等齐就起」、不起；站齐了就
// 按全部前置当时的代码定下起点（prerequisite-start-point.ts），然后照原路起跑。
//
// ## 闸住在哪
//
// 首次执行最终只汇到两处：fresh run（task-run.ts `runTask`）和续聊/投递（orchestrator `continueTask` 经
// turn-entry-guard.ts 的起跑闸）。两处各问一次，于是 /run、/fire、定时到点、回复、排队消息补投、队列推进、
// 分组运行一条都绕不过去。/run、队列、分组那几处入口自己也先问一次，只是为了能当场答一句「在等前置」、
// 不白占队列执行位。问是幂等的：起点定下（`launched_at`）之后一律放行，之后的运行、续聊、重试都不再看前置。
//
// ## 一次判定要守住的几件事
//
// - **判定和取代码是同一次**：站稳判定交出它核实过的那一版提交（prerequisite-standing.ts 的 `commit`），
//   起点就用那一版。整次判定在仓库锁里做，定下之前再判一遍，有一条变了就从头再来。
// - **边集合与起点同一次落定**：加、去前置和这里共用同一把任务级锁（`withPrerequisiteLock`）；删前置任务
//   不走这把锁，所以落库那一笔事务里再读一遍边，跟算起点时的不一样就从头再来。
// - **代码真的到了下游干活的地方才算开工**：工作区 / 任务分支换到起点（prerequisite-install.ts）之后才落
//   「已开工」，半路断掉留下的都是「还没开工」。不用独立工作区的下游在项目目录里干活，核对那里检出的代码里
//   有每条前置交出的那一版（prerequisite-start-point.ts `checkoutHasPrerequisites`），没有就挡住说清。
// - **停止键撤回的请求不复活**：放行那一路只认此刻还挂着的那一笔（launch-request.ts releaseLaunch 在锁里
//   重读、认领回合，再进这里）。
import { and, eq } from "drizzle-orm";
import { prerequisiteStepText } from "@navi/shared/prerequisites";
import { db } from "./db/index.js";
import { projects, taskPrerequisiteLaunches, taskPrerequisites, tasks } from "./db/schema.js";
import { execFileText as exec } from "./exec.js";
import { expandHome } from "./git.js";
import { withRepoLock } from "./repo-lock.js";
import { baseRef, commitAt } from "./task-branch-plan.js";
import { prerequisiteStandings, type PrerequisiteStanding } from "./prerequisite-standing.js";
import { launchRecord, prerequisiteEdges } from "./prerequisite-store.js";
import { checkoutHasPrerequisites, prerequisiteStart } from "./prerequisite-start-point.js";
import { applyInstall, journalInstall, planInstall, settleAbandonedInstall } from "./prerequisite-install.js";
import { republishPrerequisiteView } from "./prerequisite-view.js";
import { alertLine, appendTaskTimeline, receiptLine } from "./task-timeline.js";
import { id, now } from "./util.js";

/** 谁要求它起跑。`release` = 等齐之后由放行那一路自己起；`turn` = 底层起跑闸（见文件头）。 */
export type LaunchSource = "run" | "queue" | "group" | "release" | "turn";
export type LaunchRequest = { source: LaunchSource; actingUserId?: string | null };
/** `blocked`：前置都站稳了却开不了工（记成了 `blocked`）；没有 = 还在等前置。 */
export type PrerequisiteHold = { reason: string; blocked?: true };

// 同一条任务的「开工判定」与「加减前置」串行：放行、点运行、改前置同时到时，边集合与起点只按一个顺序落定。
const chains = new Map<string, Promise<unknown>>();
export function withPrerequisiteLock<T>(taskId: string, work: () => Promise<T>): Promise<T> {
  const previous = chains.get(taskId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(work);
  chains.set(taskId, next);
  void next.finally(() => { if (chains.get(taskId) === next) chains.delete(taskId); }).catch(() => undefined);
  return next;
}

export async function recordRequest(taskId: string, request: LaunchRequest, blocked: string | null): Promise<void> {
  const existing = await launchRecord(taskId);
  // 放行那一路只替已经挂着的请求办事：没有了（停止键撤回了）就不替谁新挂一笔。
  if (request.source === "release" && !existing?.requestedAt) return;
  // 新挂的一笔换一个代号、退避清零（launch-request.ts）；已经挂着的照旧是那一代。
  const fresh = { requestId: id(), startFailures: 0, retryAt: null, giveUp: null };
  await db.insert(taskPrerequisiteLaunches)
    .values({ taskId, requestedAt: now(), source: request.source, actingUserId: request.actingUserId ?? null, blocked, ...fresh })
    .onConflictDoUpdate({
      target: taskPrerequisiteLaunches.taskId,
      set: {
        ...(existing?.requestedAt ? {} : fresh),
        requestedAt: existing?.requestedAt ?? now(),
        // 等齐之后由放行那一路替原来那个人起跑：别让这一笔把「谁要求的」覆盖掉。
        ...(request.source === "release" || (request.source === "turn" && existing?.requestedAt)
          ? {} : { source: request.source, actingUserId: request.actingUserId ?? null }),
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
export function holdForPrerequisites(task: { id: string }, request: LaunchRequest): Promise<PrerequisiteHold | null> {
  return withPrerequisiteLock(task.id, () => gate(task.id, request));
}

/** 同上，给已经拿着 `withPrerequisiteLock` 的调用方（锁不可重入）。 */
export function holdForPrerequisitesLocked(taskId: string, request: LaunchRequest): Promise<PrerequisiteHold | null> {
  return gate(taskId, request);
}

const RETRY = Symbol("retry");

async function gate(taskId: string, request: LaunchRequest): Promise<PrerequisiteHold | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const outcome = await attemptGate(taskId, request);
    if (outcome !== RETRY) return outcome;
  }
  // 连着几次判定一半前置就变了：这一次先不开工，请求挂着，下一次进展/扫描再来。
  await recordRequest(taskId, request, null);
  return { reason: "前置正在变动，等它们停下来再开工" };
}

const label = (task: { title: string | null; id: string }) => `「${task.title || task.id}」`;
const sameEdges = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
const sameStanding = (a: PrerequisiteStanding | undefined, b: PrerequisiteStanding | undefined) =>
  !!a && !!b && a.step === b.step && a.commit === b.commit;

async function attemptGate(taskId: string, request: LaunchRequest): Promise<PrerequisiteHold | null | typeof RETRY> {
  const edges = await prerequisiteEdges(taskId);
  const record = await launchRecord(taskId);
  if (record?.launchedAt) return null;
  // 没有前置的任务照原路起跑 —— 除非上一次开工判定换到一半（日志非空）：那份代码得先退回去（prerequisite-install.ts）。
  if (!edges.length && !record?.installJournal?.length) return null;
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return null;
  const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
  if (!project) return null;
  if (!edges.length) {
    const reason = await withRepoLock(project.repoPath, () => settleAbandonedInstall(project.repoPath, task));
    if (!reason) return null;
    await recordRequest(taskId, request, reason);
    return { reason, blocked: true };
  }
  const ids = edges.map((edge) => edge.prerequisiteId);
  return withRepoLock(project.repoPath, async () => {
    const standings = await prerequisiteStandings(ids);
    const open = ids.flatMap((id) => {
      const found = standings.get(id);
      return found && found.standing.step !== "settled" ? [found] : [];
    });
    if (open.length) {
      await recordRequest(taskId, request, null);
      return { reason: `在等前置：${open.map(({ task: p, standing }) => `${label(p)}${prerequisiteStepText({ ...standing, movedOn: false })}`).join("；")}` };
    }
    const certified = ids.flatMap((id) => {
      const found = standings.get(id);
      return found ? [{ task: found.task, commit: found.standing.commit }] : [];
    });
    const block = async (reason: string) => { await recordRequest(taskId, request, reason); return { reason, blocked: true as const }; };
    // 用 worktree 的下游按起点建 / 换工作区；不用的在项目目录里干活，只能核对那里检出的代码里有没有前置的。
    const start = task.useWorktree
      ? await prerequisiteStart(project.repoPath, task, certified)
      : await checkoutHasPrerequisites(project.repoPath, task, certified);
    if (!start.ok) return block(start.reason);
    const install = task.useWorktree ? await planInstall(project.repoPath, task, start.commit) : { ok: true as const, plan: { kind: "none" } as const };
    if (!install.ok) return block(install.reason);
    // 定下之前再判一遍：这一段里有前置又动了（开了一轮、交出的版本变了），这一次作废重来。
    const again = await prerequisiteStandings(ids);
    if (ids.some((id) => !sameStanding(standings.get(id)?.standing, again.get(id)?.standing))) return RETRY;
    // 先记日志、再把代码真的放到位、最后才落「已开工」（顺序的理由见 prerequisite-install.ts 文件头）。
    if (task.useWorktree) {
      const repo = expandHome(project.repoPath);
      await journalInstall(taskId, start.commit);
      const before = await commitAt(repo, baseRef(task.id));
      await exec("git", ["-C", repo, "update-ref", baseRef(task.id), start.commit]);
      try {
        await applyInstall(project.repoPath, install.plan, start.commit);
      } catch (error) {
        if (before) await exec("git", ["-C", repo, "update-ref", baseRef(task.id), before]).catch(() => undefined);
        return block(`${label(task)}的工作区没能换到前置的代码（${error instanceof Error ? error.message.split("\n")[0] : String(error)}）`);
      }
    }
    const committed = await db.transaction(async (tx) => {
      const current = (await tx.select().from(taskPrerequisites).where(eq(taskPrerequisites.taskId, taskId))).map((edge) => edge.prerequisiteId);
      if (!sameEdges(current, ids)) return false;
      if (!(await tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId))).length) return false;
      if (task.useWorktree) {
        await tx.update(tasks).set({ worktreeStartCommit: start.commit, worktreeBaseBranch: start.baseBranch, updatedAt: now() })
          .where(eq(tasks.id, taskId));
      }
      for (const id of ids) {
        await tx.update(taskPrerequisites).set({ inheritedCommit: start.inherited.get(id) ?? null })
          .where(and(eq(taskPrerequisites.taskId, taskId), eq(taskPrerequisites.prerequisiteId, id)));
      }
      // 起点定下了。别的入口起跑时，起不起得来由它自己负责（用户看得到结果、队列自己会重试），这一笔请求
      // 就此了结；放行那一路自己放出来的，要等真起跑了才了结（见 launch-request.ts releaseLaunch）——
      // 它只认已经挂着的那一笔，不新建：停止键撤回了的，不能被放行那一路复活。
      await tx.insert(taskPrerequisiteLaunches)
        .values({ taskId, launchedAt: now(), blocked: null, requestedAt: null, installJournal: null })
        .onConflictDoUpdate({
          target: taskPrerequisiteLaunches.taskId,
          set: { launchedAt: now(), blocked: null, installJournal: null,
            ...(request.source === "release" ? {} : { requestedAt: null, startFailures: 0, retryAt: null, giveUp: null }) },
        });
      return true;
    });
    // 边变了：工作区已经换到这次的起点、日志里记着它，下一次判定从这里接着核对（换过去的目录认得出没动过）。
    if (!committed) return RETRY;
    await appendTaskTimeline(taskId, receiptLine(`前置都站稳了，从 ${certified.map(({ task: p }) => label(p)).join("、")} 的代码开工。`));
    await republishPrerequisiteView([taskId]);
    return null;
  });
}
