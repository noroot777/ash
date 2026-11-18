// 可以派出去的活的三个端点（逻辑在 dispatch-suggestion.ts / dispatch-suggestion-launch.ts）：
//   POST   /tasks/:id/dispatch-suggestions          智能体挂（MCP suggest_dispatch），跟派活单同一套回合与方向身份核对；不停任务
//   DELETE /tasks/:id/dispatch-suggestions/:sid     用户点了叉：这一件不派
//   POST   /tasks/:id/dispatch-suggestions/launch   用户按「派出去」：照那一行此刻的样子建任务，这条任务的智能体不被叫醒
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { publicSuggestions, type DispatchSuggestionLaunchInput } from "@ash/shared/dispatch-suggestion";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { executorScopeForOwner } from "./auth/owned-executors.js";
import { handoffBlockReason } from "./handoff-guard.js";
import { turnIdentity } from "./turn-lock.js";
import { publishTaskUpdated } from "./task-store.js";
import { normalizeSuggestions, suggestionRoomError, updateSuggestions, withoutSuggestions } from "./dispatch-suggestion.js";
import { launchSuggestions, normalizeSuggestionLaunch } from "./dispatch-suggestion-launch.js";

export function mountDispatchSuggestionRoutes(api: Hono): void {
api.post("/tasks/:id/dispatch-suggestions", async (c) => {
  const taskId = c.req.param("id");
  const b = await c.req.json<{ tasks?: unknown }>().catch(() => ({}) as { tasks?: unknown });
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  // 派出去的任务收在这条名下：只有普通的独立任务能挂（团队、讨论、团队执行者各有各的归属）。
  if (r.mode !== "single" || r.parentId) return c.json({ error: "只有普通任务能挂可以派出去的活" }, 409);
  if (r.status !== "running") return c.json({ error: "只能在任务正在运行时挂", status: r.status }, 409);
  const token = c.req.header("x-ash-turn-token");
  if (r.activeTurnToken && token !== r.activeTurnToken) {
    return c.json({ error: token ? "来自已结束的回合，已拒绝写入" : "MCP 未携带当前回合身份，已拒绝写入" }, 409);
  }
  const direction = c.req.header("x-ash-direction-token");
  if (r.activeDirectionToken && direction !== r.activeDirectionToken) {
    return c.json({ error: direction
      ? "方向身份已过期；请从最新用户消息的【当前方向身份】复制 directionToken 后重试"
      : "MCP 未携带当前方向身份（请传当前消息附带的 directionToken），已拒绝写入" }, 409);
  }
  // 只有这条任务自己的执行回合能挂：审查、就地验证、讨论的一段、计划模式、原生命令都是旁路（role 不是 single），
  // `@` 别人来问一句时这一轮的执行器不是任务自己的。
  const turn = turnIdentity(taskId);
  if (turn && turn.role !== "single") return c.json({ error: "这是审查、讨论或其他旁路回合，不能挂可以派出去的活" }, 409);
  if (turn?.agent && r.agentType && turn.agent !== r.agentType) {
    return c.json({ error: "这一轮是被叫来问一句的，不能挂可以派出去的活" }, 409);
  }
  const items = normalizeSuggestions(b, await executorScopeForOwner(r.ownerUserId), r.activeTurnToken);
  if ("error" in items) return c.json({ error: items.error }, 400);
  let room: string | null = null;
  const written = await updateSuggestions(taskId, (current) => {
    room = suggestionRoomError(current.length, items.length);
    return room ? null : [...current, ...items];
  });
  if (room) return c.json({ error: room }, 409);
  if (!written) return c.json({ error: "not found" }, 404);
  await publishTaskUpdated(taskId);
  return c.json({
    suggested: items.length, ids: items.map((item) => item.id),
    next: "已挂在回复框顶上，用户一按就派。照常往下做、照常结束本回合；不要再自己建这几条任务",
  });
});

api.delete("/tasks/:id/dispatch-suggestions/:sid", async (c) => {
  const taskId = c.req.param("id");
  const task = (await db.select({ id: tasks.id, archived: tasks.archived }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return c.json({ error: "not found" }, 404);
  const drop = withoutSuggestions([c.req.param("sid")]);
  const written = await updateSuggestions(taskId, drop.change);
  // 已经不在了（刚派掉、回合结束刚收掉）就当收掉了：用户要的结果本来就是它不在。
  const updated = written ? await publishTaskUpdated(taskId) : null;
  return c.json({ dropped: !!written, suggestions: updated?.dispatchSuggestions ?? publicSuggestions([]) });
});

api.post("/tasks/:id/dispatch-suggestions/launch", async (c) => {
  const taskId = c.req.param("id");
  const b = await c.req.json<Partial<DispatchSuggestionLaunchInput>>().catch(() => ({}) as Partial<DispatchSuggestionLaunchInput>);
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return c.json({ error: "not found" }, 404);
  if (task.archived) return c.json({ error: "任务已归档，先取消归档再派", archived: true }, 409);
  const blocked = handoffBlockReason(task.handoff);
  if (blocked) return c.json({ error: blocked, handoff: true }, 409);
  if (task.mode !== "single" || task.parentId) return c.json({ error: "只有普通任务能派出可以派出去的活" }, 409);
  const launch = normalizeSuggestionLaunch(b, await executorScopeForOwner(task.ownerUserId));
  if ("error" in launch) return c.json({ error: launch.error }, 400);
  const result = await launchSuggestions(c, task, launch);
  return c.json(result.body, result.status);
});
}
