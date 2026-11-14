// 任务「看过没有」的读写(为什么进库见 db/schema-task-reads.ts，round / rev 的分工见 shared/src/task-reads.ts)。
//
// 只有两条，都只碰「我自己」那一份：GET 整份拿走，PUT 合进去一批。不挂在 `/tasks/:id/…` 下面，
// 因为它不是任务的东西、是人的东西。回合凭证写不动它(auth/personal-gate.ts)。
//
// PUT 的几道关：
//  · 请求体里写明这批是谁看的(owner)，跟这次请求认证出来的人对不上就 409、一条不写 —— 同一个浏览器
//    另一个标签页换了人登录，这一页攒着的上一个人的记录不能借新 cookie 记到新人头上；
//  · 写进来的比已经记下的旧(round 小)就不写：断网后补送的、停在旧数据上的页面写的，都是这种；
//  · round 按库里那个任务此刻的轮次封顶：超了只能是坏数据，放进来会让这个任务往后几轮都判成看过；
//  · 不存在、看不见的任务一条不写，回执里列出来让前端别再送。
import {
  TASK_READS_MAX, parseTaskReads, taskReadRound,
  type TaskReads, type TaskReadsSnapshot, type TaskReadsWriteResult,
} from "@ash/shared/task-reads";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { actorOf, ownerIdOf, type Actor } from "./auth/context.js";
import { visibleTaskIds } from "./auth/visibility.js";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { taskReadRevs, taskReads, tasks } from "./db/schema.js";

/** 自用模式没有 userId，记在空串名下(主键里不能放 NULL)。 */
const ownerKeyOf = (actor: Actor): string => ownerIdOf(actor) ?? "";

/** 先读 rev 再读记录：两步之间又写进来一批，记录只会比 rev 说的新，不会更旧(前端按 rev 丢旧回执)。 */
async function snapshotOf(owner: string): Promise<TaskReadsSnapshot> {
  const rev = (await db.select({ rev: taskReadRevs.rev }).from(taskReadRevs).where(eq(taskReadRevs.owner, owner))).at(0)?.rev ?? 0;
  const rows = await db.select().from(taskReads).where(eq(taskReads.owner, owner));
  const reads: TaskReads = Object.fromEntries(rows.map((row) => [row.taskId, { event: row.event, round: row.round }]));
  return { owner, rev, reads };
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
  api.get("/task-reads", async (c) => c.json(await snapshotOf(ownerKeyOf(actorOf(c)))));

  api.put("/task-reads", async (c) => {
    const actor = actorOf(c);
    const owner = ownerKeyOf(actor);
    const raw = await c.req.json<unknown>().catch(() => null);
    const body = raw && typeof raw === "object" ? (raw as { owner?: unknown; reads?: unknown }) : {};
    if (body.owner !== owner) return c.json({ error: "这批已读记录不是当前登录账号的", owner }, 409);
    // 一次最多收上限那么多条(正常一批只有几条，多出来的是坏请求)。
    const incoming = Object.entries(parseTaskReads(body.reads)).slice(0, TASK_READS_MAX);
    const rounds = await currentRounds(await visibleTaskIds(actor, incoming.map(([taskId]) => taskId)));
    // 「最近看到」按人严格递增：同一毫秒里先后两批也分得出先后，满额裁的时候不会按 task_id 误伤刚看的那批。
    // 取号放在写入那条语句里算，不先读出来再写 —— 两批同时到时读到同一个最大值、拿到同一个号。
    const at = sql<number>`max(${Date.now()}, coalesce((select max(read_at) from task_reads where owner = ${owner}), 0) + 1)`;
    const rows = incoming.flatMap(([taskId, entry]) => {
      const current = rounds.get(taskId);
      return current === undefined ? [] : [{ owner, taskId, event: entry.event, round: Math.min(entry.round, current), readAt: at }];
    });
    if (rows.length) {
      await db.batch([
        db.insert(taskReads).values(rows).onConflictDoUpdate({
          target: [taskReads.owner, taskReads.taskId],
          set: { event: sql`excluded.event`, round: sql`excluded.round`, readAt: sql`excluded.read_at` },
          setWhere: sql`excluded.round >= ${taskReads.round}`,
        }),
        // 留最近看到的那些(read_at)。刚写进来的这批 read_at 最新，不会当场被裁掉。
        db.delete(taskReads).where(and(
          eq(taskReads.owner, owner),
          sql`${taskReads.taskId} not in (
            select task_id from task_reads where owner = ${owner} order by read_at desc, task_id asc limit ${TASK_READS_MAX}
          )`,
        )),
        db.insert(taskReadRevs).values({ owner, rev: 1 }).onConflictDoUpdate({
          target: taskReadRevs.owner,
          set: { rev: sql`${taskReadRevs.rev} + 1` },
        }),
      ]);
      bus.publish({ type: "task.reads", ownerUserId: ownerIdOf(actor) });
    }
    const result: TaskReadsWriteResult = {
      ...(await snapshotOf(owner)),
      rejected: incoming.map(([taskId]) => taskId).filter((taskId) => !rounds.has(taskId)),
    };
    return c.json(result);
  });
}
