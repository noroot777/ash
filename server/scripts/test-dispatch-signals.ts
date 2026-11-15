// 派出的任务来问 / 失败，在派它的那条任务那一头（src/dispatch-signals.ts、db/schema-dispatch-signals.ts）：
//   · 来问不往派它的那条任务名下记任何东西、不通知它：答题卡只在提问的那条任务自己的页面上；
//     早一版记下的提问行（升级前留在库里的）读的时候不给，提问触发器升级时拆掉；
//   · 提问的那条自己答：答复送到它、它接着跑，派它的那条一个回合都没多、状态不变；
//   · 名下有在问的时候，往派它的那条任务里说一句：送到的是它自己，提问的那条原样等着；
//   · 失败的那一刻记在派它的那条任务名下，原因跟落 failed 那一笔一起写进那一行：续聊回到原失败
//     不碰旧行；重试再失败再记一行；启动对账落的失败也有原因；只冒一层；
//   · 事件挂在派它的那条任务上：多人模式下看得见它的人收得到，看不见的收不到；
//   · 刷新、重启后还在；删了任务连它的记录一起没。
//
// 跑的是 PATH 上的假 claude（scheduled-messages-fixture.ts），不起真实 CLI。
// 跑：npm -w @ash/server run test:dispatch-signals
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { DispatchSignal } from "@ash/shared";
import { releaseTmpDb } from "./tmp-db.js";
import { installFakeClaude } from "./scheduled-messages-fixture.js";

const root = mkdtempSync(join(tmpdir(), "ash-dispatch-signals-"));
const leadLog = join(root, "lead-input.jsonl");
const originalPath = process.env.PATH;
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_ALLOW_REAL_AGENT = "1";
process.env.ASH_TEST_LEAD_LOG = leadLog;
process.env.PATH = `${installFakeClaude(root)}${delimiter}${originalPath ?? ""}`;

const [{ db, dbClient, ensureSchema }, schema, signalsSchema, runs, runRoutes, { bus }, question, { setTaskStatus }, reconcile] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/db/schema-dispatch-signals.js"),
  import("../src/runs.js"),
  import("../src/task-run-routes.js"),
  import("../src/bus.js"),
  import("../src/task-question.js"),
  import("../src/status.js"),
  import("../src/task-reconcile.js"),
]);
const { projects, scheduledMessages, sessions, sessionTurns, tasks } = schema;
const { dispatchSignals } = signalsSchema;
await ensureSchema();
const api = new Hono();
runRoutes.mountTaskRunRoutes(api);

const announced: string[] = [];
const statusTrail = new Map<string, string[]>();
bus.subscribe((event) => {
  if (event.type === "task.dispatchSignals") announced.push(event.taskId);
  if (event.type === "task.status") statusTrail.set(event.taskId, [...(statusTrail.get(event.taskId) ?? []), event.status]);
});

const at = new Date(Date.now() - 60_000).toISOString();
const projectId = "dispatch-signals-project";
const row = (id: string, status: string, extra: Partial<typeof tasks.$inferInsert> = {}): typeof tasks.$inferInsert => ({
  id, projectId, groupId: null, parentId: null, title: `任务 ${id}`, body: "派出的任务来问", mode: "single", status,
  labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "claude", executorId: null, autoTitle: false,
  duet: null, team: null, scheduleId: null, createdAt: at, updatedAt: at, useWorktree: false, worktreeBase: null,
  originTaskId: null, ...extra,
});
const withSession = (taskId: string) => db.insert(sessions).values({
  id: `${taskId}-prev`, taskId, role: "single", agentType: "claude", executor: "claude@test", cwd: root,
  cliSessionId: `${taskId}-cli`, startedAt: at,
});
const waitFor = async (predicate: () => boolean | Promise<boolean>, message: string) => {
  const deadline = Date.now() + 15_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
const countIn = (needle: string) => (existsSync(leadLog) ? readFileSync(leadLog, "utf8") : "").split(needle).length - 1;
const taskOf = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
const settled = async (id: string) => {
  const status = (await taskOf(id)).status;
  return status !== "running" && status !== "queued" && !runs.isRunning(id) && !runs.isTurnClaimed(id);
};
const signalsOf = async (id: string) => {
  const res = await api.request(`/tasks/${id}/dispatch-signals`);
  assert.equal(res.status, 200);
  return res.json() as Promise<DispatchSignal[]>;
};
const post = (path: string, body: Record<string, unknown>) => api.request(path, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const footprint = async (id: string) => ({
  status: (await taskOf(id)).status,
  updatedAt: (await taskOf(id)).updatedAt,
  sessions: (await db.select().from(sessions).where(eq(sessions.taskId, id))).length,
  turns: (await db.select().from(sessionTurns).where(eq(sessionTurns.taskId, id))).length,
  messages: (await db.select().from(scheduledMessages).where(eq(scheduledMessages.taskId, id))).length,
});
const triggers = async () => (await dbClient.execute("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'dispatch_signals%'"))
  .rows.map((r) => String(r.name)).sort();

const [P, D1, D2, G, SOLO, OLD] = ["ds-lead", "ds-kid-1", "ds-kid-2", "ds-grandkid", "ds-solo", "ds-old"];
let failure: unknown = null;
try {
  await db.insert(projects).values({ id: projectId, name: "dispatch-signals", repoPath: root, apiKeys: null, createdAt: at });
  await db.insert(tasks).values([
    row(P, "done"),
    row(D1, "running", { dispatchedBy: P }),
    row(D2, "running", { dispatchedBy: P }),
    row(G, "running", { dispatchedBy: D1 }),
    row(SOLO, "running"),
    row(OLD, "failed", { dispatchedBy: P }),
  ]);
  for (const id of [P, D1, D2, G, SOLO]) await withSession(id);

  // —— 升级：早一版的表（带提问那几列）、早一版的提问触发器、早一版记下的提问行和失败行。
  //    升级后提问触发器没了，提问行留在库里但读的时候不给，失败行照旧读得出原因。
  await dbClient.executeMultiple(`
    DROP TRIGGER IF EXISTS dispatch_signals_failed;
    DROP TABLE dispatch_signals;
    CREATE TABLE dispatch_signals (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      dispatcher_id TEXT NOT NULL, task_id TEXT NOT NULL, kind TEXT NOT NULL, occurred_at TEXT NOT NULL,
      question TEXT, question_options TEXT, question_items TEXT, reason TEXT, answered_at TEXT, answer TEXT
    );
    CREATE TRIGGER dispatch_signals_question AFTER UPDATE OF question ON tasks
      WHEN NEW.question IS NOT NULL AND NEW.dispatched_by IS NOT NULL
    BEGIN
      INSERT INTO dispatch_signals (dispatcher_id, task_id, kind, occurred_at, question)
        VALUES (NEW.dispatched_by, NEW.id, 'question', NEW.updated_at, NEW.question);
    END;
    INSERT INTO dispatch_signals (dispatcher_id, task_id, kind, occurred_at, question, answered_at, answer)
      VALUES ('${P}', '${OLD}', 'question', '${at}', '早一版记下的提问', '${at}', '{"answer":"在派它的那条里答的"}');
    INSERT INTO dispatch_signals (dispatcher_id, task_id, kind, occurred_at, reason)
      VALUES ('${P}', '${OLD}', 'failed', '${at}', '早一版记下的失败原因。');
  `);
  await ensureSchema();
  assert.deepEqual(await triggers(), ["dispatch_signals_failed", "dispatch_signals_task_deleted"], "升级后提问触发器拆掉了");
  let listed = await signalsOf(P);
  assert.deepEqual(listed.map((signal) => [signal.taskId, signal.kind, signal.reason]), [[OLD, "failed", "早一版记下的失败原因。"]],
    "早一版记下的提问不给（老会话里那颗提问气泡不再画），失败照旧");
  assert.equal((await dbClient.execute("SELECT count(*) AS n FROM dispatch_signals WHERE kind = 'question'")).rows[0]!.n, 1,
    "库里已有的提问记录原样留着，不删");
  console.log("✓ 升级：提问触发器拆掉；早一版的提问行不读、不删；失败行照旧");

  const before = await footprint(P);
  // —— 来问：派它的那条名下什么都不记，也不通知它。
  assert.equal(await question.setTaskQuestion({ taskId: D1, question: "先改哪一块？前端还是服务端。", options: ["前端", "服务端"] }), true);
  assert.equal(await question.setTaskQuestion({ taskId: D2, question: "要不要迁数据？" }), true);
  assert.equal(await question.setTaskQuestion({ taskId: G, question: "孙一层的提问" }), true);
  assert.equal(await question.setTaskQuestion({ taskId: SOLO, question: "没人派的任务来问" }), true);
  for (const id of [D1, D2, G, SOLO]) await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, id));
  assert.deepEqual(await signalsOf(P), listed, "派出的任务来问：派它的那条名下不多一行");
  assert.deepEqual(await signalsOf(D1), [], "孙一层来问：它的上一层名下也不记");
  assert.equal((await db.select().from(dispatchSignals)).length, 2, "提问一行都不记");
  assert.deepEqual(announced, [], "来问不通知派它的那条");
  console.log("✓ 来问：派它的那条名下不记、不通知");

  // —— 名下有在问的时候，往派它的那条任务里说一句：送到的是它自己，提问的那几条原样等着。
  const kidsBefore = await Promise.all([D1, D2].map(async (id) => ({ ...(await footprint(id)), question: (await taskOf(id)).question })));
  const said = "这条任务自己听的话(ds-reply-lead)";
  const replied = await post(`/tasks/${P}/reply`, { text: said });
  assert.deepEqual(await replied.json(), { started: true }, "派它的那条接住这句话、开了它自己的一个回合");
  await waitFor(() => countIn(said) > 0, "那句话没有送进派它的那条任务的会话");
  await waitFor(() => settled(P), "派它的那条这一轮没有结算");
  const afterReply = await footprint(P);
  assert.ok(afterReply.turns > before.turns, "那句话是派它的那条自己的一个回合");
  assert.deepEqual(await Promise.all([D1, D2].map(async (id) => ({ ...(await footprint(id)), question: (await taskOf(id)).question }))), kidsBefore,
    "提问的那几条：问题还挂着、一个回合都没多");
  assert.equal((await taskOf(D1)).questionHistory, null, "那句话没被当成答复");
  console.log("✓ 名下有在问时往派它的那条说话：送到的是它自己，提问的那几条原样等着");

  // —— 提问的那条自己答：答复送到它、它接着跑；派它的那条一点没动。
  const settledLead = await footprint(P);
  const trailLead = statusTrail.get(P)?.length ?? 0;
  const d1Answer = "先改前端(ds-answer-d1)";
  const answered = await post(`/tasks/${D1}/answer`, { answer: d1Answer, answers: [d1Answer] });
  assert.equal(answered.status, 200);
  assert.equal(((await answered.json()) as { resumed?: boolean }).resumed, true, "答复让提问的那条接着跑");
  await waitFor(() => countIn(d1Answer) > 0, "答复没有送进提问那条任务的会话");
  assert.equal((await taskOf(D1)).question, null, "那一问撤下了");
  await waitFor(() => settled(D1), "提问的那条续跑后没有结算");
  assert.deepEqual(await footprint(P), settledLead, "派它的那条：没有多出回合、会话、待发消息，状态、更新时刻都没变");
  assert.equal(statusTrail.get(P)?.length ?? 0, trailLead, "派它的那条一次状态都没广播过");
  console.log("✓ 提问的那条答了：它接着跑；派它的那条一个回合都没多");

  // —— 失败：跟着状态那一笔记下，原因跟落位那一笔一起写进那一行。
  assert.equal((await taskOf(D1)).status, "failed", "前提：假 CLI 不交卷，这一轮记未完成");
  await waitFor(() => announced.includes(P), "派出的任务失败时没有通知派它的那条去重读");
  const failedRows = async () => (await signalsOf(P)).filter((signal) => signal.taskId === D1);
  const failed = await failedRows();
  assert.equal(failed.length, 1, "失败那一刻记了一行");
  assert.equal(failed[0]!.kind, "failed");
  assert.match(failed[0]!.reason ?? "", /没有交卷/, "原因是结算那一句");
  // 在失败的那条上续聊一句：收尾回到原来的「失败」不是又失败了一次 —— 也不把这一句原因写到上一次失败头上。
  await db.update(tasks).set({ status: "running", followUpFrom: "failed" }).where(eq(tasks.id, D1));
  assert.equal(await setTaskStatus(D1, "failed", { consume: { followUpFrom: null }, failedBecause: "续聊这一轮的原因" }), true);
  assert.deepEqual((await failedRows()).map((signal) => signal.reason), [failed[0]!.reason], "续聊回到原终态不另记，上一次的原因不被改写");
  // 重试是执行回合：再失败一次就再记一行，原因跟那一笔一起写进新的这一行。
  await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, D1));
  assert.equal(await setTaskStatus(D1, "failed", { failedBecause: "重试那一轮：模型上游连不上（503）。" }), true);
  assert.deepEqual((await failedRows()).map((signal) => signal.reason), [failed[0]!.reason, "重试那一轮：模型上游连不上（503）。"], "重试再失败，再记一行");
  // 只冒一层：孙一层失败记在它的上一层。
  await db.update(tasks).set({ status: "running", question: null }).where(eq(tasks.id, G));
  assert.equal(await setTaskStatus(G, "failed", { failedBecause: "孙一层失败了。" }), true);
  assert.deepEqual((await signalsOf(D1)).map((signal) => signal.taskId), [G], "孙一层失败记在它的上一层");
  assert.equal((await signalsOf(P)).some((signal) => signal.taskId === G), false, "不再往上冒");
  console.log("✓ 失败：派它的那条名下有一行，原因跟落位那一笔一起写，续聊不碰旧行，只冒一层");

  // —— 启动对账落的失败（上一个进程跑到一半没了）：原因跟那一笔一起写下。
  const D4 = "ds-kid-4";
  await db.insert(tasks).values(row(D4, "running", { dispatchedBy: P }));
  await withSession(D4);
  assert.equal(await reconcile.reconcileInterruptedTask(D4), true);
  assert.equal((await taskOf(D4)).status, "failed", "前提：被打断的执行回合落 failed");
  const d4 = (await signalsOf(P)).filter((signal) => signal.taskId === D4);
  assert.equal(d4.length, 1);
  assert.ok((d4[0]!.reason ?? "").length > 0, `对账落的失败也说得出原因：${d4[0]!.reason}`);
  console.log(`✓ 启动对账落的失败带原因：${d4[0]!.reason}`);

  // —— 刷新后还在：重读、重启（再跑一遍建表）都是同一份，触发器不重复装。
  listed = await signalsOf(P);
  await ensureSchema();
  assert.deepEqual(await signalsOf(P), listed, "重启后读回同一份");
  assert.deepEqual(await triggers(), ["dispatch_signals_failed", "dispatch_signals_task_deleted"]);

  // —— 不是派出去的任务失败不记；删了任务连它的记录一起没。
  await db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, SOLO));
  assert.equal((await db.select().from(dispatchSignals).where(eq(dispatchSignals.taskId, SOLO))).length, 0);
  await db.delete(sessions).where(eq(sessions.taskId, D4));
  await db.delete(tasks).where(eq(tasks.id, D4));
  assert.equal((await signalsOf(P)).filter((signal) => signal.taskId === D4).length, 0, "删了任务，它的记录一起没");
  console.log("✓ 刷新、重启后还在；删任务连记录一起删");

  // —— 多人模式：事件挂在派它的那条任务上，看得见那条任务的人收得到，看不见的收不到（放在最后：转不回自用）。
  const [{ setInstanceMode }, { createUser }, { addProjectMember }, { makeEventFilter }] = await Promise.all([
    import("../src/auth/mode.js"), import("../src/auth/store.js"), import("../src/auth/visibility.js"), import("../src/auth/event-filter.js"),
  ]);
  await setInstanceMode("multi", join(root, "users"));
  const person = (name: string) => createUser({ name, role: "member", dirName: name, gitName: name, gitEmail: `${name}@example.test`, createdBy: null });
  const [alice, bob] = [await person("alice"), await person("bob")];
  await addProjectMember({ projectId, userId: alice.id, role: "member", addedBy: alice.id });
  const filters = [alice, bob].map((user) => makeEventFilter({ kind: "user", userId: user.id, role: "member", name: user.name }));
  await Promise.all(filters.map((filter) => filter.refresh()));
  const events: import("@ash/shared").ServerEvent[] = [];
  const unsubscribe = bus.subscribe((event) => { if (event.type === "task.dispatchSignals") events.push(event); });
  await db.update(tasks).set({ status: "running", question: null }).where(eq(tasks.id, D2));
  assert.equal(await setTaskStatus(D2, "failed", { failedBecause: "多人模式下失败了。" }), true);
  await waitFor(() => events.length > 0, "失败了没有通知派它的那条");
  unsubscribe();
  const event = events.at(-1)!;
  for (const filter of filters) filter.allow(event); // 头一回只是把任务归属的项目补进缓存
  await waitFor(() => filters[0]!.allow(event), "看得见派它的那条任务的人收不到这条事件");
  assert.equal(filters[1]!.allow(event), false, "看不见那条任务的人收不到");
  for (const filter of filters) filter.stop();
  console.log("✓ 多人模式：事件挂在派它的那条任务上，看得见的收得到、看不见的收不到");
} catch (error) {
  failure = error;
  console.error(error);
} finally {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  for (const id of runs.runningTaskIds?.() ?? []) runs.stopTask(id);
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
  process.exit(failure ? 1 : 0);
}
