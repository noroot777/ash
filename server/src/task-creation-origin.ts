import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, eq, isNull } from "drizzle-orm";
import type { TaskCreationOrigin } from "@ash/shared/task-origin";
import { db } from "./db/index.js";
import { sessions, tasks } from "./db/schema.js";
import { actorOf } from "./auth/context.js";
import { canSeeProject } from "./auth/visibility.js";

export async function agentTaskCreationOrigin(taskId: string): Promise<string> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  const active = await db.select().from(sessions).where(and(eq(sessions.taskId, taskId), isNull(sessions.endedAt)));
  const candidates = task?.mode === "team" ? active.filter(s => s.role === "lead") : active;
  const session = candidates.length === 1 ? candidates[0] : undefined;
  const origin: TaskCreationOrigin = {
    kind: "agent", taskId, ...(task ? { taskTitle: task.title } : {}),
    ...(session ? { agentType: session.agentType, executorLabel: session.executor } : {}),
  };
  return JSON.stringify(origin);
}

// 创建来源记录调用方；worktreeBase / originTaskId 只表示代码和任务的关系。
export async function requestTaskCreationOrigin(c: Context): Promise<string> {
  const actor = actorOf(c);
  const sourceId = actor.kind === "agent" ? actor.taskId : c.req.header("x-ash-source-task-id")?.trim();
  if (!sourceId) return JSON.stringify({ kind: c.req.header("x-ash-client") === "mcp" ? "agent" : "user" });
  const source = (await db.select().from(tasks).where(eq(tasks.id, sourceId))).at(0);
  if (!source || !(await canSeeProject(actor, source.projectId))) throw new HTTPException(404, { res: Response.json({ error: "来源任务不存在" }, { status: 404 }) });
  const token = c.req.header("x-ash-turn-token")?.trim();
  const valid = actor.kind === "agent" || (source.activeTurnToken
    ? token === source.activeTurnToken
    : source.mode === "team" && ["running", "idle"].includes(source.status));
  if (!valid) throw new HTTPException(409, { res: Response.json({ error: "创建来源的回合身份已过期，请由当前智能体重试" }, { status: 409 }) });
  return agentTaskCreationOrigin(sourceId);
}
