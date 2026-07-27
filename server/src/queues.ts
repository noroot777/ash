// 队列(queue)这一层的全部 HTTP 端点 + 共享 helper。
// queue 是有序的 task id 列表(顺序依赖原语,DESIGN-scheduling.md §1):前一个
// done/canceled/failed 后,后一个自动启动。
// 不变量:
//   ① 同一 queue 内所有 task 必须在同一个 group(或都无 group)——应用层校验;
//   ② 同一 queue 同一时刻至多一个成员在跑——守卫在 selectNextInQueue(scheduler.ts)。
// 推进规则本身不在这里,统一由 scheduler.ts 的 advanceQueue 负责;本文件只做
// 「改队列内容」并在改完推一把。
import type { Hono } from "hono";
import { eq, and, lt, asc, inArray } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks, queueItems } from "./db/schema.js";
import { id, now } from "./util.js";
import { advanceQueue, queueStatus } from "./scheduler.js";

// 内部:把 (queueId, [..items..]) 重排成 position 0..N-1,保持 dense
export async function repackQueue(queueId: string, orderedTaskIds: string[]): Promise<void> {
  const ts = now();
  // 先全删,再按新顺序插入(libsql 没有 batch txn 暴露,但 queue 通常很小)
  await db.delete(queueItems).where(eq(queueItems.queueId, queueId));
  if (orderedTaskIds.length === 0) return;
  await db.insert(queueItems).values(
    orderedTaskIds.map((tid, i) => ({
      taskId: tid,
      queueId,
      position: i,
      createdAt: ts,
    })),
  );
}

// 校验:queue 里所有 task 必须同 group(或都无 group)
async function assertSameGroup(queueId: string, candidateTaskId?: string): Promise<string | null> {
  const items = await db.select().from(queueItems).where(eq(queueItems.queueId, queueId));
  const taskIds = [...items.map((i) => i.taskId), ...(candidateTaskId ? [candidateTaskId] : [])];
  if (taskIds.length === 0) return null;
  const rows = await db.select().from(tasks).where(inArray(tasks.id, taskIds));
  const groups = new Set(rows.map((r) => r.groupId));
  if (groups.size > 1) {
    return `跨 group 不允许:queue ${queueId} 涉及多个 group ${[...groups].join(", ")}`;
  }
  return null;
}

// 队列前置检查:task 在某个 queue 里时,前面所有 item 必须已让位才允许单独启动,
// 否则等于绕过队列顺序。/run 与 /fire 共用。返回挡路的任务 id。
// 「让位」的判定跟 selectNextInQueue 的透明跳过**同源**:done / canceled / failed
// 三种都不算挡路 —— 自动推进会跳过失败的继续跑,人手动点运行却被拦住是两套说法。
// 状态一律过 queueStatus():前面那位若正在「续聊」(终态任务的追加对话),按它
// 续聊前的终态算,一段闲聊不该把后面的人挡住。
export async function queueBlockers(taskId: string): Promise<string[]> {
  const myItem = (
    await db.select().from(queueItems).where(eq(queueItems.taskId, taskId))
  ).at(0);
  if (!myItem) return [];
  const before = await db
    .select()
    .from(queueItems)
    .where(and(eq(queueItems.queueId, myItem.queueId), lt(queueItems.position, myItem.position)))
    .orderBy(asc(queueItems.position));
  if (!before.length) return [];
  const beforeTasks = await db
    .select()
    .from(tasks)
    .where(inArray(tasks.id, before.map((i) => i.taskId)));
  return beforeTasks
    .filter((t) => {
      const s = queueStatus(t);
      return !t.archived && s !== "done" && s !== "canceled" && s !== "failed";
    })
    .map((t) => t.id);
}

// ── 重新排队(requeue)的两个纯函数 ────────────────────────────────────────────
// isOvertaken / tailOrder 都不碰 DB,单测直接喂字面量(scripts/test-queue-order.ts)。

// 「被越过」= 队列里排在它后面的成员中,有人已经开跑过。
// 判定用 startedAt 非空(setTaskStatus 在 → running 时盖章),外加此刻
// running/queued —— queued 是"已被拉起、还没 spawn",还没盖 startedAt。
// 用途:失败任务重新排队时,被越过就该去队尾(前面的位置已经名存实亡),
// 没被越过就原位不动(整组还没启动时保持用户原本编排的顺序)。
export function isOvertaken(
  rows: { id: string; status: string; startedAt: string | null }[],
  taskId: string,
): boolean {
  const idx = rows.findIndex((t) => t.id === taskId);
  if (idx < 0) return false;
  return rows
    .slice(idx + 1)
    .some((t) => !!t.startedAt || t.status === "running" || t.status === "queued");
}

// 把 taskId 移到末位,其余成员保持原相对顺序。
export function tailOrder(orderedIds: string[], taskId: string): string[] {
  if (!orderedIds.includes(taskId)) return orderedIds;
  return [...orderedIds.filter((x) => x !== taskId), taskId];
}

// ── 端点 ─────────────────────────────────────────────────────────────────────
export function mountQueueRoutes(api: Hono): void {
  // 列出某 queue 的内容(含每个 task 的状态)
  api.get("/queues/:queueId", async (c) => {
    const qid = c.req.param("queueId");
    const items = await db
      .select()
      .from(queueItems)
      .where(eq(queueItems.queueId, qid))
      .orderBy(asc(queueItems.position));
    if (items.length === 0) return c.json({ error: "queue not found" }, 404);
    const rows = await db.select().from(tasks).where(inArray(tasks.id, items.map((i) => i.taskId)));
    const byId = new Map(rows.map((r) => [r.id, r] as const));
    const groupId = rows[0]?.groupId ?? null;
    return c.json({
      queueId: qid,
      groupId,
      items: items.map((i) => {
        const t = byId.get(i.taskId);
        return {
          taskId: i.taskId,
          position: i.position,
          title: t?.title ?? "",
          status: t?.status ?? null,
          archived: t?.archived ?? false,
        };
      }),
    });
  });

  // 整批 reorder:body 必须是 queue 完整成员的新顺序(防止漏掉或重复)
  api.post("/queues/:queueId/reorder", async (c) => {
    const qid = c.req.param("queueId");
    const b = await c.req.json<{ taskIds?: string[] }>();
    const want = b.taskIds ?? [];
    if (!Array.isArray(want)) return c.json({ error: "taskIds 必须是数组" }, 400);

    const current = await db.select().from(queueItems).where(eq(queueItems.queueId, qid));
    if (current.length === 0) return c.json({ error: "queue not found" }, 404);

    const haveSet = new Set(current.map((i) => i.taskId));
    const wantSet = new Set(want);
    if (haveSet.size !== wantSet.size || [...haveSet].some((id) => !wantSet.has(id))) {
      return c.json(
        {
          error: "reorder 必须传 queue 的完整成员,不能漏或多",
          have: [...haveSet],
          got: [...wantSet],
        },
        400,
      );
    }

    // running task 不能被移走/前面新插队
    const taskRows = await db.select().from(tasks).where(inArray(tasks.id, want));
    const runningId = taskRows.find((t) => t.status === "running" || t.status === "queued")?.id;
    if (runningId) {
      const oldPos = current.find((i) => i.taskId === runningId)!.position;
      const newPos = want.indexOf(runningId);
      if (oldPos !== newPos) {
        return c.json({ error: `running/queued task ${runningId} 不能移动位置` }, 409);
      }
    }

    await repackQueue(qid, want);
    // reorder 后某个 backlog/paused 可能上位到 head,立刻推进一次
    void advanceQueue(qid);
    return c.json({ ok: true });
  });

  // 从 queue 移除一项(task 本身不删,只是脱离 queue → 成为独立 task)
  api.post("/queues/:queueId/remove", async (c) => {
    const qid = c.req.param("queueId");
    const b = await c.req.json<{ taskId?: string }>();
    if (!b.taskId) return c.json({ error: "taskId required" }, 400);

    const items = await db
      .select()
      .from(queueItems)
      .where(eq(queueItems.queueId, qid))
      .orderBy(asc(queueItems.position));
    if (items.length === 0) return c.json({ error: "queue not found" }, 404);
    if (!items.some((i) => i.taskId === b.taskId)) {
      return c.json({ error: "task 不在此 queue 里" }, 404);
    }

    // running task 不能拔
    const tr = (await db.select().from(tasks).where(eq(tasks.id, b.taskId))).at(0);
    if (tr && (tr.status === "running" || tr.status === "queued")) {
      return c.json({ error: `task ${b.taskId} 正在跑,不能移出 queue` }, 409);
    }

    const next = items.filter((i) => i.taskId !== b.taskId).map((i) => i.taskId);
    await repackQueue(qid, next);
    // 移除后立刻推一下,看看后面的 task 是否能动了
    if (next.length > 0) void advanceQueue(qid);
    return c.json({ ok: true });
  });

  // 在指定位置插入(校验跨 group)
  api.post("/queues/:queueId/insert", async (c) => {
    const qid = c.req.param("queueId");
    const b = await c.req.json<{ taskId?: string; position?: number }>();
    if (!b.taskId) return c.json({ error: "taskId required" }, 400);
    const pos = typeof b.position === "number" ? Math.max(0, b.position | 0) : -1;

    const items = await db
      .select()
      .from(queueItems)
      .where(eq(queueItems.queueId, qid))
      .orderBy(asc(queueItems.position));
    if (items.length === 0) return c.json({ error: "queue not found" }, 404);
    if (items.some((i) => i.taskId === b.taskId)) {
      return c.json({ error: "task 已在此 queue 里" }, 409);
    }

    // 候选 task 必须先存在
    const tr = (await db.select().from(tasks).where(eq(tasks.id, b.taskId))).at(0);
    if (!tr) return c.json({ error: "task not found" }, 404);

    // 候选 task 不能已在别的 queue 里(task_id PK 保证,但提前给个友好错误)
    const otherQueue = (
      await db.select().from(queueItems).where(eq(queueItems.taskId, b.taskId))
    ).at(0);
    if (otherQueue && otherQueue.queueId !== qid) {
      return c.json({ error: `task 已在另一个 queue ${otherQueue.queueId}` }, 409);
    }

    // 跨 group 校验
    const violation = await assertSameGroup(qid, b.taskId);
    if (violation) return c.json({ error: violation }, 400);

    const insertAt = pos < 0 || pos > items.length ? items.length : pos;
    const next = [
      ...items.slice(0, insertAt).map((i) => i.taskId),
      b.taskId,
      ...items.slice(insertAt).map((i) => i.taskId),
    ];
    await repackQueue(qid, next);
    // 插入后:如果前序已全 done/canceled,新 task 应立刻起来(实测发现的竞态:
    // codex skill 在链跑完后插尾任务,不推进会一直 backlog)
    void advanceQueue(qid);
    return c.json({ ok: true });
  });

  // 新建一个 queue,用给定的 task ids
  api.post("/queues", async (c) => {
    const b = await c.req.json<{ taskIds?: string[] }>();
    const want = b.taskIds ?? [];
    if (!Array.isArray(want) || want.length === 0) {
      return c.json({ error: "taskIds 不能为空" }, 400);
    }
    // 候选 task 都得存在
    const rows = await db.select().from(tasks).where(inArray(tasks.id, want));
    if (rows.length !== want.length) {
      return c.json({ error: "部分 taskId 不存在" }, 400);
    }
    // 同 group(或都无 group)
    const gs = new Set(rows.map((r) => r.groupId));
    if (gs.size > 1) return c.json({ error: "跨 group 不允许" }, 400);
    // 任何一个 task 已在其他 queue?
    const occupied = await db.select().from(queueItems).where(inArray(queueItems.taskId, want));
    if (occupied.length > 0) {
      return c.json(
        { error: `这些 task 已在其他 queue: ${occupied.map((o) => o.taskId).join(", ")}` },
        409,
      );
    }
    const qid = id();
    const ts = now();
    await db.insert(queueItems).values(
      want.map((tid, i) => ({ taskId: tid, queueId: qid, position: i, createdAt: ts })),
    );
    // 新建 queue 也要推进:head 如果已经可启动(backlog/paused),让它立刻动
    void advanceQueue(qid);
    return c.json({ queueId: qid, taskIds: want }, 201);
  });
}
