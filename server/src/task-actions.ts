// 任务「此刻能做什么」的下发通道：取事实 → 跑判据（task-action-verdicts.ts / task-retry-turn.ts
// 的 `retryTurnRejection`）→ `GET /tasks/:id/actions` 取一次、`task.actions` 事件推送。
//
// **推给谁**：只推「有页面打开过」的那些任务（`watched`，按最近打开排、留最近的一批）。前端只有
// 打开着的那个任务需要这份结论（详情头、回复框、信息格、审查格、命令面板都只看当前任务），给一千
// 多行全量重算只是白费。
//
// **什么时候重算**：这个任务自己的事件（状态、阶段、提问、审查链、整行更新）；同队成员的这些事件
// （队列挡路是别人的状态）；它的历史独立审查任务的事件（「已有一轮审查尚未结束」）；分组暂停 /
// 恢复（`markGroupActionsDirty`）；执行器 profile 被改或删（重跑上一回合的保真前提）。同一拍里的
// 多条事件合成一次。
import type { Hono } from "hono";
import type { PrimaryAction, RetryTurnAction, ServerEvent, TaskActions } from "@ash/shared";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { queueItems, tasks } from "./db/schema.js";
import { actorOf } from "./auth/context.js";
import { canSeeProject } from "./auth/visibility.js";
import { hasActiveFreeReview } from "./free-workflow.js";
import { latestRun, roundOf } from "./free-review-round.js";
import { reviewRetryGeneration } from "./free-review-retry-identity.js";
import { queueBlockerDetails } from "./queues.js";
import { isRunning } from "./runs.js";
import {
  archiveVerdict, primaryAction, publicVerdict, requeueVerdict, stopVerdict, verifyVerdict, type ActionFacts,
} from "./task-action-verdicts.js";
import { readRetryTurnFacts, retryTurnRejection, retryTurnTaskRejection } from "./task-retry-turn.js";
import { onTaskActionsDirty } from "./task-actions-dirty.js";

type TaskRow = typeof tasks.$inferSelect;

const LEGACY_REVIEW_IN_FLIGHT = ["backlog", "queued", "running", "paused"];

/** 判据要的全部事实。路由与下发共用这一个读法。 */
export async function readActionFacts(row: TaskRow): Promise<ActionFacts> {
  const inQueue = (await db.select({ id: queueItems.taskId }).from(queueItems).where(eq(queueItems.taskId, row.id))).length > 0;
  const parent = row.parentId
    ? (await db.select({ mode: tasks.mode }).from(tasks).where(eq(tasks.id, row.parentId))).at(0)
    : undefined;
  const legacy = await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.reviewOf, row.id));
  return {
    task: row,
    inQueue,
    blockedBy: inQueue ? await queueBlockerDetails(row.id) : [],
    liveProcess: isRunning(row.id),
    parentIsTeam: parent?.mode === "team",
    freeReviewActive: row.workflowMode === "free" ? await hasActiveFreeReview(row.id) : false,
    legacyReviewActive: legacy.some((review) => LEGACY_REVIEW_IN_FLIGHT.includes(review.status)),
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
    stop: publicVerdict(stopVerdict(facts)),
    archive: publicVerdict(archiveVerdict(facts)),
    requeue: publicVerdict(requeueVerdict(facts)),
    retryTurn: await retryTurnAction(row),
    verify: publicVerdict(verifyVerdict(facts)),
  };
}

// ── 推送 ─────────────────────────────────────────────────────────────────────

const WATCH_LIMIT = 64;
const watched = new Map<string, true>();

function watch(taskId: string): void {
  watched.delete(taskId);
  watched.set(taskId, true);
  while (watched.size > WATCH_LIMIT) watched.delete(watched.keys().next().value!);
}

const dirty = new Set<string>();
const dirtyGroups = new Set<string>();
let everything = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function schedule(): void {
  if (timer || !watched.size) return;
  timer = setTimeout(() => { timer = null; void flush().catch((error) => console.error("[ash] 重算任务可做动作失败:", error)); }, 30);
}

const TRIGGERS = new Set<ServerEvent["type"]>(["task.created", "task.updated", "task.status", "task.stage", "task.question", "task.review"]);

function eventTaskId(event: ServerEvent): string | null {
  if (!TRIGGERS.has(event.type)) return null;
  if ("task" in event && event.task) return event.task.id;
  return "taskId" in event && typeof event.taskId === "string" ? event.taskId : null;
}

/** 这一批脏任务牵连到的、有页面在看的任务。 */
async function affected(ids: string[], groupIds: string[], all: boolean): Promise<string[]> {
  if (all) return [...watched.keys()];
  const out = new Set(ids.filter((id) => watched.has(id)));
  if (ids.length) {
    const queues = await db.select({ queueId: queueItems.queueId }).from(queueItems).where(inArray(queueItems.taskId, ids));
    if (queues.length) {
      const mates = await db.select({ taskId: queueItems.taskId }).from(queueItems)
        .where(inArray(queueItems.queueId, [...new Set(queues.map((q) => q.queueId))]));
      for (const mate of mates) if (watched.has(mate.taskId)) out.add(mate.taskId);
    }
    const reviewed = await db.select({ reviewOf: tasks.reviewOf }).from(tasks)
      .where(and(inArray(tasks.id, ids), isNotNull(tasks.reviewOf)));
    for (const row of reviewed) if (row.reviewOf && watched.has(row.reviewOf)) out.add(row.reviewOf);
  }
  if (groupIds.length) {
    const members = await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.groupId, groupIds));
    for (const member of members) if (watched.has(member.id)) out.add(member.id);
  }
  return [...out];
}

async function flush(): Promise<void> {
  const ids = [...dirty];
  const groupIds = [...dirtyGroups];
  const all = everything;
  dirty.clear();
  dirtyGroups.clear();
  everything = false;
  const targets = await affected(ids, groupIds, all);
  for (const taskId of targets) {
    const actions = await computeTaskActions(taskId);
    if (actions) bus.publish({ type: "task.actions", taskId, actions });
  }
}

let started = false;

function startFeed(): void {
  if (started) return;
  started = true;
  bus.subscribe((event) => {
    const taskId = eventTaskId(event);
    if (!taskId) return;
    dirty.add(taskId);
    schedule();
  });
  onTaskActionsDirty((mark) => {
    if (mark.kind === "all") everything = true;
    else dirtyGroups.add(mark.groupId);
    schedule();
  });
}

export function mountTaskActionRoutes(api: Hono): void {
  startFeed();
  api.get("/tasks/:id/actions", async (c) => {
    const taskId = c.req.param("id");
    const row = (await db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId))).at(0);
    // 看不见的任务与不存在的任务回同一句话（同 GET /tasks/:id）。
    if (!row || !(await canSeeProject(actorOf(c), row.projectId))) return c.json({ error: "not found" }, 404);
    watch(taskId);
    const actions = await computeTaskActions(taskId);
    return actions ? c.json(actions) : c.json({ error: "not found" }, 404);
  });
}
