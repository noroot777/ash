import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentType,
  GateAction,
  QuestionItem,
  ScheduledMessage,
  ScheduledMessageMode,
  ScheduledMessageStatus,
  TaskStatus,
} from "@ash/shared";
import {
  MAX_QUESTION_ITEMS,
  MAX_QUESTION_OPTION_LEN,
  MAX_QUESTION_OPTIONS,
  canSingleRun,
} from "@ash/shared";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { forceKillCuaService, lastCuaResidualStatus, refreshCuaResidualStatus } from "./cua.js";
import { db } from "./db/index.js";
import { isAcceptingTask } from "./acceptance-lock.js";
import { queueItems, scheduledMessages, tasks } from "./db/schema.js";
import { resumeDuet, resumeAtGate, runDuet } from "./duet/index.js";
import { resolveGate } from "./duet/gates.js";
import { runTask } from "./orchestrator.js";
import { resumeOrRunTask } from "./task-resume.js";
import { mountTaskArchiveRoutes } from "./task-archive-routes.js";
import { mountTaskRetryTurnRoutes } from "./task-retry-turn.js";
import { mountTaskScheduleRoutes } from "./task-schedule-routes.js";
import { mountTaskSessionRoutes } from "./task-session-routes.js";
import { mountTaskSteerRoutes } from "./task-steer.js";
import { RUNS_DIR } from "./paths.js";
import { publishPendingMessages } from "./pending-messages.js";
import { isOvertaken, queueBlockers, repackQueue, tailOrder } from "./queues.js";
import { claimTurn, confirmDone, releaseTurn, stopTask } from "./runs.js";
import { handoffBlockReason } from "./handoff-guard.js";
import { advanceQueue } from "./scheduler.js";
import { setTaskStatus } from "./status.js";
import { replyToTask } from "./task-reply.js";
import { answerTask } from "./task-answer.js";
import { dispatchWorkers, type DispatchSpec } from "./team/dispatch.js";
import { haltTeam } from "./team/session.js";
import { enrichTasks } from "./task-store.js";
import { setTaskQuestion } from "./task-question.js";
import { announceResumePrompt } from "./task-resume-prompt.js";
import { readableRunPath } from "./transcript.js";
import { actorOf, ownerIdOf } from "./auth/context.js";
import { now } from "./util.js";

export function mountTaskRunRoutes(api: Hono): void {
  mountTaskArchiveRoutes(api);
  mountTaskRetryTurnRoutes(api);
  mountTaskScheduleRoutes(api);
  mountTaskSessionRoutes(api);
  mountTaskSteerRoutes(api);
  const toScheduledMessage = (r: typeof scheduledMessages.$inferSelect): ScheduledMessage => ({
    ...r,
    attachments: JSON.parse(r.attachments),
    agent: (r.agent as AgentType) ?? null,
    // 托盘据此把「审查链自己的答复」和用户手写的回复分开（见 shared/src/schedule.ts）。
    sessionRole: (r.sessionRole as ScheduledMessage["sessionRole"]) ?? null,
    mode: r.mode as ScheduledMessageMode,
    status: r.status as ScheduledMessageStatus,
  });

// Persisted duet transcript (rebuilds the timeline on reload, §12). Old
// transcripts predate the debate→duet rename — normalize their event types here
// so the web reducer only ever sees `duet.*`.
api.get("/tasks/:id/duet", async (c) => {
  try {
    const raw = await readFile(readableRunPath(join(RUNS_DIR, c.req.param("id"), "transcript.jsonl")), "utf8");
    const turns = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .map((t) => (typeof t?.type === "string" && t.type.startsWith("debate.")
        ? { ...t, type: `duet.${t.type.slice("debate.".length)}` }
        : t));
    return c.json(turns);
  } catch {
    return c.json([]);
  }
});

// ── run a task (§1/§12) ─────────────────────────────────────────────────────
// 队列前置检查(queueBlockers)、queue 的增删改端点都在 ./queues.ts。

api.post("/tasks/:id/run", async (c) => {
  const taskId = c.req.param("id");
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.archived) return c.json({ error: "任务已归档，先取消归档再运行", archived: true }, 409);
  // 接力出去的任务是历史存档,本机启动就是双机并跑(审查实测:横幅说着存档,点「运行」
  // 真的新建了 session)。硬拦在服务端,前端隐藏按钮只是补充。
  {
    const blocked = handoffBlockReason(r.handoff);
    if (blocked) return c.json({ error: blocked, handoff: true }, 409);
  }
  // 单条手动 Run：普通任务允许 backlog / canceled / failed / paused。team 的
  // idle 也可运行:它不是终态,只是常驻调度台待命,点击会接回同一 CLI 会话。
  const runnable =
    r.mode === "team"
      ? !["running", "queued", "awaiting_review"].includes(r.status)
      : canSingleRun(r.status as TaskStatus);
  if (!runnable) return c.json({ error: "任务当前状态不可运行", status: r.status }, 409);
  const blockedBy = await queueBlockers(taskId);
  if (blockedBy.length) {
    return c.json(
      { error: "队列前面还有未完成的任务，先把它们处理完或把本任务移出队列", blockedBy },
      409,
    );
  }
  // Fire-and-forget; progress streams over /api/events.
  // team 也走「先占位、再镜像查验收锁」这一套（占位对常驻调度台本身没用途,runTask 的
  // team 分支会立刻还回来）—— 它只为让 202 是真话:早先 team 分支排在这两道检查**之前**
  // 直接 202,验收进行中照样 startTeam,用户看到「已启动」而调度台其实撞上验收锁(审查实测)。
  if (r.mode === "team") {
    if (!claimTurn(taskId, "team")) {
      return c.json({ error: "任务回合正在进行，结束后再运行", status: r.status }, 409);
    }
    if (isAcceptingTask(taskId)) {
      releaseTurn(taskId);
      return c.json({ error: "任务正在验收（含发布尾段），结束后再运行", status: r.status }, 409);
    }
    void resumeOrRunTask(taskId, { reason: "run", turnHeld: true, actingUserId: ownerIdOf(actorOf(c)) });
    return c.json({ started: true }, 202);
  }
  // **最后一个 await 之后**原子占位再启动：只读预检查后的任何 await 间隙里另一次启动
  // 都可能抢先——两个并发请求会双双 202 而只有一个真的开跑（审查实测）。占到 = 202 是
  // 真话；占不到 = 此刻确有回合在跑，409。duet 走同一把锁（它模块内那个 running Set
  // 调用方看不见，验收锁也挡不住它）。
  if (!claimTurn(taskId, r.mode === "duet" ? "duet" : "single")) {
    return c.json({ error: "任务回合正在进行，结束后再运行", status: r.status }, 409);
  }
  // 占位后镜像检查验收锁（验收侧先占己锁再查 turn）：runTask/runDuet 撞上验收锁只会
  // 静默 return，202 就成了「已启动」的谎报（审查实测：/run 与 /retry 均复现）。
  if (isAcceptingTask(taskId)) {
    releaseTurn(taskId);
    return c.json({ error: "任务正在验收（含发布尾段），结束后再运行", status: r.status }, 409);
  }
  if (r.mode === "duet") { void runDuet(taskId, { turnHeld: true, actingUserId: ownerIdOf(actorOf(c)) }); return c.json({ started: true }, 202); }
  void resumeOrRunTask(taskId, { reason: "run", turnHeld: true, actingUserId: ownerIdOf(actorOf(c)) });
  return c.json({ started: true }, 202);
});

// 立即触发一轮全新运行 = 调度器到点 fire 的效果:永远 fresh(新 CLI 会话、重新
// 喂任务正文),绝不 resume 旧会话。「运行/重试」优先续会话,这里给「现在就跑
// 一班新的」一个显式入口——典型场景:cron 任务错过班次,手动补跑今天这班。
// done 也允许(定时本来就会重跑 done 任务);running/queued/审核中拒绝。
api.post("/tasks/:id/fire", async (c) => {
  const taskId = c.req.param("id");
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.archived) return c.json({ error: "任务已归档，先取消归档再触发", archived: true }, 409);
  {
    const blocked = handoffBlockReason(r.handoff);
    if (blocked) return c.json({ error: blocked, handoff: true }, 409);
  }
  if (r.status === "running" || r.status === "queued")
    return c.json({ error: "任务正在进行，等它结束再触发新一轮", status: r.status }, 409);
  if (r.status === "awaiting_review")
    return c.json({ error: "任务等待裁决中，先处理裁决再触发", status: r.status }, 409);
  // 未收尾的就地验证轮 / 提问态:这两样都不是「在跑」,status 看不出来,可 fresh 一轮下去
  // 就错了 —— 轮次号还挂在任务身上,新起的这一轮会被当成**这一轮验证的续跑**(sideTurn
  // 判据只看 `verifyRound` 非空),于是一段全新的执行顶着验证轮号跑完,再拿它的收尾当成
  // 验证结论;提问态则是把 agent 等着的那个问题连同它停在半路的会话一起丢掉(审查实测:
  // 提问态 /fire 返回 202 并把新一轮当验证旁路)。
  if (r.verifyRound !== null)
    return c.json({ error: `第 ${r.verifyRound} 轮就地验证还没出结论，等它结束再触发新一轮`, status: r.status }, 409);
  if (r.question)
    return c.json({ error: "任务有待答复的提问，先答复再触发新一轮", status: r.status }, 409);
  // runTask 遇验收锁/单飞锁会静默 return——202 就成了谎报「已触发一轮全新运行」（审查实测）。
  if (isAcceptingTask(taskId))
    return c.json({ error: "任务正在验收（含发布尾段），结束后再触发", status: r.status }, 409);
  const blockedBy = await queueBlockers(taskId);
  if (blockedBy.length) {
    return c.json(
      { error: "队列前面还有未完成的任务，先把它们处理完或把本任务移出队列", blockedBy },
      409,
    );
  }
  // 同 /run:最后一个 await 之后原子占位,202 才是真话。duet 与 single 共用这把锁。
  if (!claimTurn(taskId, r.mode === "duet" ? "duet" : "single")) {
    return c.json({ error: "任务回合正在进行，结束后再触发", status: r.status }, 409);
  }
  // 队列检查之后验收锁可能刚刚落下:占位后再查一遍(与验收侧互为镜像)。
  if (isAcceptingTask(taskId)) {
    releaseTurn(taskId);
    return c.json({ error: "任务正在验收（含发布尾段），结束后再触发", status: r.status }, 409);
  }
  if (r.mode === "duet") { void runDuet(taskId, { turnHeld: true, actingUserId: ownerIdOf(actorOf(c)) }); return c.json({ started: true, fresh: true }, 202); }
  void runTask(taskId, { turnHeld: true, actingUserId: ownerIdOf(actorOf(c)) }); // 全新一轮,永不 resume
  return c.json({ started: true, fresh: true }, 202);
});

// Manually stop a running task: kill its live agent subprocess(es). The run loop
// then settles the task as `canceled` (re-runnable / continuable). queued(还没
// spawn)或进程已丢(如 server 重启遗留)时直接落 canceled —— 这是取消任务的
// 唯一正道;PATCH status=canceled 对 running/queued 已被禁止。
api.post("/tasks/:id/stop", async (c) => {
  const taskId = c.req.param("id");
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (stopTask(taskId)) return c.json({ stopped: true });
  if (r.status === "queued" || r.status === "running") {
    await setTaskStatus(taskId, "canceled");
    return c.json({ stopped: true, note: "没有存活的 agent 进程,已直接标记为 canceled" });
  }
  return c.json({ error: "任务没有在运行的进程可停止", status: r.status }, 409);
});

// 检查点续跑：agent 在执行中调用，写下「下次继续时该喂给我的指令」。任务这一回合
// 自然退出（agent 调完它就 return 了）后，settleTaskStatus 会因为 resumePrompt
// 非空把状态落到 paused 而不是 done；scheduler 在依赖满足后会把 resumePrompt 当作
// user 消息丢回 continueTask，清空字段、resume 同一 CLI 会话。**不**修改 status,
// 让任务自然走完当前回合再结算 —— 避免 agent 主调 pause 后还想再输出几句却被截断。
// 只接受 running 任务(agent 必须自己在跑才能合法地说"我到检查点了")。
api.post("/tasks/:id/pause", async (c) => {
  const taskId = c.req.param("id");
  const b = await c.req.json<{ resumePrompt?: string }>().catch(() => ({}) as { resumePrompt?: string });
  const rp = (b.resumePrompt ?? "").trim();
  if (!rp) return c.json({ error: "resumePrompt 不能为空 —— 否则 resume 时没东西喂给 agent" }, 400);
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.status !== "running") return c.json({ error: "只能在任务正在运行时设置检查点", status: r.status }, 409);
  const pauseToken = c.req.header("x-ash-turn-token");
  if (r.activeTurnToken && pauseToken !== r.activeTurnToken) {
    return c.json({
      error: pauseToken
        ? "检查点来自已结束的回合，已拒绝写入当前会话"
        : "MCP 未携带当前回合身份（执行器可能过滤了 ASH_TURN_TOKEN），检查点已拒绝写入",
    }, 409);
  }
  const pauseDirection = c.req.header("x-ash-direction-token");
  if (r.activeDirectionToken && pauseDirection !== r.activeDirectionToken) {
    return c.json({ error: pauseDirection
      ? "检查点的方向身份已过期；请从最新用户消息的【当前方向身份】复制 directionToken 后重试"
      : "MCP 未携带当前方向身份（请传当前消息附带的 directionToken），检查点已拒绝写入" }, 409);
  }
  const updated = await db
    .update(tasks)
    .set({ resumePrompt: rp, updatedAt: now() })
    .where(and(
      eq(tasks.id, taskId),
      eq(tasks.status, "running"),
      r.activeTurnToken === null
        ? isNull(tasks.activeTurnToken)
        : eq(tasks.activeTurnToken, r.activeTurnToken),
      r.activeDirectionToken === null
        ? isNull(tasks.activeDirectionToken)
        : eq(tasks.activeDirectionToken, r.activeDirectionToken),
    ))
    .returning({ id: tasks.id });
  if (!updated.length) return c.json({ error: "当前回合已经结束或已被引导，检查点未写入" }, 409);
  // 检查点一挂上，前端的派审/预约/修复入口就该跟着灰掉；SSE 没有带 resume_prompt 的
  // 局部事件，只能推整行（见 task-resume-prompt.ts 顶部）。
  await announceResumePrompt(taskId);
  return c.json({ paused: true, willSettleAs: "paused" });
});

// 完成确认(严格 done 协议,对称 /pause):agent 当且仅当确定任务目标已达成时
// 调用;settle 时消费这个标记才落 done,否则 exit 0 也按 failed 结算(exit 0
// 只证明进程正常退出,agent 报错后退出照样 exit 0 —— 假 done 会误推进队列)。
// 只接受 running 任务。**同时落库 + 置内存标记**:确认走 HTTP 打到监听进程,
// 而跑这个回合的未必是同一个进程(历史事故:僵尸实例在跑,确认落在监听进程的
// 内存里,结算那边什么都没看见,agent 明明确认了却记 failed)。落库那份是权威,
// settle 两边任一命中即算确认(见 orchestrator.settleTaskStatus)。
api.post("/tasks/:id/complete", async (c) => {
  const taskId = c.req.param("id");
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.status !== "running") return c.json({ error: "只能在任务正在运行时确认完成", status: r.status }, 409);
  const completeToken = c.req.header("x-ash-turn-token");
  if (r.activeTurnToken && completeToken !== r.activeTurnToken) {
    return c.json({
      error: completeToken
        ? "完成确认来自已结束的回合，已拒绝写入当前会话"
        : "MCP 未携带当前回合身份（执行器可能过滤了 ASH_TURN_TOKEN），完成确认已拒绝写入",
    }, 409);
  }
  const completeDirection = c.req.header("x-ash-direction-token");
  if (r.activeDirectionToken && completeDirection !== r.activeDirectionToken) {
    return c.json({ error: completeDirection
      ? "完成确认的方向身份已过期；请从最新用户消息的【当前方向身份】复制 directionToken 后重试 complete_task"
      : "MCP 未携带当前方向身份（请传当前消息附带的 directionToken），完成确认已拒绝写入" }, 409);
  }
  const updated = await db
    .update(tasks)
    .set({ completeConfirmedAt: now(), updatedAt: now() })
    .where(and(
      eq(tasks.id, taskId),
      eq(tasks.status, "running"),
      r.activeTurnToken === null
        ? isNull(tasks.activeTurnToken)
        : eq(tasks.activeTurnToken, r.activeTurnToken),
      r.activeDirectionToken === null
        ? isNull(tasks.activeDirectionToken)
        : eq(tasks.activeDirectionToken, r.activeDirectionToken),
    ))
    .returning({ id: tasks.id });
  if (!updated.length) return c.json({ error: "当前回合已经结束或已被引导，完成确认未写入" }, 409);
  confirmDone(taskId);
  // 续聊回合(followUpFrom 非空)确认完成 = 把任务推进到 done;正常回合就是 done。
  return c.json({ confirmed: true, willSettleAs: "done" });
});

// 提问(对称 /pause,§Team):agent 在执行中调用,写下「我被这个问题卡住了」。
// 执行者:本回合自然退出后,settleTaskStatus 因 question 非空落 paused,且队列**不**
// 自动续跑(pickNextLaunchable 挡住);问题即时投递给团队调度者,answer_question
// 的答复会清空 question 并带着答复 resume 同一 CLI 会话。
// 团队调度者自己也能调 → 界面上就是「调度者在等你答复」,答复喂回它的常驻会话。
// 没人管也能用:任务停在 paused,问题留在 task.question 等用户答复。
// 可选的 options = 单问题候选答案；questionItems = 一次并列问几个相关决策，每个
// 问题有自己的 options。候选按钮只填入对应输入框，最终仍合成一段文本走 /answer。
// 一次性任务只接受 running;常驻调度台例外(§Team):它的 status 会在 running/idle
// 间切换,但能发出 ask_question 就说明这一轮活着,不能被 idle 挡掉。
function normalizeQuestionOptions(raw: unknown, field: string): { options: string[] } | { error: string } {
  if (raw === undefined) return { options: [] };
  if (!Array.isArray(raw) || raw.some((o) => typeof o !== "string")) {
    return { error: `${field} 必须是字符串数组` };
  }
  // trim + 去空 + 去重后落库；超限明确报错，不静默截断。
  const options = [...new Set(raw.map((o) => o.trim()).filter(Boolean))];
  if (options.length > MAX_QUESTION_OPTIONS) {
    return { error: `${field} 最多 ${MAX_QUESTION_OPTIONS} 个候选答案，收到 ${options.length} 个` };
  }
  const tooLong = options.find((o) => o.length > MAX_QUESTION_OPTION_LEN);
  if (tooLong) {
    return {
      error: `${field} 的单个候选答案不超过 ${MAX_QUESTION_OPTION_LEN} 字，展开说明请写进 question：「${tooLong.slice(0, 30)}…」`,
    };
  }
  return { options };
}

function normalizeQuestionItems(raw: unknown): { items: QuestionItem[] | null } | { error: string } {
  if (raw === undefined) return { items: null };
  if (!Array.isArray(raw)) return { error: "questionItems 必须是问题数组" };
  if (raw.length > MAX_QUESTION_ITEMS) {
    return { error: `一次最多 ${MAX_QUESTION_ITEMS} 个问题，收到 ${raw.length} 个` };
  }
  const items: QuestionItem[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { error: `questionItems[${i}] 必须是 { question, options? }` };
    }
    const record = item as Record<string, unknown>;
    if (typeof record.question !== "string" || !record.question.trim()) {
      return { error: `questionItems[${i}].question 不能为空` };
    }
    const normalized = normalizeQuestionOptions(record.options, `questionItems[${i}].options`);
    if ("error" in normalized) return normalized;
    items.push({
      question: record.question.trim(),
      ...(normalized.options.length ? { options: normalized.options } : {}),
    });
  }
  return { items: items.length ? items : null };
}

api.post("/tasks/:id/ask", async (c) => {
  const taskId = c.req.param("id");
  const b = await c.req
    .json<{ question?: string; options?: unknown; questionItems?: unknown }>()
    .catch(() => ({}) as { question?: string; options?: unknown; questionItems?: unknown });
  const q = (b.question ?? "").trim();
  if (!q) return c.json({ error: "question 不能为空" }, 400);
  const normalizedOptions = normalizeQuestionOptions(b.options, "options");
  if ("error" in normalizedOptions) return c.json({ error: normalizedOptions.error }, 400);
  const normalizedItems = normalizeQuestionItems(b.questionItems);
  if ("error" in normalizedItems) return c.json({ error: normalizedItems.error }, 400);
  const opts = normalizedOptions.options;
  const questionItems = normalizedItems.items;
  if (questionItems && opts.length) {
    return c.json({ error: "多问题请把候选答案放进各 questionItems[i].options，不要同时传顶层 options" }, 400);
  }
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.mode !== "team" && r.status !== "running")
    return c.json({ error: "只能在任务正在运行时提问", status: r.status }, 409);
  const askToken = c.req.header("x-ash-turn-token");
  if (r.mode !== "team" && r.activeTurnToken && askToken !== r.activeTurnToken) {
    return c.json({
      error: askToken
        ? "提问来自已结束的回合，已拒绝写入当前会话"
        : "MCP 未携带当前回合身份（执行器可能过滤了 ASH_TURN_TOKEN），提问已拒绝写入",
    }, 409);
  }
  const askDirection = c.req.header("x-ash-direction-token");
  if (r.mode !== "team" && r.activeDirectionToken && askDirection !== r.activeDirectionToken) {
    return c.json({ error: askDirection
      ? "提问的方向身份已过期；请从最新用户消息的【当前方向身份】复制 directionToken 后重试 ask_question"
      : "MCP 未携带当前方向身份（请传当前消息附带的 directionToken），提问已拒绝写入" }, 409);
  }
  const asked = await setTaskQuestion({
    taskId,
    question: q,
    options: opts,
    items: questionItems,
    ...(r.mode === "team" ? {} : { currentTurn: {
      token: r.activeTurnToken,
      directionToken: r.activeDirectionToken,
    } }),
  });
  if (!asked) return c.json({ error: "当前回合已经结束或已被引导，提问未写入" }, 409);
  return c.json({
    asked: true,
    options: opts,
    questionItems,
    willSettleAs: r.mode === "team" ? "idle" : "paused",
  });
});

// 答复一个提问暂停中的任务(调度者或用户都可调):清空 question,把答复作为
// 消息 resume 它的 CLI 会话继续跑。提问回合还没结算完(running/queued)时拒绝
// ——等它落 paused 再答,否则答复会被单飞锁静默丢掉。
// 例外:常驻调度台(§Team)自己调 ask_question 问用户时,这道挡板不适用 —— 它正在
// 说话时也接得住(continueTask → deliverToLead 先 interrupt 再写 stdin),跟
// 「插话」走的是同一条路。挡住反而会让用户对着一个明明在线的调度台干等。
api.post("/tasks/:id/answer", (c) => answerTask(c, c.req.param("id")));

// ── §Team ───────────────────────────────────────────────────────────────────
// 派活:调度者(mode:"team")调 MCP 的 dispatch 落到这里 —— 建 N 个执行者任务 + 一个
// 内部组(serial 顺带串成队列),默认立刻起跑。
api.post("/tasks/:id/dispatch", async (c) => {
  const leadTaskId = c.req.param("id");
  type DispatchBody = { tasks?: DispatchSpec[]; mode?: "serial" | "parallel"; run?: boolean; batchName?: string };
  const b = await c.req.json<DispatchBody>().catch(() => ({}) as DispatchBody);
  const specs = (b.tasks ?? []).filter((s) => (s?.body ?? "").trim());
  if (!specs.length) return c.json({ error: "tasks 不能为空(每项至少要有 body)" }, 400);
  try {
    const r = await dispatchWorkers(leadTaskId, specs, { mode: b.mode, run: b.run, batchName: b.batchName });
    return c.json(
      { groupId: r.groupId, mode: r.mode, run: b.run !== false, tasks: r.tasks },
      201,
    );
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// 停止全组:调度台进程 + 所有在跑的执行者一起停。执行者走分组暂停(落 paused,占住
// 队列位置,恢复分组时从原会话续跑);调度台落 idle(会话留着,再说话就接回)。
api.post("/tasks/:id/team/halt", async (c) => {
  const taskId = c.req.param("id");
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.mode !== "team") return c.json({ error: "只有团队任务能停止全组", mode: r.mode }, 400);
  await haltTeam(taskId);
  return c.json({ halted: true });
});

api.get("/tasks/:id/team/cua-status", async (c) => {
  const taskId = c.req.param("id");
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.mode !== "team") return c.json({ error: "只有团队任务有 team CUA 状态", mode: r.mode }, 400);
  const last = lastCuaResidualStatus("team", taskId);
  const current = await refreshCuaResidualStatus("team", taskId);
  return c.json({ taskId, current, last });
});

api.post("/tasks/:id/team/kill-cua", async (c) => {
  const taskId = c.req.param("id");
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.mode !== "team") return c.json({ error: "只有团队任务能强制清理 CUA", mode: r.mode }, 400);
  const result = await forceKillCuaService("team", taskId);
  return c.json({
    killed: result.killed,
    before: result.before,
    after: result.after,
    status: result.status,
    warning: result.sideEffect,
  });
});

// Reply to a single task: resume its CLI session with the user's message so an
// agent that stopped to ask can be answered and keep going (same session).
// 两种情况会落成一条**待发送消息**(scheduled_messages)而不是立刻投递,返回 202
// { scheduled:true, message } 让前端把它显示在输入框上方的托盘里:
//   • 带 `sendAt`(将来的 ISO 时刻)= 定时发送(mode=timed)
//   • 单任务正在跑 = 排队追问(mode=queued),等它这一轮跑完自动发出
// 后者是刻意不再 409 的:运行中想补一句是常态,把话接住比把用户挡回去有用。真正
// 的投递时机与判定单点在 pending-messages.ts。
// 团队(§Team)的「插话」也走这个端点,但两道给一次性会话设的挡板对它不适用:
// 调度台是常驻进程,正在说话(running)时也接得住(continueTask → deliverToLead 直接
// 写进 stdin),这就是「发出去当前会话就接住、看着从没断线」的手感。
api.post("/tasks/:id/reply", (c) => replyToTask(c, c.req.param("id")));

// List a task's pending scheduled messages (soonest first).
api.get("/tasks/:id/scheduled-messages", async (c) => {
  const rows = await db
    .select()
    .from(scheduledMessages)
    .where(and(
      eq(scheduledMessages.taskId, c.req.param("id")),
      eq(scheduledMessages.status, "pending"),
    ))
    .orderBy(asc(scheduledMessages.sendAt), asc(scheduledMessages.createdAt), asc(scheduledMessages.id));
  return c.json(rows.map(toScheduledMessage));
});

// Cancel a pending scheduled message (by message id).
api.delete("/scheduled-messages/:mid", async (c) => {
  const mid = c.req.param("mid");
  const m = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, mid))).at(0);
  if (!m) return c.json({ error: "not found" }, 404);
  if (m.status !== "pending") return c.json({ error: "只能取消待发送的消息", status: m.status }, 409);
  // 投递租约挂着 = 有人**正在**把原话送进会话:此刻「取消成功」是谎报——原文可能已经
  // 送达并启动了回合,撤不回来(审查实测:cancel 200 而 transcript 已含原文)。取消与
  // beginDelivery 用同一对条件做 CAS(status=pending AND 租约为空),抢到租约的投递者
  // 赢;投递失败会把租约还回来,那时再取消不迟。
  if (m.deliveringSince) {
    return c.json({ error: "消息正在投递中，无法取消；投递失败会自动回到待发送", status: m.status }, 409);
  }
  const canceled = await db.update(scheduledMessages).set({ status: "canceled", deliveringSince: null })
    .where(and(
      eq(scheduledMessages.id, mid),
      eq(scheduledMessages.status, "pending"),
      isNull(scheduledMessages.deliveringSince),
    ))
    .returning({ id: scheduledMessages.id });
  if (!canceled.length) {
    return c.json({ error: "消息刚被开始投递或已发送，本次取消未生效" }, 409);
  }
  publishPendingMessages(m.taskId);
  return c.json({ canceled: true });
});

// Retry a failed duet: re-run only the failed (last) turn, then continue —
// instead of re-running the whole duet. Single tasks just re-run.
api.post("/tasks/:id/retry", async (c) => {
  const taskId = c.req.param("id");
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.archived) return c.json({ error: "任务已归档，先取消归档再重试", archived: true }, 409);
  {
    const blocked = handoffBlockReason(r.handoff);
    if (blocked) return c.json({ error: blocked, handoff: true }, 409);
  }
  if (r.status !== "failed") return c.json({ error: "只有失败的任务可以重试", status: r.status }, 409);
  // 同 /run:原子占位,并发重试只有一个能 202;duet 走同一把锁。
  if (!claimTurn(taskId, r.mode === "duet" ? "duet" : "single")) {
    return c.json({ error: "任务回合正在进行，结束后再重试", status: r.status }, 409);
  }
  // 占位后镜像检查验收锁:否则 runTask/resumeDuet 撞上验收锁静默 return,202 是谎报。
  if (isAcceptingTask(taskId)) {
    releaseTurn(taskId);
    return c.json({ error: "任务正在验收（含发布尾段），结束后再重试", status: r.status }, 409);
  }
  // 「这一次是谁点的」四个人工入口(run / fire / retry / 闸口重放)一个都不能漏:漏掉
  // 就退回任务归属人,于是共享项目里 B 点「重试」烧的是 A 的 key、提交署 A 的名
  // (第 5 轮审查 P1)。
  const acting = ownerIdOf(actorOf(c));
  if (r.mode === "duet") { void resumeDuet(taskId, { turnHeld: true, actingUserId: acting }); return c.json({ started: true }, 202); }
  void resumeOrRunTask(taskId, { reason: "retry", turnHeld: true, actingUserId: acting });
  return c.json({ started: true }, 202);
});

// 重新排队:队列里失败/取消的任务回到 backlog 等待,轮到它时被队列自动拉起
// (有会话就从中断处续跑)。跟「重试」的区别是不插队 —— 重试是立刻跑一遍。
//
// **被越过就排到队尾**:失败任务是被队列「透明跳过」的,后面的早就开跑了,原来
// 那个位置已经名存实亡;留在原位会让它抢在正在跑的那个前面(实测:05 失败 → 06
// 起跑 → 05 重新排队 → 两个一起跑)。反过来,如果后面根本没人跑过(整组还没
// 启动),就原位不动,尊重用户原本编排的顺序。
// 位置计算(isOvertaken/tailOrder)与状态改写在这里一次做完:前端曾用
// 「PATCH backlog + runGroup」两步拼,中间那一瞬间正是并跑窗口。
api.post("/tasks/:id/requeue", async (c) => {
  const taskId = c.req.param("id");
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.archived) return c.json({ error: "任务已归档，先取消归档再重新排队", archived: true }, 409);
  {
    const blocked = handoffBlockReason(r.handoff);
    if (blocked) return c.json({ error: blocked, handoff: true }, 409);
  }
  if (r.status === "running" || r.status === "queued")
    return c.json({ error: "任务正在进行，不需要重新排队", status: r.status }, 409);
  if (r.status !== "failed" && r.status !== "canceled")
    return c.json({ error: "只有失败/已取消的任务需要重新排队", status: r.status }, 409);

  const myItem = (await db.select().from(queueItems).where(eq(queueItems.taskId, taskId))).at(0);
  if (!myItem) return c.json({ error: "任务不在任何队列里，直接点运行即可" }, 400);
  const queueId = myItem.queueId;

  const items = await db
    .select()
    .from(queueItems)
    .where(eq(queueItems.queueId, queueId))
    .orderBy(asc(queueItems.position));
  const rows = await db.select().from(tasks).where(inArray(tasks.id, items.map((i) => i.taskId)));
  const byId = new Map(rows.map((x) => [x.id, x] as const));
  const ordered = items
    .map((i) => byId.get(i.taskId))
    .filter((t): t is typeof tasks.$inferSelect => !!t);

  const movedToEnd = isOvertaken(ordered, taskId);
  if (movedToEnd) await repackQueue(queueId, tailOrder(ordered.map((t) => t.id), taskId));

  await setTaskStatus(taskId, "backlog");
  // 前面若还有人在跑,advanceQueue 会被 selectNextInQueue 的守卫挡住,什么都不做。
  void advanceQueue(queueId);

  const updated = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
  const task = (await enrichTasks([updated]))[0];
  return c.json({ task, movedToEnd, position: task.queuePosition, queueSize: ordered.length });
});

// ── archive / unarchive ──────────────────────────────────────────────────────

// ── HITL gate decision (§7) — 放行 / 打回 / 注入意见 / 提问 ───────────────────
api.post("/tasks/:id/gate", async (c) => {
  const taskId = c.req.param("id");
  const action = await c.req.json<GateAction>();
  if (resolveGate(taskId, action)) return c.json({ ok: true });
  // No in-memory gate (e.g. the server restarted). If the task is still awaiting
  // a decision, resume the duet from the gate and apply the action.
  const t = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (t?.status === "awaiting_review" && t.mode === "duet") {
    // 重启后闸口重放会真的续跑讨论——接力出去的任务不给续(与 /run 同一条硬拦口径)。
    const blocked = handoffBlockReason(t.handoff);
    if (blocked) return c.json({ error: blocked, handoff: true }, 409);
    // 同 /run:先原子占位再启动,占不到说明确有回合在跑(闸口重放会真的续跑讨论)。
    if (!claimTurn(taskId, "duet")) {
      return c.json({ error: "任务回合正在进行，稍后再处理裁决", status: t.status }, 409);
    }
    if (isAcceptingTask(taskId)) {
      releaseTurn(taskId);
      return c.json({ error: "任务正在验收（含发布尾段），结束后再处理裁决", status: t.status }, 409);
    }
    void resumeAtGate(taskId, action, { turnHeld: true, actingUserId: ownerIdOf(actorOf(c)) });
    return c.json({ ok: true, resumed: true });
  }
  // 讨论已经收口后，验收打回仍沿用同一对讨论者和同一份 transcript 回炉；这不是
  // 新开一场讨论，所以复用 gate 的 inject 语义，但只接受会产生新一轮的动作。
  if (t?.mode === "duet" && ["done", "failed", "canceled"].includes(t.status)
    && (action.kind === "inject" || action.kind === "ask")) {
    if (t.stage === "accepted" || t.stage === "merged") {
      return c.json({ error: "讨论已经验收完成；如需继续，请先新开一轮讨论", stage: t.stage }, 409);
    }
    if (t.archived) return c.json({ error: "讨论已归档，先取消归档再继续", archived: true }, 409);
    const blocked = handoffBlockReason(t.handoff);
    if (blocked) return c.json({ error: blocked, handoff: true }, 409);
    if (!claimTurn(taskId, "duet")) {
      return c.json({ error: "讨论回合正在进行，稍后再提交验收意见", status: t.status }, 409);
    }
    if (isAcceptingTask(taskId)) {
      releaseTurn(taskId);
      return c.json({ error: "讨论正在验收，结束后再提交意见", status: t.status }, 409);
    }
    void resumeAtGate(taskId, action, { turnHeld: true, actingUserId: ownerIdOf(actorOf(c)) });
    return c.json({ ok: true, resumed: true, revision: true }, 202);
  }
  return c.json({ error: "no open gate for this task" }, 409);
});

}
