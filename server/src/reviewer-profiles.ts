import type { AgentType, ReviewerProfile } from "@harness/shared";
import { AGENT_TYPES } from "@harness/shared";
import { desc, eq } from "drizzle-orm";
import type { Hono } from "hono";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { agents, freeWorkflowStates, reviewerProfiles } from "./db/schema.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { id, now } from "./util.js";

type ReviewerRow = typeof reviewerProfiles.$inferSelect;

function text(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("字段必须是字符串或 null");
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > max) throw new Error(`字段不能超过 ${max} 个字符`);
  return normalized;
}

function name(value: unknown): string {
  const normalized = text(value, 80);
  if (!normalized) throw new Error("审查者名称必填");
  return normalized;
}

function agentType(value: unknown): AgentType {
  if (typeof value !== "string" || !(AGENT_TYPES as readonly string[]).includes(value)) {
    throw new Error("智能体类型无效");
  }
  return value as AgentType;
}

async function validateExecutor(executorId: string | null, type: AgentType): Promise<void> {
  if (!executorId) return;
  const profile = (await db.select({ type: agents.type }).from(agents).where(eq(agents.id, executorId))).at(0);
  if (!profile) throw new Error("所选执行器不存在");
  if (profile.type !== type) throw new Error(`所选执行器属于 ${profile.type}，与 ${type} 不匹配`);
}

async function toProfile(row: ReviewerRow): Promise<ReviewerProfile> {
  const selected = row.executorId
    ? (await db.select({ name: agents.name }).from(agents).where(eq(agents.id, row.executorId))).at(0)
    : null;
  return {
    id: row.id,
    name: row.name,
    agentType: row.agentType as AgentType,
    executorId: row.executorId,
    executorLabel: selected?.name ?? null,
    model: row.model,
    reasoningEffort: row.reasoningEffort,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function parseBody(body: Record<string, unknown>, existing?: ReviewerRow) {
  const type = body.agentType === undefined ? existing?.agentType as AgentType : agentType(body.agentType);
  if (!type) throw new Error("智能体类型必填");
  const executorId = body.executorId === undefined ? existing?.executorId ?? null : text(body.executorId, 100);
  await validateExecutor(executorId, type);
  return {
    name: body.name === undefined && existing ? existing.name : name(body.name),
    agentType: type,
    executorId,
    model: body.model === undefined ? existing?.model ?? null : text(body.model, 160),
    reasoningEffort: body.reasoningEffort === undefined
      ? existing?.reasoningEffort ?? null
      : text(body.reasoningEffort, 60),
  };
}

export function mountReviewerProfileRoutes(api: Hono): void {
  api.get("/reviewer-profiles", async (c) => {
    const rows = await db.select().from(reviewerProfiles).orderBy(desc(reviewerProfiles.updatedAt));
    return c.json(await Promise.all(rows.map(toProfile)));
  });

  api.post("/reviewer-profiles", async (c) => {
    try {
      const data = await parseBody(await c.req.json<Record<string, unknown>>());
      const at = now();
      const row: ReviewerRow = { id: id(), ...data, createdAt: at, updatedAt: at };
      await db.insert(reviewerProfiles).values(row);
      return c.json(await toProfile(row), 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  api.patch("/reviewer-profiles/:id", async (c) => {
    const profileId = c.req.param("id");
    const existing = (await db.select().from(reviewerProfiles).where(eq(reviewerProfiles.id, profileId))).at(0);
    if (!existing) return c.json({ error: "审查者不存在" }, 404);
    try {
      const data = await parseBody(await c.req.json<Record<string, unknown>>(), existing);
      await db.update(reviewerProfiles).set({ ...data, updatedAt: now() }).where(eq(reviewerProfiles.id, profileId));
      const updated = (await db.select().from(reviewerProfiles).where(eq(reviewerProfiles.id, profileId))).at(0)!;
      return c.json(await toProfile(updated));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  api.delete("/reviewer-profiles/:id", async (c) => {
    const profileId = c.req.param("id");
    const existing = (await db.select({ id: reviewerProfiles.id }).from(reviewerProfiles).where(eq(reviewerProfiles.id, profileId))).at(0);
    if (!existing) return c.json({ error: "审查者不存在" }, 404);
    // 先摘掉引用再删配置：预约态必须同步 disarm，否则 UI 仍显示「已预约」而结算因 reviewerId 为空静默不派审。
    const affected = await db.select({
      taskId: freeWorkflowStates.taskId,
      reviewArmed: freeWorkflowStates.reviewArmed,
    }).from(freeWorkflowStates).where(eq(freeWorkflowStates.selectedReviewerId, profileId));
    const at = now();
    await db.update(freeWorkflowStates).set({
      selectedReviewerId: null,
      reviewArmed: false,
      reviewNote: null,
      updatedAt: at,
    }).where(eq(freeWorkflowStates.selectedReviewerId, profileId));
    await db.delete(reviewerProfiles).where(eq(reviewerProfiles.id, profileId));
    for (const row of affected) {
      if (!row.reviewArmed) continue;
      await appendTaskTimeline(row.taskId, "完成后审查预约已取消：所选审查者配置已被删除。");
      bus.publish({ type: "task.review", taskId: row.taskId });
    }
    return c.json({ deleted: true });
  });
}
