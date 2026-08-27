// 用户管理(实例层,仅管理员)+ 项目成员与项目邀请(项目层)。§五 / §六。
import type { Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import type { ProjectInviteInfo, ProjectRole, UserRole } from "@ash/shared";
import { suggestDirName, suggestGitEmail, userDirNameError } from "@ash/shared/multiuser";
import { db } from "../db/index.js";
import { projectInvites, projects, schedules, tasks } from "../db/schema.js";
import { stopTask } from "../runs.js";
import { setTaskStatus } from "../status.js";
import { id, now } from "../util.js";
import { actorOf, authErrorResponse, isAdminActor, requireAdmin } from "./context.js";
import { ensureUserHomeDir, isMultiUser } from "./mode.js";
import {
  activeAdminCount,
  createUser,
  dirNameTaken,
  getUser,
  issueInvite,
  listUsers,
  mintToken,
  nameTaken,
  pendingInviteUserIds,
  resumeUser,
  revokeInvitesOf,
  suspendUser,
  toUserView,
  tokenDigest,
  updateUser,
} from "./store.js";
import { initUserCliEnv } from "./user-cli.js";
import {
  addProjectMember,
  explicitProjectAdminCount,
  listProjectMembers,
  removeProjectMember,
  requireProjectAccess,
  requireProjectAdmin,
} from "./visibility.js";

/** 路由体内统一的 403/401 落地。 */
function mapAuthError(error: unknown): { status: 401 | 403; body: { error: string } } {
  const mapped = authErrorResponse(error);
  if (mapped) return mapped;
  throw error;
}

export function mountUserRoutes(api: Hono): void {
  // ── 用户名单 ───────────────────────────────────────────────────────────────
  // **全员可见**(§四):项目管理员邀人时要选人。但只有管理员看得到状态/目录名这些
  // 管理字段,普通用户拿到的是精简版。
  api.get("/users", async (c) => {
    if (!(await isMultiUser())) return c.json([]);
    const actor = actorOf(c);
    const rows = await listUsers();
    if (!isAdminActor(actor)) {
      return c.json(
        rows
          .filter((u) => u.status !== "suspended")
          .map((u) => ({ id: u.id, name: u.name, role: u.role })),
      );
    }
    const pending = await pendingInviteUserIds();
    return c.json(rows.map((u) => toUserView(u, pending.has(u.id))));
  });

  api.post("/users", async (c) => {
    try {
      requireAdmin(actorOf(c));
    } catch (error) {
      const mapped = mapAuthError(error);
      return c.json(mapped.body, mapped.status);
    }
    if (!(await isMultiUser())) return c.json({ error: "自用模式没有用户概念" }, 400);
    const b = await c.req.json<{
      name?: string;
      role?: string;
      dirName?: string;
      gitName?: string;
      gitEmail?: string;
    }>().catch(() => ({} as Record<string, never>));

    const name = (b.name ?? "").trim();
    if (!name) return c.json({ error: "姓名必填" }, 400);
    if (await nameTaken(name)) return c.json({ error: `已经有一个叫「${name}」的用户了` }, 409);
    const dirName = (b.dirName ?? "").trim() || suggestDirName(name);
    const dirError = userDirNameError(dirName);
    if (dirError) return c.json({ error: `目录名不合法：${dirError}` }, 400);
    if (await dirNameTaken(dirName)) return c.json({ error: `目录名「${dirName}」已被占用` }, 409);
    const role: UserRole = b.role === "admin" ? "admin" : "member";

    const user = await createUser({
      name,
      role,
      dirName,
      gitName: (b.gitName ?? "").trim() || name,
      gitEmail: (b.gitEmail ?? "").trim() || suggestGitEmail(name),
      createdBy: actorOf(c).userId,
    });
    // 目录与个人 CLI 环境在**建用户时**就位(§五/§九):等到第一次派任务再建的话,
    // 那一刻的失败会表现成一个莫名其妙的执行错误。
    try {
      await ensureUserHomeDir(user.dirName);
    } catch (error) {
      return c.json({ error: `用户已建，但目录没建出来：${(error as Error).message}` }, 500);
    }
    initUserCliEnv(user.id);
    const token = await issueInvite(user.id, actorOf(c).userId);
    return c.json({ user: toUserView(user, true), inviteUrl: `/claim/${token}` }, 201);
  });

  // 改姓名 / 角色 / git 署名。**目录名不在可改之列**(§七 设定后锁死)。
  api.patch("/users/:id", async (c) => {
    const actor = actorOf(c);
    const target = c.req.param("id");
    const user = await getUser(target);
    if (!user) return c.json({ error: "用户不存在" }, 404);
    const self = actor.userId === target;
    // 本人可以改自己的姓名与 git 署名;角色只有管理员能动。
    if (!self) {
      try {
        requireAdmin(actor);
      } catch (error) {
        const mapped = mapAuthError(error);
        return c.json(mapped.body, mapped.status);
      }
    }
    const b = await c.req.json<{ name?: string; role?: string; gitName?: string; gitEmail?: string; dirName?: string }>()
      .catch(() => ({} as Record<string, never>));
    if (b.dirName !== undefined && b.dirName !== user.dirName) {
      return c.json({ error: "目录名设定后锁死：一改，所有已建项目的路径都会失效。确要改请走文档化的手工迁移步骤" }, 409);
    }
    const patch: Record<string, unknown> = {};
    if (b.name !== undefined) {
      const name = b.name.trim();
      if (!name) return c.json({ error: "姓名不能为空" }, 400);
      if (await nameTaken(name, target)) return c.json({ error: `已经有一个叫「${name}」的用户了` }, 409);
      patch.name = name;
    }
    if (b.gitName !== undefined) patch.gitName = b.gitName.trim();
    if (b.gitEmail !== undefined) patch.gitEmail = b.gitEmail.trim();
    if (b.role !== undefined) {
      if (!isAdminActor(actor)) return c.json({ error: "只有实例管理员可以改角色" }, 403);
      const role: UserRole = b.role === "admin" ? "admin" : "member";
      if (role === "member" && user.role === "admin" && (await activeAdminCount(target)) === 0) {
        return c.json({ error: "这是最后一个管理员，不能降级（降了就没人能管用户和实例设置了）" }, 409);
      }
      patch.role = role;
    }
    if (Object.keys(patch).length) await updateUser(target, patch);
    const updated = await getUser(target);
    return c.json(toUserView(updated!));
  });

  // ── 停用 / 恢复 ───────────────────────────────────────────────────────────
  // 停用 = 断会话 + 停他名下 running/queued 任务 + 暂停他建的日程(§五 B7)。
  // **不做删除** —— 那牵扯归属转移。
  api.post("/users/:id/suspend", async (c) => {
    try {
      requireAdmin(actorOf(c));
    } catch (error) {
      const mapped = mapAuthError(error);
      return c.json(mapped.body, mapped.status);
    }
    const target = c.req.param("id");
    const user = await getUser(target);
    if (!user) return c.json({ error: "用户不存在" }, 404);
    if (target === actorOf(c).userId) return c.json({ error: "不能停用自己" }, 409);
    if (user.role === "admin" && (await activeAdminCount(target)) === 0) {
      return c.json({ error: "这是最后一个可用的管理员，不能停用" }, 409);
    }

    await suspendUser(target);
    await revokeInvitesOf(target);

    // 停任务走**现有 stop 语义**:先真杀进程,杀不到再落状态。只改数据库不停进程是
    // 已知事故模式(`docs/incidents.md`「只改数据库不停进程」)。
    const live = (await db.select().from(tasks).where(eq(tasks.ownerUserId, target)))
      .filter((t) => t.status === "running" || t.status === "queued");
    const stopped: string[] = [];
    for (const task of live) {
      try {
        if (!stopTask(task.id)) await setTaskStatus(task.id, "canceled");
        stopped.push(task.id);
      } catch (e) {
        console.warn(`[ash] 停用 ${target} 时停不掉任务 ${task.id}:`, e);
      }
    }
    // 日程:暂停而不是删除。恢复启用后由本人自行续跑(§五)。
    const activeSchedules = await db
      .select({ id: schedules.id })
      .from(schedules)
      .where(and(eq(schedules.ownerUserId, target), eq(schedules.enabled, true)));
    if (activeSchedules.length) {
      await db
        .update(schedules)
        .set({ enabled: false })
        .where(and(eq(schedules.ownerUserId, target), eq(schedules.enabled, true)));
    }
    return c.json({ ok: true, stoppedTasks: stopped, pausedSchedules: activeSchedules.length });
  });

  // 恢复只恢复「能不能登录」。任务与日程**不自动续跑** —— 由本人自己决定(§五)。
  api.post("/users/:id/resume", async (c) => {
    try {
      requireAdmin(actorOf(c));
    } catch (error) {
      const mapped = mapAuthError(error);
      return c.json(mapped.body, mapped.status);
    }
    const user = await getUser(c.req.param("id"));
    if (!user) return c.json({ error: "用户不存在" }, 404);
    await resumeUser(user.id);
    // 还没领过 key 的人恢复后需要一条新链接才能进来。
    const inviteUrl = user.keyHash ? null : `/claim/${await issueInvite(user.id, actorOf(c).userId)}`;
    return c.json({ ok: true, inviteUrl });
  });

  // 重发/作废专属邀请链接。
  api.post("/users/:id/invite", async (c) => {
    try {
      requireAdmin(actorOf(c));
    } catch (error) {
      const mapped = mapAuthError(error);
      return c.json(mapped.body, mapped.status);
    }
    const user = await getUser(c.req.param("id"));
    if (!user) return c.json({ error: "用户不存在" }, 404);
    const token = await issueInvite(user.id, actorOf(c).userId);
    return c.json({ inviteUrl: `/claim/${token}` });
  });

  api.delete("/users/:id/invite", async (c) => {
    try {
      requireAdmin(actorOf(c));
    } catch (error) {
      const mapped = mapAuthError(error);
      return c.json(mapped.body, mapped.status);
    }
    await revokeInvitesOf(c.req.param("id"));
    return c.json({ revoked: true });
  });

  mountProjectMemberRoutes(api);
}

// ── 项目成员(§六)──────────────────────────────────────────────────────────
function mountProjectMemberRoutes(api: Hono): void {
  api.get("/projects/:id/members", async (c) => {
    const projectId = c.req.param("id");
    try {
      await requireProjectAccess(actorOf(c), projectId);
    } catch (error) {
      const mapped = mapAuthError(error);
      return c.json(mapped.body, mapped.status);
    }
    return c.json(await listProjectMembers(projectId));
  });

  // 选人直加:从实例名单里挑,立即加入,无「接受」步骤(§六)。
  api.post("/projects/:id/members", async (c) => {
    const projectId = c.req.param("id");
    const actor = actorOf(c);
    try {
      await requireProjectAdmin(actor, projectId);
    } catch (error) {
      const mapped = mapAuthError(error);
      return c.json(mapped.body, mapped.status);
    }
    const b = await c.req.json<{ userId?: string; role?: string }>().catch(() => ({} as Record<string, never>));
    const userId = (b.userId ?? "").trim();
    if (!userId) return c.json({ error: "userId required" }, 400);
    const user = await getUser(userId);
    // 「只能邀请实例中已存在的用户」(§六)——不在系统里就明确指路,不静默建号。
    if (!user) return c.json({ error: "这个人不在实例里。找管理员给他开通账号后再邀请" }, 404);
    if (user.status === "suspended") return c.json({ error: "这个账号已被停用" }, 409);
    const role: ProjectRole = b.role === "admin" ? "admin" : "member";
    await addProjectMember({ projectId, userId, role, addedBy: actor.userId });
    return c.json(await listProjectMembers(projectId), 201);
  });

  api.patch("/projects/:id/members/:userId", async (c) => {
    const projectId = c.req.param("id");
    const userId = c.req.param("userId");
    try {
      await requireProjectAdmin(actorOf(c), projectId);
    } catch (error) {
      const mapped = mapAuthError(error);
      return c.json(mapped.body, mapped.status);
    }
    const b = await c.req.json<{ role?: string }>().catch(() => ({} as Record<string, never>));
    const role: ProjectRole = b.role === "admin" ? "admin" : "member";
    if (role === "member" && (await explicitProjectAdminCount(projectId, userId)) === 0) {
      return c.json({ error: "这是项目里最后一个管理员，不能降级" }, 409);
    }
    await addProjectMember({ projectId, userId, role, addedBy: actorOf(c).userId });
    return c.json(await listProjectMembers(projectId));
  });

  // 移除成员;成员也可以自行退出(userId === 自己时只要求可见性)。
  api.delete("/projects/:id/members/:userId", async (c) => {
    const projectId = c.req.param("id");
    const userId = c.req.param("userId");
    const actor = actorOf(c);
    const leaving = actor.userId === userId;
    try {
      if (leaving) await requireProjectAccess(actor, projectId);
      else await requireProjectAdmin(actor, projectId);
    } catch (error) {
      const mapped = mapAuthError(error);
      return c.json(mapped.body, mapped.status);
    }
    if ((await explicitProjectAdminCount(projectId, userId)) === 0) {
      return c.json({ error: "这是项目里最后一个管理员，先指定另一个管理员再退出" }, 409);
    }
    await removeProjectMember(projectId, userId);
    return c.json({ removed: true });
  });

  // ── 项目邀请链接 ──────────────────────────────────────────────────────────
  // 一条链接发群里,多个**已有账号**的人点开即加入。只能发普通成员角色(§六)。
  api.get("/projects/:id/invite", async (c) => {
    const projectId = c.req.param("id");
    try {
      await requireProjectAdmin(actorOf(c), projectId);
    } catch (error) {
      const mapped = mapAuthError(error);
      return c.json(mapped.body, mapped.status);
    }
    const rows = (await db.select().from(projectInvites).where(eq(projectInvites.projectId, projectId)))
      .filter((r) => !r.revokedAt && (!r.expiresAt || Date.parse(r.expiresAt) > Date.now()));
    // token 只在创建那一刻回一次;这里只报「有没有一条活着的」。
    return c.json({ active: rows.length > 0, expiresAt: rows.at(0)?.expiresAt ?? null });
  });

  api.post("/projects/:id/invite", async (c) => {
    const projectId = c.req.param("id");
    const actor = actorOf(c);
    try {
      await requireProjectAdmin(actor, projectId);
    } catch (error) {
      const mapped = mapAuthError(error);
      return c.json(mapped.body, mapped.status);
    }
    const b = await c.req.json<{ days?: number }>().catch(() => ({} as Record<string, never>));
    // 作废旧的:一个项目同时只有一条活链接,免得作废了一条另一条还在群里飘。
    await db
      .update(projectInvites)
      .set({ revokedAt: now() })
      .where(and(eq(projectInvites.projectId, projectId), isNull(projectInvites.revokedAt)));
    const token = mintToken();
    const days = typeof b.days === "number" && b.days > 0 && b.days <= 365 ? Math.round(b.days) : null;
    await db.insert(projectInvites).values({
      id: id(),
      projectId,
      tokenHash: tokenDigest(token),
      createdBy: actor.userId,
      createdAt: now(),
      expiresAt: days ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
      revokedAt: null,
    });
    return c.json({ inviteUrl: `/join/${token}` }, 201);
  });

  api.delete("/projects/:id/invite", async (c) => {
    const projectId = c.req.param("id");
    try {
      await requireProjectAdmin(actorOf(c), projectId);
    } catch (error) {
      const mapped = mapAuthError(error);
      return c.json(mapped.body, mapped.status);
    }
    await db
      .update(projectInvites)
      .set({ revokedAt: now() })
      .where(and(eq(projectInvites.projectId, projectId), isNull(projectInvites.revokedAt)));
    return c.json({ revoked: true });
  });

  // 说明页(未登录也能看)——它只泄露项目名,不泄露内容。
  api.get("/auth/project-invite/:token", async (c) => {
    const row = (
      await db.select().from(projectInvites).where(eq(projectInvites.tokenHash, tokenDigest(c.req.param("token"))))
    ).at(0);
    if (!row) return c.json({ error: "这条邀请链接不存在" }, 404);
    const project = (await db.select().from(projects).where(eq(projects.id, row.projectId))).at(0);
    if (!project) return c.json({ error: "这条邀请对应的项目已经不在了" }, 404);
    const invalid = row.revokedAt
      ? "这条邀请链接已被作废"
      : row.expiresAt && Date.parse(row.expiresAt) <= Date.now()
        ? "这条邀请链接已过期"
        : undefined;
    const info: ProjectInviteInfo = {
      projectId: project.id,
      projectName: project.name,
      role: "member",
      expiresAt: row.expiresAt,
      ...(invalid ? { invalid } : {}),
    };
    return c.json(info);
  });

  // 点「加入」。**必须已登录**(链接只能发给已有账号的人,§六);没登录时前端先引导输 key。
  api.post("/auth/project-invite/:token", async (c) => {
    const actor = actorOf(c);
    if (actor.kind !== "user" || !actor.userId) {
      return c.json({ error: "先用你的 key 登录，再点加入。没有账号请找这台机器的管理员开通", needsAuth: true }, 401);
    }
    const row = (
      await db.select().from(projectInvites).where(eq(projectInvites.tokenHash, tokenDigest(c.req.param("token"))))
    ).at(0);
    if (!row) return c.json({ error: "这条邀请链接不存在" }, 404);
    if (row.revokedAt) return c.json({ error: "这条邀请链接已被作废" }, 409);
    if (row.expiresAt && Date.parse(row.expiresAt) <= Date.now()) {
      return c.json({ error: "这条邀请链接已过期" }, 409);
    }
    await addProjectMember({ projectId: row.projectId, userId: actor.userId, role: "member", addedBy: row.createdBy });
    return c.json({ projectId: row.projectId });
  });
}

/** 删项目时把它的邀请链接一起清掉。 */
export async function deleteProjectInvites(projectId: string): Promise<void> {
  await db.delete(projectInvites).where(eq(projectInvites.projectId, projectId));
}
