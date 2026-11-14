// 任务「此刻能做什么」的下发通道：取事实 → 跑判据（task-action-verdicts.ts / task-retry-turn.ts
// 的 `retryTurnRejection`）→ `GET /tasks/:id/actions`。结论只在这里算、只随请求下发；事实变了的时候
// 服务端只广播「重取一下」（task-actions-feed.ts），算一遍的永远是开着那个任务的页面发来的这次请求。
import type { Hono } from "hono";
import type { PrimaryAction, RetryTurnAction, TaskActions, TaskStatus } from "@ash/shared";
import { and, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { groups, queueItems, tasks } from "./db/schema.js";
import { actorOf } from "./auth/context.js";
import { rememberTaskProject } from "./auth/event-filter.js";
import { canSeeProject } from "./auth/visibility.js";
import { hasActiveFreeReview } from "./free-workflow.js";
import { latestRun, roundOf } from "./free-review-round.js";
import { reviewRetryGeneration } from "./free-review-retry-identity.js";
import { queueBlockerDetails } from "./queues.js";
import { isRunning } from "./runs.js";
import {
  archiveVerdict, primaryAction, publicVerdict, requeueVerdict, stopVerdict, teamHaltVerdict, verifyVerdict,
  type ActionFacts,
} from "./task-action-verdicts.js";
import { readRetryTurnFacts, retryTurnRejection, retryTurnTaskRejection } from "./task-retry-turn.js";
import { startTaskActionsFeed } from "./task-actions-feed.js";

type TaskRow = typeof tasks.$inferSelect;

const LEGACY_REVIEW_IN_FLIGHT = ["backlog", "queued", "running", "paused"];

/** 判据要的全部事实。路由与下发共用这一个读法。 */
export async function readActionFacts(row: TaskRow): Promise<ActionFacts> {
  const inQueue = (await db.select({ id: queueItems.taskId }).from(queueItems).where(eq(queueItems.taskId, row.id))).length > 0;
  const parent = row.parentId
    ? (await db.select({ mode: tasks.mode }).from(tasks).where(eq(tasks.id, row.parentId))).at(0)
    : undefined;
  const legacy = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.reviewOf, row.id));
  const team = row.mode === "team"
    ? {
      workers: (await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.parentId, row.id)))
        .map((worker) => ({ status: worker.status as TaskStatus })),
      groupsPaused: (await db.select({ id: groups.id }).from(groups)
        .where(and(eq(groups.ownerTaskId, row.id), eq(groups.paused, true)))).length > 0,
    }
    : null;
  return {
    task: row,
    inQueue,
    blockedBy: inQueue ? await queueBlockerDetails(row.id) : [],
    liveProcess: isRunning(row.id),
    parentIsTeam: parent?.mode === "team",
    freeReviewActive: row.workflowMode === "free" ? await hasActiveFreeReview(row.id) : false,
    legacyReviewActive: legacy.some((review) => LEGACY_REVIEW_IN_FLIGHT.includes(review.status)),
    team,
  };
}

/**
 * 重跑上一回合下发哪一档。先问普通回合（上一回合崩了的那条会话），它不该出键时再问审查档（审查
 * 链停在「异常结束 / 等你拿主意」的那一轮）—— 顺序跟用户眼前的事一致：上一回合是一次崩掉的普通
 * 回合时，那颗「重试这一回合」才是该点的。两档都是 `retryTurnRejection` 判的，路由同一份。
 */
async function retryTurnAction(row: TaskRow): Promise<RetryTurnAction | null> {
  if (retryTurnTaskRejection(row)) return null;
  const turn = await readRetryTurnFacts(row.id);
  if (turn?.kind === "turn" && turn.latest) {
    const rejection = retryTurnRejection(turn.facts);
    if (!rejection?.hidden) {
      const target = { kind: "turn" as const, sessionId: turn.latest.id };
      return rejection ? { ...target, ok: false, reason: rejection.error } : { ...target, ok: true };
    }
  }
  if (row.workflowMode !== "free") return null;
  const run = await latestRun(row.id);
  const round = run ? await roundOf(run) : null;
  const retry = run && round ? await reviewRetryGeneration(row, run, round) : null;
  if (!run || !round || !retry) return null;
  const review = { runId: run.id, round: round.round, generation: retry.generation };
  const facts = await readRetryTurnFacts(row.id, { review });
  const rejection = facts ? retryTurnRejection(facts.facts) : null;
  if (rejection?.hidden) return null;
  const target = { kind: "review" as const, review: { ...review, sessionId: retry.sessionId } };
  return rejection ? { ...target, ok: false, reason: rejection.error } : { ...target, ok: true };
}

// 只增不减（跨重启也是：拿墙钟打底），前端据此丢掉迟到的旧结论。
let lastSeq = 0;
const nextSeq = () => (lastSeq = Math.max(Date.now(), lastSeq + 1));

export async function computeTaskActions(taskId: string): Promise<TaskActions | null> {
  const row = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!row) return null;
  const facts = await readActionFacts(row);
  const primary: PrimaryAction | null = primaryAction(facts);
  return {
    taskId,
    seq: nextSeq(),
    primary,
    // 团队的「停止」是停止全组（POST /tasks/:id/team/halt），判据按整个团队算。
    stop: publicVerdict(row.mode === "team" ? teamHaltVerdict(facts) : stopVerdict(facts)),
    archive: publicVerdict(archiveVerdict(facts)),
    requeue: publicVerdict(requeueVerdict(facts)),
    retryTurn: await retryTurnAction(row),
    verify: publicVerdict(verifyVerdict(facts)),
  };
}

export function mountTaskActionRoutes(api: Hono): void {
  startTaskActionsFeed();
  api.get("/tasks/:id/actions", async (c) => {
    const taskId = c.req.param("id");
    const row = (await db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId))).at(0);
    // 看不见的任务与不存在的任务回同一句话（同 GET /tasks/:id）。
    if (!row || !(await canSeeProject(actorOf(c), row.projectId))) return c.json({ error: "not found" }, 404);
    // 多人模式下 SSE 过滤器按任务认项目、缓存没命中的第一条事件会丢：这里已经读到了，顺手记上，
    // 免得这个任务的第一条失效信号送不到正开着它的这张页面。
    rememberTaskProject(taskId, row.projectId);
    const actions = await computeTaskActions(taskId);
    return actions ? c.json(actions) : c.json({ error: "not found" }, 404);
  });
}
