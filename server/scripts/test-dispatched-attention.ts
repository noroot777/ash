// 派出的任务来问 / 失败，在派它的那条任务那一头什么都不出（用户 2026-11-15 定的）：
//   · 来问、答复、失败，派它的那条任务名下都不记、不广播任何事件，它一个回合都不多、状态不变；
//     提示只靠前端从任务列表算的那个数变色（lib/dispatchTree.ts，回归在 web 那份）；
//   · 名下有在问的时候，往派它的那条任务里说一句：送到的是它自己，提问的那几条原样等着；
//   · 提问的那条自己答：答复送到它、它接着跑；
//   · 升级：早一版记这些的触发器启动时拆掉，那张表和已记下的行原样留着（不删）；拆完以后改任务
//     状态、删任务都照常。
//
// 跑的是 PATH 上的假 claude（scheduled-messages-fixture.ts），不起真实 CLI。
// 跑：npm -w @ash/server run test:dispatched-attention
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { releaseTmpDb } from "./tmp-db.js";
import { installFakeClaude } from "./scheduled-messages-fixture.js";

const root = mkdtempSync(join(tmpdir(), "ash-dispatched-attention-"));
const leadLog = join(root, "lead-input.jsonl");
const originalPath = process.env.PATH;
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_ALLOW_REAL_AGENT = "1";
process.env.ASH_TEST_LEAD_LOG = leadLog;
process.env.PATH = `${installFakeClaude(root)}${delimiter}${originalPath ?? ""}`;

const [{ db, dbClient, ensureSchema }, schema, runs, runRoutes, questionRoutes, { bus }, question, { setTaskStatus }, reconcile] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/runs.js"),
  import("../src/task-run-routes.js"),
  import("../src/task-question-routes.js"),
  import("../src/bus.js"),
  import("../src/task-question.js"),
  import("../src/status.js"),
  import("../src/task-reconcile.js"),
]);
const { projects, scheduledMessages, sessions, sessionTurns, tasks } = schema;
await ensureSchema();
const api = new Hono();
runRoutes.mountTaskRunRoutes(api);
questionRoutes.mountTaskQuestionRoutes(api);

const at = new Date(Date.now() - 60_000).toISOString();
const projectId = "dispatched-attention-project";
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
  .rows.map((r) => String(r.name));
const legacyRows = async () => Number((await dbClient.execute("SELECT count(*) AS n FROM dispatch_signals")).rows[0]!.n);

const [P, D1, D2, D3, OLD] = ["da-lead", "da-kid-1", "da-kid-2", "da-kid-3", "da-old"];
let failure: unknown = null;
try {
  await db.insert(projects).values({ id: projectId, name: "dispatched-attention", repoPath: root, apiKeys: null, createdAt: at });
  await db.insert(tasks).values([
    row(P, "done"),
    row(D1, "running", { dispatchedBy: P }),
    row(D2, "running", { dispatchedBy: P }),
    row(OLD, "failed", { dispatchedBy: P }),
  ]);
  for (const id of [P, D1, D2]) await withSession(id);

  // —— 升级：早一版的表、三个触发器、已经记下的提问行和失败行。启动以后触发器拆掉，表和行原样留着。
  await dbClient.executeMultiple(`
    CREATE TABLE IF NOT EXISTS dispatch_signals (
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
    CREATE TRIGGER dispatch_signals_failed AFTER UPDATE OF status ON tasks
      WHEN NEW.status = 'failed' AND OLD.status IS NOT 'failed' AND NEW.dispatched_by IS NOT NULL
    BEGIN
      INSERT INTO dispatch_signals (dispatcher_id, task_id, kind, occurred_at) VALUES (NEW.dispatched_by, NEW.id, 'failed', NEW.updated_at);
    END;
    CREATE TRIGGER dispatch_signals_task_deleted AFTER DELETE ON tasks BEGIN
      DELETE FROM dispatch_signals WHERE task_id = OLD.id OR dispatcher_id = OLD.id;
    END;
    INSERT INTO dispatch_signals (dispatcher_id, task_id, kind, occurred_at, question)
      VALUES ('${P}', '${OLD}', 'question', '${at}', '早一版记下的提问');
    INSERT INTO dispatch_signals (dispatcher_id, task_id, kind, occurred_at, reason)
      VALUES ('${P}', '${OLD}', 'failed', '${at}', '早一版记下的失败原因。');
  `);
  assert.equal((await triggers()).length, 3, "前提：早一版的三个触发器都在");
  await ensureSchema();
  assert.deepEqual(await triggers(), [], "启动以后那三个触发器都拆掉了");
  assert.equal(await legacyRows(), 2, "早一版记下的行原样留着，不删");
  assert.equal((await api.request(`/tasks/${P}/dispatch-signals`)).status, 404, "读那份记录的接口没了");
  console.log("✓ 升级：触发器拆掉；表和已记下的行原样留着；读接口没了");

  // 盯住派它的那条任务：之后不管名下来问、答复、失败，它身上一条事件都不该有。「此刻能做什么可能变了」
  // 那条失效信号除外：它不带内容，只叫开着的页面重取一次键（task-actions-feed.ts），跟会话无关。
  const leadEvents: string[] = [];
  bus.subscribe((event) => {
    if ("taskId" in event && event.taskId === P && event.type !== "task.actions.stale") leadEvents.push(event.type);
  });
  const before = await footprint(P);

  // —— 来问：派它的那条名下不记、不广播。
  assert.equal(await question.setTaskQuestion({ taskId: D1, question: "先改哪一块？前端还是服务端。", options: ["前端", "服务端"] }), true);
  assert.equal(await question.setTaskQuestion({ taskId: D2, question: "要不要迁数据？" }), true);
  for (const id of [D1, D2]) await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, id));
  assert.equal(await legacyRows(), 2, "来问不往那张表里记");
  assert.deepEqual(leadEvents, [], "来问不惊动派它的那条");
  assert.deepEqual(await footprint(P), before);
  console.log("✓ 来问：派它的那条名下不记、不广播");

  // —— 名下有在问的时候，往派它的那条任务里说一句：送到的是它自己，提问的那几条原样等着。
  const kidsBefore = async () => Promise.all([D1, D2].map(async (id) => ({ ...(await footprint(id)), question: (await taskOf(id)).question })));
  const kids = await kidsBefore();
  const said = "这条任务自己听的话(da-reply-lead)";
  const replied = await post(`/tasks/${P}/reply`, { text: said });
  assert.deepEqual(await replied.json(), { started: true }, "派它的那条接住这句话、开了它自己的一个回合");
  await waitFor(() => countIn(said) > 0, "那句话没有送进派它的那条任务的会话");
  await waitFor(() => settled(P), "派它的那条这一轮没有结算");
  assert.ok((await footprint(P)).turns > before.turns, "那句话是派它的那条自己的一个回合");
  assert.deepEqual(await kidsBefore(), kids, "提问的那几条：问题还挂着、一个回合都没多");
  assert.equal((await taskOf(D1)).questionHistory, null, "那句话没被当成答复");
  console.log("✓ 名下有在问时往派它的那条说话：送到的是它自己，提问的那几条原样等着");

  // —— 提问的那条自己答：答复送到它、它接着跑；它这一轮失败（假 CLI 不交卷）。派它的那条一点没动。
  const lead = await footprint(P);
  leadEvents.length = 0;
  const d1Answer = "先改前端(da-answer-d1)";
  const answered = await post(`/tasks/${D1}/answer`, { answer: d1Answer, answers: [d1Answer] });
  assert.equal(answered.status, 200);
  assert.equal(((await answered.json()) as { resumed?: boolean }).resumed, true, "答复让提问的那条接着跑");
  await waitFor(() => countIn(d1Answer) > 0, "答复没有送进提问那条任务的会话");
  assert.equal((await taskOf(D1)).question, null, "那一问撤下了");
  await waitFor(() => settled(D1), "提问的那条续跑后没有结算");
  assert.equal((await taskOf(D1)).status, "failed", "前提：假 CLI 不交卷，这一轮记未完成");
  assert.deepEqual(await footprint(P), lead, "派它的那条：没有多出回合、会话、待发消息，状态、更新时刻都没变");
  assert.deepEqual(leadEvents, [], `答复、失败都不惊动派它的那条：${leadEvents.join()}`);
  assert.equal(await legacyRows(), 2, "失败也不往那张表里记");
  console.log("✓ 提问的那条答了、接着跑、失败了：派它的那条一个回合都没多、一条事件都没有");

  // —— 别的落 failed 的路：手动落位、启动对账，同样不记、不惊动。
  await db.update(tasks).set({ status: "running", question: null }).where(eq(tasks.id, D2));
  assert.equal(await setTaskStatus(D2, "failed"), true);
  await db.insert(tasks).values(row(D3, "running", { dispatchedBy: P }));
  await withSession(D3);
  assert.equal(await reconcile.reconcileInterruptedTask(D3), true);
  assert.equal((await taskOf(D3)).status, "failed", "前提：被打断的执行回合落 failed");
  assert.equal(await legacyRows(), 2);
  assert.deepEqual(leadEvents, []);
  assert.deepEqual(await footprint(P), lead);

  // —— 删任务照常（删除触发器没了，不连带也不报错）。
  await db.delete(sessions).where(eq(sessions.taskId, D3));
  await db.delete(tasks).where(eq(tasks.id, D3));
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, D3))).length, 0);
  console.log("✓ 手动落 failed、启动对账、删任务：照常，派它的那条不记、不惊动");
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
