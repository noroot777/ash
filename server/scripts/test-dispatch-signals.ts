// 派出的任务来问 / 失败，直接到用户手上（src/dispatch-signals.ts、db/schema-dispatch-signals.ts）：
//   · 来问、失败的那一刻记在派它的那条任务名下，刷新（重读）后还在，原话、原因都在；
//   · 只冒一层：派出的任务又派出的任务来问，记在它的上一层；不是派出去的任务不记；
//   · 在派它的那条任务里答：答复送到的是提问的那一条、它接着跑，派它的那条一个回合都没多、状态不变；
//   · 在别处答了：那一问照样认得出「答过了」，只是不留「你」那颗气泡；
//   · 升级前就在问的补一行、只补一次；删了任务连它的记录一起没。
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

const [{ db, dbClient, ensureSchema }, schema, signalsSchema, runs, runRoutes, { bus }, question] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/db/schema-dispatch-signals.js"),
  import("../src/runs.js"),
  import("../src/task-run-routes.js"),
  import("../src/bus.js"),
  import("../src/task-question.js"),
]);
const { projects, scheduledMessages, sessions, sessionTurns, tasks } = schema;
const { dispatchSignals, backfillOpenDispatchQuestions } = signalsSchema;
await ensureSchema();
const api = new Hono();
runRoutes.mountTaskRunRoutes(api);

const announced: string[] = [];
const statusTrail = new Map<string, string[]>();
bus.subscribe((event) => {
  if (event.type === "task.dispatchSignals") announced.push(event.dispatcherId);
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
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
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
const answer = async (id: string, body: Record<string, unknown>) => {
  const res = await api.request(`/tasks/${id}/answer`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, `${id} 的答复应被接住`);
  return res.json() as Promise<{ resumed?: boolean; queued?: boolean }>;
};
const footprint = async (id: string) => ({
  status: (await taskOf(id)).status,
  updatedAt: (await taskOf(id)).updatedAt,
  sessions: (await db.select().from(sessions).where(eq(sessions.taskId, id))).length,
  turns: (await db.select().from(sessionTurns).where(eq(sessionTurns.taskId, id))).length,
  messages: (await db.select().from(scheduledMessages).where(eq(scheduledMessages.taskId, id))).length,
});

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
  ]);
  for (const id of [P, D1, D2, G, SOLO]) await withSession(id);
  const before = await footprint(P);

  // —— 来问：记在派它的那条名下，按先后；原话（题目、选项）原样。
  assert.equal(await question.setTaskQuestion({ taskId: D1, question: "先改哪一块？前端还是服务端。", options: ["前端", "服务端"] }), true);
  await tick();
  assert.equal(await question.setTaskQuestion({
    taskId: D2, question: "两件事要你定。", items: [{ question: "要不要迁数据？", options: ["要"] }, { question: "什么时候上？" }],
  }), true);
  await tick();
  assert.equal(await question.setTaskQuestion({ taskId: G, question: "孙一层的提问" }), true);
  assert.equal(await question.setTaskQuestion({ taskId: SOLO, question: "没人派的任务来问" }), true);
  for (const id of [D1, D2, G, SOLO]) await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, id));
  await waitFor(() => announced.filter((id) => id === P).length >= 2, "派出的任务来问时没有通知派它的那条去重读");
  let listed = await signalsOf(P);
  assert.deepEqual(listed.map((signal) => [signal.taskId, signal.kind]), [[D1, "question"], [D2, "question"]], "几条同时问：按提问先后");
  assert.equal(listed[0]!.question, "先改哪一块？前端还是服务端。");
  assert.deepEqual(listed[0]!.questionOptions, ["前端", "服务端"], "选项是原话");
  assert.deepEqual(listed[1]!.questionItems, [{ question: "要不要迁数据？", options: ["要"] }, { question: "什么时候上？" }]);
  assert.ok(listed.every((signal) => signal.answered === false && !signal.answer), "还没人答");
  assert.ok(listed[0]!.at < listed[1]!.at, "时刻就是提问那一刻");
  assert.deepEqual((await signalsOf(D1)).map((signal) => signal.taskId), [G], "只冒一层：孙一层的提问记在它的上一层");
  assert.equal((await db.select().from(dispatchSignals)).length, 3, "不是派出去的任务来问不记");
  console.log("✓ 来问：记在派它的那条名下、按先后、原话不改，只冒一层");

  // —— 在派它的那条任务里答：答复送到的是提问的那一条，派它的那条一点没动。
  const d1Answer = "先改前端(ds-answer-d1)";
  assert.equal((await answer(D1, { answer: d1Answer, answers: [d1Answer], via: P })).resumed, true, "答复让提问的那条接着跑");
  await waitFor(() => countIn(d1Answer) > 0, "答复没有送进提问那条任务的会话");
  assert.equal((await taskOf(D1)).question, null, "那一问撤下了：两处的卡都收走");
  await waitFor(() => settled(D1), "提问的那条续跑后没有结算");
  listed = await signalsOf(P);
  const d1 = listed.find((signal) => signal.taskId === D1 && signal.kind === "question")!;
  assert.equal(d1.answered, true);
  assert.equal(d1.answer?.answer, d1Answer, "在这里答的：留下那条问答记录（你那颗气泡）");
  assert.deepEqual(await footprint(P), before, "派它的那条：没有多出回合、会话、待发消息，状态、更新时刻都没变");
  assert.equal(statusTrail.get(P), undefined, "派它的那条一次状态都没广播过");
  console.log("✓ 在派它的那条里答：送到的是提问的那一条，它接着跑；派它的那条一个回合都没多");

  // —— 失败：跟着状态那一笔记下，原因在结算之后补上。
  assert.equal((await taskOf(D1)).status, "failed", "前提：假 CLI 不交卷，这一轮记未完成");
  listed = await signalsOf(P);
  const failed = listed.filter((signal) => signal.taskId === D1 && signal.kind === "failed");
  assert.equal(failed.length, 1, "失败那一刻记了一行");
  assert.match(failed[0]!.reason ?? "", /没有交卷/, "原因是结算那一句");
  assert.ok(failed[0]!.at >= d1.answer!.answeredAt, "按失败那一刻排在答复之后");
  // 在失败的那条上续聊一句：收尾回到原来的「失败」不是又失败了一次。
  await db.update(tasks).set({ status: "running", followUpFrom: "failed" }).where(eq(tasks.id, D1));
  await db.update(tasks).set({ status: "failed", followUpFrom: null }).where(eq(tasks.id, D1));
  assert.equal((await signalsOf(P)).filter((signal) => signal.taskId === D1 && signal.kind === "failed").length, 1, "续聊回到原终态不另记");
  // 重试是执行回合：再失败一次就再记一行。
  await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, D1));
  await db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, D1));
  assert.equal((await signalsOf(P)).filter((signal) => signal.taskId === D1 && signal.kind === "failed").length, 2, "重试再失败，再记一行");
  console.log("✓ 失败：派它的那条名下有一行，带着原因");

  // —— 在别处答了（不经派它的那条、或者 via 对不上）：认得出答过了，不留你那颗气泡。
  await answer(D2, { answer: "要(ds-answer-d2)；下周上", answers: ["要(ds-answer-d2)", "下周上"], via: G });
  await waitFor(() => countIn("ds-answer-d2") > 0, "D2 的答复没有送进它的会话");
  await waitFor(() => settled(D2), "D2 续跑后没有结算");
  listed = await signalsOf(P);
  const d2 = listed.find((signal) => signal.taskId === D2 && signal.kind === "question")!;
  assert.equal(d2.answered, true, "在别处答了：那一问认得出已经答过");
  assert.equal(d2.answer ?? null, null, "不是在派它的那条里答的，不留你那颗气泡");
  // 同一条再问一次：新的一问还在等，上一问仍是答过了。
  await tick();
  await question.setTaskQuestion({ taskId: D2, question: "再确认一次？" });
  listed = await signalsOf(P);
  const d2Questions = listed.filter((signal) => signal.taskId === D2 && signal.kind === "question");
  assert.deepEqual(d2Questions.map((signal) => signal.answered), [true, false], "再问一次是新的一问");
  console.log("✓ 在别处答了：认得出答过了；再问一次是新的一行");

  // —— 刷新后还在：重读、重启（再跑一遍建表）都是同一份，触发器不重复装。
  await ensureSchema();
  assert.deepEqual(await signalsOf(P), listed, "重启后读回同一份");
  await db.update(tasks).set({ question: "再确认一次？", updatedAt: new Date().toISOString() }).where(eq(tasks.id, D2));
  assert.equal((await signalsOf(P)).length, listed.length, "同一问只改了时刻不另记");

  // —— 升级前就在问的：补一行，只补一次。
  await db.insert(tasks).values(row(OLD, "paused", { dispatchedBy: P, question: "升级前就在问" }));
  await backfillOpenDispatchQuestions(dbClient as never);
  await backfillOpenDispatchQuestions(dbClient as never);
  assert.equal((await signalsOf(P)).filter((signal) => signal.taskId === OLD).length, 1, "升级前就在问的补一行，只补一次");

  // —— 不是派出去的任务失败不记；删了任务连它的记录一起没。
  await db.update(tasks).set({ status: "failed" }).where(eq(tasks.id, SOLO));
  assert.equal((await db.select().from(dispatchSignals).where(eq(dispatchSignals.taskId, SOLO))).length, 0);
  await db.delete(sessions).where(eq(sessions.taskId, D2));
  await db.delete(tasks).where(eq(tasks.id, D2));
  assert.equal((await signalsOf(P)).filter((signal) => signal.taskId === D2).length, 0, "删了任务，它的记录一起没");
  console.log("✓ 刷新、重启后还在；升级前在问的补一行；删任务连记录一起删");
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
