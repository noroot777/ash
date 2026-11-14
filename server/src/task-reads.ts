// 任务「看过没有」的读写(为什么进库见 db/schema-task-reads.ts)。
//
// 只有两条，都只碰「我自己」那一份：GET 整份拿走，PUT 合进去一批。不挂在 `/tasks/:id/…` 下面，
// 因为它不是任务的东西、是人的东西。回合凭证写不动它(auth/personal-gate.ts)。
//
// 新旧只认 round(shared/src/task-reads.ts 文件头)：写进来的比已经记下的旧就不写 —— 断网后补送的、
// 停在旧数据上的页面写的，都是这种。round 还要按库里那个任务此刻的轮次封顶：前端的 round 本来就是
// 从任务数据里算的，不会超过库里那份；超了只能是坏数据，放进来会让这个任务往后几轮都判成看过。
// 不存在、看不见的任务一条不写，回执里列出来让前端别再送。
import { TASK_READS_MAX, parseTaskReads, taskReadRound, trimTaskReads, type TaskReads, type TaskReadsWriteResult } from "@ash/shared/task-reads";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { actorOf, ownerIdOf, type Actor } from "./auth/context.js";
import { visibleTaskIds } from "./auth/visibility.js";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { taskReads, tasks } from "./db/schema.js";

/** 自用模式没有 userId，记在空串名下(主键里不能放 NULL)。 */
const ownerKeyOf = (actor: Actor): string => ownerIdOf(actor) ?? "";

async function readsOf(owner: string): Promise<TaskReads> {
  const rows = await db.select().from(taskReads).where(eq(taskReads.owner, owner));
  return Object.fromEntries(rows.map((row) => [row.taskId, { event: row.event, round: row.round }]));
}

/** 这几个任务此刻在库里的轮次；不存在的不在结果里。 */
async function currentRounds(ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: tasks.id, mode: tasks.mode, parentId: tasks.parentId, updatedAt: tasks.updatedAt, endedAt: tasks.endedAt })
    .from(tasks)
    .where(inArray(tasks.id, ids));
  const leads = rows.filter((row) => row.mode === "team" && !row.parentId).map((row) => row.id);
  const workers = leads.length
    ? await db.select({ parentId: tasks.parentId, updatedAt: tasks.updatedAt }).from(tasks).where(inArray(tasks.parentId, leads))
    : [];
  return new Map(rows.map((row) => [row.id, taskReadRound(row, workers.filter((worker) => worker.parentId === row.id))]));
}

export function mountTaskReadRoutes(api: Hono): void {
  api.get("/task-reads", async (c) => {
    const owner = ownerKeyOf(actorOf(c));
    return c.json({ owner, reads: await readsOf(owner) });
  });

  api.put("/task-reads", async (c) => {
    const actor = actorOf(c);
    const owner = ownerKeyOf(actor);
    const raw = await c.req.json<unknown>().catch(() => null);
    const body = raw && typeof raw === "object" ? (raw as { reads?: unknown }).reads : undefined;
    // 先裁再写：一次最多收上限那么多条，多出来的是最旧的那几轮，本来也留不下。
    const incoming = trimTaskReads(parseTaskReads(body));
    const ids = Object.keys(incoming);
    const rounds = await currentRounds(await visibleTaskIds(actor, ids));
    const at = Date.now();
    const rows = ids.flatMap((taskId) => {
      const current = rounds.get(taskId);
      if (current === undefined) return [];
      return [{ owner, taskId, event: incoming[taskId]!.event, round: Math.min(incoming[taskId]!.round, current), readAt: at }];
    });
    if (rows.length) {
      await db.batch([
        db.insert(taskReads).values(rows).onConflictDoUpdate({
          target: [taskReads.owner, taskReads.taskId],
          set: { event: sql`excluded.event`, round: sql`excluded.round`, readAt: sql`excluded.read_at` },
          setWhere: sql`excluded.round >= ${taskReads.round}`,
        }),
        // 跟前端 trimTaskReads 同一个排法(round 新的在前，同轮按 id)，两端裁掉的是同一批，不会来回补送。
        db.delete(taskReads).where(and(
          eq(taskReads.owner, owner),
          sql`${taskReads.taskId} not in (
            select task_id from task_reads where owner = ${owner} order by round desc, task_id asc limit ${TASK_READS_MAX}
          )`,
        )),
      ]);
      bus.publish({ type: "task.reads", ownerUserId: ownerIdOf(actor) });
    }
    const result: TaskReadsWriteResult = { owner, reads: await readsOf(owner), rejected: ids.filter((taskId) => !rounds.has(taskId)) };
    return c.json(result);
  });
}
