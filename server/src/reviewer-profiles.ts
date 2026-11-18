import type { AgentType, ReviewerProfile } from "@ash/shared";
import { AGENT_TYPES } from "@ash/shared";
import { and, desc, eq, isNotNull, isNull, type SQL } from "drizzle-orm";
import type { Hono } from "hono";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { agents, freeWorkflowStates, reviewerProfiles } from "./db/schema.js";
import { appendTaskTimeline, alertLine } from "./task-timeline.js";
import { id, now } from "./util.js";
import { actorOf, ownerIdOf, type Actor } from "./auth/context.js";
import { canUseOwned, filterOwned, notYours, ownerStamp } from "./auth/owned.js";
import { executorScope, type ExecutorScope } from "./auth/owned-executors.js";

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

// 执行器是个人面资源(§八):**看不见的等同于不存在**,所以这里连措辞都不用改 ——
// 别人的 id 和悬空 id 一样报「所选执行器不存在」,两者对外不可区分(能区分就能枚举)。
function validateExecutor(scope: ExecutorScope, executorId: string | null, type: AgentType): void {
  if (!executorId) return;
  const actual = scope.typeOf(executorId);
  if (!actual) throw new Error("所选执行器不存在");
  if (actual !== type) throw new Error(`所选执行器属于 ${actual}，与 ${type} 不匹配`);
}

// executorLabel 只在**这条审查者配置归属人**自己的执行器里解析(理由见
// auth/owned-executors.ts `profilesOwnedBy`)。
async function toProfile(row: ReviewerRow): Promise<ReviewerProfile> {
  const selected = row.executorId
    ? (await db.select({ name: agents.name, ownerUserId: agents.ownerUserId })
        .from(agents).where(eq(agents.id, row.executorId))).at(0)
    : null;
  const label = selected && selected.ownerUserId === row.ownerUserId ? selected.name : null;
  return {
    id: row.id,
    name: row.name,
    agentType: row.agentType as AgentType,
    executorId: row.executorId,
    executorLabel: label,
    model: row.model,
    reasoningEffort: row.reasoningEffort,
    isDefault: !!row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function parseBody(scope: ExecutorScope, body: Record<string, unknown>, existing?: ReviewerRow) {
  const type = body.agentType === undefined ? existing?.agentType as AgentType : agentType(body.agentType);
  if (!type) throw new Error("智能体类型必填");
  const executorId = body.executorId === undefined ? existing?.executorId ?? null : text(body.executorId, 100);
  validateExecutor(scope, executorId, type);
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

/** 同一个归属人的那几行（自用模式下归属全是 NULL）。 */
export function ownedBy(owner: string | null): SQL {
  return owner === null ? isNull(reviewerProfiles.ownerUserId) : eq(reviewerProfiles.ownerUserId, owner);
}

/**
 * 设 / 取消默认审查者（shared/src/review-on-create.ts）。只认**自己名下**的那一位：默认是按归属人分的，
 * 实例管理员看得见的无主行不是他的，设成默认等于替「没有人」设了一位。先清后设同一笔事务，至多一位由
 * 部分唯一索引兜底（db/index.ts）。不碰 updatedAt：列表按它排，点一下星标不该让这一行跳到最前。
 */
async function setDefaultReviewer(row: ReviewerRow, on: boolean, actor: Actor): Promise<void> {
  if (row.ownerUserId !== ownerIdOf(actor)) throw new Error("只能把自己的审查者设为默认");
  await db.transaction(async (tx) => {
    if (on) await tx.update(reviewerProfiles).set({ isDefault: false }).where(and(ownedBy(row.ownerUserId), eq(reviewerProfiles.isDefault, true)));
    await tx.update(reviewerProfiles).set({ isDefault: on }).where(eq(reviewerProfiles.id, row.id));
  });
}

export function mountReviewerProfileRoutes(api: Hono): void {
  // 审查者是**个人面**资源(§八):多人模式下各人只看得到自己那份。
  api.get("/reviewer-profiles", async (c) => {
    const rows = await db.select().from(reviewerProfiles).orderBy(desc(reviewerProfiles.updatedAt));
    return c.json(await Promise.all((await filterOwned(rows, actorOf(c))).map(toProfile)));
  });

  api.post("/reviewer-profiles", async (c) => {
    try {
      const scope = await executorScope(actorOf(c));
      const data = await parseBody(scope, await c.req.json<Record<string, unknown>>());
      const at = now();
      const row: ReviewerRow = { id: id(), ...data, ...ownerStamp(actorOf(c)), isDefault: false, createdAt: at, updatedAt: at };
      await db.insert(reviewerProfiles).values(row);
      return c.json(await toProfile(row), 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  api.patch("/reviewer-profiles/:id", async (c) => {
    const profileId = c.req.param("id");
    const existing = (await db.select().from(reviewerProfiles).where(eq(reviewerProfiles.id, profileId))).at(0);
    if (!(await canUseOwned(existing, actorOf(c)))) return c.json(notYours("审查者"), 404);
    try {
      const body = await c.req.json<Record<string, unknown>>();
      const { isDefault, ...fields } = body;
      if (isDefault !== undefined && typeof isDefault !== "boolean") throw new Error("isDefault 要是布尔值");
      if (Object.keys(fields).length) {
        const scope = await executorScope(actorOf(c));
        const data = await parseBody(scope, fields, existing);
        await db.update(reviewerProfiles).set({ ...data, updatedAt: now() }).where(eq(reviewerProfiles.id, profileId));
      }
      if (isDefault !== undefined) await setDefaultReviewer(existing!, isDefault, actorOf(c));
      const updated = (await db.select().from(reviewerProfiles).where(eq(reviewerProfiles.id, profileId))).at(0)!;
      return c.json(await toProfile(updated));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  api.delete("/reviewer-profiles/:id", async (c) => {
    const profileId = c.req.param("id");
    const existing = (await db.select().from(reviewerProfiles).where(eq(reviewerProfiles.id, profileId))).at(0);
    if (!(await canUseOwned(existing, actorOf(c)))) return c.json(notYours("审查者"), 404);
    // 先摘掉引用再删配置。两种预约分开处理：
    // - 手动预约（reviewRunId 空）依赖 profile 配置 → 必须 disarm，否则 UI 仍显示
    //   「已预约」而结算因 reviewerId 为空静默不派审。
    // - 自动续轮（reviewRunId 非空）的配置已冻结在 run 行快照，profile 删了照样能续
    //   → 只清 selectedReviewerId 引用，armed 和 runId 保留。
    // 摘引用和删行同一笔：中间要是空着，正在建的任务（review-on-create.ts，它在自己那笔事务里核这位还在不在）
    // 能在「摘完、还没删」那一拍挂上这位的新预约，删完就成了指向不存在审查者的预约。
    const affected = await db.transaction(async (tx) => {
      const rows = await tx.select({
        taskId: freeWorkflowStates.taskId,
        reviewArmed: freeWorkflowStates.reviewArmed,
        reviewRunId: freeWorkflowStates.reviewRunId,
      }).from(freeWorkflowStates).where(eq(freeWorkflowStates.selectedReviewerId, profileId));
      const at = now();
      await tx.update(freeWorkflowStates).set({
        selectedReviewerId: null,
        reviewArmed: false,
        reviewNote: null,
        reviewSource: null,
        // 覆盖是「相对这位审查者的这一次改动」，审查者没了它就没有参照系，跟着预约一起清。
        reviewAgentType: null,
        reviewExecutorId: null,
        reviewModel: null,
        reviewReasoningEffort: null,
        updatedAt: at,
      }).where(and(eq(freeWorkflowStates.selectedReviewerId, profileId), isNull(freeWorkflowStates.reviewRunId)));
      await tx.update(freeWorkflowStates).set({
        selectedReviewerId: null,
        updatedAt: at,
      }).where(and(eq(freeWorkflowStates.selectedReviewerId, profileId), isNotNull(freeWorkflowStates.reviewRunId)));
      await tx.delete(reviewerProfiles).where(eq(reviewerProfiles.id, profileId));
      return rows;
    }, { behavior: "immediate" });
    for (const row of affected) {
      if (!row.reviewArmed || row.reviewRunId) continue;
      await appendTaskTimeline(row.taskId, alertLine("完成后审查预约已取消：所选审查者配置已被删除。"));
      bus.publish({ type: "task.review", taskId: row.taskId });
    }
    return c.json({ deleted: true });
  });
}
