import type { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import type { AgentType, TeamPreset, TeamPresetConfig } from "@ash/shared";
import { AGENT_TYPES } from "@ash/shared";
import { db } from "./db/index.js";
import { teamPresets } from "./db/schema.js";
import { id, now } from "./util.js";
import { actorOf } from "./auth/context.js";
import { canUseOwned, filterOwned, notYours, ownerStamp } from "./auth/owned.js";
import { executorScope, profilesOwnedBy, type ExecutorProfileRow, type ExecutorScope } from "./auth/owned-executors.js";

type PresetRow = typeof teamPresets.$inferSelect;
type AgentLabelRow = ExecutorProfileRow;

const CONFIG_STRING_FIELDS = [
  "leadExecutorId",
  "workerExecutorId",
  "leadModel",
  "leadReasoningEffort",
  "workerModel",
  "workerReasoningEffort",
  "reviewerExecutorId",
  "reviewerModel",
  "reviewerReasoningEffort",
] as const;

function isAgentType(value: unknown): value is AgentType {
  return typeof value === "string" && (AGENT_TYPES as readonly string[]).includes(value);
}

function normalizeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name && name.length <= 80 ? name : null;
}

// `scope` 省略 = 只做形状校验(读侧解析存量行)。写侧一律传:预设里的三个 executorId
// 是个人面资源,看不见的 id 归一成 null,别把别人的执行器存进我的预设(第 2 轮审查 P1)。
function normalizeConfig(value: unknown, scope?: ExecutorScope): { config?: TeamPresetConfig; error?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "config 必须是团队配置对象" };
  }
  const raw = value as Record<string, unknown>;
  if (!isAgentType(raw.lead) || !isAgentType(raw.worker)) {
    return { error: "config.lead / config.worker 必须是有效的 agent 类型" };
  }
  if (raw.reviewerAgentType !== undefined && !isAgentType(raw.reviewerAgentType)) {
    return { error: "config.reviewerAgentType 必须是有效的 agent 类型" };
  }
  if (raw.review !== undefined && typeof raw.review !== "boolean") {
    return { error: "config.review 必须是 boolean" };
  }
  for (const field of CONFIG_STRING_FIELDS) {
    const item = raw[field];
    if (item !== undefined && item !== null && typeof item !== "string") {
      return { error: `config.${field} 必须是字符串或 null` };
    }
  }
  const nullable = (field: (typeof CONFIG_STRING_FIELDS)[number]): string | null => {
    const item = raw[field];
    const text = typeof item === "string" && item.trim() ? item.trim() : null;
    return field.endsWith("ExecutorId") && scope ? scope.keep(text) : text;
  };
  return {
    config: {
      lead: raw.lead,
      worker: raw.worker,
      leadExecutorId: nullable("leadExecutorId"),
      workerExecutorId: nullable("workerExecutorId"),
      leadModel: nullable("leadModel"),
      leadReasoningEffort: nullable("leadReasoningEffort"),
      workerModel: nullable("workerModel"),
      workerReasoningEffort: nullable("workerReasoningEffort"),
      review: raw.review !== false,
      reviewerAgentType: isAgentType(raw.reviewerAgentType) ? raw.reviewerAgentType : undefined,
      reviewerExecutorId: nullable("reviewerExecutorId"),
      reviewerModel: nullable("reviewerModel"),
      reviewerReasoningEffort: nullable("reviewerReasoningEffort"),
    },
  };
}

function executorLabelFor(
  profiles: AgentLabelRow[],
  executorId: string | null | undefined,
  type: AgentType,
): string | null {
  const selected = executorId
    ? profiles.find((profile) => profile.id === executorId && profile.type === type)
    : null;
  if (selected) return selected.name;
  const sameType = profiles.filter((profile) => profile.type === type);
  return (sameType.find((profile) => profile.isDefault) ?? sameType[0])?.name ?? null;
}

// label 只在**这条预设归属人**自己的执行器里解析(profilesOwnedBy 顶部写了为什么锚在
// 归属人而不是看客)。默认回退同理 —— 否则 `executorId:null` 会回退出别人的默认执行器名。
function toPreset(row: PresetRow, allProfiles: AgentLabelRow[]): TeamPreset {
  const profiles = profilesOwnedBy(allProfiles, row.ownerUserId);
  const parsed = normalizeConfig(JSON.parse(row.config));
  if (!parsed.config) throw new Error(`team preset ${row.id} config invalid: ${parsed.error}`);
  return {
    id: row.id,
    name: row.name,
    config: {
      ...parsed.config,
      leadExecutorLabel: executorLabelFor(
        profiles,
        parsed.config.leadExecutorId,
        parsed.config.lead,
      ),
      workerExecutorLabel: executorLabelFor(
        profiles,
        parsed.config.workerExecutorId,
        parsed.config.worker,
      ),
      reviewerExecutorLabel: executorLabelFor(
        profiles,
        parsed.config.reviewerExecutorId,
        parsed.config.reviewerAgentType ?? parsed.config.worker,
      ),
    },
    createdAt: row.createdAt,
  };
}

const labelRows = (scope: ExecutorScope): AgentLabelRow[] => scope.rows;

export function mountTeamPresetRoutes(api: Hono): void {
  api.get("/team-presets", async (c) => {
    const [rows, scope] = await Promise.all([
      db.select().from(teamPresets).orderBy(desc(teamPresets.createdAt)),
      executorScope(actorOf(c)),
    ]);
    return c.json((await filterOwned(rows, actorOf(c))).map((row) => toPreset(row, labelRows(scope))));
  });

  api.post("/team-presets", async (c) => {
    const body = await c.req.json<{ name?: unknown; config?: unknown }>();
    const name = normalizeName(body.name);
    if (!name) return c.json({ error: "预设名称必填，且不能超过 80 个字符" }, 400);
    const scope = await executorScope(actorOf(c));
    const parsed = normalizeConfig(body.config, scope);
    if (!parsed.config) return c.json({ error: parsed.error }, 400);
    const row: PresetRow = {
      id: id(),
      name,
      ...ownerStamp(actorOf(c)),
      config: JSON.stringify(parsed.config),
      createdAt: now(),
    };
    await db.insert(teamPresets).values(row);
    return c.json(toPreset(row, labelRows(scope)), 201);
  });

  api.patch("/team-presets/:id", async (c) => {
    const presetId = c.req.param("id");
    const existing = (await db.select().from(teamPresets).where(eq(teamPresets.id, presetId))).at(0);
    if (!(await canUseOwned(existing, actorOf(c)))) return c.json(notYours("预设"), 404);
    const body = await c.req.json<{ name?: unknown; config?: unknown }>();
    const patch: Partial<typeof teamPresets.$inferInsert> = {};
    if (body.name !== undefined) {
      const name = normalizeName(body.name);
      if (!name) return c.json({ error: "预设名称必填，且不能超过 80 个字符" }, 400);
      patch.name = name;
    }
    const scope = await executorScope(actorOf(c));
    if (body.config !== undefined) {
      const parsed = normalizeConfig(body.config, scope);
      if (!parsed.config) return c.json({ error: parsed.error }, 400);
      patch.config = JSON.stringify(parsed.config);
    }
    if (Object.keys(patch).length) {
      await db.update(teamPresets).set(patch).where(eq(teamPresets.id, presetId));
    }
    const updated = (await db.select().from(teamPresets).where(eq(teamPresets.id, presetId))).at(0)!;
    return c.json(toPreset(updated, labelRows(scope)));
  });

  api.delete("/team-presets/:id", async (c) => {
    const presetId = c.req.param("id");
    const existing = (await db.select().from(teamPresets).where(eq(teamPresets.id, presetId))).at(0);
    if (!(await canUseOwned(existing, actorOf(c)))) return c.json(notYours("预设"), 404);
    await db.delete(teamPresets).where(eq(teamPresets.id, presetId));
    return c.json({ deleted: true });
  });
}
