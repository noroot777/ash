// 任务「看过没有」的读写(为什么进库见 db/schema-task-reads.ts)。
//
// 只有两条，都只碰「我自己」那一份：GET 整份拿走，PUT 合进去一批。不挂在 `/tasks/:id/…` 下面，
// 因为它不是任务的东西、是人的东西 —— 写的只是「我看过 id 为 X 的任务停在 Y 轮」，看不见的任务
// 写进来也只落在自己名下，读不出任何别人的数据。回合凭证写不动它(auth/personal-gate.ts)。
import { parseTaskReads, TASK_READS_MAX, trimTaskReads, type TaskReads } from "@ash/shared/task-reads";
import { and, eq, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { actorOf, ownerIdOf, type Actor } from "./auth/context.js";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { taskReads } from "./db/schema.js";

/** 自用模式没有 userId，记在空串名下(主键里不能放 NULL)。 */
const ownerKeyOf = (actor: Actor): string => ownerIdOf(actor) ?? "";

async function readsOf(owner: string): Promise<TaskReads> {
  const rows = await db.select().from(taskReads).where(eq(taskReads.owner, owner));
  return Object.fromEntries(rows.map((row) => [row.taskId, { event: row.event, readAt: row.readAt }]));
}

export function mountTaskReadRoutes(api: Hono): void {
  api.get("/task-reads", async (c) => c.json({ reads: await readsOf(ownerKeyOf(actorOf(c))) }));

  api.put("/task-reads", async (c) => {
    const actor = actorOf(c);
    const owner = ownerKeyOf(actor);
    const raw = await c.req.json<unknown>().catch(() => null);
    const body = raw && typeof raw === "object" ? (raw as { reads?: unknown }).reads : undefined;
    // 先裁再写：一次最多收上限那么多条，多出来的是最早看的那几条，本来也留不下。
    const incoming = trimTaskReads(parseTaskReads(body));
    // 看的时刻按服务端的钟记，谁后到谁算数。不拿客户端带来的 readAt 比先后：那是各台设备自己的钟，
    // 钟慢的设备刚看过的新一轮会因为「时间更早」写不进去，到它那儿绿点又亮回来。
    const at = Date.now();
    const rows = Object.keys(incoming).map((taskId) => ({ owner, taskId, event: incoming[taskId]!.event, readAt: at }));
    if (rows.length) {
      await db.batch([
        db.insert(taskReads).values(rows).onConflictDoUpdate({
          target: [taskReads.owner, taskReads.taskId],
          set: { event: sql`excluded.event`, readAt: sql`excluded.read_at` },
        }),
        db.delete(taskReads).where(and(
          eq(taskReads.owner, owner),
          sql`${taskReads.taskId} not in (
            select task_id from task_reads where owner = ${owner} order by read_at desc limit ${TASK_READS_MAX}
          )`,
        )),
      ]);
      bus.publish({ type: "task.reads", ownerUserId: ownerIdOf(actor) });
    }
    return c.json({ reads: await readsOf(owner) });
  });
}
