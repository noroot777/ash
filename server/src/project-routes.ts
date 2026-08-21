import { eq, inArray } from "drizzle-orm";
import { rmSync } from "node:fs";
import { join, basename } from "node:path";
import type { Hono } from "hono";
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

  api.get("/projects", async (c) =>
    c.json((await db.select().from(projects)).map(toProject)),
  );

  api.post("/projects", async (c) => {
    const b = await c.req.json<{ name: string; repoPath: string; createDir?: boolean }>();
    if (!b.name?.trim()) return c.json({ error: "name required" }, 400);
    const repoPath = tidyRepoPath(b.repoPath);
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
    const row = { id: id(), name: b.name.trim(), repoPath, apiKeys: null, workflowId: null, createdAt: now() };
    await db.insert(projects).values(row);
    return c.json(toProject(row), 201);
  });

  // Find-or-create a project by repoPath — idempotent, agent-friendly. Lets an agent
  // go straight from a repo path to a stable projectId without first listing/creating
  // (call it every time without worrying about duplicates). Matching is by canonical
  // path key (repoKey), so `~/code/foo`, `/Users/me/code/foo`, and a trailing slash
  // all resolve to the same project. name defaults to the repo's directory name.
  // 200 = existing (matched or adopted), 201 = created, 409 = ambiguous.
  api.post("/projects/resolve", async (c) => {
    const b = await c.req.json<{ repoPath: string; name?: string }>();
    const repoPath = tidyRepoPath(b.repoPath);
    if (!repoPath) return c.json({ error: "repoPath required" }, 400);
    const key = repoKey(repoPath);
    const all = await db.select().from(projects);

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
    const row = { id: id(), name, repoPath, apiKeys: null, workflowId: null, createdAt: now() };
    await db.insert(projects).values(row);
    return c.json(toProject(row), 201);
  });

  api.patch("/projects/:id", async (c) => {
    const pid = c.req.param("id");
    const existing = (await db.select().from(projects).where(eq(projects.id, pid))).at(0);
    if (!existing) return c.json({ error: "not found" }, 404);
    const b = await c.req.json<Partial<Project>>();
    const patch: Record<string, unknown> = {};
    if (b.name !== undefined) {
      if (!b.name.trim()) return c.json({ error: "name required" }, 400);
      patch.name = b.name.trim();
    }
    if (b.repoPath !== undefined) patch.repoPath = tidyRepoPath(b.repoPath);
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
    await db.delete(projects).where(eq(projects.id, pid));
    return c.json({ deleted: true });
  });

  // Health probes: by id (settings panel) and by raw path (validate unsaved input).
  api.get("/projects/:id/health", async (c) => {
    const p = (await db.select().from(projects).where(eq(projects.id, c.req.param("id")))).at(0);
    if (!p) return c.json({ error: "not found" }, 404);
    return c.json(await projectHealthFull(p.repoPath));
  });

  api.post("/projects/check", async (c) => {
    const b = await c.req.json<{ repoPath: string }>();
    return c.json(await projectHealthFull(b.repoPath));
  });

  // List the project's local git branches plus the current HEAD — drives the
  // new-task form's "base 分支" picker. Empty `{ branches: [], current: null }`
  // when the path isn't a git repo, so the UI can degrade to a text field.
  api.get("/projects/:id/branches", async (c) => {
    const p = (await db.select().from(projects).where(eq(projects.id, c.req.param("id")))).at(0);
    if (!p) return c.json({ error: "not found" }, 404);
    return c.json(await listBranches(p.repoPath));
  });

  // Read-only command-palette view: local branches plus every registered worktree.
  // It deliberately bypasses repo-lock because neither git command mutates refs,
  // indexes, or the worktree registry.
  api.get("/projects/:id/git-overview", async (c) => {
    const p = (await db.select().from(projects).where(eq(projects.id, c.req.param("id")))).at(0);
    if (!p) return c.json({ error: "not found" }, 404);
    return c.json(await getGitOverview(p.repoPath));
  });

  // 清理某个任务留下的 worktree 目录 / 分支。任务行这时通常已经被删掉了(删除时
  // 没勾选、或勾了但 git 拒绝),所以入口挂在 project 上、只按 taskId 推导路径与
  // 分支名 —— 不查任务表,删掉的任务照样能收拾干净。逐项结果原样回给 UI:git 拒绝
  // (脏 worktree / 未合并分支)是要展示给用户的信息,不是 500。
  api.post("/projects/:id/workspaces/discard", async (c) => {
    const p = (await db.select().from(projects).where(eq(projects.id, c.req.param("id")))).at(0);
    if (!p) return c.json({ error: "not found" }, 404);
    const b = await c.req.json<{ taskId: string; worktree?: boolean; branch?: boolean; force?: boolean }>();
    if (!b?.taskId) return c.json({ error: "taskId required" }, 400);
    return c.json(
      await discardTaskWorkspace(p.repoPath, b.taskId, {
        worktree: b.worktree !== false,
        branch: b.branch !== false,
        force: !!b.force,
      }),
    );
  });
}
