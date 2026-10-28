// 任务备忘的 CRUD(语义与分界见 shared/src/task-memo.ts)。
//
// 两条轴都要过,跟随手记同一套:
//  ① **项目可见性** —— 由 `/api/tasks/:id/…` 的横切闸(auth/resource-gate.ts)统一拦,
//     所以这里的单条端点一律挂在任务 id 下面,不开 `/memos/:memoId` 那种全局 id 路由
//     (那个形状已经被审出来两次整个漏在闸外:定时消息、哨兵)。
//  ② **归属** —— 备忘是私有的个人批注,同一个共享项目里各人的备忘互不可见,所以读要
//     `filterOwned`、写要 `canUseOwned`。
//
// 批量摘要 `POST /tasks/memos` 是**同级集合端点**(第二段是字面量不是 id),必须登记进
// resource-gate.ts 的 NOT_AN_ID,否则 "memos" 会被当成 taskId 查库。它自己逐任务过一遍
// 可见性 + 归属。
import { TASK_MEMO_MAX_COUNT, TASK_MEMO_MAX_LEN, taskMemoDigestText } from "@ash/shared/task-memo";
import type { TaskMemo, TaskMemoDigest } from "@ash/shared/task-memo";
import { TASK_BATCH_LIMIT } from "@ash/shared";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Hono } from "hono";
import { db } from "./db/index.js";
import { taskMemos, tasks } from "./db/schema.js";
import { id, now } from "./util.js";
import { actorOf, type Actor } from "./auth/context.js";
import { canUseOwned, filterOwned, ownerStamp } from "./auth/owned.js";
import { visibleTaskIds } from "./auth/visibility.js";

type MemoBody = { body?: unknown };

/**
 * 请求体,一律当成一个对象读。`.json().catch(() => ({}))` 只兜得住**解析失败** ——
 * 字面量 `null`(以及 `3`、`"x"`、`[]`)都是合法 JSON、解析得出来,随后访问 `.body`
 * 就在 null 上取属性,一条输入形状错误被报成 500(独立审查第 1 轮)。
 */
async function bodyOf<T extends object>(c: { req: { json: <R>() => Promise<R> } }): Promise<Partial<T>> {
  const raw = await c.req.json<unknown>().catch(() => null);
  return raw && typeof raw === "object" ? (raw as Partial<T>) : {};
}

function toMemo(row: typeof taskMemos.$inferSelect): TaskMemo {
  return {
    id: row.id,
    taskId: row.taskId,
    body: row.body,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * 正文校验。**空白不算内容**(全是空格的一条在列表里就是一行看不见的空行),超长直接
 * 报错而不是截断 —— 悄悄吞掉用户写的几百字是最坏的一种「成功」。
 */
function readBody(raw: unknown): { body: string } | { error: string } {
  if (typeof raw !== "string" || !raw.trim()) return { error: "备忘内容不能为空" };
  if (raw.length > TASK_MEMO_MAX_LEN) {
    return { error: `备忘内容最多 ${TASK_MEMO_MAX_LEN} 字,这条有 ${raw.length} 字` };
  }
  // 行内缩进是用户自己排的版,只摘首尾空白。
  return { body: raw.trim() };
}

/**
 * 「我自己名下、这个任务的那些备忘」—— 配额算的就是这一堆（判据与 `ownerStamp` 决定
 * 新行记在谁名下的那个值对齐）。自用模式下归属列恒为 null,`isNull` 正好等于全部。
 *
 * 跟 `filterOwned` 的唯一偏差:多人模式下的**实例管理员**在那边还能算上无主行(转多人
 * 之前留下的),这里不算 —— 方向是让配额更松一点,不会把谁挡在外面。
 */
const mineOn = (taskId: string, ownerUserId: string | null) => and(
  eq(taskMemos.taskId, taskId),
  ownerUserId === null ? isNull(taskMemos.ownerUserId) : eq(taskMemos.ownerUserId, ownerUserId),
);

async function ownMemos(taskId: string, actor: Actor) {
  const rows = await db
    .select()
    .from(taskMemos)
    .where(eq(taskMemos.taskId, taskId))
    .orderBy(desc(taskMemos.updatedAt));
  return filterOwned(rows, actor);
}

export function mountTaskMemoRoutes(api: Hono): void {
  api.get("/tasks/:id/memos", async (c) => {
    const actor = actorOf(c);
    const rows = await ownMemos(c.req.param("id"), actor);
    return c.json(rows.map(toMemo));
  });

  api.post("/tasks/:id/memos", async (c) => {
    const actor = actorOf(c);
    const taskId = c.req.param("id");
    // 横切闸只在多人模式下拦,而「往一个不存在的任务上写备忘」在哪种模式下都该 404。
    // 这一下只是**快速否决**(省掉读正文和插入):它和下面的插入之间隔着 `await bodyOf`,
    // 任务可以在这期间被删掉,所以真正的保证在那个 batch 里(见下)。
    const task = (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task) return c.json({ error: "任务不存在" }, 404);
    const parsed = readBody((await bodyOf<MemoBody>(c)).body);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    const timestamp = now();
    const row: typeof taskMemos.$inferInsert = {
      id: id(),
      taskId,
      ...ownerStamp(actor),
      body: parsed.body,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    // 任务还在不在、条数有没有超,都跟插入在**同一个 batch** 里。
    //
    // 「先查再插」那种写法两步之间有 await,两种并发都漏:条数上并发两发都读到 499、
    // 然后都插进去(第 2 轮审查 N3);存在性上**正文还在上传**的时候任务被删掉、清理也
    // 跑完了,这一发随后照样插进去并回 201,那行就成了没有任何界面入口的孤儿(第 3 轮
    // 审查 N2)。`db.batch` 在一个 BEGIN…COMMIT 里同步跑完,中间没有让出点:后两条在
    // 插入**之后**判,不成立就把刚插的那行当场收走 —— 净效果是「两条都过才留得下」。
    // 范式同 claude-monitor-write.ts 的 `writeIfTaskAlive`(那里也解释了为什么不用
    // `db.transaction`:它的函数体里每个 await 都会把同一条连接上别人的语句卷进来)。
    //
    // 为什么不靠外键/级联:这个库一张表都没有声明外键(`grep -c 'references(' db/schema.ts`
    // = 0,DDL 里也没有),sqlite 还默认 `foreign_keys=off`。为备忘一张表单开这条路,等于
    // 让约束只在「记得开 pragma」时成立 —— 条件写入是和现状一致、且当场生效的那一种。
    const [, orphan, overflow] = await db.batch([
      db.insert(taskMemos).values(row),
      db.delete(taskMemos)
        .where(and(
          eq(taskMemos.id, row.id),
          sql`not exists (select 1 from ${tasks} where ${tasks.id} = ${taskId})`,
        ))
        .returning({ id: taskMemos.id }),
      db.delete(taskMemos)
        .where(and(
          eq(taskMemos.id, row.id),
          sql`(select count(*) from ${taskMemos} where ${mineOn(taskId, row.ownerUserId ?? null)}) > ${TASK_MEMO_MAX_COUNT}`,
        ))
        // 回执就是「有没有被收走」——不 returning 的话还得再查一发才知道。
        .returning({ id: taskMemos.id }),
    ]);
    // 任务没了那一条排在前面:它先把行收走,配额那条的 count 里也就不含它,不会再多报一个 400。
    if (orphan.length) return c.json({ error: "任务不存在" }, 404);
    if (overflow.length) {
      return c.json({ error: `一个任务最多 ${TASK_MEMO_MAX_COUNT} 条备忘,先删几条再加` }, 400);
    }
    return c.json(toMemo(row as typeof taskMemos.$inferSelect), 201);
  });

  api.patch("/tasks/:id/memos/:memoId", async (c) => {
    const actor = actorOf(c);
    const taskId = c.req.param("id");
    const memoId = c.req.param("memoId");
    const existing = (await db
      .select()
      .from(taskMemos)
      .where(and(eq(taskMemos.id, memoId), eq(taskMemos.taskId, taskId)))).at(0);
    // 不存在与不是我的回同一句话:否则挨个 id 试一遍就能问出「这条存在但不是我的」。
    if (!existing || !(await canUseOwned(existing, actor))) return c.json({ error: "备忘不存在" }, 404);
    const parsed = readBody((await bodyOf<MemoBody>(c)).body);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    const updated = { body: parsed.body, updatedAt: now() };
    await db.update(taskMemos).set(updated).where(eq(taskMemos.id, memoId));
    return c.json(toMemo({ ...existing, ...updated }));
  });

  api.delete("/tasks/:id/memos/:memoId", async (c) => {
    const actor = actorOf(c);
    const existing = (await db
      .select()
      .from(taskMemos)
      .where(and(eq(taskMemos.id, c.req.param("memoId")), eq(taskMemos.taskId, c.req.param("id"))))).at(0);
    if (!existing || !(await canUseOwned(existing, actor))) return c.json({ error: "备忘不存在" }, 404);
    await db.delete(taskMemos).where(eq(taskMemos.id, existing.id));
    return c.json({ deleted: true });
  });

  // 侧边栏铺开那一列:一批任务各自「最近更新的那一条备忘 + 一共几条」。
  // 没有备忘的任务**不出现在结果里** —— 跟 `/tasks/follow-ups` 同一条规矩,前端据此
  // 区分「这个任务没有备忘」和「这一批我压根没问过」。
  api.post("/tasks/memos", async (c) => {
    const actor = actorOf(c);
    const body = await bodyOf<{ taskIds?: unknown }>(c);
    if (!Array.isArray(body.taskIds)) return c.json({ error: "taskIds must be an array" }, 400);
    const unique = [...new Set(body.taskIds.filter((value): value is string => typeof value === "string" && !!value))];
    // **超了返 400,不截断** —— 跟 `/tasks/follow-ups`、`/tasks/bodies` 同一条规矩
    // (task-routes.ts 的 overBatchLimit):静默少返几行会被前端渲染成「还没读到」,
    // 一条永远不会消失的假状态。请求方分批才是对的做法。
    if (unique.length > TASK_BATCH_LIMIT) {
      return c.json(
        { error: `一次最多问 ${TASK_BATCH_LIMIT} 个任务,请分批`, limit: TASK_BATCH_LIMIT, requested: unique.length },
        400,
      );
    }
    if (!unique.length) return c.json([]);
    // 可见性在这条路上没有横切闸兜底(第二段是字面量),所以自己过一遍。
    const visible = new Set(await visibleTaskIds(actor, unique));
    if (!visible.size) return c.json([]);
    const rows = await filterOwned(
      await db.select().from(taskMemos).where(inArray(taskMemos.taskId, [...visible])),
      actor,
    );
    // 平手时按 id 定胜负：时间戳只到毫秒，同一毫秒写进来的两条会并列，而「谁是最新」
    // 要是随查询顺序变，同一份数据两次请求就能给出两个答案（那一格会自己跳）。
    const newer = (a: typeof taskMemos.$inferSelect, b: typeof taskMemos.$inferSelect) =>
      (a.updatedAt !== b.updatedAt ? a.updatedAt > b.updatedAt : a.id > b.id);
    const byTask = new Map<string, { count: number; latest: typeof taskMemos.$inferSelect }>();
    for (const row of rows) {
      const current = byTask.get(row.taskId);
      if (!current) byTask.set(row.taskId, { count: 1, latest: row });
      else {
        current.count += 1;
        if (newer(row, current.latest)) current.latest = row;
      }
    }
    const digests: TaskMemoDigest[] = [...byTask].map(([taskId, { count, latest }]) => ({
      taskId,
      count,
      ...taskMemoDigestText(latest.body),
      at: latest.updatedAt,
    }));
    return c.json(digests);
  });
}
