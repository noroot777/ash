// 挂在回复框顶上的活的四个端点（接口形状写在 shared/src/dispatch-suggestion.ts 文件头，页面照那一份做）：
//   POST   /tasks/:id/dispatch-suggestions          智能体挂、收回、摆要等的一批（MCP suggest_dispatch），跟提问同一套回合与方向身份核对
//   POST   /tasks/:id/dispatch-suggestions/launch   用户按「派出去」：照那几行此刻的样子建任务（dispatch-suggestion-launch.ts）
//   DELETE /tasks/:id/dispatch-suggestions/:sid     用户点了叉：这一件不派
//   PUT    /tasks/:id/dispatch-target               「派出去的活交给谁」（回复框胶囊点开那一层里的一行）
// 「发回去改」不在这里：它就是对等着的那一问的普通答复（POST /tasks/:id/answer），一条任务都不建。
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { AGENT_TYPES, type AgentType } from "@navi/shared";
import { hangingSuggestions, publicSuggestions, type DispatchSuggestionLaunchInput } from "@navi/shared/dispatch-suggestion";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { actorOf, ownerIdOf } from "./auth/context.js";
import { executorScopeForOwner } from "./auth/owned-executors.js";
import { handoffBlockReason } from "./handoff-guard.js";
import { turnIdentity } from "./turn-lock.js";
import { publishTaskUpdated } from "./task-store.js";
import { now } from "./util.js";
import { NAVI_HEADERS, requestHeader } from "./request-headers.js";
import { pinReviewChoice, ReviewOnCreateError } from "./review-on-create.js";
import { normalizeSuggestionLaunch, normalizeSuggestions, normalizeTarget, normalizeWithdrawals } from "./dispatch-suggestion-input.js";
import { writeAgentChange } from "./dispatch-suggestion-agent.js";
import { planQuestionText, proposedTarget, QUESTION_BLOCKS_DISPATCH_WAIT, targetLabeler } from "./dispatch-suggestion-wait.js";
import { dropSuggestion, launchSuggestions } from "./dispatch-suggestion-launch.js";
import { readSuggestions } from "./dispatch-suggestion.js";

export function mountDispatchSuggestionRoutes(api: Hono): void {
api.post("/tasks/:id/dispatch-suggestions", async (c) => {
  const taskId = c.req.param("id");
  type Body = { tasks?: unknown; order?: unknown; wait?: unknown; withdraw?: unknown };
  const b = await c.req.json<Body>().catch(() => ({}) as Body);
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  // 派出去的任务收在这条名下：只有普通的独立任务能挂（团队、讨论、团队执行者各有各的归属，见 task-dispatch.ts）。
  if (r.mode !== "single" || r.parentId) return c.json({ error: "只有普通任务能挂要派出去的活；团队调度台派活用 dispatch" }, 409);
  if (r.status !== "running") return c.json({ error: "只能在任务正在运行时挂或收回", status: r.status }, 409);
  const token = requestHeader(c, NAVI_HEADERS.turnToken);
  if (r.activeTurnToken && token !== r.activeTurnToken) {
    return c.json({ error: token ? "来自已结束的回合，已拒绝写入" : "MCP 未携带当前回合身份，已拒绝写入" }, 409);
  }
  const direction = requestHeader(c, NAVI_HEADERS.directionToken);
  if (r.activeDirectionToken && direction !== r.activeDirectionToken) {
    return c.json({ error: direction
      ? "方向身份已过期；请从最新用户消息的【当前方向身份】复制 directionToken 后重试"
      : "MCP 未携带当前方向身份（请传当前消息附带的 directionToken），已拒绝写入" }, 409);
  }
  // 只有这条任务自己的执行回合能挂、能收回：审查、就地验证、讨论的一段、计划模式、原生命令都是旁路（role 不是
  // single），`@` 别人来问一句时这一轮的执行器不是任务自己的——它们既挂不上，也动不了已经挂着的。
  const turn = turnIdentity(taskId);
  if (turn && turn.role !== "single") return c.json({ error: "这是审查、讨论或其他旁路回合，不能挂或收回要派出去的活" }, 409);
  if (turn?.agent && r.agentType && turn.agent !== r.agentType) {
    return c.json({ error: "这一轮是被叫来问一句的，不能挂或收回要派出去的活" }, 409);
  }
  const incoming = normalizeSuggestions(b, await executorScopeForOwner(r.ownerUserId));
  if ("error" in incoming) return c.json({ error: incoming.error }, 400);
  const withdrawing = normalizeWithdrawals(b);
  if ("error" in withdrawing) return c.json({ error: withdrawing.error }, 400);
  if (!incoming.items.length && !withdrawing.length) return c.json({ error: "tasks（要挂的）和 withdraw（要收回的）至少给一样" }, 400);
  // 要等的一批：先看一眼那一格，有普通提问在等就当场说清（真正的判定在写的那一笔里，见 dispatch-suggestion-agent.ts）。
  if (incoming.wait !== "none" && r.question && !readSuggestions(r).some((item) => item.wait !== "none")) {
    return c.json({ error: QUESTION_BLOCKS_DISPATCH_WAIT }, 409);
  }
  // 指定了审查者的那几件：名字换成 id、找不到当场退回（框顶要画得出是谁）。新任务归按「派出去」的人，这里先按这条
  // 任务的归属人核——普通情况下是同一个人；不同时派出那一下还会按派的人再认一遍。
  try {
    for (const item of incoming.items) item.review = await pinReviewChoice(item.review ?? "default", r.ownerUserId);
  } catch (error) {
    if (error instanceof ReviewOnCreateError) return c.json({ error: error.message }, 400);
    throw error;
  }
  let question: string | null = null;
  if (incoming.wait !== "none") {
    const label = await targetLabeler();
    const proposed = proposedTarget(r);
    question = planQuestionText(incoming.order, incoming.items, (item) => {
      const target = proposed(item);
      return target ? label(target) : "默认执行器";
    });
    for (const item of incoming.items) item.question = question;
  }
  // 收回的那几件和各自的原因同一条更新落库：框顶那一行不见了，原因就一定读得到。写不进去（原因接不到收回记录
  // 后面）就是整笔没落：如实告诉智能体，别让它以为收回了。
  const written = await writeAgentChange(r, withdrawing, incoming, question).catch((error: unknown) => {
    console.error(`[navi] 要派出去的活没能写进去 task=${taskId}:`, error instanceof Error ? error.message : error);
    return "failed" as const;
  });
  if (written === "failed") return c.json({ error: "没能写进去，这一笔一样都没落：要收回的还挂着，要挂的没挂上" }, 500);
  if (written.kind === "question-taken") return c.json({ error: QUESTION_BLOCKS_DISPATCH_WAIT }, 409);
  if (written.kind === "refused") return c.json({ error: written.change.refused }, 409);
  // 入口核过之后、写进去之前，任务停了、回合结束了或用户换了方向：这一批是旧方向下的，不落。
  if (written.kind === "turn-gone") return c.json({ error: "这一轮的回合或方向已经变了（任务停了、回合结束了或用户补了新要求），已拒绝写入" }, 409);
  const { added, withdrawn, gone, already, after } = written.change;
  await publishTaskUpdated(taskId);
  const waiting = incoming.wait !== "none";
  const next = [
    waiting && (incoming.wait === "done"
      ? "这一批在回复框顶上等用户过目，调完正常结束回合（任务停在等用户上）。用户处理完由 Navi 把本任务结成完成、不叫醒你，建好的清单下一回合开头给你（那时名下还有没收下的哨兵结果就不结成完成，等结果送到叫醒你、由你确认）；要对用户说的话这一回合说完"
      : "这一批在回复框顶上等用户过目，调完正常结束回合（任务停在等用户上）。用户处理完，建好的清单会作为答复续上你的会话"),
    !waiting && added.length && "新挂的在回复框顶上，会一直留到用户派掉或点叉，之后的回合不用重挂；照常往下做、照常结束本回合",
    added.length && "不要再自己建这几条任务",
    already.length && `${already.map((item) => `「${item.title}」`).join("")}已经挂着、用户还没处理，这次没有重挂；要换说明就在同一次调用里先 withdraw 那一件再挂`,
    withdrawn.length && "收回的已经从回复框顶上拿掉，你写的原因用户在会话里看得到",
    gone.length && "gone 里那几件已经不在了（用户派掉或叉掉了），不用再收回",
  ].filter(Boolean).join("。");
  return c.json({
    suggested: added.length, ids: added.map((item) => item.id),
    ...(withdrawn.length ? { withdrawn: withdrawn.map((item) => item.id) } : {}),
    ...(gone.length ? { gone } : {}),
    ...(already.length ? { already } : {}),
    ...(waiting ? { wait: incoming.wait, willSettleAs: "paused" } : {}),
    // 此刻还挂着、用户没处理的全部：智能体据它知道哪些不用重挂、哪些该收回。
    hanging: hangingSuggestions(after).map((item) => ({ id: item.id, title: item.title, ...(item.wait !== "none" ? { waiting: true } : {}) })),
    next,
  });
});

api.post("/tasks/:id/dispatch-suggestions/launch", async (c) => {
  const taskId = c.req.param("id");
  const b = await c.req.json<Partial<DispatchSuggestionLaunchInput>>().catch(() => ({}) as Partial<DispatchSuggestionLaunchInput>);
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return c.json({ error: "not found" }, 404);
  if (task.archived) return c.json({ error: "任务已归档，先取消归档再派", archived: true }, 409);
  const blocked = handoffBlockReason(task.handoff);
  if (blocked) return c.json({ error: blocked, handoff: true }, 409);
  if (task.mode !== "single" || task.parentId) return c.json({ error: "只有普通任务能派出挂着的活" }, 409);
  // 新任务归按「派出去」的这个人（同 POST /tasks）：交给谁按**他**看得见的执行器核，跟建任务用同一个归属人。
  // 按来源任务的归属人核，共享项目里别人的任务上他选的非默认执行器会被悄悄换成默认。
  const owner = ownerIdOf(actorOf(c));
  const launch = normalizeSuggestionLaunch(b, await executorScopeForOwner(owner));
  if ("error" in launch) return c.json({ error: launch.error }, 400);
  const result = await launchSuggestions(c, task, owner, launch);
  return c.json(result.body, result.status);
});

api.delete("/tasks/:id/dispatch-suggestions/:sid", async (c) => {
  const taskId = c.req.param("id");
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return c.json({ error: "not found" }, 404);
  const blocked = handoffBlockReason(task.handoff);
  if (blocked) return c.json({ error: blocked, handoff: true }, 409);
  const result = await dropSuggestion(task, c.req.param("sid"), ownerIdOf(actorOf(c)));
  if (result.status !== 200) return c.json(result.body, result.status);
  const latest = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  return c.json({ ...result.body, suggestions: latest ? publicSuggestions(readSuggestions(latest)) : [] });
});

api.put("/tasks/:id/dispatch-target", async (c) => {
  const taskId = c.req.param("id");
  const b = await c.req.json<{ target?: unknown }>().catch(() => ({}) as { target?: unknown });
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return c.json({ error: "not found" }, 404);
  if (task.archived) return c.json({ error: "任务已归档，先取消归档再改", archived: true }, 409);
  if (task.mode !== "single" || task.parentId) return c.json({ error: "只有普通任务能设派出去的活交给谁" }, 409);
  let stored: string | null = null;
  if (b.target !== null && b.target !== undefined) {
    const raw = b.target as { agentType?: unknown };
    if (typeof raw.agentType !== "string" || !AGENT_TYPES.includes(raw.agentType as AgentType)) {
      return c.json({ error: "target.agentType 要写明交给哪种智能体；改回同这里传 null" }, 400);
    }
    const target = normalizeTarget(raw, await executorScopeForOwner(task.ownerUserId), "target");
    if (!target || "error" in target) return c.json({ error: target ? target.error : "target 要写明交给谁" }, 400);
    stored = JSON.stringify(target);
  }
  await db.update(tasks).set({ dispatchTarget: stored, updatedAt: now() }).where(eq(tasks.id, taskId));
  return c.json(await publishTaskUpdated(taskId));
});
}
