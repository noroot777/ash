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
// - **工作目录真的换成了起点**：没开过工作区的照常按起点建；已经开过（比如先点过预览）而且原封未动的，
//   就地换到起点；里面已经有改动或提交的，不替它做决定，挡住并说清原因。不用独立工作区的下游拿不到前置
//   分支上的代码，建边时就拒（prerequisite-store.ts），这里再挡一次兜老数据。
import { existsSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { prerequisiteStepText } from "@ash/shared/prerequisites";
import { db } from "./db/index.js";
import { projects, taskPrerequisiteLaunches, taskPrerequisites, tasks } from "./db/schema.js";
import { execFileText as exec } from "./exec.js";
import { expandHome, worktreePathFor } from "./git.js";
import { withRepoLock } from "./repo-lock.js";
import { baseRef, commitAt } from "./task-branch-plan.js";
import { prerequisiteStandings, type PrerequisiteStanding } from "./prerequisite-standing.js";
import { launchRecord, prerequisiteEdges } from "./prerequisite-store.js";
import { prerequisiteStart } from "./prerequisite-start-point.js";
import { republishPrerequisiteView } from "./prerequisite-view.js";
import { alertLine, appendTaskTimeline, receiptLine } from "./task-timeline.js";
import { now } from "./util.js";

/** 谁要求它起跑。`release` = 等齐之后由放行那一路自己起；`turn` = 底层起跑闸（见文件头）。 */
export type LaunchSource = "run" | "queue" | "group" | "release" | "turn";
export type LaunchRequest = { source: LaunchSource; actingUserId?: string | null };
export type PrerequisiteHold = { reason: string };

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
  await db.insert(taskPrerequisiteLaunches)
    .values({ taskId, requestedAt: now(), source: request.source, actingUserId: request.actingUserId ?? null, blocked })
    .onConflictDoUpdate({
      target: taskPrerequisiteLaunches.taskId,
      set: {
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
  if (!edges.length) return null;
  if ((await launchRecord(taskId))?.launchedAt) return null;
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return null;
  const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
  if (!project) return null;
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
    const block = async (reason: string) => { await recordRequest(taskId, request, reason); return { reason }; };
    const unreachable = !task.useWorktree && certified.find(({ task: p }) => p.useWorktree);
    if (unreachable) return block(`${label(task)}不用独立工作区，拿不到${label(unreachable.task)}分支上的代码`);
    const start = await prerequisiteStart(project.repoPath, task, certified);
    if (!start.ok) return block(start.reason);
    const repo = expandHome(project.repoPath);
    const path = worktreePathFor(project.repoPath, task.id);
    // 已经开过的工作区：原封未动（还在建任务时冻结的起点上、没有未提交改动）才能就地换到新起点。
    let move = false;
    if (task.useWorktree && existsSync(path)) {
      const head = await commitAt(path, "HEAD");
      if (head !== start.commit) {
        const clean = !(await exec("git", ["-C", path, "status", "--porcelain"]).then((r) => r.stdout.trim(), () => "?"));
        if (!clean || !head || head !== task.worktreeStartCommit) {
          return block(`${label(task)}的工作区里已经有自己的改动或提交，换不成前置的代码；放弃那些改动后会自动开工`);
        }
        move = true;
      }
    }
    // 定下之前再判一遍：这一段里有前置又动了（开了一轮、交出的版本变了），这一次作废重来。
    const again = await prerequisiteStandings(ids);
    if (ids.some((id) => !sameStanding(standings.get(id)?.standing, again.get(id)?.standing))) return RETRY;
    if (task.useWorktree) await exec("git", ["-C", repo, "update-ref", baseRef(task.id), start.commit]);
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
      // 就此了结；放行那一路自己放出来的，要等真起跑了才了结（见 prerequisite-launch.ts releaseOne）。
      const launch = (await tx.select().from(taskPrerequisiteLaunches).where(eq(taskPrerequisiteLaunches.taskId, taskId))).at(0);
      await tx.insert(taskPrerequisiteLaunches)
        .values({ taskId, launchedAt: now(), blocked: null, requestedAt: request.source === "release" ? launch?.requestedAt ?? now() : null })
        .onConflictDoUpdate({
          target: taskPrerequisiteLaunches.taskId,
          set: { launchedAt: now(), blocked: null, ...(request.source === "release" ? {} : { requestedAt: null }) },
        });
      return true;
    });
    if (!committed) return RETRY;
    if (move) {
      try {
        await exec("git", ["-C", path, "reset", "--keep", start.commit]);
      } catch (error) {
        // 没换成：撤回这一次开工，工作区与登记都退回去，挡住并说清楚。
        await db.transaction(async (tx) => {
          await tx.update(tasks).set({ worktreeStartCommit: task.worktreeStartCommit, worktreeBaseBranch: task.worktreeBaseBranch, updatedAt: now() })
            .where(eq(tasks.id, taskId));
          await tx.update(taskPrerequisites).set({ inheritedCommit: null }).where(eq(taskPrerequisites.taskId, taskId));
          await tx.update(taskPrerequisiteLaunches).set({ launchedAt: null }).where(eq(taskPrerequisiteLaunches.taskId, taskId));
        });
        if (task.worktreeStartCommit) await exec("git", ["-C", repo, "update-ref", baseRef(task.id), task.worktreeStartCommit]).catch(() => undefined);
        return block(`${label(task)}的工作区没能换到前置的代码（${error instanceof Error ? error.message.split("\n")[0] : String(error)}）`);
      }
    }
    await appendTaskTimeline(taskId, receiptLine(`前置都站稳了，从 ${certified.map(({ task: p }) => label(p)).join("、")} 的代码开工。`));
    await republishPrerequisiteView([taskId]);
    return null;
  });
}
