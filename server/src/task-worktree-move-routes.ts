// 「改到独立工作区」的两个入口（办法本身在 task-worktree-move.ts）：
//
//   POST   /tasks/:id/worktree-move   { base, mergeTargetBranch? }
//     · 任务正在跑、请求带着这一回合的身份（智能体调 MCP `move_to_worktree`）：这一回合的目录换不得，
//       只登记 + 留一段续跑交代，回合结束后叫起下一回合，由下一回合开头办。
//     · 任务没在跑（用户在信息格里点）：当场占住回合锁办完。
//   DELETE /tasks/:id/worktree-move   撤回还没办的登记（下一回合照旧在原目录里跑，并告诉智能体撤回了）。
//   GET    /tasks/:id/foreign-worktrees  智能体自己建的、Navi 没管到的工作区，各带一句收不收得了（foreign-worktrees.ts）
//   POST   /tasks/:id/worktree-adopt   { path, mergeTargetBranch? } 收编其中一个（task-worktree-adopt.ts），只给没在跑的任务
//
// 登记和撤回都按「此刻还是我读到的那一份」比对着写；撤回在仓库锁里做，跟「办」的那一段互斥
// （办的一方进锁后会重读登记，见 task-worktree-move.ts），所以撤回回了成功，任务就一定没被搬走。
import type { Context, Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "./db/index.js";
import { projects, tasks } from "./db/schema.js";
import { isAcceptingTask } from "./acceptance-lock.js";
import { claimOwnTurn, releaseTurn, turnBusyText, whenTurnIdle } from "./runs.js";
import { NAVI_HEADERS, requestHeader } from "./request-headers.js";
import { occupyResumePrompt } from "./task-resume-prompt.js";
import { publishTaskUpdated } from "./task-store.js";
import { appendTaskTimeline, alertLine } from "./task-timeline.js";
import {
  dirtyProjectError, moveTaskToWorktree, requestIs, taskMoveBlocker, wakeForWorktreeMove, worktreeMoveBlocker, worktreeMoveInputError, WorktreeMoveError,
} from "./task-worktree-move.js";
import { parseWorktreeMoveRequest, serializeWorktreeMoveRequest } from "./worktree-move-request.js";
import { withRepoLock } from "./repo-lock.js";
import { expandHome, resolveTaskMergeTarget } from "./git.js";
import { foreignWorktreesOf } from "./foreign-worktrees.js";
import { adoptForeignWorktree, adoptionBlocker } from "./task-worktree-adopt.js";
import { now } from "./util.js";

const refused = (c: Context, error: unknown) => {
  if (error instanceof WorktreeMoveError) return c.json({ error: error.message }, error.status);
  throw error;
};

const resumeText = (base: string) =>
  `继续：你刚才请求把本任务改到独立工作区（起点 ${base}）。办没办成、新目录在哪，见本条消息后面的说明；接着做用户要你做的事。`;

export function mountWorktreeMoveRoutes(api: Hono): void {
  api.post("/tasks/:id/worktree-move", async (c) => {
    const taskId = c.req.param("id");
    const body = await c.req.json<{ base?: unknown; mergeTargetBranch?: unknown }>().catch(() => ({}) as Record<string, unknown>);
    const base = typeof body.base === "string" ? body.base.trim() : "";
    const mergeTargetBranch = typeof body.mergeTargetBranch === "string" && body.mergeTargetBranch.trim() ? body.mergeTargetBranch.trim() : null;
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task) return c.json({ error: "not found" }, 404);
    const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
    if (!project) return c.json({ error: "任务所在的项目不存在" }, 404);
    const input = { base, mergeTargetBranch };
    const precheck = await worktreeMoveBlocker(task, project.repoPath) ?? await worktreeMoveInputError(project.repoPath, input)
      ?? await dirtyProjectError(project.repoPath, base);
    if (precheck) return refused(c, precheck);

    if (task.status === "running") {
      // 只认这一回合里的智能体（同 /pause 的身份校验）：别人替一个正在跑的回合换目录，那一回合会落在旧目录里。
      const turnToken = requestHeader(c, NAVI_HEADERS.turnToken);
      if (!turnToken || (task.activeTurnToken && turnToken !== task.activeTurnToken)) {
        return c.json({ error: "任务正在运行：只有这一回合里的智能体能登记，否则等它停下再改" }, 409);
      }
      const direction = requestHeader(c, NAVI_HEADERS.directionToken);
      if (task.activeDirectionToken && direction !== task.activeDirectionToken) {
        return c.json({ error: "方向身份已过期；请从最新用户消息的【当前方向身份】复制 directionToken 后重试" }, 409);
      }
      const identity = [
        eq(tasks.status, "running"),
        task.activeTurnToken === null ? isNull(tasks.activeTurnToken) : eq(tasks.activeTurnToken, task.activeTurnToken),
        task.activeDirectionToken === null ? isNull(tasks.activeDirectionToken) : eq(tasks.activeDirectionToken, task.activeDirectionToken),
      ];
      // 先登记（跟这一回合的身份、「此刻没有别的登记」一起比对），再写续跑交代；交代没写上就把自己这一份收回。
      const raw = serializeWorktreeMoveRequest({ base, mergeTargetBranch, requestedAt: now() });
      const registered = await db.update(tasks).set({ worktreeMoveRequest: raw, updatedAt: now() })
        .where(and(eq(tasks.id, taskId), requestIs(null), ...identity)).returning({ id: tasks.id });
      if (!registered.length) return c.json({ error: "当前回合已经结束、已被引导，或已经登记过一次，没有登记" }, 409);
      // 续跑交代跟 pause_task 写的是同一格：这一回合结束落「已暂停」，而不是按没交卷记未完成。
      if (!(await occupyResumePrompt(taskId, resumeText(base), false, identity))) {
        const withdrawn = await withRepoLock(expandHome(project.repoPath), () => db.update(tasks)
          .set({ worktreeMoveRequest: null, updatedAt: now() })
          .where(and(eq(tasks.id, taskId), requestIs(raw))).returning({ id: tasks.id }));
        await publishTaskUpdated(taskId);
        return withdrawn.length
          ? c.json({ error: "当前回合已经结束或已被引导，没有登记" }, 409)
          : c.json({ requested: true, note: "这一回合刚好结束，登记已经被下一回合接手去办了。" });
      }
      await publishTaskUpdated(taskId);
      whenTurnIdle(taskId, () => void wakeForWorktreeMove(taskId).catch((error) =>
        console.error(`[navi] 叫起改到独立工作区的下一回合失败 ${taskId}:`, error)));
      return c.json({
        requested: true, willSettleAs: "paused",
        note: "已登记。现在结束本回合；Navi 会把本任务改到独立工作区，然后在新目录里续跑这个会话。",
      });
    }
    if (task.status === "queued") return c.json({ error: "任务正要起跑，等这一回合跑起来或停下再改" }, 409);
    if (isAcceptingTask(taskId)) return c.json({ error: "任务正在验收，结束后再改" }, 409);
    const turn = claimOwnTurn(taskId, "single");
    if (!turn) return c.json({ error: turnBusyText(taskId, "改到独立工作区") }, 409);
    try {
      const moved = await moveTaskToWorktree(taskId, input);
      return c.json({ moved });
    } catch (error) {
      return refused(c, error);
    } finally {
      releaseTurn(taskId, turn);
    }
  });

  api.get("/tasks/:id/foreign-worktrees", async (c) => {
    const task = (await db.select().from(tasks).where(eq(tasks.id, c.req.param("id")))).at(0);
    if (!task) return c.json({ error: "not found" }, 404);
    const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
    if (!project || await taskMoveBlocker(task, project.repoPath)) return c.json({ worktrees: [], mergeTarget: null });
    const found = await foreignWorktreesOf(task, project.repoPath);
    const worktrees = await Promise.all(found.map(async (worktree) => ({
      path: worktree.path, seenAs: worktree.seenAs, branch: worktree.branch, head: worktree.head,
      blocker: (await adoptionBlocker(task, project.repoPath, worktree))?.message ?? null,
    })));
    const mergeTarget = found.length ? await resolveTaskMergeTarget(project.repoPath, null) : null;
    return c.json({ worktrees, mergeTarget: mergeTarget === "HEAD" ? null : mergeTarget });
  });

  api.post("/tasks/:id/worktree-adopt", async (c) => {
    const taskId = c.req.param("id");
    const body = await c.req.json<{ path?: unknown; mergeTargetBranch?: unknown }>().catch(() => ({}) as Record<string, unknown>);
    const path = typeof body.path === "string" ? body.path.trim() : "";
    if (!path) return c.json({ error: "要给出收编哪个工作区（path）" }, 400);
    const mergeTargetBranch = typeof body.mergeTargetBranch === "string" && body.mergeTargetBranch.trim() ? body.mergeTargetBranch.trim() : null;
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task) return c.json({ error: "not found" }, 404);
    // 智能体正在那个目录里跑的时候挪不得：收编只在任务停着时办。
    if (task.status === "running" || task.status === "queued") return c.json({ error: "任务正在运行，等它停下再收编" }, 409);
    if (isAcceptingTask(taskId)) return c.json({ error: "任务正在验收，结束后再收编" }, 409);
    const turn = claimOwnTurn(taskId, "single");
    if (!turn) return c.json({ error: turnBusyText(taskId, "收编工作区") }, 409);
    try {
      return c.json({ adopted: await adoptForeignWorktree(taskId, { path, mergeTargetBranch }) });
    } catch (error) {
      return refused(c, error);
    } finally {
      releaseTurn(taskId, turn);
    }
  });

  api.delete("/tasks/:id/worktree-move", async (c) => {
    const taskId = c.req.param("id");
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task) return c.json({ error: "not found" }, 404);
    const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
    if (!project) return c.json({ error: "任务所在的项目不存在" }, 404);
    // 等「办」的那一段（如果正在办）做完再看：办完了登记就没了，如实说「已经办了」，不回一个假的撤回成功。
    const withdrawn = await withRepoLock(expandHome(project.repoPath), async () => {
      const raw = (await db.select({ raw: tasks.worktreeMoveRequest }).from(tasks).where(eq(tasks.id, taskId))).at(0)?.raw ?? null;
      const request = parseWorktreeMoveRequest(raw);
      if (!raw || !request) return null;
      const cleared = await db.update(tasks).set({
        worktreeMoveRequest: null, updatedAt: now(),
        workspaceNote: `〔改到独立工作区已撤回〕用户撤回了把本任务改到独立工作区（起点 ${request.base}）的请求，工作目录没变。`,
      }).where(and(eq(tasks.id, taskId), requestIs(raw))).returning({ id: tasks.id });
      return cleared.length ? request : null;
    });
    if (!withdrawn) return c.json({ error: "没有待办的改到独立工作区（可能刚刚已经办完了）" }, 409);
    await appendTaskTimeline(taskId, alertLine(`已撤回改到独立工作区（起点 ${withdrawn.base}），工作目录没变。`));
    return c.json(await publishTaskUpdated(taskId));
  });
}
