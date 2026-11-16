// 队列名次：对外的 queuePosition 是连续的名次(0..N-1),侧栏「第几位/共几位」直接拿它 +1。
// 钉的是「13/12」那个读数：删任务只摘掉自己那一格,后面的成员原位不动,库里留下缺号,
// 原值 +1 当名次就比总数还大。两头都要堵:
//   · 读：库里已经有缺号的老队列(删过任务的),名次照样连续;
//   · 写：删掉队里一条后,队列在库里重排成连续,剩下的成员名次跟着往前挪。
// 跑：npm -w server run test:queue
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-queue-rank-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");

try {
  const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
  const { projects, queueItems, tasks } = await import("../src/db/schema.js");
  const { enrichTasks } = await import("../src/task-store.js");
  const { deleteTaskCompletely } = await import("../src/task-delete-routes.js");
  const { asc, eq } = await import("drizzle-orm");
  await ensureSchema();

  const stamp = new Date().toISOString();
  await db.insert(projects).values({ id: "p", name: "p", repoPath: join(root, "repo"), createdAt: stamp });
  const queue = async (queueId: string, members: [string, number][]) => {
    for (const [id] of members) {
      await db.insert(tasks).values({ id, projectId: "p", title: id, status: "done", createdAt: stamp, updatedAt: stamp });
    }
    await db.insert(queueItems).values(members.map(([taskId, position]) => ({ taskId, queueId, position, createdAt: stamp })));
  };
  const ranks = async () => {
    const rows = await db.select().from(tasks);
    return Object.fromEntries((await enrichTasks(rows)).map((task) => [task.id, task.queuePosition ?? null]));
  };
  const positions = async (queueId: string) =>
    (await db.select().from(queueItems).where(eq(queueItems.queueId, queueId)).orderBy(asc(queueItems.position)))
      .map((item) => [item.taskId, item.position]);

  // ── 读：老队列里已经有缺号(第 2 格删过),名次照样连续;两条队列各数各的 ──
  await queue("gapped", [["a", 0], ["b", 1], ["c", 3], ["d", 4]]);
  await queue("dense", [["x", 0], ["y", 1]]);
  await db.insert(tasks).values({ id: "solo", projectId: "p", title: "solo", status: "done", createdAt: stamp, updatedAt: stamp });
  assert.deepEqual(await ranks(), { a: 0, b: 1, c: 2, d: 3, x: 0, y: 1, solo: null });

  // ── 写：删掉中间一条,队列在库里重排成连续,后面的往前挪 ──
  await deleteTaskCompletely("b");
  assert.deepEqual(await positions("gapped"), [["a", 0], ["c", 1], ["d", 2]]);
  assert.deepEqual(await ranks(), { a: 0, c: 1, d: 2, x: 0, y: 1, solo: null });
  // 删的不是更新时间：同队删掉一条不是剩下这些任务自己的动静,不能把它们顶到列表最前。
  const untouched = await db.select({ id: tasks.id, updatedAt: tasks.updatedAt }).from(tasks);
  assert.ok(untouched.every((row) => row.updatedAt === stamp), JSON.stringify(untouched));

  // 删到只剩一条、再删光：不留空队列的残行。
  await deleteTaskCompletely("a");
  await deleteTaskCompletely("c");
  assert.deepEqual(await positions("gapped"), [["d", 0]]);
  await deleteTaskCompletely("d");
  assert.deepEqual(await positions("gapped"), []);

  dbClient.close();
  console.log("✓ 队列名次：缺号的老队列读出来连续，删任务后库里重排、名次前移");
} finally {
  rmSync(root, { recursive: true, force: true });
}
