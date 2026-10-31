import type {
  AgentType,
  GateAction,
  ScheduledMessage,
  ScheduledMessageMode,
  ScheduledMessageStatus,
  TaskStatus,
} from "@ash/shared";
import {
  canSingleRun,
} from "@ash/shared";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Hono } from "hono";
import { forceKillCuaService, lastCuaResidualStatus, refreshCuaResidualStatus } from "./cua.js";
import { db } from "./db/index.js";
import { isAcceptingTask } from "./acceptance-lock.js";
import { queueItems, scheduledMessages, tasks } from "./db/schema.js";
import { resumeDuet, resumeAtGate, runDuet } from "./duet/index.js";
import { readDuetTurns } from "./duet/transcript-reads.js";
import { resolveGate } from "./duet/gates.js";
import { runTask } from "./orchestrator.js";
import { resumeOrRunTask } from "./task-resume.js";
import { preparePendingCheckpointStart, recoverPendingCheckpoints } from "./pending-checkpoint-recovery.js";
import { cancelQueueAdvance } from "./queue-advance-retry.js";
import { mountTaskArchiveRoutes } from "./task-archive-routes.js";
import { confirmTaskComplete } from "./task-complete.js";
import { mountTaskRetryTurnRoutes } from "./task-retry-turn.js";
import { mountTaskScheduleRoutes } from "./task-schedule-routes.js";
import { mountTaskSessionRoutes } from "./task-session-routes.js";
import { mountTaskSteerRoutes } from "./task-steer.js";
import { publishPendingMessages } from "./pending-messages.js";
import { isOvertaken, queueBlockers, repackQueue, tailOrder } from "./queues.js";
import { queueClaimError, seatThenStart } from "./queue-seat.js";
import { claimTurn, releaseTurn, stopTask } from "./runs.js";
import { handoffBlockReason } from "./handoff-guard.js";
import { advanceQueueInBackground } from "./scheduler.js";
import { setTaskStatus } from "./status.js";
import { replyToTask } from "./task-reply.js";
import { dispatchWorkers, type DispatchSpec } from "./team/dispatch.js";
import { haltTeam } from "./team/session.js";
import { enrichTasks } from "./task-store.js";
import { mountTaskQuestionRoutes } from "./task-question-routes.js";
import { occupyResumePrompt } from "./task-resume-prompt.js";
import { actorOf, ownerIdOf } from "./auth/context.js";

// 手动启动入口的队列认领失败话术(/run、/fire、/retry、重跑上一回合共用,
// 本体在 queue-seat.ts 的 queueClaimError:transient 故障必须说真话)。

// 起跑占位(/run、/fire、/retry 的最后一道)住在 queue-seat.ts 的 seatThenStart:整队
// 检查与落 queued 在同一临界区里,且与消息补投扫描、重跑上一回合、定时到点、队列推进
// 共用同一条认领链。路由前面那次 queueBlockers 只是无互斥的快速失败;seatThenStart
// 才是权威认领 —— 检查到落库之间的 await 窗口里,并发的另一个入口(哪怕只占了任务级
// 回合锁、状态还停在终态)刚认领的占位在链上立刻可见,整队在跑守卫不再被双双穿过
// (第 6/7 轮审查)。

export function mountTaskRunRoutes(api: Hono): void {
  mountTaskArchiveRoutes(api);
  mountTaskRetryTurnRoutes(api);
  mountTaskScheduleRoutes(api);
  mountTaskSessionRoutes(api);
  mountTaskSteerRoutes(api);
  mountTaskQuestionRoutes(api);
  const toScheduledMessage = (r: typeof scheduledMessages.$inferSelect): ScheduledMessage => ({
    ...r,
    attachments: JSON.parse(r.attachments),
    agent: (r.agent as AgentType) ?? null,
    // 托盘据此把「审查链自己的答复」和用户手写的回复分开（见 shared/src/schedule.ts）。
    sessionRole: (r.sessionRole as ScheduledMessage["sessionRole"]) ?? null,
    mode: r.mode as ScheduledMessageMode,
    status: r.status as ScheduledMessageStatus,
  });

// Persisted duet transcript (rebuilds the timeline on reload, §12). 读取、老事件名归一
// 与「这些回合里的图补上任务归属」都在 duet/transcript-reads.ts。
api.get("/tasks/:id/duet", async (c) => c.json(await readDuetTurns(c.req.param("id"))));

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
  const checkpointBlocked = await preparePendingCheckpointStart(taskId);
  if (checkpointBlocked) return c.json({ error: checkpointBlocked, checkpoint: true }, 409);
  const blockedBy = await queueBlockers(taskId);
  if (blockedBy.length) {
    return c.json(
      { error: "同一队列里还有未完成或正在运行的任务，先等它们结束、处理完，或把本任务移出队列", blockedBy },
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
  // 起跑占位 + 启动:认领队列执行占位后才真正拉起(见 seatThenStart 顶注)。
  const acting = ownerIdOf(actorOf(c));
  const started = await seatThenStart(taskId, () =>
    r.mode === "duet"
      ? runDuet(taskId, { turnHeld: true, actingUserId: acting })
      : resumeOrRunTask(taskId, { reason: "run", turnHeld: true, actingUserId: acting }));
  if (!started.ok) {
    return c.json({ error: queueClaimError(started), blockedBy: started.blockers }, 409);
  }
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
  const checkpointBlocked = await preparePendingCheckpointStart(taskId);
  if (checkpointBlocked) return c.json({ error: checkpointBlocked, checkpoint: true }, 409);
  // runTask 遇验收锁/单飞锁会静默 return——202 就成了谎报「已触发一轮全新运行」（审查实测）。
  if (isAcceptingTask(taskId))
    return c.json({ error: "任务正在验收（含发布尾段），结束后再触发", status: r.status }, 409);
  const blockedBy = await queueBlockers(taskId);
  if (blockedBy.length) {
    return c.json(
      { error: "同一队列里还有未完成或正在运行的任务，先等它们结束、处理完，或把本任务移出队列", blockedBy },
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
  // 起跑占位 + 启动,理由同 /run(检查与占位同临界区,堵并发双跑窗口)。
  const firedBy = ownerIdOf(actorOf(c));
  const fired = await seatThenStart(taskId, () =>
    r.mode === "duet"
      ? runDuet(taskId, { turnHeld: true, actingUserId: firedBy })
      : runTask(taskId, { turnHeld: true, actingUserId: firedBy })); // 全新一轮,永不 resume
  if (!fired.ok) {
    return c.json({ error: queueClaimError(fired), blockedBy: fired.blockers }, 409);
  }
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
  if (await cancelQueueAdvance(taskId)) return c.json({ stopped: true, note: "已撤销待启动的队列运行请求" });
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
  // `auto: false` = 这段是 agent 自己写的,系统不许替它清掉（见 task-resume-prompt.ts 文件头）。
  //
  // **这一笔必须走存储层的 writer**,不许在这里自己 `db.update`:那样代次不会 +1,而代次正是
  // 「这一格现在是第几次占用」这个归属判据的本体。实测过的现场:写下一段新的主动暂停后代次仍
  // 是 1,于是一个在途的旧凭证合法地填回来、占住位置,真正新的那一段再也退不回去（第 3 轮审查
  // F1-A `F2_HTTP_PAUSE_GENERATION_BYPASS`）。身份 CAS 跟这一笔写在同一条语句里（见那一层）；
  // 整行广播也在那一层，前端的派审/预约/修复入口靠这一列灰掉。
  const occupied = await occupyResumePrompt(taskId, rp, false, [
    eq(tasks.status, "running"),
    r.activeTurnToken === null
      ? isNull(tasks.activeTurnToken)
      : eq(tasks.activeTurnToken, r.activeTurnToken),
    r.activeDirectionToken === null
      ? isNull(tasks.activeDirectionToken)
      : eq(tasks.activeDirectionToken, r.activeDirectionToken),
  ]);
  if (!occupied) return c.json({ error: "当前回合已经结束或已被引导，检查点未写入" }, 409);
  return c.json({ paused: true, willSettleAs: "paused" });
});

// 完成确认(严格 done 协议,对称 /pause):agent 当且仅当确定任务目标已达成时
// 调用;settle 时消费这个标记才落 done,否则 exit 0 也按 failed 结算(exit 0
// 只证明进程正常退出,agent 报错后退出照样 exit 0 —— 假 done 会误推进队列)。
// 只接受 running 任务。**同时落库 + 置内存标记**:确认走 HTTP 打到监听进程,
// 而跑这个回合的未必是同一个进程(历史事故:僵尸实例在跑,确认落在监听进程的
// 内存里,结算那边什么都没看见,agent 明明确认了却记 failed)。落库那份是权威,
// settle 两边任一命中即算确认(见 orchestrator.settleTaskStatus)。
// **名下还挂着会被这次完成毁掉的哨兵时一律拒绝**(见 task-complete-monitors.ts)。
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
  // ── 落确认走共用入口（task-complete.ts）──────────────────────────────────────
  // 身份校验留在这里（这一条通道独有的口径、独有的措辞），闸和落库那一段必须共用 ——
  // 补录那条旁路就是因为「只在这里问了一次」才走穿了整条不变量（第 1 轮审查 F1）。
  // 排在令牌校验**之后**：身份没对上的请求连「你名下有哪几个哨兵」都不该看见。
  const confirm = await confirmTaskComplete({
    taskId,
    where: [
      eq(tasks.status, "running"),
      r.activeTurnToken === null
        ? isNull(tasks.activeTurnToken)
        : eq(tasks.activeTurnToken, r.activeTurnToken),
      r.activeDirectionToken === null
        ? isNull(tasks.activeDirectionToken)
        : eq(tasks.activeDirectionToken, r.activeDirectionToken),
    ],
    staleError: "当前回合已经结束或已被引导，完成确认未写入",
  });
  if (!confirm.ok) return c.json({ error: confirm.error }, 409);
  // **`willSettleAs` 得跟结算真会落的那个一致**(第 2 轮审查 R2-2:这里回 done、实际落 paused,
  // agent 据此以为活干完了)。结算的优先级是「提问 > 检查点 > 完成」(settle-status.ts):手里
  // 还攥着一段续跑指令,这一轮就落 paused。系统为哨兵写的那段已经在闸放行时清掉了,所以能
  // 走到这里还剩下的,是 agent 自己 `pause_task` 写的那一段 —— 它比我们更知道它想干什么,
  // 不动它,只是别谎称这一轮会落 done。
  const after = (await db
    .select({
      resumePrompt: tasks.resumePrompt, question: tasks.question, followUpFrom: tasks.followUpFrom,
    })
    .from(tasks).where(eq(tasks.id, taskId))).at(0);
  // **续聊回合走的是另一条分支**(第 1 轮审查 N2):那一支里「本回合亲口确认」优先于一切 ——
  // 检查点被这一轮消费掉、任务直接落 done(settle-status.ts 的 `followUpFrom` 分支)。拿普通
  // 回合的「提问/检查点优先」去预告它,就会说「将暂停」而实际落 done。
  if (after?.followUpFrom) return c.json({ confirmed: true, willSettleAs: "done" });
  if (after?.question) {
    return c.json({
      confirmed: true,
      willSettleAs: "paused",
      note: "确认已记下,但你这一轮还留着一个待答复的提问,所以这一轮会落「已暂停」等答复;"
        + "答复回来会续跑同一条会话。",
    });
  }
  if (after?.resumePrompt) {
    return c.json({
      confirmed: true,
      willSettleAs: "paused",
      note: "确认已记下,但你这一轮还留着一段续跑指令(pause_task),结算把检查点排在完成之前,"
        + "所以这一轮会落「已暂停」。真要收工就别再留检查点。",
    });
  }
  // 续聊回合(followUpFrom 非空)确认完成 = 把任务推进到 done;正常回合就是 done。
  return c.json({ confirmed: true, willSettleAs: "done" });
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
  await recoverPendingCheckpoints(m.taskId);
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
  const checkpointBlocked = await preparePendingCheckpointStart(taskId);
  if (checkpointBlocked) return c.json({ error: checkpointBlocked, checkpoint: true }, 409);
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
  // 起跑占位 + 启动,同 /run:失败成员的重试也是一次执行,同队有人在跑/已占位时不得
  // 再起第二个 —— 此前这里连队列检查都没有,是与第 7 轮审查同类的跨入口窗口。
  const started = await seatThenStart(taskId, () =>
    r.mode === "duet"
      ? resumeDuet(taskId, { turnHeld: true, actingUserId: acting })
      : resumeOrRunTask(taskId, { reason: "retry", turnHeld: true, actingUserId: acting }));
  if (!started.ok) {
    return c.json({ error: queueClaimError(started), blockedBy: started.blockers }, 409);
  }
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
  advanceQueueInBackground(queueId);

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
