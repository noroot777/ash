import { eq, inArray } from "drizzle-orm";
import { rmSync } from "node:fs";
import { join, basename } from "node:path";
import type { Context, Hono } from "hono";
import type { Project, ProjectView } from "@ash/shared";
import { RUNS_DIR, DATA_DIR } from "./paths.js";
import { db } from "./db/index.js";
import { projects, groups, tasks, notes, noteTasks } from "./db/schema.js";
import { id, now } from "./util.js";
import { projectHealthLight, projectHealthFull, tidyRepoPath, repoKey, listBranches } from "./git.js";
import { getGitOverview } from "./git-overview.js";
import { discardTaskWorkspace } from "./workspace-cleanup.js";
import { deleteTaskAssociations } from "./task-routes.js";
import { isTurnClaimed } from "./runs.js";
import { isAcceptingTask } from "./acceptance-lock.js";
import { findWorkflow } from "./workflows.js";
import { ensureProjectDir } from "./project-dir.js";
import { deleteProjectGitCredential } from "./git-credentials.js";
import { actorOf, authErrorResponse, ownerIdOf } from "./auth/context.js";
import { projectPathRejection } from "./auth/path-scope.js";
import {
  deleteProjectMembers,
  requireProjectAccess,
  requireProjectAdmin,
  seedProjectOwner,
  visibleProjectIds,
} from "./auth/visibility.js";
import { deleteProjectInvites } from "./auth/user-routes.js";

// 项目这张表自己的 CRUD 与体检端点。从 routes.ts 搬出来:那份文件是各模块 mount 的总表
// 加上零散端点,项目这一段已经长到能自成一块了(建项目、按路径找回、删项目的级联、路径
// 体检、分支列表)。「从 Git 检出」那条更重的路另住 project-clone.ts。

export function mountProjectRoutes(api: Hono): void {
  // ── projects ───────────────────────────────────────────────────────────────
  // repoPath health is computed, never persisted (§ path-awareness). The list
  // uses the cheap sync check; per-id and path-check endpoints do the full git probe.
  const toProject = (r: typeof projects.$inferSelect): ProjectView => ({
    ...r,
    health: projectHealthLight(r.repoPath),
  });

  // 可见性过滤(§十二):普通用户只看得到自己是成员的项目。`visible === null` 表示
  // 不设限(自用模式 / 实例管理员),这时走的是与本功能上线前完全一样的那条路。
  api.get("/projects", async (c) => {
    const visible = await visibleProjectIds(actorOf(c));
    const rows = await db.select().from(projects);
    return c.json(rows.filter((r) => visible === null || visible.has(r.id)).map(toProject));
  });

  api.post("/projects", async (c) => {
    const actor = actorOf(c);
    const b = await c.req.json<{ name: string; repoPath: string; createDir?: boolean }>();
    if (!b.name?.trim()) return c.json({ error: "name required" }, 400);
    const repoPath = tidyRepoPath(b.repoPath);
    // 普通用户只能在自己的目录里建项目(§七)。管理员不受钳制。
    const rejection = await projectPathRejection(actor, repoPath);
    if (rejection) return c.json({ error: rejection }, 403);
    // 目录不存在时**照记不误**仍是默认行为（路径写错、或先建项目回头再补路径都很常见）。
    // 只有调用方明确说了 `createDir` 才动磁盘 —— 界面上那句「目录不存在，会建出来」和这个
    // 标志位是同一件事的两面，见 project-dir.ts 顶部。
    if (b.createDir) {
      try {
        ensureProjectDir(repoPath);
      } catch (error) {
        const status = (error as { status?: number }).status ?? 400;
        return c.json({ error: (error as Error).message }, status as 400);
      }
    }
    const row = {
      id: id(),
      name: b.name.trim(),
      repoPath,
      apiKeys: null,
      workflowId: null,
      createdAt: now(),
      ownerUserId: ownerIdOf(actor),
    };
    await db.insert(projects).values(row);
    // 建的人立刻成为项目管理员 —— 否则他自己都进不去自己刚建的项目。
    await seedProjectOwner(row.id, actor);
    return c.json(toProject(row), 201);
  });

  // Find-or-create a project by repoPath — idempotent, agent-friendly. Lets an agent
  // go straight from a repo path to a stable projectId without first listing/creating
  // (call it every time without worrying about duplicates). Matching is by canonical
  // path key (repoKey), so `~/code/foo`, `/Users/me/code/foo`, and a trailing slash
  // all resolve to the same project. name defaults to the repo's directory name.
  // 200 = existing (matched or adopted), 201 = created, 409 = ambiguous.
  api.post("/projects/resolve", async (c) => {
    const actor = actorOf(c);
    const b = await c.req.json<{ repoPath: string; name?: string }>();
    const repoPath = tidyRepoPath(b.repoPath);
    if (!repoPath) return c.json({ error: "repoPath required" }, 400);
    // MCP 也走这条路(agent 从一个仓库路径换 projectId),所以钳制必须做在这里,
    // 而不是只做在 HTTP 建项目的表单上(§七 明确点名了 MCP 这一侧)。
    const rejection = await projectPathRejection(actor, repoPath);
    if (rejection) return c.json({ error: rejection }, 403);
    const key = repoKey(repoPath);
    const visible = await visibleProjectIds(actor);
    // 看不见的项目对这个人**等于不存在**:否则「按路径找回」会变成一个探测器 ——
    // 换一个路径试一次,就能问出别人有没有在那个位置建过项目。
    const all = (await db.select().from(projects)).filter((p) => visible === null || visible.has(p.id));

    // 1) Canonical path match — the happy path, fully idempotent across path spellings.
    const pathHits = all.filter((p) => repoKey(p.repoPath) === key);
    if (pathHits.length > 1) return c.json({ error: "repoPath 匹配到多个项目，请改用 projectId", repoPath }, 409);
    if (pathHits.length === 1) return c.json(toProject(pathHits[0]), 200);

    // 2) No path match: adopt a path-less project with the same name — the common
    //    case where the user created the project in the UI by name only (no repoPath).
    //    Backfill its repoPath so it becomes the stable target, instead of spawning a
    //    confusing same-name duplicate. Ambiguous (>1 such project) → 409.
    const name = b.name?.trim() || basename(repoPath) || "project";
    const orphans = all.filter((p) => !repoKey(p.repoPath) && p.name === name);
    if (orphans.length > 1) return c.json({ error: "有多个同名且未设路径的项目，请在界面里设置路径或改用 projectId", name }, 409);
    if (orphans.length === 1) {
      await db.update(projects).set({ repoPath }).where(eq(projects.id, orphans[0].id));
      const adopted = (await db.select().from(projects).where(eq(projects.id, orphans[0].id))).at(0)!;
      return c.json(toProject(adopted), 200);
    }

    // 3) Genuinely new project.
    const row = {
      id: id(),
      name,
      repoPath,
      apiKeys: null,
      workflowId: null,
      createdAt: now(),
      ownerUserId: ownerIdOf(actor),
    };
    await db.insert(projects).values(row);
    await seedProjectOwner(row.id, actor);
    return c.json(toProject(row), 201);
  });

  api.patch("/projects/:id", async (c) => {
    const pid = c.req.param("id");
    const actor = actorOf(c);
    const existing = (await db.select().from(projects).where(eq(projects.id, pid))).at(0);
    if (!existing) return c.json({ error: "not found" }, 404);
    try {
      await requireProjectAdmin(actor, pid);
    } catch (error) {
      const mapped = authErrorResponse(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
    const b = await c.req.json<Partial<Project>>();
    const patch: Record<string, unknown> = {};
    if (b.name !== undefined) {
      if (!b.name.trim()) return c.json({ error: "name required" }, 400);
      patch.name = b.name.trim();
    }
    if (b.repoPath !== undefined) {
      const next = tidyRepoPath(b.repoPath);
      const rejection = await projectPathRejection(actor, next);
      if (rejection) return c.json({ error: rejection }, 403);
      patch.repoPath = next;
    }
    // 项目默认起手式：空串/null 都表示「跟随全局默认」，存成 null 保持一种写法
    if (b.workflowId !== undefined) {
      if (b.workflowId !== null && typeof b.workflowId !== "string") {
        return c.json({ error: "workflowId 必须是字符串或 null" }, 400);
      }
      const wid = typeof b.workflowId === "string" ? b.workflowId.trim() : "";
      if (wid && !(await findWorkflow(wid))) return c.json({ error: "起手式不存在" }, 400);
      patch.workflowId = wid || null;
    }
    if (Object.keys(patch).length) await db.update(projects).set(patch).where(eq(projects.id, pid));
    const updated = (await db.select().from(projects).where(eq(projects.id, pid))).at(0)!;
    return c.json(toProject(updated));
  });

  // Full delete: cascade tasks → their sessions/schedules/run-artifacts, then
  // groups, then the project. Refuses while any task is live (§ safety).
  api.delete("/projects/:id", async (c) => {
    const pid = c.req.param("id");
    try {
      await requireProjectAdmin(actorOf(c), pid);
    } catch (error) {
      const mapped = authErrorResponse(error);
      if (mapped) return c.json(mapped.body, mapped.status);
      throw error;
    }
    const ptasks = await db.select().from(tasks).where(eq(tasks.projectId, pid));
    // 单任务 DELETE 的生命周期锁在这里同样成立：turn 已占（status 未落 running）、验收
    // （含发布尾段）进行中删掉任务行，结算/尾段会写向不存在的任务（审查实测：项目入口
    // 完全绕过了任务级门禁）。
    const live = ptasks.find((t) =>
      t.status === "running" || t.status === "queued" || isTurnClaimed(t.id) || isAcceptingTask(t.id));
    if (live) return c.json({ error: "项目有正在运行/排队/验收中的任务，无法删除", taskId: live.id }, 409);
    for (const t of ptasks) {
      // 与单任务 DELETE 同一份级联（审查链/预约/事件/消息/会话/计划/队列位），不留
      // reconcile 收不掉的孤儿（state/event/message/queue item 都没有自愈入口）。
      await deleteTaskAssociations(t.id);
      rmSync(join(RUNS_DIR, t.id), { recursive: true, force: true });
      rmSync(join(DATA_DIR, "scratch", t.id), { recursive: true, force: true });
    }
    await db.delete(tasks).where(eq(tasks.projectId, pid));
    await db.delete(groups).where(eq(groups.projectId, pid));
    const projectNotes = await db.select({ id: notes.id }).from(notes).where(eq(notes.projectId, pid));
    if (projectNotes.length) await db.delete(noteTasks).where(inArray(noteTasks.noteId, projectNotes.map((note) => note.id)));
    await db.delete(notes).where(eq(notes.projectId, pid));
    await deleteProjectGitCredential(pid);
    await deleteProjectMembers(pid);
    await deleteProjectInvites(pid);
    await db.delete(projects).where(eq(projects.id, pid));
    return c.json({ deleted: true });
  });

  // 单项目读型端点的统一取数:看不见就 403,不存在就 404。
  // 这几条都会**把服务端磁盘上的事实回给调用方**(路径存不存在、是不是 git 仓库、
  // 有哪些分支),所以它们和列表一样要过可见性,不能只在列表上过滤。
  type Loaded =
    | { row: typeof projects.$inferSelect; error?: undefined }
    | { row?: undefined; error: Response };
  const loadVisible = async (c: Context, pid: string): Promise<Loaded> => {
    const row = (await db.select().from(projects).where(eq(projects.id, pid))).at(0);
    if (!row) return { error: c.json({ error: "not found" }, 404) };
    try {
      await requireProjectAccess(actorOf(c), pid);
    } catch (error) {
      const mapped = authErrorResponse(error);
      if (mapped) return { error: c.json(mapped.body, mapped.status) };
      throw error;
    }
    return { row };
  };

  // Health probes: by id (settings panel) and by raw path (validate unsaved input).
  api.get("/projects/:id/health", async (c) => {
    const { row, error } = await loadVisible(c, c.req.param("id"));
    if (error) return error;
    return c.json(await projectHealthFull(row.repoPath));
  });

  // 按**原始路径**探健康:表单里边打边校验。多人模式下它同样要钳 —— 否则这条端点
  // 就是一台目录探测器(挨个路径试,看回的是「不是 git 仓库」还是「路径不存在」)。
  api.post("/projects/check", async (c) => {
    const b = await c.req.json<{ repoPath: string }>();
    const rejection = await projectPathRejection(actorOf(c), b.repoPath ?? "");
    if (rejection) return c.json({ error: rejection }, 403);
    return c.json(await projectHealthFull(b.repoPath));
  });

  // List the project's local git branches plus the current HEAD — drives the
  // new-task form's "base 分支" picker. Empty `{ branches: [], current: null }`
  // when the path isn't a git repo, so the UI can degrade to a text field.
  api.get("/projects/:id/branches", async (c) => {
    const { row, error } = await loadVisible(c, c.req.param("id"));
    if (error) return error;
    return c.json(await listBranches(row.repoPath));
  });

  // Read-only command-palette view: local branches plus every registered worktree.
  // It deliberately bypasses repo-lock because neither git command mutates refs,
  // indexes, or the worktree registry.
  api.get("/projects/:id/git-overview", async (c) => {
    const { row, error } = await loadVisible(c, c.req.param("id"));
    if (error) return error;
    return c.json(await getGitOverview(row.repoPath));
  });

  // 清理某个任务留下的 worktree 目录 / 分支。任务行这时通常已经被删掉了(删除时
  // 没勾选、或勾了但 git 拒绝),所以入口挂在 project 上、只按 taskId 推导路径与
  // 分支名 —— 不查任务表,删掉的任务照样能收拾干净。逐项结果原样回给 UI:git 拒绝
  // (脏 worktree / 未合并分支)是要展示给用户的信息,不是 500。
  api.post("/projects/:id/workspaces/discard", async (c) => {
    const { row, error } = await loadVisible(c, c.req.param("id"));
    if (error) return error;
    const b = await c.req.json<{ taskId: string; worktree?: boolean; branch?: boolean; force?: boolean }>();
    if (!b?.taskId) return c.json({ error: "taskId required" }, 400);
    return c.json(
      await discardTaskWorkspace(row.repoPath, b.taskId, {
        worktree: b.worktree !== false,
        branch: b.branch !== false,
        force: !!b.force,
      }),
    );
  });
}
