// 归档/取消归档（从 task-run-routes.ts 拆出，纯行数拆分）。归档 = 冻结（archived 位，
// 不动 status），门禁与团队连带见各路由内注释。磁盘上的 worktree/分支按全局设置
// `archiveClean` 一起收，那一段在 task-archive-cleanup.ts。
import type { TaskStatus } from "@ash/shared";
import { canArchive } from "@ash/shared";
import { summarizeArchiveCleanup } from "@ash/shared/project";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { db } from "./db/index.js";
import { projects, tasks } from "./db/schema.js";
import { hasActiveFreeReview } from "./free-workflow.js";
import { isAcceptingTask } from "./acceptance-lock.js";
import { isRunning, isTurnClaimed } from "./runs.js";
import { setTaskStatus } from "./status.js";
import { cleanupArchivedWorkspaces } from "./task-archive-cleanup.js";
import { acceptedHeadRef, commitAt } from "./task-branch-plan.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { enrichTasks } from "./task-store.js";
import { detectTaskWorkspace } from "./workspace-cleanup.js";
import { haltTeam } from "./team/session.js";
import { now } from "./util.js";

export function mountTaskArchiveRoutes(api: Hono): void {
  // Archiving is orthogonal to status (a separate `archived` flag, not an 8th
  // status): a settled terminal task (done/failed/canceled) is frozen and tucked
  // away into the archive view. It does NOT go through setTaskStatus — the status
  // is preserved so unarchiving restores it. Both endpoints are idempotent (already
  // in the target state → just return the task) so a double-click never errors.
  api.post("/tasks/:id/archive", async (c) => {
    const r = (await db.select().from(tasks).where(eq(tasks.id, c.req.param("id")))).at(0);
    if (!r) return c.json({ error: "not found" }, 404);
    // idempotent：已经归档了就什么都不做（清理也不重跑——它在第一次归档时就做过了）
    if (r.archived) return c.json({ task: (await enrichTasks([r]))[0], cleanup: null });
    if (!canArchive(r.status as TaskStatus)) {
      return c.json({ error: "只有已完成/失败/已取消的任务可以归档", status: r.status }, 409);
    }
    // 归档 = 冻结。回合被占（status 尚未落 running）、自由审查正在进行、或验收正在执行时
    // 归档，会让一个「冻结」任务上继续跑回合/审查/合并写入——先等它结束或停掉再归档。
    if (isTurnClaimed(r.id)) {
      return c.json({ error: "任务回合正在进行（状态尚未落库），结束后再归档", status: r.status }, 409);
    }
    if (isAcceptingTask(r.id)) {
      return c.json({ error: "任务正在验收中，结束后再归档" }, 409);
    }
    if (r.workflowMode === "free" && await hasActiveFreeReview(r.id)) {
      return c.json({ error: "自由审查正在进行，结束后再归档" }, 409);
    }
    // 就地验证轮中途提问后,旁路结算会把 status 放回原终态(done/failed),而 verifyRound
    // 和 question 都还挂着——只看 status/turn 的门禁会放行,于是「已冻结」的任务被答复后
    // 继续结算,最后留下 archived=true + stage=verifying 的死局(审查实测)。验证轮没结束
    // 就是还在进行,先答复/停掉它再归档。
    if (r.verifyRound !== null) {
      return c.json({ error: "就地验证轮还没结束（可能正等你答复），处理完再归档", status: r.status }, 409);
    }
    // 团队归档会连 children 一起冻结：任一执行者还在验收(含发布尾段)/回合中时归档，
    // 冻结的任务会继续产生外部副作用(审查实测:child beginAccepting 后归档 lead 200)。
    if (r.mode === "team") {
      const children = await db.select({ id: tasks.id, title: tasks.title }).from(tasks).where(eq(tasks.parentId, r.id));
      const busy = children.find((child) => isAcceptingTask(child.id) || isTurnClaimed(child.id));
      if (busy) {
        return c.json({ error: `执行者「${busy.title}」正在验收或回合中，结束后再归档`, childId: busy.id }, 409);
      }
    }
    const ts = now();
    // 团队(§Team):归档才是「这件事结束了」—— 先停掉调度台进程和所有在跑的执行者,
    // 再把执行者一并归档(不管它们各自停在什么状态:团队没了,散在列表里的执行者只是
    // 噪音;取消归档时整支队伍一起回来)。
    if (r.mode === "team") {
      await haltTeam(r.id);
      const workers = await db.select().from(tasks).where(eq(tasks.parentId, r.id));
      for (const w of workers) {
        // 显示 running/queued 却没有活 handle/turn 的执行者(重启残留):没有进程可停,
        // stopTask 也不会替它落状态——直接归档会得到「archived=true + status=running」的
        // 失真组合(审查实测)。按 reconcileInterrupted 同一口径先落格再归档。
        if ((w.status === "running" || w.status === "queued") && !isRunning(w.id) && !isTurnClaimed(w.id)) {
          await setTaskStatus(w.id, (w.followUpFrom as TaskStatus | null) ?? "failed");
        }
        await db.update(tasks).set({ archived: true, archivedAt: ts, updatedAt: ts }).where(eq(tasks.id, w.id));
      }
    }
    await db.update(tasks).set({ archived: true, archivedAt: ts, updatedAt: ts }).where(eq(tasks.id, r.id));
    // 任务行已经冻结,再收磁盘。顺序刻意如此:清理失败(目录脏/分支未合并/预览没停)
    // 不该把归档一起挡回去,结果如实回给 UI,并写进时间线 —— 刷新页面后还能看出
    // 「归档那一下到底删了什么」,否则用户只剩去 git 里翻这一条路。
    const cleanupTargets = [{ id: r.id, title: r.title ?? r.id }];
    if (r.mode === "team") {
      for (const w of await db.select().from(tasks).where(eq(tasks.parentId, r.id))) {
        cleanupTargets.push({ id: w.id, title: w.title ?? w.id });
      }
    }
    const cleanup = await cleanupArchivedWorkspaces(await repoPathOf(r.projectId), cleanupTargets);
    const summary = summarizeArchiveCleanup(cleanup);
    if (summary) await appendTaskTimeline(r.id, `归档时清理工作区：${summary}。`);
    const task = (await enrichTasks([(await db.select().from(tasks).where(eq(tasks.id, r.id))).at(0)!]))[0];
    return c.json({ task, cleanup });
  });

  api.post("/tasks/:id/unarchive", async (c) => {
    const r = (await db.select().from(tasks).where(eq(tasks.id, c.req.param("id")))).at(0);
    if (!r) return c.json({ error: "not found" }, 404);
    if (!r.archived) return c.json({ task: (await enrichTasks([r]))[0], restoreNote: null }); // idempotent
    const ts = now();
    await db.update(tasks).set({ archived: false, archivedAt: null, updatedAt: ts }).where(eq(tasks.id, r.id));
    // 对称:团队回来了,它的执行者也一起回来(归档时是整支队伍一起走的)
    if (r.mode === "team") {
      await db.update(tasks).set({ archived: false, archivedAt: null, updatedAt: ts }).where(eq(tasks.parentId, r.id));
    }
    const task = (await enrichTasks([(await db.select().from(tasks).where(eq(tasks.id, r.id))).at(0)!]))[0];
    // 归档会按设置把 worktree 删掉,所以「取回」之后的工作区状态必须当场说清楚 ——
    // 否则用户点开任务看见一个不存在的路径,只能自己猜还能不能接着跑。
    return c.json({ task, restoreNote: await restoreNoteFor(r.projectId, r.id) });
  });
}

/**
 * 取回归档时的工作区实情。归档清理过之后目录多半已经没了,而「还能不能接着跑」全看
 * 下次重建从哪个提交起:
 *  · 分支还在 → `prepareWorktree` 照分支重建,原样接着干;
 *  · 分支没了但 `acceptedHeadRef` 还在 → `restoreAcceptedStart` 把起点抬到任务完成时
 *    那个提交(验收写的是合并提交,归档清理写的是被删分支的末端);
 *  · 两样都没有 → 只剩 `worktreeStartCommit` 这个**开工点**,重跑等于从那儿重新做。
 * 第三档必须说清楚是「退回开工点」而不是含糊的「新开一份」—— 用户据此决定要不要先去
 * 主分支把自己的成果捡回来(第 1 轮审查:原文案与实际重建结果不符)。
 */
async function restoreNoteFor(projectId: string, taskId: string): Promise<string | null> {
  const repo = await repoPathOf(projectId);
  if (!repo) return null;
  const { path, branch } = await detectTaskWorkspace(repo, taskId);
  if (path) return null; // 工作区还在原地,没什么要交代的
  if (branch) return `工作区已在归档时清理，下次运行会按分支 ${branch} 重建。`;
  const head = await commitAt(repo, acceptedHeadRef(taskId));
  if (head) return `工作区和任务分支都已清理，下次运行会从任务完成时的提交 ${head.slice(0, 8)} 重建。`;
  return "工作区和任务分支都已不在（归档清理或验收时收掉了），下次运行会退回这个任务的开工提交；"
    + "它做完的改动如果已经合进目标分支，需要你自己决定要不要带回来。";
}

const repoPathOf = async (projectId: string): Promise<string | null> =>
  (await db.select({ repoPath: projects.repoPath }).from(projects).where(eq(projects.id, projectId))).at(0)?.repoPath ?? null;
