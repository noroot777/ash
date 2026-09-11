import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { AGENT_TYPES } from "@ash/shared";
import type { ChatMember } from "@ash/shared/chat";
import { isAllMention } from "@ash/shared/chat";
import { db } from "../db/index.js";
import { agents, chatRooms, projects, tasks } from "../db/schema.js";
import { actorOf, isAccountHolder } from "../auth/context.js";
import { canSeeProject } from "../auth/visibility.js";
import { canUseOwned, filterOwned } from "../auth/owned.js";
import { id } from "../util.js";
import type { RoomRow } from "./service.js";

export async function visibleRoom(c: Context): Promise<RoomRow | undefined> {
  const actor = actorOf(c);
  if (!isAccountHolder(actor)) return;
  const row = (await db.select().from(chatRooms).where(eq(chatRooms.id, c.req.param("roomId")!))).at(0);
  if (row?.kind === "side") {
    const parent = row.parentTaskId ? (await db.select().from(tasks).where(eq(tasks.id, row.parentTaskId))).at(0) : undefined;
    if (!parent || parent.projectId !== row.projectId) return;
  }
  if (row && await canUseOwned(row, actor) && ((row.kind === "assistant" && !row.projectId) || await visibleProject(c, row.projectId))) return row;
}

export async function visibleProject(c: Context, projectId: string) {
  return await canSeeProject(actorOf(c), projectId) && (await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId))).length > 0;
}

export function isHumanRequest(c: Context) {
  return isAccountHolder(actorOf(c)) && !c.req.header("x-ash-source-task-id") && !c.req.header("x-ash-turn-token");
}

/** 成员 + 执行器的组合键。用 JSON 拼，免得分隔符和 id / 类型里的字符撞上。 */
const executorKey = (memberId: string, agentType: unknown, executorId: string) => JSON.stringify([memberId, agentType, executorId]);

/**
 * 校验一份成员配置。`existing` 是这个群当前已经存下来的成员：**已经存在的那一条不再重新
 * 体检执行器**——profile 被删之后，用户只想改个群名也会连带提交这份陈旧成员，严格校验会
 * 把改名一起 400 掉。新填进来的执行器仍然照常校验，运行时也仍有 `invokeChat` 那道闸
 * （执行器没了会明说「请在群成员配置中重新选择」），所以放行存量不会让活跑到别人的
 * profile 上。
 */
export async function parseMembers(value: unknown, c: Context, existing: ChatMember[] = []): Promise<ChatMember[]> {
  if (!Array.isArray(value) || !value.length || value.length > 24) throw new Error("请选择 1–24 位成员。");
  const profiles = await filterOwned(await db.select().from(agents), actorOf(c));
  const grandfathered = new Set(existing.flatMap((member) => member.executorId ? [executorKey(member.id, member.agentType, member.executorId)] : []));
  const names = new Set<string>();
  const ids = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object") throw new Error("成员配置无效。");
    const raw = entry as Record<string, unknown>;
    if (typeof raw.name !== "string" || !/^[\p{L}\p{N}_·.-]{1,32}$/u.test(raw.name) || names.has(raw.name)) throw new Error("成员名须唯一，限 32 字，不含空格或 @。");
    if (isAllMention(raw.name)) throw new Error("「all / 所有人」是召唤全体成员的保留名，请换一个成员名。");
    if (!AGENT_TYPES.includes(raw.agentType as ChatMember["agentType"])) throw new Error("请选择有效的智能体。");
    const executorId = typeof raw.executorId === "string" && raw.executorId ? raw.executorId : null;
    const memberId = typeof raw.id === "string" && /^[\w-]{1,80}$/u.test(raw.id) ? raw.id : id();
    if (executorId && !profiles.some((profile) => profile.id === executorId && profile.type === raw.agentType)
      && !grandfathered.has(executorKey(memberId, raw.agentType, executorId))) throw new Error("所选执行器不存在或类型不匹配。");
    for (const field of ["model", "reasoningEffort"] as const) {
      if (raw[field] != null && (typeof raw[field] !== "string" || raw[field].length > 200)) throw new Error("模型或智能水平无效。");
    }
    if (ids.has(memberId)) throw new Error("成员编号重复。");
    names.add(raw.name);
    ids.add(memberId);
    return { id: memberId, name: raw.name, agentType: raw.agentType as ChatMember["agentType"], executorId, model: raw.model as string || null, reasoningEffort: raw.reasoningEffort as string || null };
  });
}

