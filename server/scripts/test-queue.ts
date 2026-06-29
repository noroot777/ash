// E2E 测试:队列调度 + 迁移自检 + 跨 group 校验。
// 跑法:
//   HARNESS_DB=/tmp/test-queue-$RANDOM.db npx tsx server/scripts/test-queue.ts
//
// 用 pickNextLaunchable 来验证"队列下一个该跑哪个"——绕开 resumeOrRunTask
// 实际拉起 agent 的副作用(测试环境无 executor)。少量端到端走 advanceQueue。
import { asc, eq } from "drizzle-orm";

if (!process.env.HARNESS_DB) {
  console.error("先设 HARNESS_DB=/tmp/test-queue-<rand>.db 再跑");
  process.exit(1);
}
if (!process.env.HARNESS_DB.startsWith("/tmp/")) {
  console.error("HARNESS_DB 必须在 /tmp/ 下(防止误改真实数据)");
  process.exit(1);
}

const { db } = await import("../src/db/index.js");
const { tasks, groups, projects, queueItems } = await import("../src/db/schema.js");
const { ensureSchema } = await import("../src/db/index.js");
const { migrateQueues } = await import("../src/db/migrateQueues.js");
const { pickNextLaunchable } = await import("../src/scheduler.js");
const { setTaskStatus } = await import("../src/status.js");
const { id, now } = await import("../src/util.js");

await ensureSchema();

let pass = 0;
let fail = 0;

async function clear() {
  await db.delete(queueItems);
  await db.delete(tasks);
  await db.delete(groups);
  await db.delete(projects);
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await clear();
    await fn();
    console.log(`  PASS  ${name}`);
    pass++;
  } catch (e) {
    console.error(`  FAIL  ${name}`);
    console.error(`        ${(e as Error).message}`);
    fail++;
  }
}

function assertEq<T>(actual: T, expected: T, msg: string) {
  if (actual !== expected) {
    throw new Error(`${msg}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}
function assertTrue(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

async function seedProject() {
  const p = { id: id(), name: "test", repoPath: "/tmp/test-repo", createdAt: now() };
  await db.insert(projects).values(p);
  return p;
}
async function seedGroup(projectId: string, mode: "serial" | "parallel" = "serial") {
  const g = { id: id(), projectId, name: "g", mode, paused: false, createdAt: now() };
  await db.insert(groups).values(g);
  return g;
}
async function seedTask(
  projectId: string,
  groupId: string | null,
  opts: Partial<typeof tasks.$inferInsert> = {},
) {
  const ts = now();
  const tid = id();
  const row = {
    id: tid,
    projectId,
    groupId,
    parentId: null,
    title: (opts.title as string) ?? "t",
    body: "",
    mode: "single",
    status: (opts.status as string) ?? "backlog",
    priority: "none",
    labels: "[]",
    dependsOn: opts.dependsOn ?? "[]",
    resumeDependsOn: opts.resumeDependsOn ?? "[]",
    agentType: null,
    autoTitle: false,
    debate: null,
    scheduleId: null,
    createdAt: ts,
    updatedAt: ts,
    useWorktree: false,
    worktreeBase: null,
    resumePrompt: opts.resumePrompt ?? null,
  } as typeof tasks.$inferInsert;
  await db.insert(tasks).values(row);
  return (await db.select().from(tasks).where(eq(tasks.id, tid))).at(0)!;
}
async function seedQueue(taskIds: string[]) {
  const qid = id();
  const ts = now();
  for (let i = 0; i < taskIds.length; i++) {
    await db
      .insert(queueItems)
      .values({ taskId: taskIds[i], queueId: qid, position: i, createdAt: ts });
  }
  return qid;
}

// ── 1. 迁移自检 ─────────────────────────────────────────────────────

await test("迁移自检: 跨 group depends_on throw", async () => {
  const p = await seedProject();
  const g1 = await seedGroup(p.id);
  const g2 = await seedGroup(p.id);
  const t1 = await seedTask(p.id, g1.id);
  await seedTask(p.id, g2.id, { dependsOn: JSON.stringify([t1.id]) });
  let threw = false;
  try {
    await migrateQueues();
  } catch (e) {
    threw = true;
    assertTrue(String(e).includes("cross-group"), `期待 cross-group 错误,得到: ${e}`);
  }
  assertTrue(threw, "迁移应该 throw");
});

await test("迁移自检: DAG (depends_on 长度 > 1) throw", async () => {
  const p = await seedProject();
  const g = await seedGroup(p.id);
  const t1 = await seedTask(p.id, g.id);
  const t2 = await seedTask(p.id, g.id);
  await seedTask(p.id, g.id, { dependsOn: JSON.stringify([t1.id, t2.id]) });
  let threw = false;
  try {
    await migrateQueues();
  } catch (e) {
    threw = true;
    assertTrue(String(e).includes("DAG"), `期待 DAG 错误,得到: ${e}`);
  }
  assertTrue(threw, "迁移应该 throw");
});

await test("迁移自检: depends_on 和 resume_depends_on 指向不同 task throw", async () => {
  const p = await seedProject();
  const g = await seedGroup(p.id);
  const t1 = await seedTask(p.id, g.id);
  const t2 = await seedTask(p.id, g.id);
  await seedTask(p.id, g.id, {
    dependsOn: JSON.stringify([t1.id]),
    resumeDependsOn: JSON.stringify([t2.id]),
  });
  let threw = false;
  try {
    await migrateQueues();
  } catch (e) {
    threw = true;
    assertTrue(String(e).includes("ambiguous"), `期待 ambiguous 错误,得到: ${e}`);
  }
  assertTrue(threw, "迁移应该 throw");
});

// ── 2. 迁移正确性 ────────────────────────────────────────────────────

await test("迁移: serial group 拓扑入 queue,字段清空", async () => {
  const p = await seedProject();
  const g = await seedGroup(p.id, "serial");
  const a = await seedTask(p.id, g.id, { title: "a" });
  const b = await seedTask(p.id, g.id, {
    title: "b",
    dependsOn: JSON.stringify([a.id]),
  });
  const c = await seedTask(p.id, g.id, {
    title: "c",
    dependsOn: JSON.stringify([b.id]),
  });
  await migrateQueues();
  const items = await db.select().from(queueItems).orderBy(asc(queueItems.position));
  assertEq(items.length, 3, "应有 3 个 queue_items");
  assertEq(items[0].taskId, a.id, "位置 0 = a");
  assertEq(items[1].taskId, b.id, "位置 1 = b");
  assertEq(items[2].taskId, c.id, "位置 2 = c");
  for (const t of await db.select().from(tasks)) {
    assertEq(t.dependsOn, "[]", "depends_on 应被清空");
    assertEq(t.resumeDependsOn, "[]", "resume_depends_on 应被清空");
  }
});

await test("迁移: parallel group + resume chain → 也建 queue", async () => {
  // 真实数据揭示:用户用"parallel group + resume_depends_on 链"表达
  // 并行预处理→串行 TTS。queue 表达完成顺序,group.mode 表达初始启动方式,
  // 两者正交。所以任何 group 只要有依赖链就建 queue。
  const p = await seedProject();
  const g = await seedGroup(p.id, "parallel");
  const a = await seedTask(p.id, g.id, { title: "v1" });
  const b = await seedTask(p.id, g.id, {
    title: "v2",
    resumeDependsOn: JSON.stringify([a.id]),
  });
  const c = await seedTask(p.id, g.id, {
    title: "v3",
    resumeDependsOn: JSON.stringify([b.id]),
  });
  await migrateQueues();
  const items = await db.select().from(queueItems).orderBy(asc(queueItems.position));
  assertEq(items.length, 3, "parallel group 的 resume chain 也应建 queue");
  assertEq(items[0].taskId, a.id, "v1 在前");
  assertEq(items[1].taskId, b.id, "v2 在中");
  assertEq(items[2].taskId, c.id, "v3 在后");
});

await test("迁移: parallel group 无 deps → 不建 queue", async () => {
  const p = await seedProject();
  const g = await seedGroup(p.id, "parallel");
  await seedTask(p.id, g.id);
  await seedTask(p.id, g.id);
  await migrateQueues();
  const items = await db.select().from(queueItems);
  assertEq(items.length, 0, "纯独立任务不应建 queue");
});

await test("迁移: 幂等(无 legacy 数据时直接 return)", async () => {
  const p = await seedProject();
  const g = await seedGroup(p.id, "serial");
  await seedTask(p.id, g.id); // no deps
  await migrateQueues(); // 第一次:没 legacy 数据,直接 return
  const items = await db.select().from(queueItems);
  assertEq(items.length, 0, "无 legacy → 不建 queue");
  await migrateQueues(); // 第二次:幂等,啥也不发生
  const items2 = await db.select().from(queueItems);
  assertEq(items2.length, 0, "幂等 OK");
});

// ── 3. pickNextLaunchable: 队列推进规则 ──────────────────────────────

await test("pickNext: 基本 — 全 backlog,选 head", async () => {
  const p = await seedProject();
  const g = await seedGroup(p.id, "serial");
  const a = await seedTask(p.id, g.id, { title: "a" });
  const b = await seedTask(p.id, g.id, { title: "b" });
  const c = await seedTask(p.id, g.id, { title: "c" });
  const q = await seedQueue([a.id, b.id, c.id]);
  const next = await pickNextLaunchable(q);
  assertEq(next?.id, a.id, "head 应该是 a");
});

await test("pickNext: head done → 选下一个", async () => {
  const p = await seedProject();
  const g = await seedGroup(p.id, "serial");
  const a = await seedTask(p.id, g.id, { status: "done" });
  const b = await seedTask(p.id, g.id);
  const q = await seedQueue([a.id, b.id]);
  const next = await pickNextLaunchable(q);
  assertEq(next?.id, b.id, "a done → 选 b");
});

await test("pickNext: head canceled 透明 → 选下一个", async () => {
  const p = await seedProject();
  const g = await seedGroup(p.id, "serial");
  const a = await seedTask(p.id, g.id, { status: "done" });
  const b = await seedTask(p.id, g.id, { status: "canceled" });
  const c = await seedTask(p.id, g.id);
  const q = await seedQueue([a.id, b.id, c.id]);
  const next = await pickNextLaunchable(q);
  assertEq(next?.id, c.id, "b canceled 透明,选 c");
});

await test("pickNext: head failed → 链停,返回 null", async () => {
  const p = await seedProject();
  const g = await seedGroup(p.id, "serial");
  const a = await seedTask(p.id, g.id, { status: "failed" });
  const b = await seedTask(p.id, g.id);
  const q = await seedQueue([a.id, b.id]);
  const next = await pickNextLaunchable(q);
  assertEq(next, null, "a failed → 链停,b 不能动");
});

await test("pickNext: head awaiting_review → 链停", async () => {
  const p = await seedProject();
  const g = await seedGroup(p.id, "serial");
  const a = await seedTask(p.id, g.id, { status: "awaiting_review" });
  const b = await seedTask(p.id, g.id);
  const q = await seedQueue([a.id, b.id]);
  const next = await pickNextLaunchable(q);
  assertEq(next, null, "awaiting_review → 链停");
});

await test("pickNext: head running → 不重复启动", async () => {
  const p = await seedProject();
  const g = await seedGroup(p.id, "serial");
  const a = await seedTask(p.id, g.id, { status: "running" });
  const b = await seedTask(p.id, g.id);
  const q = await seedQueue([a.id, b.id]);
  const next = await pickNextLaunchable(q);
  assertEq(next, null, "a running → 不动");
});

await test("pickNext: paused 是合法 head(等续跑)", async () => {
  const p = await seedProject();
  const g = await seedGroup(p.id, "serial");
  const a = await seedTask(p.id, g.id, { status: "done" });
  const b = await seedTask(p.id, g.id, { status: "paused", resumePrompt: "继续" });
  const q = await seedQueue([a.id, b.id]);
  const next = await pickNextLaunchable(q);
  assertEq(next?.id, b.id, "a done → b paused 该续跑");
});

await test("pickNext: archived 透明跳过", async () => {
  const p = await seedProject();
  const g = await seedGroup(p.id, "serial");
  const a = await seedTask(p.id, g.id);
  // 直接 update archived
  await db.update(tasks).set({ archived: true }).where(eq(tasks.id, a.id));
  const b = await seedTask(p.id, g.id);
  const q = await seedQueue([a.id, b.id]);
  const next = await pickNextLaunchable(q);
  assertEq(next?.id, b.id, "archived 透明,选 b");
});

// ── 4. 状态钩子:done 触发推进 ───────────────────────────────────────

await test("setTaskStatus(done) 触发队列推进(链式拉下一个)", async () => {
  const p = await seedProject();
  const g = await seedGroup(p.id, "serial");
  const a = await seedTask(p.id, g.id);
  const b = await seedTask(p.id, g.id);
  await seedQueue([a.id, b.id]);
  // 把 a 设成 done — 钩子应触发 advanceQueueFromTask
  await setTaskStatus(a.id, "done");
  // 钩子是 async fire-and-forget,等一小会儿
  await new Promise((r) => setTimeout(r, 100));
  const bRow = (await db.select().from(tasks).where(eq(tasks.id, b.id))).at(0)!;
  // b 应已从 backlog 变成 queued(advanceQueue 调了 setQueued)
  // ——之后 resumeOrRunTask 会试着启动,会失败,但我们只看立刻的状态
  assertTrue(
    bRow.status === "queued" || bRow.status === "running" || bRow.status === "failed",
    `b 应被推进(非 backlog),实际 status=${bRow.status}`,
  );
});

await test("setTaskStatus(failed) 不触发推进(链停)", async () => {
  const p = await seedProject();
  const g = await seedGroup(p.id, "serial");
  const a = await seedTask(p.id, g.id);
  const b = await seedTask(p.id, g.id);
  await seedQueue([a.id, b.id]);
  await setTaskStatus(a.id, "failed");
  await new Promise((r) => setTimeout(r, 100));
  const bRow = (await db.select().from(tasks).where(eq(tasks.id, b.id))).at(0)!;
  assertEq(bRow.status, "backlog", "failed 不应推进 → b 仍 backlog");
});

await test("setTaskStatus(paused) 在 head → 推进(自我触发 resume)", async () => {
  // 实际工作流:v2 跑完 pre-TTS 进入 paused,前面的 v1 已经 done。
  // 此时 v2 应自动 resume(它是 queue head 的可启动 task)。
  const p = await seedProject();
  const g = await seedGroup(p.id, "parallel");
  const a = await seedTask(p.id, g.id, { status: "done" });
  const b = await seedTask(p.id, g.id, { resumePrompt: "继续 TTS" });
  await seedQueue([a.id, b.id]);
  await setTaskStatus(b.id, "paused");
  await new Promise((r) => setTimeout(r, 100));
  const bRow = (await db.select().from(tasks).where(eq(tasks.id, b.id))).at(0)!;
  assertTrue(
    bRow.status === "queued" || bRow.status === "running" || bRow.status === "failed",
    `b 在 head + 上游 done → 应被 advance 推到 queued/running/failed,实际=${bRow.status}`,
  );
});

await test("setTaskStatus(paused) 但不在 head → 不推进", async () => {
  // v3 paused,但 v2(它前面)还在 running/backlog。v3 必须继续等。
  const p = await seedProject();
  const g = await seedGroup(p.id, "parallel");
  const a = await seedTask(p.id, g.id, { status: "done" });
  const b = await seedTask(p.id, g.id, { status: "running" });
  const c = await seedTask(p.id, g.id, { resumePrompt: "继续" });
  await seedQueue([a.id, b.id, c.id]);
  await setTaskStatus(c.id, "paused");
  await new Promise((r) => setTimeout(r, 100));
  const cRow = (await db.select().from(tasks).where(eq(tasks.id, c.id))).at(0)!;
  assertEq(cRow.status, "paused", "前面 b 还在 running,c 必须保持 paused");
});

// ── 5. 总结 ────────────────────────────────────────────────────────

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
