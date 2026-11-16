// 队列/分组归属的写方与起跑认领争同一个原子边界(src/queue-claim-chain.ts)。
//
// 被钉住的那一类:起跑方在认领临界区里读完「它不在队列 / 还在原组」,隔着几个 await 才提交占位;
// 写方要是不进同一条链,就在这段窗口里按「它还是 backlog」把它插进一条有人在跑的队列,起跑方
// 随后按旧归属起跑,同队两个一起跑(mIDVPBcrvLZ8 第 4 轮审查实测)。每一节都在起跑方**读完归属、
// 还没提交**的那一拍把写请求发出去,断言写方要么排在后面看见那个占位而拒绝,要么根本没机会插进来:
//   ③ 回复/答复/补投那类先认领、后占回合锁的入口:认领刚放行、锁还没占上时入队,409。每次放行一张
//     凭证,只有交回它才作废:中途别处占过又还了回合锁(工作区操作之类)不算;两次放行各交各的;
//   ① 接着跑兑现(member-start.ts admit)× 入队:入队 409,队列里仍只有原来那一条;
//   ② 手动运行一条独立任务(/run → claimQueueSeat 不在队列那一支,不落 queued)× 入队:同上;
//   ⑤ 正在起跑的独立任务跟一条空闲任务一起建队:不能因为「在跑的只有一条」就放行 —— 队列推进
//     只读库,它在库里还是 backlog,排在前面的空闲任务会被拉起来跟它一起跑;
//   ④ 接着跑兑现 × 改 groupId:改分组排在占位之后,此刻它已占着旧组的名额,改分组被拒;
//   ⑥ 在跑的任务、跟别的成员同队的任务都不许改分组(名额记在旧组 / 同队必须同组);
//   ⑦ 建任务串到队尾时队列在中途没了:创建被拒,一行都没落下;
//   ⑦b 建任务那一笔还没提交时,别处运行分组、改它的分组:都排在提交之后,看见的是已经在队里的它
//     —— 不会被单独起跑,也不会被挪去别的组;
//   ⑧ 重新排队等链期间有人占上回合锁起它:出链前重验,不再把它写回待办;
//   ⑨ 重新排队挪位时写库失败:状态和位置一起不动,原入口照样能重试;
//   ⑩ 改分组进门时目标组还在、轮到时已被删:拒绝,不把任务挂回一个删掉的组;
//   ⑪ 等齐就起(前置放行)× 改分组:占着名额正要起跑(库里还是 backlog)时改分组被拒;改分组落在它读完
//     分组、还没占名额之间的,起跑方在链上认出组变了,不按旧组的名额起,按新组重排再起。
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
const { mountGroupRoutes } = await import("../src/group-routes.js");
const { holdDispatched, releaseDispatched } = await import("../src/dispatch-hold.js");
const { oweHeldStart } = await import("../src/dispatch-hold-owed.js");
const { claimQueueSeat, serializeQueueClaims } = await import("../src/queue-seat.js");
const { sweepPrerequisiteLaunches } = await import("../src/prerequisite-launch.js");
const { holdsSlot, slotsTaken } = await import("../src/launch-slots.js");
await ensureSchema();

const api = new Hono();
mountTaskRunRoutes(api);
mountTaskRoutes(api);
mountQueueRoutes(api);
mountGroupRoutes(api);

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
// 的时间,再照常执行、原样返回。写方若不在同一条链上,这段时间里它就已经落库了。根语句和事务里
// 的语句都拦(建任务、重新排队是整笔事务)。
type Exec = (stmt: Parameters<typeof dbClient.execute>[0]) => ReturnType<typeof dbClient.execute>;
function hookStatements(onStatement: (sql: string, args: unknown[], exec: () => ReturnType<Exec>) => ReturnType<Exec>): () => void {
  const execute = dbClient.execute.bind(dbClient);
  const transaction = dbClient.transaction.bind(dbClient);
  const through = (inner: Exec): Exec => (stmt) => {
    const sql = typeof stmt === "string" ? stmt : stmt.sql;
    const args = typeof stmt === "string" ? [] : Object.values(stmt.args ?? {});
    return onStatement(sql, args, () => inner(stmt));
  };
  dbClient.execute = through(execute) as typeof dbClient.execute;
  dbClient.transaction = (async (mode?: Parameters<typeof transaction>[0]) => {
    const tx = await transaction(mode);
    tx.execute = through(tx.execute.bind(tx)) as typeof tx.execute;
    return tx;
  }) as typeof dbClient.transaction;
  return () => { dbClient.execute = execute; dbClient.transaction = transaction; };
}
type Interleave = { hit: boolean; settledInWindow: boolean; response: Promise<Response> | null };
function interleave(when: "before" | "after", match: (sql: string, args: unknown[]) => boolean,
  write: () => Promise<Response>): Interleave {
  const state: Interleave = { hit: false, settledInWindow: false, response: null };
  const cut = async () => {
    let settled = false;
    state.response = write().finally(() => { settled = true; });
    await sleep(200);
    state.settledInWindow = settled;
  };
  const unhook = hookStatements(async (sql, args, exec) => {
    const hit = !state.hit && match(sql, args);
    if (hit) { state.hit = true; unhook(); }
    if (hit && when === "before") await cut();
    const result = await exec();
    if (hit && when === "after") await cut();
    return result;
  });
  return state;
}
// 命中的那一条语句报一次写错误(瞬时故障),之后照常。
function failOnce(match: (sql: string) => boolean): { hit: boolean } {
  const state = { hit: false };
  const unhook = hookStatements(async (sql, _args, exec) => {
    if (state.hit || !match(sql)) return exec();
    state.hit = true;
    unhook();
    throw new Error("注入的瞬时写错误");
  });
  return state;
}
// 占住认领链,直到放开:等链的写方按进链先后排队。
async function holdChain(): Promise<() => Promise<void>> {
  let open!: () => void;
  const held = new Promise<void>((resolve) => { open = resolve; });
  let entered!: () => void;
  const inChain = new Promise<void>((resolve) => { entered = resolve; });
  const blocker = serializeQueueClaims(async () => { entered(); await held; });
  await inChain;
  return async () => { open(); await blocker; };
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
  { id: "GP", projectId: "p", name: "停着的组", mode: "serial", paused: true, createdAt: at },
  { id: "GR", projectId: "p", name: "在跑的组", mode: "parallel", paused: false, createdAt: at },
  { id: "GD", projectId: "p", name: "要删的组", mode: "parallel", paused: false, createdAt: at },
  { id: "GS", projectId: "p", name: "等齐就起的组", mode: "parallel", paused: false, createdAt: at },
  { id: "GF", projectId: "p", name: "挪进去的组", mode: "parallel", paused: false, createdAt: at },
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
  task("Y1"),
  task("Y2"),
  // GP 停着:建队/挪位之后的自动推进不会去拉起这几条,只看归属写本身。
  task("Z1", { groupId: "GP" }),
  task("Z2", { groupId: "GP" }),
  task("R1", { groupId: "GP" }),
  task("R2", { groupId: "GP" }),
  task("R3", { groupId: "GP" }),
  task("R4", { groupId: "GP" }),
  task("L", { groupId: "GR" }),
  task("P1", { groupId: "GS" }),
  task("P2", { groupId: "GS" }),
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
  assert.ok(claim.ok, "不在队列的任务直接放行");
  assert.equal((await row("X3")).status, "paused", "独立任务不落 queued");
  assert.equal(runs.isTurnClaimed("X3"), false);
  assert.equal((await request("POST", `/queues/${Q}/insert`, { taskId: "X3" })).status, 409,
    "认领刚放行的独立任务,在它占上回合锁之前也算正在起跑");
  assert.deepEqual(await queueOf(Q), ["A"]);
  // 起跑没成、交回占位:「正在起跑」那一笔撤掉,能照常入队(再移出来,后面几节要 Q 只有 A)。
  await claim.seat.release();
  assert.equal((await request("POST", `/queues/${Q}/insert`, { taskId: "X3" })).status, 200, "交回之后不再算在起跑");
  assert.equal((await request("POST", `/queues/${Q}/remove`, { taskId: "X3" })).status, 200);
  // 别处占过又还了一把回合锁(工作区操作那一类),没有接手这次起跑:凭证还在,仍是 409。
  const again = await claimQueueSeat("X3");
  assert.ok(again.ok);
  const other = runs.claimOwnTurn("X3")!;
  runs.releaseTurn("X3", other);
  assert.equal((await request("POST", `/queues/${Q}/insert`, { taskId: "X3" })).status, 409,
    "别处的回合锁来了又走,证明不了这次起跑结束了");
  // 两次放行各一张凭证:交回一张,另一张还在。
  const twice = await claimQueueSeat("X3");
  assert.ok(twice.ok);
  await again.seat.release();
  assert.equal((await request("POST", `/queues/${Q}/insert`, { taskId: "X3" })).status, 409, "另一次起跑还没交回");
  await twice.seat.release();
  assert.equal((await request("POST", `/queues/${Q}/insert`, { taskId: "X3" })).status, 200, "全交回之后才不算在起跑");
  assert.equal((await request("POST", `/queues/${Q}/remove`, { taskId: "X3" })).status, 200);
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

  // ⑤ 正在起跑的独立任务 + 一条空闲任务一起建队 ─────────────────────────────────────────
  // 按 /run 的生产顺序:先占回合锁,再认领(放行、不落 queued),起跑还没落到 running。
  const y2Turn = runs.claimOwnTurn("Y2")!;
  const y2Claim = await claimQueueSeat("Y2", { turnHeld: y2Turn });
  assert.ok(y2Claim.ok);
  assert.equal((await request("POST", "/queues", { taskIds: ["Y1", "Y2"] })).status, 409,
    "库里还是 backlog 的那条正在起跑,不能放进队列");
  assert.equal((await db.select().from(queueItems).where(eq(queueItems.taskId, "Y1"))).length, 0);
  await y2Claim.seat.release();
  runs.releaseTurn("Y2", y2Turn);

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
  assert.equal((await moveX4.response!).status, 409, "占好位之后它占着旧组的名额,改分组要被拒");
  assert.ok(statusWhenMoved === "queued" || statusWhenMoved === "running",
    `改分组排在占位之后(应答时 X4 是 ${statusWhenMoved})`);
  await running("X4");
  assert.equal((await row("X4")).groupId, "G", "分组没变");

  // ⑥ 在跑的、同队有别人的,都不改分组 ────────────────────────────────────────────────
  assert.equal((await request("PATCH", "/tasks/X1", { groupId: "G2" })).status, 409, "在跑的任务不换组");
  const zq = await request("POST", "/queues", { taskIds: ["Z1", "Z2"] });
  assert.equal(zq.status, 201);
  const ZQ = ((await zq.json()) as { queueId: string }).queueId;
  assert.equal((await request("PATCH", "/tasks/Z2", { groupId: "G2" })).status, 409, "同队成员不单独换组");
  assert.equal((await row("Z2")).groupId, "GP");

  // ⑦ 串到队尾时队列在中途没了 ───────────────────────────────────────────────────────
  // 进门检查时 ZQ 还在;两次移出排在建任务前面进链,轮到建任务时队列已经空了。
  const appendBody = (title: string, groupId: string, appendToQueue: string) => ({
    projectId: "p", title, body: title, groupId, appendToQueue, agentType: "claude", executorId: "fixture-claude", useWorktree: false,
  });
  const openForAppend = await holdChain();
  const removeZ2 = request("POST", `/queues/${ZQ}/remove`, { taskId: "Z2" });
  const removeZ1 = request("POST", `/queues/${ZQ}/remove`, { taskId: "Z1" });
  await sleep(100);
  const appending = request("POST", "/tasks", appendBody("串到队尾", "GP", ZQ));
  await sleep(100);
  await openForAppend();
  assert.equal((await removeZ2).status, 200);
  assert.equal((await removeZ1).status, 200);
  assert.equal((await appending).status, 400, "队列已经没了,创建被拒");
  assert.equal((await db.select().from(tasks).where(eq(tasks.title, "串到队尾"))).length, 0, "一行都没落下");
  assert.deepEqual(await queueOf(ZQ), []);

  // ⑦b 建任务那一笔还没提交:别处运行分组、改它的分组 ──────────────────────────────────
  assert.equal((await request("POST", "/tasks/L/run")).status, 202);
  await running("L");
  const lq = await request("POST", "/queues", { taskIds: ["L"] });
  assert.equal(lq.status, 201);
  const LQ = ((await lq.json()) as { queueId: string }).queueId;
  let freshId = "";
  const meddle = interleave("after", (sql, args) => /^insert into "tasks"/.test(sql) && args.includes("串到在跑的队"), async () => {
    // 同一条连接上,事务里刚插的任务行别人读得到 —— 这正是它不许被别人先动的原因。
    freshId = (await db.select().from(tasks).where(eq(tasks.title, "串到在跑的队"))).at(0)!.id;
    assert.equal((await request("POST", "/groups/GR/run")).status, 202);
    return request("PATCH", `/tasks/${freshId}`, { groupId: "G2" });
  });
  const joined = await request("POST", "/tasks", appendBody("串到在跑的队", "GR", LQ));
  assert.ok(meddle.hit, "拦到了建任务插下任务行的那一拍");
  assert.equal(joined.status, 201, `创建成功(${await joined.clone().text()})`);
  assert.equal(meddle.settledInWindow, false, "改分组不能插进「插下任务行 → 串进队列」之间");
  assert.equal((await meddle.response!).status, 409, "轮到改分组时它已经跟 L 同队,不单独换组");
  assert.equal((await row(freshId)).groupId, "GR");
  assert.deepEqual(await queueOf(LQ), ["L", freshId]);
  await sleep(300);
  assert.equal(launches.includes(freshId), false, "L 在跑,同队的新任务不被分组运行单独拉起");
  assert.equal((await row(freshId)).status, "backlog");

  // ⑧ 重新排队等链期间有人起它 ───────────────────────────────────────────────────────
  const rq = await request("POST", "/queues", { taskIds: ["R1", "R2"] });
  assert.equal(rq.status, 201);
  const RQ = ((await rq.json()) as { queueId: string }).queueId;
  await db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, "R2")); // 入队之后失败了
  const openForRequeue = await holdChain();
  const requeue = request("POST", "/tasks/R2/requeue");
  await sleep(100);
  const r2Turn = runs.claimOwnTurn("R2")!; // 一次 /retry 抢先占上了它的回合锁
  await openForRequeue();
  assert.equal((await requeue).status, 409, "有人正在起它,不重新排队");
  assert.equal((await row("R2")).status, "failed", "状态没被写回待办");
  assert.deepEqual(await queueOf(RQ), ["R1", "R2"], "也没被挪位");
  runs.releaseTurn("R2", r2Turn);

  // ⑨ 重新排队挪位时写库失败 ─────────────────────────────────────────────────────────
  const rq2 = await request("POST", "/queues", { taskIds: ["R3", "R4"] });
  assert.equal(rq2.status, 201);
  const RQ2 = ((await rq2.json()) as { queueId: string }).queueId;
  // R3 失败之后 R4 开跑过:R3 被越过,重新排队要挪到队尾。
  await db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, "R3"));
  await db.update(tasks).set({ status: "done", startedAt: at }).where(eq(tasks.id, "R4"));
  const fault = failOnce((sql) => /^insert into "queue_items"/.test(sql));
  const broken = await request("POST", "/tasks/R3/requeue");
  assert.ok(fault.hit, "挪位那一笔写确实失败了");
  assert.notEqual(broken.status, 200, "挪位没成,这次重新排队报失败");
  assert.equal((await row("R3")).status, "failed", "状态跟着一起没落");
  assert.deepEqual(await queueOf(RQ2), ["R3", "R4"], "位置没动");
  const retried = await request("POST", "/tasks/R3/requeue");
  assert.equal(retried.status, 200, "原入口照样能重试");
  assert.equal(((await retried.json()) as { movedToEnd: boolean }).movedToEnd, true);
  assert.equal((await row("R3")).status, "backlog");
  assert.deepEqual(await queueOf(RQ2), ["R4", "R3"]);

  // ⑩ 改分组轮到时目标组已被删 ───────────────────────────────────────────────────────
  const openForMove = await holdChain();
  const deleting = request("DELETE", "/groups/GD");
  await sleep(100);
  const moving = request("PATCH", "/tasks/Y1", { groupId: "GD" }); // 进门检查时 GD 还在
  await sleep(100);
  await openForMove();
  assert.equal((await deleting).status, 200);
  assert.equal((await moving).status, 409, "目标组已经删了,不改");
  assert.equal((await row("Y1")).groupId, "G", "没被挂到删掉的组上");

  // ⑪ 等齐就起 × 改分组 ───────────────────────────────────────────────────────────
  // 占着名额、还没落 running:改分组被拒,名额与分组一致。
  await db.insert(schema.taskPrerequisiteLaunches).values({ taskId: "P1", requestedAt: at, source: "run" });
  const moveP1 = interleave("before",
    (sql, args) => /^select .*from "task_prerequisite_launches"/.test(sql) && args.includes("P1") && holdsSlot("P1"),
    () => request("PATCH", "/tasks/P1", { groupId: "GF" }));
  await sweepPrerequisiteLaunches();
  assert.ok(moveP1.hit, "放行那一路占着名额时拦到了");
  assert.equal((await moveP1.response!).status, 409, "占着原组名额正要起跑,不换组");
  await running("P1");
  assert.equal((await row("P1")).groupId, "GS");
  assert.equal(slotsTaken("GS"), 1, "名额记在它真在的那一组");
  // 改分组落在放行读完分组、还没占名额之间:不按旧组的名额起;名额空出来那一扫按新组起。
  await db.insert(schema.taskPrerequisiteLaunches).values({ taskId: "P2", requestedAt: at, source: "run" });
  const moveP2 = interleave("after",
    (sql, args) => /^select .*from "tasks" where "tasks"\."id" = \?$/.test(sql) && args.includes("P2") && !holdsSlot("P2"),
    () => request("PATCH", "/tasks/P2", { groupId: "GF" }));
  await sweepPrerequisiteLaunches();
  assert.ok(moveP2.hit, "拦到了放行读分组那一下");
  assert.equal((await moveP2.response!).status, 200, "那时还没人占名额,改分组照常成");
  assert.equal(launches.includes("P2"), false, "按旧组占的名额不起");
  assert.equal(holdsSlot("P2"), false, "旧组的名额还回去了");
  assert.equal((await row("P2")).status, "backlog");
  await sweepPrerequisiteLaunches();
  await running("P2");
  assert.equal((await row("P2")).groupId, "GF");
  assert.equal(slotsTaken("GF"), 1, "按新组的名额起");
  assert.equal(slotsTaken("GS"), 1, "旧组只剩 P1");

  assert.deepEqual(launches.filter((id) => id !== "A").sort(), ["L", "P1", "P2", "X1", "X2", "X4"], "每条只起了一次");
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
