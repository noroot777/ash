// 可以派出去的活的三个端点（逻辑在 dispatch-suggestion.ts / dispatch-suggestion-launch.ts）：
//   POST   /tasks/:id/dispatch-suggestions          智能体挂、收回（MCP suggest_dispatch），跟派活单同一套回合与方向身份核对；不停任务
//   DELETE /tasks/:id/dispatch-suggestions/:sid     用户点了叉：这一件不派
//   POST   /tasks/:id/dispatch-suggestions/launch   用户按「派出去」：照那一行此刻的样子建任务，这条任务的智能体不被叫醒
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { publicSuggestions, type DispatchSuggestionLaunchInput } from "@ash/shared/dispatch-suggestion";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { actorOf, ownerIdOf } from "./auth/context.js";
import { executorScopeForOwner } from "./auth/owned-executors.js";
import { handoffBlockReason } from "./handoff-guard.js";
import { turnIdentity } from "./turn-lock.js";
import { publishTaskUpdated } from "./task-store.js";
import {
  agentChange, normalizeSuggestions, normalizeWithdrawals, turnWriteGuard, updateSuggestions, withoutSuggestions,
  type AgentSuggestionChange,
} from "./dispatch-suggestion.js";
import { launchSuggestions, normalizeSuggestionLaunch } from "./dispatch-suggestion-launch.js";

export function mountDispatchSuggestionRoutes(api: Hono): void {
api.post("/tasks/:id/dispatch-suggestions", async (c) => {
  const taskId = c.req.param("id");
  const b = await c.req.json<{ tasks?: unknown; withdraw?: unknown }>().catch(() => ({}) as { tasks?: unknown; withdraw?: unknown });
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  // 派出去的任务收在这条名下：只有普通的独立任务能挂（团队、讨论、团队执行者各有各的归属）。
  if (r.mode !== "single" || r.parentId) return c.json({ error: "只有普通任务能挂可以派出去的活" }, 409);
  if (r.status !== "running") return c.json({ error: "只能在任务正在运行时挂或收回", status: r.status }, 409);
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
  // 只有这条任务自己的执行回合能挂、能收回：审查、就地验证、讨论的一段、计划模式、原生命令都是旁路（role 不是
  // single），`@` 别人来问一句时这一轮的执行器不是任务自己的——它们既挂不上，也动不了已经挂着的。
  const turn = turnIdentity(taskId);
  if (turn && turn.role !== "single") return c.json({ error: "这是审查、讨论或其他旁路回合，不能挂或收回可以派出去的活" }, 409);
  if (turn?.agent && r.agentType && turn.agent !== r.agentType) {
    return c.json({ error: "这一轮是被叫来问一句的，不能挂或收回可以派出去的活" }, 409);
  }
  const adding = normalizeSuggestions(b, await executorScopeForOwner(r.ownerUserId));
  if ("error" in adding) return c.json({ error: adding.error }, 400);
  const withdrawing = normalizeWithdrawals(b);
  if ("error" in withdrawing) return c.json({ error: withdrawing.error }, 400);
  if (!adding.length && !withdrawing.length) return c.json({ error: "tasks（要挂的）和 withdraw（要收回的）至少给一样" }, 400);
  let change = null as AgentSuggestionChange | null;
  // 收回的那几件和各自的原因同一条更新落库（dispatch-suggestion.ts）：框顶那一行不见了，原因就一定读得到。
  // 写不进去（原因接不到收回记录后面、被同时改了太多次）就是整笔没落：如实告诉智能体，别让它以为收回了。
  const written = await updateSuggestions(taskId, (current) => {
    change = agentChange(current, withdrawing, adding);
    return change.room ? null : change.after;
  }, db, turnWriteGuard(r), () => change?.withdrawn ?? []).catch((error: unknown) => {
    console.error(`[ash] 可以派出去的活没能写进去 task=${taskId}:`, error instanceof Error ? error.message : error);
    return "failed" as const;
  });
  if (written === "failed") return c.json({ error: "没能写进去，这一笔一样都没落：要收回的还挂着，要挂的没挂上" }, 500);
  if (change?.room) return c.json({ error: change.room }, 409);
  // 入口核过之后、写进去之前，任务停了、回合结束了或用户换了方向：这一批是旧方向下的，不落。
  if (!written || !change) return c.json({ error: "这一轮的回合或方向已经变了（任务停了、回合结束了或用户补了新要求），已拒绝写入" }, 409);
  const { added, withdrawn, gone, already, after } = change;
  await publishTaskUpdated(taskId);
  const next = [
    added.length && "新挂的在回复框顶上，会一直留到用户派掉或点叉，之后的回合不用重挂；照常往下做、照常结束本回合，不要再自己建这几条任务",
    already.length && `${already.map((item) => `「${item.title}」`).join("")}已经挂着、用户还没处理，这次没有重挂；要换说明就在同一次调用里先 withdraw 那一件再挂`,
    withdrawn.length && "收回的已经从回复框顶上拿掉，你写的原因用户在会话里看得到",
    gone.length && "gone 里那几件已经不在了（用户派掉或叉掉了），不用再收回",
  ].filter(Boolean).join("。");
  return c.json({
    suggested: added.length, ids: added.map((item) => item.id),
    ...(withdrawn.length ? { withdrawn: withdrawn.map((item) => item.id) } : {}),
    ...(gone.length ? { gone } : {}),
    ...(already.length ? { already } : {}),
    // 此刻还挂着、用户没处理的全部：智能体据它知道哪些不用重挂、哪些该收回。
    hanging: after.map((item) => ({ id: item.id, title: item.title })),
    next,
  });
});

api.delete("/tasks/:id/dispatch-suggestions/:sid", async (c) => {
  const taskId = c.req.param("id");
  const task = (await db.select({ id: tasks.id, archived: tasks.archived }).from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return c.json({ error: "not found" }, 404);
  const drop = withoutSuggestions([c.req.param("sid")]);
  const written = await updateSuggestions(taskId, drop.change);
  // 已经不在了（刚派掉、智能体刚收回）就当叉掉了：用户要的结果本来就是它不在。
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
  // 新任务归按「派出去」的这个人（同 POST /tasks）：交给谁按**他**看得见的执行器核，跟建任务用同一个归属人。
  // 按来源任务的归属人核，共享项目里别人的任务上他选的非默认执行器会被悄悄换成默认。
  const owner = ownerIdOf(actorOf(c));
  const launch = normalizeSuggestionLaunch(b, await executorScopeForOwner(owner));
  if ("error" in launch) return c.json({ error: launch.error }, 400);
  const result = await launchSuggestions(c, task, owner, launch);
  return c.json(result.body, result.status);
});
}
