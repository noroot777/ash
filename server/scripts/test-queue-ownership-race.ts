// 队列/分组归属的写方与起跑认领争同一个原子边界(src/queue-claim-chain.ts)。
//
// 被钉住的那一类:起跑方在认领临界区里读完「它不在队列 / 还在原组」,隔着几个 await 才提交占位;
// 写方要是不进同一条链,就在这段窗口里按「它还是 backlog」把它插进一条有人在跑的队列,起跑方
// 随后按旧归属起跑,同队两个一起跑(mIDVPBcrvLZ8 第 4 轮审查实测)。每一节都在起跑方**读完归属、
// 还没提交**的那一拍把写请求发出去,断言写方要么排在后面看见那个占位而拒绝,要么根本没机会插进来:
//   ③ 回复/答复/补投那类先认领、后占回合锁的入口:认领刚放行、锁还没占上时入队,409;
//   ① 接着跑兑现(member-start.ts admit)× 入队:入队 409,队列里仍只有原来那一条;
//   ② 手动运行一条独立任务(/run → claimQueueSeat 不在队列那一支,不落 queued)× 入队:同上;
//   ④ 接着跑兑现 × 改 groupId:改分组的写排在占位之后,不会让它拿旧组的名额在新组起跑。
// ③ 排在最前:前两节在旧代码上会把任务塞进队列,队里在跑的一多,入队另有理由被拒,就分辨不出它。
//
// 走真实的路由与调度,只换掉「起一个 CLI」:假执行器的回合一直挂着,直到测试放它走。
//
// 跑:npm -w server run test:queue-ownership
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AgentEvent } from "@ash/shared";

const root = mkdtempSync(join(tmpdir(), "ash-queue-ownership-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_LAX_DONE = "1";
delete process.env.ASH_ALLOW_REAL_AGENT;

const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const schema = await import("../src/db/schema.js");
const { tasks, queueItems } = schema;
const runs = await import("../src/runs.js");
const { ClaudeExecutor } = await import("../src/executors/claude.js");
const { CodexExecutor } = await import("../src/executors/codex.js");
const { mountTaskRunRoutes } = await import("../src/task-run-routes.js");
const { mountTaskRoutes } = await import("../src/task-routes.js");
const { mountQueueRoutes } = await import("../src/queues.js");
const { holdDispatched, releaseDispatched } = await import("../src/dispatch-hold.js");
const { oweHeldStart } = await import("../src/dispatch-hold-owed.js");
const { claimQueueSeat } = await import("../src/queue-seat.js");
await ensureSchema();

const api = new Hono();
mountTaskRunRoutes(api);
mountTaskRoutes(api);
mountQueueRoutes(api);

// ── 假执行器 ──────────────────────────────────────────────────────────────────────
const gates = new Map<string, () => void>();
const launches: string[] = [];
const run = (opts: { prompt: string; sessionId?: string; env?: Record<string, string | undefined> }) => {
  const taskId = opts.env!.ASH_TASK_ID!;
  launches.push(taskId);
  const native = opts.sessionId ?? `native-${taskId}`;
  let release!: () => void;
  const ended = new Promise<void>((resolve) => { release = resolve; });
  gates.set(taskId, release);
  return {
    sessionId: native, commandLine: "queue ownership fixture; no CLI",
    kill() { release(); },
    events: (async function* (): AsyncGenerator<AgentEvent> {
      yield { kind: "session", cliSessionId: native };
      await ended;
      yield { kind: "done", exitStatus: 0 };
    })(),
  };
};
for (const executor of [ClaudeExecutor.prototype, CodexExecutor.prototype]) {
  (executor as { run: unknown }).run = run;
  (executor as { runSteerable: unknown }).runSteerable = run;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(label: string, check: () => Promise<boolean> | boolean, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`等不到:${label}`);
    await sleep(25);
  }
}
const row = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
const running = (taskId: string) =>
  until(`${taskId} 在跑`, async () => runs.isRunning(taskId) && (await row(taskId)).status === "running");
const queueOf = async (queueId: string) =>
  (await db.select().from(queueItems).where(eq(queueItems.queueId, queueId)).orderBy(asc(queueItems.position)))
    .map((item) => item.taskId);
const request = (method: string, path: string, body: unknown = {}) =>
  api.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// ── 在起跑方「读完归属、还没提交」那一拍插一个写请求 ───────────────────────────────────
// 拦的是数据库那一层:命中那条语句的前(before)或后(after),先把写请求发出去、给它一段足够跑完
// 的时间,再照常执行、原样返回。写方若不在同一条链上,这段时间里它就已经落库了。
type Interleave = { hit: boolean; settledInWindow: boolean; response: Promise<Response> | null };
function interleave(when: "before" | "after", match: (sql: string, args: unknown[]) => boolean,
  write: () => Promise<Response>): Interleave {
  const state: Interleave = { hit: false, settledInWindow: false, response: null };
  const execute = dbClient.execute.bind(dbClient);
  const cut = async () => {
    let settled = false;
    state.response = write().finally(() => { settled = true; });
    await sleep(200);
    state.settledInWindow = settled;
  };
  dbClient.execute = (async (stmt: Parameters<typeof execute>[0]) => {
    const sql = typeof stmt === "string" ? stmt : stmt.sql;
    const args = typeof stmt === "string" ? [] : Object.values(stmt.args ?? {});
    const hit = !state.hit && match(sql, args);
    if (hit) { state.hit = true; dbClient.execute = execute; }
    if (hit && when === "before") await cut();
    const result = await execute(stmt);
    if (hit && when === "after") await cut();
    return result;
  }) as typeof dbClient.execute;
  return state;
}
const queueMembershipRead = (taskId: string) => (sql: string, args: unknown[]) =>
  /^select .*from "queue_items" where "queue_items"\."task_id" = \?$/.test(sql) && args.includes(taskId);
// 接着跑在临界区里读完归属之后落的那一笔 queued 占位(进临界区之前还有一次无互斥的快速读,那次
// 被入队插进来是对的:它会把任务交回队列按位置起)。
const queuedReservation = (taskId: string) => (sql: string, args: unknown[]) =>
  /^update "tasks" set "status" = \?/.test(sql) && args[0] === "queued" && args.includes(taskId);

// ── 夹具:Q 是一条队列,头上的 A 一直在跑 ──────────────────────────────────────────────
const at = new Date().toISOString();
await db.insert(schema.projects).values({ id: "p", name: "queue ownership", repoPath: root, createdAt: at });
await db.insert(schema.agents).values({ id: "fixture-claude", name: "claude@fixture", type: "claude", isDefault: true });
await db.insert(schema.groups).values([
  { id: "G", projectId: "p", name: "原来的组", mode: "parallel", paused: false, createdAt: at },
  { id: "G2", projectId: "p", name: "挪去的组", mode: "parallel", paused: false, createdAt: at },
]);
const task = (id: string, over: Partial<typeof tasks.$inferInsert> = {}): typeof tasks.$inferInsert => ({
  id, projectId: "p", title: `任务 ${id}`, body: id, status: "backlog", mode: "single", agentType: "claude",
  executorId: "fixture-claude", useWorktree: false, autoTitle: false, groupId: "G", createdAt: at, updatedAt: at, ...over,
});
await db.insert(tasks).values([
  task("A"),
  task("H1", { status: "done", groupId: null }),
  task("X1", { dispatchedBy: "H1" }),
  task("X2"),
  task("X3", { status: "paused" }),
  task("H4", { status: "done", groupId: null }),
  task("X4", { dispatchedBy: "H4" }),
]);

let failure: unknown = null;
try {
  assert.equal((await request("POST", "/tasks/A/run")).status, 202);
  await running("A");
  const created = await request("POST", "/queues", { taskIds: ["A"] });
  assert.equal(created.status, 201);
  const Q = ((await created.json()) as { queueId: string }).queueId;

  // ③ 先认领、后占回合锁的入口(回复、答复、消息补投):放行之后、锁还没占上 ─────────────────
  const claim = await claimQueueSeat("X3");
  assert.ok(claim.ok && claim.seat === null, "不在队列的任务直接放行");
  assert.equal(runs.isTurnClaimed("X3"), false);
  assert.equal((await request("POST", `/queues/${Q}/insert`, { taskId: "X3" })).status, 409,
    "认领刚放行的独立任务,在它占上回合锁之前也算正在起跑");
  assert.deepEqual(await queueOf(Q), ["A"]);

  // ① 接着跑兑现 × 入队 ─────────────────────────────────────────────────────────────
  await holdDispatched("H1");
  await oweHeldStart("X1", "H1");
  const joinX1 = interleave("before", queuedReservation("X1"),
    () => request("POST", `/queues/${Q}/insert`, { taskId: "X1", position: 1 }));
  await releaseDispatched("H1");
  await until("接着跑读到 X1 的归属", () => joinX1.hit);
  await running("X1");
  assert.equal(joinX1.settledInWindow, false, "入队不能插进接着跑「读完归属 → 落占位」之间");
  assert.equal((await joinX1.response!).status, 409, "X1 已经占好位在起跑,同队 A 也在跑,入队该被拒");
  assert.deepEqual(await queueOf(Q), ["A"], "队列里只有原来那一条");

  // ② 手动运行一条独立任务 × 入队 ────────────────────────────────────────────────────
  // /run 先做一次无互斥的快速检查(也读这张表),那一次不算;要拦的是占了回合锁之后认领里那一次。
  const joinX2 = interleave("after", (sql, args) => queueMembershipRead("X2")(sql, args) && runs.isTurnClaimed("X2"),
    () => request("POST", `/queues/${Q}/insert`, { taskId: "X2", position: 1 }));
  assert.equal((await request("POST", "/tasks/X2/run")).status, 202);
  assert.ok(joinX2.hit, "认领在临界区里读了 X2 的归属");
  assert.equal(joinX2.settledInWindow, false, "入队不能插进认领「读完归属 → 放行起跑」的那一拍");
  assert.equal((await joinX2.response!).status, 409, "X2 正以独立任务身份起跑,入队该被拒");
  await running("X2");
  assert.deepEqual(await queueOf(Q), ["A"]);

  // ④ 接着跑兑现 × 改分组 ───────────────────────────────────────────────────────────
  await holdDispatched("H4");
  await oweHeldStart("X4", "H4");
  let statusWhenMoved: string | null = null;
  const moveX4 = interleave("before", queuedReservation("X4"),
    () => request("PATCH", "/tasks/X4", { groupId: "G2" }).then(async (response) => {
      statusWhenMoved = (await row("X4")).status;
      return response;
    }));
  await releaseDispatched("H4");
  await until("接着跑读到 X4 的归属", () => moveX4.hit);
  assert.equal(moveX4.settledInWindow, false, "改分组不能插进接着跑「比对分组 → 落占位」的那一拍");
  assert.equal((await moveX4.response!).status, 200);
  assert.ok(statusWhenMoved === "queued" || statusWhenMoved === "running",
    `改分组排在占位之后(落库时 X4 是 ${statusWhenMoved})`);
  await running("X4");
  assert.equal((await row("X4")).groupId, "G2");

  assert.deepEqual(launches.filter((id) => id !== "A").sort(), ["X1", "X2", "X4"], "每条只起了一次");
  console.log("queue ownership race: ok");
} catch (error) {
  failure = error;
} finally {
  for (const release of gates.values()) release();
  await sleep(300);
  dbClient.close();
  rmSync(root, { recursive: true, force: true });
}
if (failure) {
  console.error(failure);
  process.exit(1);
}
process.exit(0);
