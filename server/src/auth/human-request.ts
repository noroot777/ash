import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { actorOf, isAccountHolder } from "./context.js";
import { crossSiteRejection } from "./middleware.js";
import { canSeeProject } from "./visibility.js";
import { db } from "../db/index.js";
import { tasks } from "../db/schema.js";
import { noteRejectedUserAction } from "../user-action-rejection.js";

export const AGENT_HUMAN_ONLY_REFUSAL =
  "这个动作只有账号本人按得动：它解除的是回合互斥，系统判不了原来那一位死没死才交给人来判，"
  + "回合凭证不能代替用户知情同意";

export function humanRequestRejection(context: Context): string | null {
  if (!isAccountHolder(actorOf(context)) || context.req.header("x-ash-source-task-id") !== undefined
    || context.req.header("x-ash-turn-token") !== undefined) return AGENT_HUMAN_ONLY_REFUSAL;
  return crossSiteRejection({
    secFetchSite: context.req.header("sec-fetch-site"), origin: context.req.header("origin"), host: new URL(context.req.url).host,
  });
}

export async function rejectHumanRequest(context: Context, error: string): Promise<Response> {
  const match = /^\/api\/tasks\/([^/]+)\/reclaim-turn(?:\/approval)?$/.exec(context.req.path);
  if (!match) return context.json({ error }, 403);
  const taskId = decodeURIComponent(match[1]!);
  const task = (await db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (task && await canSeeProject(actorOf(context), task.projectId)) {
    await noteRejectedUserAction(taskId, context.req.path.endsWith("/approval") ? "申请人工授权" : "放开回合占位", error);
  }
  return context.json({ error }, 403);
}
