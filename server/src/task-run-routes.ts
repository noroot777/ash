import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentType,
  GateAction,
  QuestionItem,
  ScheduledMessage,
  ScheduledMessageMode,
  ScheduledMessageStatus,
  Session,
  TaskStatus,
} from "@harness/shared";
import {
  AGENT_TYPES,
  MAX_QUESTION_ITEMS,
  MAX_QUESTION_OPTION_LEN,
  MAX_QUESTION_OPTIONS,
  canSingleRun,
} from "@harness/shared";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { bus } from "./bus.js";
import { forceKillCuaService, lastCuaResidualStatus, refreshCuaResidualStatus } from "./cua.js";
import { db } from "./db/index.js";
import { freeReviewResumeOptions } from "./free-workflow.js";
import { isAcceptingTask } from "./acceptance-lock.js";
import { projects, queueItems, schedules, scheduledMessages, sessions, tasks } from "./db/schema.js";
import { resumeDuet, resumeAtGate, runDuet } from "./duet/index.js";
import { resolveGate } from "./duet/gates.js";
import { taskCommits } from "./git.js";
import { continueTask, runTask } from "./orchestrator.js";
import { resumeOrRunTask } from "./task-resume.js";
import { mountTaskArchiveRoutes } from "./task-archive-routes.js";
import { RUNS_DIR } from "./paths.js";
import { enqueueMessage } from "./pending-messages.js";
import { isOvertaken, queueBlockers, repackQueue, tailOrder } from "./queues.js";
import { confirmDone, isTurnClaimed, stopTask } from "./runs.js";
import { advanceQueue } from "./scheduler.js";
import { setTaskStatus } from "./status.js";
import { dispatchWorkers, type DispatchSpec } from "./team/dispatch.js";
import { haltTeam } from "./team/session.js";
import { enrichTasks } from "./task-store.js";
import { askingAgentFor, setTaskQuestion } from "./task-question.js";
import { parseSessionTrace, readableRunPath, sessionTracePath, sessionTranscriptPath } from "./transcript.js";
import { sessionContext, sessionUsage } from "./usage.js";
import { resumeCommandFor } from "./executors/resume.js";
import { sessionRunMeta } from "./session-run-meta.js";
import { id, now } from "./util.js";

export function mountTaskRunRoutes(api: Hono): void {
  mountTaskArchiveRoutes(api);
  const toSession = (
    r: typeof sessions.$inferSelect,
    run: { model: string | null; reasoningEffort: string | null } = { model: null, reasoningEffort: null },
  ): Session => ({
    ...r,
    role: r.role as Session["role"],
    agentType: r.agentType as Session["agentType"],
    transcriptPath: sessionTranscriptPath(r.taskId, r.id),
    resumeCommand: r.cliSessionId
      ? resumeCommandFor(r.agentType, r.target, r.cwd ?? r.worktreePath ?? ".", r.cliSessionId, r.relayEnv)
      : r.resumeCommand,
    ...run,
    usage: sessionUsage(r),
    context: sessionContext(r),
  });
  const toScheduledMessage = (r: typeof scheduledMessages.$inferSelect): ScheduledMessage => ({
    ...r,
    attachments: JSON.parse(r.attachments),
    agent: (r.agent as AgentType) ?? null,
    mode: r.mode as ScheduledMessageMode,
    status: r.status as ScheduledMessageStatus,
  });

// ── sessions (traceability credentials, §13) ───────────────────────────────
api.get("/tasks/:id/sessions", async (c) => {
  const taskId = c.req.param("id");
  const rows = await db.select().from(sessions).where(eq(sessions.taskId, taskId));
  const runMeta = await sessionRunMeta(taskId, rows);
  return c.json(rows.map((row) => toSession(row, runMeta.get(row.id))));
});

// Persisted output of a session (for reloads; live output comes via SSE).
api.get("/sessions/:id/output", async (c) => {
  const sid = c.req.param("id");
  const row = (await db.select().from(sessions).where(eq(sessions.id, sid))).at(0);
  if (!row) return c.json({ error: "not found" }, 404);
  try {
    const text = await readFile(readableRunPath(sessionTranscriptPath(row.taskId, sid)), "utf8");
    return c.text(text);
  } catch {
    return c.text("");
  }
});

// Persisted non-body execution trace. It deliberately lives outside the
// Markdown transcript so reasoning/tool events never become assistant prose.
api.get("/sessions/:id/trace", async (c) => {
  const sid = c.req.param("id");
  const row = (await db.select().from(sessions).where(eq(sessions.id, sid))).at(0);
  if (!row) return c.json({ error: "not found" }, 404);
  try {
    const raw = await readFile(readableRunPath(sessionTracePath(row.taskId, sid)), "utf8");
    return c.json(parseSessionTrace(raw));
  } catch {
    return c.json([]);
  }
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
  // 单条手动 Run：普通任务允许 backlog / canceled / failed / paused。team 的
  // idle 也可运行:它不是终态,只是常驻调度台待命,点击会接回同一 CLI 会话。
  const runnable =
    r.mode === "team"
      ? !["running", "queued", "awaiting_review"].includes(r.status)
      : canSingleRun(r.status as TaskStatus);
  if (!runnable) return c.json({ error: "任务当前状态不可运行", status: r.status }, 409);
  // turn 已被占（claim 到 status 落 running 的窗口）：runTask/continueTask 会被单飞锁
  // 静默挡回，202 就成了谎报「已启动」（审查实测）。团队调度台不占 turn，不受影响。
  if (isTurnClaimed(taskId)) {
    return c.json({ error: "任务回合正在进行（状态尚未落库），结束后再运行", status: r.status }, 409);
  }
  const blockedBy = await queueBlockers(taskId);
  if (blockedBy.length) {
    return c.json(
      { error: "队列前面还有未完成的任务，先把它们处理完或把本任务移出队列", blockedBy },
      409,
    );
  }
  // Fire-and-forget; progress streams over /api/events.
  if (r.mode === "duet") void runDuet(taskId);
  else void resumeOrRunTask(taskId, { reason: "run" });
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
  if (r.status === "running" || r.status === "queued")
    return c.json({ error: "任务正在进行，等它结束再触发新一轮", status: r.status }, 409);
  if (r.status === "awaiting_review")
    return c.json({ error: "任务等待裁决中，先处理裁决再触发", status: r.status }, 409);
  // runTask 遇验收锁/单飞锁会静默 return——202 就成了谎报「已触发一轮全新运行」（审查实测）。
  if (isAcceptingTask(taskId))
    return c.json({ error: "任务正在验收（含发布尾段），结束后再触发", status: r.status }, 409);
  if (isTurnClaimed(taskId))
    return c.json({ error: "任务回合正在进行（状态尚未落库），结束后再触发", status: r.status }, 409);
  const blockedBy = await queueBlockers(taskId);
  if (blockedBy.length) {
    return c.json(
      { error: "队列前面还有未完成的任务，先把它们处理完或把本任务移出队列", blockedBy },
      409,
    );
  }
  if (r.mode === "duet") void runDuet(taskId);
  else void runTask(taskId); // 全新一轮,永不 resume
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
  await db.update(tasks).set({ resumePrompt: rp, updatedAt: now() }).where(eq(tasks.id, taskId));
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
  await db.update(tasks).set({ completeConfirmedAt: now(), updatedAt: now() }).where(eq(tasks.id, taskId));
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
  await setTaskQuestion({ taskId, question: q, options: opts, items: questionItems });
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
api.post("/tasks/:id/answer", async (c) => {
  const taskId = c.req.param("id");
  const b = await c.req.json<{ answer?: string }>().catch(() => ({}) as { answer?: string });
  const a = (b.answer ?? "").trim();
  if (!a) return c.json({ error: "answer 不能为空" }, 400);
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (!r.question) return c.json({ error: "该任务没有待答复的问题", status: r.status }, 409);
  if (r.mode !== "team" && (r.status === "running" || r.status === "queued")) {
    return c.json({ error: "提问回合还没结束,等任务落 paused 再答复", status: r.status }, 409);
  }
  const updatedAt = now();
  // CAS 清问题：两个并发答复都读到 question 后，只有第一个能把它清掉——第二个 UPDATE
  // 影响 0 行，按「已被答复」拒绝。否则两个相互冲突的答案都会启动回合并行执行（审查
  // 实测：两条 transcript 各含 A1/A2）。
  const claimed = await db
    .update(tasks)
    .set({ question: null, questionOptions: null, questionItems: null, updatedAt })
    .where(and(eq(tasks.id, taskId), isNotNull(tasks.question)))
    .returning({ id: tasks.id });
  if (!claimed.length) {
    return c.json({ error: "问题已被答复（可能有并发的另一次答复），本次未投递" }, 409);
  }
  bus.publish({ type: "task.question", taskId, updatedAt, question: null, questionOptions: null, questionItems: null });
  // 调度台不说「完成任务」——它没有完成一说,只是拿到答案接着安排。
  const tail = r.mode === "team" ? "请据此接着安排。" : "请据此继续完成任务。";
  // 送回给提问的那一个:普通任务可以住着好几个 agent(@ 召唤进来的各有会话行),
  // 默认续跑走的是任务常设执行器,那多半不是刚才停下来提问的那个。
  // 只在**类型**不同时才改路由:会话行是按 agentType 找的(continueTask 里的 prev),
  // 同类型换 profile 仍是同一条会话,照任务常设配置续跑即可——显式指定会让这一回合
  // 变成「召唤」,把任务自带的 model/reasoningEffort 一并清掉。
  const asker = r.mode === "single" ? await askingAgentFor(taskId) : null;
  const reviewRoute = asker?.role === "reviewer" ? await freeReviewResumeOptions(taskId) : null;
  const route = reviewRoute ?? (asker && asker.agent !== r.agentType
    ? { agent: asker.agent, executorId: asker.executorId, model: null, reasoningEffort: null }
    : {});
  const answerText = `【答复】你之前的提问:「${r.question}」\n\n${a}\n\n${tail}`;
  // 同 /reply:被单飞锁挡回时答复一个字都没送出去,落成排队消息等任务空下来再发,
  // 绝不静默丢掉(问题已经清了,丢了就是死局——agent 永远等不到答案)。
  void continueTask(taskId, answerText, route).then(async (started) => {
    if (started) return;
    await enqueueMessage({ taskId, text: answerText, ...route });
  });
  return c.json({ answered: true, resumed: true });
});

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
api.post("/tasks/:id/reply", async (c) => {
  const taskId = c.req.param("id");
  const b = await c.req.json<{
    text?: string;
    attachments?: string[];
    agent?: AgentType;
    executorId?: string | null;
    model?: string | null;
    reasoningEffort?: string | null;
    sendAt?: string;
  }>();
  if (!b.text?.trim() && !b.attachments?.length) return c.json({ error: "empty" }, 400);
  if (b.agent && !AGENT_TYPES.includes(b.agent)) return c.json({ error: "未知的 agent", agent: b.agent }, 400);
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.archived) return c.json({ error: "任务已归档，先取消归档再回复", archived: true }, 409);
  const isTeam = r.mode === "team";
  if (!isTeam && r.mode !== "single") return c.json({ error: "仅单任务支持回复" }, 409);
  // 定时发送 / 排队追问:都只是"现在不发",落库交给 pending-messages 投递。
  const queueWhileRunning = !isTeam && (r.status === "running" || r.status === "queued");
  if (b.sendAt || queueWhileRunning) {
    // 排队的 sendAt 不表示"到点才发",只用来排先后,所以取此刻;定时的必须是将来。
    let when = new Date();
    if (b.sendAt) {
      when = new Date(b.sendAt);
      if (Number.isNaN(when.getTime()) || when.getTime() <= Date.now())
        return c.json({ error: "定时时间必须是将来的有效时间" }, 400);
    }
    const row = await enqueueMessage({
      taskId,
      text: (b.text ?? "").trim(),
      attachments: b.attachments,
      agent: b.agent ?? null,
      executorId: b.executorId ?? null,
      model: b.model?.trim() || null,
      reasoningEffort: b.reasoningEffort?.trim() || null,
      mode: b.sendAt ? "timed" : "queued",
      sendAt: when,
    });
    return c.json({ scheduled: true, message: toScheduledMessage(row) }, 202);
  }
  const route = {
    attachments: b.attachments,
    agent: b.agent,
    executorId: b.executorId ?? null,
    model: b.model?.trim() || null,
    reasoningEffort: b.reasoningEffort?.trim() || null,
  };
  // 上面那两道挡板看的是 tasks.status,而单飞锁是内存态的:结算已经把状态落成终态、
  // 这一轮却还没退干净的那道缝里,continueTask 会被挡回并返回 false。**不能就这么把
  // 用户的字丢了** —— 原样落成一条排队消息,任务一空下来照常发出去(托盘也会显示)。
  void continueTask(taskId, (b.text ?? "").trim(), route).then(async (started) => {
    if (started) return;
    await enqueueMessage({ taskId, text: (b.text ?? "").trim(), ...route, agent: b.agent ?? null });
  });
  return c.json({ started: true }, 202);
});

// List a task's pending scheduled messages (soonest first).
api.get("/tasks/:id/scheduled-messages", async (c) => {
  const rows = (await db.select().from(scheduledMessages).where(eq(scheduledMessages.taskId, c.req.param("id"))))
    .filter((m) => m.status === "pending")
    .sort((a, b) => a.sendAt.localeCompare(b.sendAt));
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
  return c.json({ canceled: true });
});

// Retry a failed duet: re-run only the failed (last) turn, then continue —
// instead of re-running the whole duet. Single tasks just re-run.
api.post("/tasks/:id/retry", async (c) => {
  const taskId = c.req.param("id");
  const r = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!r) return c.json({ error: "not found" }, 404);
  if (r.archived) return c.json({ error: "任务已归档，先取消归档再重试", archived: true }, 409);
  if (r.status !== "failed") return c.json({ error: "只有失败的任务可以重试", status: r.status }, 409);
  if (isTurnClaimed(taskId)) {
    return c.json({ error: "任务回合正在进行（状态尚未落库），结束后再重试", status: r.status }, 409);
  }
  if (r.mode === "duet") void resumeDuet(taskId);
  else void resumeOrRunTask(taskId, { reason: "retry" });
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
    void resumeAtGate(taskId, action);
    return c.json({ ok: true, resumed: true });
  }
  return c.json({ error: "no open gate for this task" }, 409);
});

// ── schedules (§9) — one schedule per task ──────────────────────────────────
api.get("/tasks/:id/schedule", async (c) => {
  const row = (await db.select().from(schedules).where(eq(schedules.taskId, c.req.param("id")))).at(0);
  return c.json(row ?? null);
});

api.put("/tasks/:id/schedule", async (c) => {
  const taskId = c.req.param("id");
  const t = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (t?.archived) return c.json({ error: "任务已归档，不能设置定时", archived: true }, 409);
  const b = await c.req.json<{ kind: "once" | "cron"; at?: string | null; cron?: string | null; enabled?: boolean }>();
  const existing = (await db.select().from(schedules).where(eq(schedules.taskId, taskId))).at(0);
  const row = {
    id: existing?.id ?? id(),
    taskId,
    kind: b.kind,
    at: b.at ?? null,
    cron: b.cron ?? null,
    enabled: b.enabled ?? true,
    lastRunAt: null,
    createdAt: existing?.createdAt ?? now(),
  };
  if (existing) await db.update(schedules).set(row).where(eq(schedules.id, existing.id));
  else await db.insert(schedules).values(row);
  await db.update(tasks).set({ scheduleId: row.id, updatedAt: now() }).where(eq(tasks.id, taskId));
  return c.json(row);
});

api.delete("/tasks/:id/schedule", async (c) => {
  await db.delete(schedules).where(eq(schedules.taskId, c.req.param("id")));
  await db.update(tasks).set({ scheduleId: null, updatedAt: now() }).where(eq(tasks.id, c.req.param("id")));
  return c.json({ deleted: true });
});

// Commits produced on a task's isolated worktree branch. Empty when the task ran
// in place (no worktree).
api.get("/tasks/:id/commits", async (c) => {
  const tid = c.req.param("id");
  const t = (await db.select().from(tasks).where(eq(tasks.id, tid))).at(0);
  if (!t) return c.json({ error: "not found" }, 404);
  const project = (await db.select().from(projects).where(eq(projects.id, t.projectId))).at(0);
  const sess = (await db.select().from(sessions).where(eq(sessions.taskId, tid))).find((s) => s.worktreePath);
  if (!sess?.worktreePath || !project) return c.json({ branch: null, commits: [] });
  return c.json(await taskCommits(sess.worktreePath, project.repoPath, t.worktreeBase));
});

}
