// 「这个人能看见哪些项目」——多人模式所有横切过滤面的单一判据(§十二)。
//
// 三条规则,全在这个文件里:
//  ① 自用模式:一切可见。
//  ② 实例管理员:一切可见,且进任意项目时权限等同项目管理员(§四)。
//  ③ 普通用户:project_members 里有他的那些。
//
// **别在调用点自己拼 SQL** —— 项目切换器、任务列表、搜索、SSE、通知、验收页、随手记
// 全都要过同一份判据;复制一份出去,漏掉的那个面就是横向越权。
import { and, eq, inArray } from "drizzle-orm";
import type { ProjectMemberView, ProjectRole } from "@ash/shared";
import { db } from "../db/index.js";
import { projectMembers, projects, tasks, users } from "../db/schema.js";
import { now } from "../util.js";
import type { Actor } from "./context.js";
import { forbidden, isAdminActor } from "./context.js";
import { isMultiUser } from "./mode.js";

/** null = 不设限(自用模式或实例管理员);Set = 只这些。 */
export async function visibleProjectIds(actor: Actor): Promise<Set<string> | null> {
  if (!(await isMultiUser())) return null;
  if (isAdminActor(actor)) return null;
  if (!actor.userId) return new Set();
  const rows = await db
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, actor.userId));
  return new Set(rows.map((r) => r.projectId));
}

export async function canSeeProject(actor: Actor, projectId: string): Promise<boolean> {
  const visible = await visibleProjectIds(actor);
  return visible === null || visible.has(projectId);
}

/** 这个人看得见的项目行。接力的对端项目清单用它,与本机所有过滤面同一份判据。 */
export async function visibleProjectsFor(actor: Actor): Promise<(typeof projects.$inferSelect)[]> {
  const rows = await db.select().from(projects);
  const visible = await visibleProjectIds(actor);
  return visible === null ? rows : rows.filter((p) => visible.has(p.id));
}

/** 项目里的角色。实例管理员返回 "admin"(隐式);不是成员返回 null。 */
export async function projectRoleOf(actor: Actor, projectId: string): Promise<ProjectRole | null> {
  if (!(await isMultiUser())) return "admin";
  if (isAdminActor(actor)) return "admin";
  if (!actor.userId) return null;
  const row = (
    await db
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, actor.userId)))
  ).at(0);
  if (!row) return null;
  return row.role === "admin" ? "admin" : "member";
}

/** 看得见就放行,否则 403。读型端点的统一入口。 */
export async function requireProjectAccess(actor: Actor, projectId: string): Promise<void> {
  if (!(await canSeeProject(actor, projectId))) {
    throw forbidden("你没有这个项目的权限");
  }
}

/** 项目管理动作(改路径/归档/删除/成员管理)的统一入口。 */
export async function requireProjectAdmin(actor: Actor, projectId: string): Promise<void> {
  if ((await projectRoleOf(actor, projectId)) !== "admin") {
    throw forbidden("只有项目管理员或实例管理员可以做这个操作");
  }
}

/** 批量端点的过滤:把一串 taskId 收窄成「这个人看得见的那些」。 */
export async function visibleTaskIds(actor: Actor, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const visible = await visibleProjectIds(actor);
  if (visible === null) return ids;
  const rows = await db
    .select({ id: tasks.id, projectId: tasks.projectId })
    .from(tasks)
    .where(inArray(tasks.id, ids));
  const ok = new Set(rows.filter((r) => visible.has(r.projectId)).map((r) => r.id));
  return ids.filter((taskId) => ok.has(taskId));
}

/** 任务可见性跟项目走(§八):看得见项目就看得见任务。 */
export async function requireTaskAccess(actor: Actor, taskId: string): Promise<void> {
  if (!(await isMultiUser())) return;
  const row = (await db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  // 任务不存在时不在这里报 404 —— 让业务路由自己去报,它的文案更准。
  if (!row) return;
  await requireProjectAccess(actor, row.projectId);
}

// ── 成员表读写 ──────────────────────────────────────────────────────────────

export async function addProjectMember(input: {
  projectId: string;
  userId: string;
  role: ProjectRole;
  addedBy: string | null;
}): Promise<void> {
  await db
    .insert(projectMembers)
    .values({
      projectId: input.projectId,
      userId: input.userId,
      role: input.role,
      addedBy: input.addedBy,
      addedAt: now(),
    })
    .onConflictDoUpdate({
      target: [projectMembers.projectId, projectMembers.userId],
      set: { role: input.role },
    });
}

export async function removeProjectMember(projectId: string, userId: string): Promise<void> {
  await db
    .delete(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
}

export async function listProjectMembers(projectId: string): Promise<ProjectMemberView[]> {
  const rows = await db.select().from(projectMembers).where(eq(projectMembers.projectId, projectId));
  const all = await db.select().from(users);
  const byId = new Map(all.map((u) => [u.id, u]));
  const list: ProjectMemberView[] = rows.map((r) => ({
    projectId: r.projectId,
    userId: r.userId,
    name: byId.get(r.userId)?.name ?? "(已删除)",
    role: r.role === "admin" ? "admin" : "member",
    addedAt: r.addedAt,
  }));
  // 实例管理员不在表里却对所有项目有管理员权限(§四)。名单上不显示它们会让人以为
  // 「这个项目没人管」,所以补一行标 implicit —— 但不能移除、不能改角色。
  const explicit = new Set(rows.map((r) => r.userId));
  for (const u of all) {
    if (u.role !== "admin" || explicit.has(u.id) || u.status === "suspended") continue;
    list.push({
      projectId,
      userId: u.id,
      name: u.name,
      role: "admin",
      implicit: true,
      addedAt: u.createdAt,
    });
  }
  return list.sort((a, b) => Number(!!a.implicit) - Number(!!b.implicit) || a.name.localeCompare(b.name));
}

/** 项目最后一个显式管理员不能被移除/降级 —— 否则只剩实例管理员进得去。 */
export async function explicitProjectAdminCount(projectId: string, exceptUserId?: string): Promise<number> {
  const rows = await db.select().from(projectMembers).where(eq(projectMembers.projectId, projectId));
  return rows.filter((r) => r.role === "admin" && r.userId !== exceptUserId).length;
}

/** 建项目时把创建者登记成项目管理员。自用模式无操作。 */
export async function seedProjectOwner(projectId: string, actor: Actor): Promise<void> {
  if (!(await isMultiUser()) || !actor.userId) return;
  await addProjectMember({ projectId, userId: actor.userId, role: "admin", addedBy: actor.userId });
}

/** 删项目时连成员行一起清。 */
export async function deleteProjectMembers(projectId: string): Promise<void> {
  await db.delete(projectMembers).where(eq(projectMembers.projectId, projectId));
}

/** 某个项目还在不在(过滤前先确认,免得报错文案说成「没权限」)。 */
export async function projectExists(projectId: string): Promise<boolean> {
  return !!(await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId))).at(0);
}
