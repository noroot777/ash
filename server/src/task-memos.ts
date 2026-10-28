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
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { db } from "./db/index.js";
import { taskMemos, tasks } from "./db/schema.js";
import { id, now } from "./util.js";
import { actorOf, type Actor } from "./auth/context.js";
import { canUseOwned, filterOwned, ownerStamp } from "./auth/owned.js";
import { visibleTaskIds } from "./auth/visibility.js";

type MemoBody = { body?: unknown };

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
    const task = (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task) return c.json({ error: "任务不存在" }, 404);
    const parsed = readBody((await c.req.json<MemoBody>().catch((): MemoBody => ({}))).body);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    const mine = await ownMemos(taskId, actor);
    if (mine.length >= TASK_MEMO_MAX_COUNT) {
      return c.json({ error: `一个任务最多 ${TASK_MEMO_MAX_COUNT} 条备忘,先删几条再加` }, 400);
    }
    const timestamp = now();
    const row: typeof taskMemos.$inferInsert = {
      id: id(),
      taskId,
      ...ownerStamp(actor),
      body: parsed.body,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await db.insert(taskMemos).values(row);
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
    const parsed = readBody((await c.req.json<MemoBody>().catch((): MemoBody => ({}))).body);
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
    const body = await c.req.json<{ taskIds?: unknown }>().catch(() => ({ taskIds: undefined }));
    if (!Array.isArray(body.taskIds)) return c.json({ error: "taskIds must be an array" }, 400);
    const unique = [...new Set(body.taskIds.filter((value): value is string => typeof value === "string" && !!value))]
      .slice(0, TASK_BATCH_LIMIT);
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
