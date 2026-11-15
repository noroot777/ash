// 派活单（src/dispatch-plan*.ts、MCP propose_dispatch）：
//   · 摆出来之后任务停着：写下的是 task.question，结算落 paused；刷新（重读任务、列表）后单子还在；
//   · 同一时刻只等用户一样东西：有提问在等时摆不出来，摆了单之后也问不出来，两边的拒绝说得清；
//     同一回合里同时发出提问和派活单，只有一个写得进去，另一个明说被谁占了（不是两边都说成功）；
//   · 「发回去改」就是对那一问的普通答复：一条任务都不建，智能体收到的是那句话（带一句「没有派出」）；
//   · 「派出去」由 ash 照卡上此刻的样子建（换的人、去掉的条、一个接一个 / 同时、顺序），挂在这条任务名下；
//     建任务的不是智能体（来源记的是用户），续上会话的那段答复里有建好的任务号、标题、交给了谁；
//   · 派过一次的单子再按一次、拿着旧单子的号来按，都不再建；
//   · 派出中途写库失败（队列那一笔）：整笔回滚，一条任务、一个分组都不留，单子原样还在；再按还是那样，修好再按只建一批；
//   · 「派出去的活交给谁」：派活单上没指明的那几条默认交给它，智能体绕过派活单直接建任务没给执行器时也交给它。
//
// 跑的是 PATH 上的假 claude（scheduled-messages-fixture.ts），不起真实 CLI。
// 跑：npm -w @ash/server run test:dispatch-plan
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { asc, eq, inArray, like, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Task } from "@ash/shared";
import { releaseTmpDb } from "./tmp-db.js";
import { installFakeClaude } from "./scheduled-messages-fixture.js";

const root = mkdtempSync(join(tmpdir(), "ash-dispatch-plan-"));
const leadLog = join(root, "lead-input.jsonl");
const originalPath = process.env.PATH;
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_ALLOW_REAL_AGENT = "1";
process.env.ASH_TEST_LEAD_LOG = leadLog;
process.env.PATH = `${installFakeClaude(root)}${delimiter}${originalPath ?? ""}`;

const [{ db, ensureSchema }, schema, runs, runRoutes, groupRoutes, taskRoutes, question, settle, plan] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/runs.js"),
  import("../src/task-run-routes.js"),
  import("../src/group-routes.js"),
  import("../src/task-routes.js"),
  import("../src/task-question.js"),
  import("../src/settle-status.js"),
  import("../src/dispatch-plan.js"),
]);
const { DISPATCH_PLAN_RETURNED } = await import("../src/task-question-record.js");
const { groups, projects, queueItems, sessions, tasks } = schema;
await ensureSchema();
const api = new Hono();
runRoutes.mountTaskRunRoutes(api);
groupRoutes.mountGroupRoutes(api);
taskRoutes.mountTaskRoutes(api);

const at = new Date(Date.now() - 60_000).toISOString();
const projectId = "dispatch-plan-project";
const row = (id: string, status: string, extra: Partial<typeof tasks.$inferInsert> = {}): typeof tasks.$inferInsert => ({
  id, projectId, groupId: null, parentId: null, title: `任务 ${id}`, body: "拆一件事派出去", mode: "single", status,
  labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "claude", executorId: null, model: "fable-5-2",
  autoTitle: false, duet: null, team: null, scheduleId: null, createdAt: at, updatedAt: at, useWorktree: false,
  worktreeBase: null, originTaskId: null, ...extra,
});
const waitFor = async (predicate: () => boolean | Promise<boolean>, message: string) => {
  const deadline = Date.now() + 15_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
const delivered = () => (existsSync(leadLog) ? readFileSync(leadLog, "utf8") : "");
const taskOf = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
const settled = async (id: string) => {
  const status = (await taskOf(id)).status;
  return status !== "running" && status !== "queued" && !runs.isRunning(id) && !runs.isTurnClaimed(id);
};
const send = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await api.request(path, {
    method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};
let turn = 0;
/** 让这条任务处在「正在跑的那一回合」里：MCP 调用要带上这一回合与方向的身份。 */
const inTurn = async (id: string) => {
  turn += 1;
  await db.update(tasks).set({ status: "running", activeTurnToken: `turn-${turn}`, activeDirectionToken: `dir-${turn}` }).where(eq(tasks.id, id));
  return { "x-ash-client": "mcp", "x-ash-source-task-id": id, "x-ash-turn-token": `turn-${turn}`, "x-ash-direction-token": `dir-${turn}` };
};
/** 那一回合结束：照真结算的判据落位（提问 / 派活单在等就是 paused）。 */
const endTurn = async (id: string) => {
  const result = await settle.settleTaskStatus(id, 0, null);
  await db.update(tasks).set({ status: result.status, activeTurnToken: null }).where(eq(tasks.id, id));
  return result.status;
};
const kidsOf = async (id: string) => db.select().from(tasks).where(eq(tasks.dispatchedBy, id)).orderBy(asc(tasks.createdAt));
const propose = (id: string, headers: Record<string, string>, body: unknown) => send("POST", `/tasks/${id}/dispatch-plan`, body, headers);
const PLAN = [
  { key: "gate", title: "验收门禁加准备命令", body: "在快照里现装依赖（完整说明 A）", note: "不再自己拒绝起跑" },
  { key: "entry", title: "关掉起手式的新建入口", body: "只关入口（完整说明 B）", note: "代码不动", prerequisites: ["gate"] },
  { title: "MCP 接入改成起跑时注入", body: "要上 Windows 真机验证（完整说明 C）", note: "要上真机", agentType: "codex", prerequisites: ["entry"] },
];

const [P, Q, R] = ["dp-lead", "dp-asking", "dp-race"];
let failure: unknown = null;
try {
  await db.insert(projects).values({ id: projectId, name: "dispatch-plan", repoPath: root, apiKeys: null, createdAt: at });
  await db.insert(tasks).values([row(P, "backlog"), row(Q, "backlog"), row(R, "backlog")]);
  for (const id of [P, Q, R]) {
    await db.insert(sessions).values({ id: `${id}-prev`, taskId: id, role: "single", agentType: "claude", executor: "claude@test", cwd: root, cliSessionId: `${id}-cli`, startedAt: at });
  }

  // —— 同一时刻只等用户一样东西：已经在问的，摆不出派活单。
  const qHeaders = await inTurn(Q);
  assert.equal(await question.setTaskQuestion({ taskId: Q, question: "先改哪一块？" }), true);
  const refused = await propose(Q, qHeaders, { tasks: PLAN });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, plan.QUESTION_BLOCKS_PLAN, "拒绝说得清：有提问在等");

  // —— 同一回合里同时发出提问和派活单：判在同一笔条件写里，只有一个写进去，另一个说清被谁占了。
  const rHeaders = await inTurn(R);
  const [racePlan, raceAsk] = await Promise.all([
    propose(R, rHeaders, { tasks: PLAN.slice(0, 1) }),
    send("POST", `/tasks/${R}/ask`, { question: "先回答我，还是先派活？" }, rHeaders),
  ]);
  assert.deepEqual([racePlan.status, raceAsk.status].sort(), [200, 409], `只有一个写得进去：${JSON.stringify([racePlan.body, raceAsk.body])}`);
  const raced = await taskOf(R);
  if (racePlan.status === 200) {
    assert.equal(raceAsk.body.error, plan.DISPATCH_PLAN_BLOCKS_ASK);
    assert.ok(raced.dispatchPlan && raced.question?.startsWith("派出这 1 个任务"), "留下的就是说成功的那一个");
  } else {
    assert.equal(racePlan.body.error, plan.QUESTION_BLOCKS_PLAN);
    assert.equal(raced.question, "先回答我，还是先派活？");
    assert.equal(raced.dispatchPlan, null);
  }
  console.log("✓ 同时提问和摆单：只有一个写进去，另一个明说被谁占了");

  // —— 智能体在回合里绕过派活单直接建：没给执行器的交给「同这里」（这条任务自己的那一套）。
  let headers = await inTurn(P);
  await db.insert(groups).values({ id: "dp-group", projectId, name: "直接建", mode: "parallel", paused: false, createdAt: at });
  const direct = await send("POST", "/groups/dp-group/tasks/batch", {
    tasks: [{ title: "直接建·没指明", body: "x" }, { title: "直接建·指明了", body: "y", agentType: "gemini" }],
  }, headers);
  assert.equal(direct.status, 201);
  const [same, named] = direct.body.tasks as Task[];
  assert.equal(same!.dispatchedBy, P);
  assert.deepEqual([same!.agentType, same!.model], ["claude", "fable-5-2"], "没指明执行器：同这里");
  assert.equal(named!.agentType, "gemini", "指明了的一个字不碰");

  // —— 「派出去的活交给谁」设成另一个执行器：直接建、派活单上没指明的条目都交给它。
  const setTarget = await send("PUT", `/tasks/${P}/dispatch-target`, { target: { agentType: "codex", model: "gpt-5.6" } });
  assert.equal(setTarget.status, 200);
  assert.deepEqual((setTarget.body as unknown as Task).dispatchTarget, { agentType: "codex", executorId: null, model: "gpt-5.6", reasoningEffort: null });
  const direct2 = await send("POST", "/groups/dp-group/tasks/batch", { tasks: [{ title: "直接建·默认改过之后", body: "z" }] }, headers);
  assert.deepEqual([(direct2.body.tasks as Task[])[0]!.agentType, (direct2.body.tasks as Task[])[0]!.model], ["codex", "gpt-5.6"], "没指明执行器：交给设的那个");
  console.log("✓ 默认交给谁：同这里时跟这条任务；设了之后直接建任务没给执行器的交给它，指明了的不碰");
  const directIds = new Set((await kidsOf(P)).map((kid) => kid.id));

  // —— 摆出来：写下的是那一问，任务停着；刷新（重读）后单子还在。
  const proposed = await propose(P, headers, { tasks: PLAN, order: "serial" });
  assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
  const planId = String(proposed.body.planId);
  const asked = await send("POST", `/tasks/${P}/ask`, { question: "顺便问一句" }, headers);
  assert.equal(asked.status, 409);
  assert.equal(asked.body.error, plan.DISPATCH_PLAN_BLOCKS_ASK, "摆了单就问不出来，拒绝说得清");
  assert.equal(await endTurn(P), "paused", "结算落 paused，队列不会自动续跑");
  const detail = (await send("GET", `/tasks/${P}`)).body as unknown as Task;
  assert.equal(detail.dispatchPlan?.id, planId, "刷新后单子还在");
  assert.match(detail.question ?? "", /^派出这 3 个任务（一个接一个）：\n1\. 验收门禁加准备命令 —— 不再自己拒绝起跑（交给 codex · gpt-5\.6）/,
    "写下的那一问是一句看得懂的清单：别的端不认识这张卡也看得出它在等什么");
  assert.match(detail.question ?? "", /3\. MCP 接入改成起跑时注入 —— 要上真机（交给 codex）/);
  assert.equal(detail.dispatchPlan?.items[2]!.target?.agentType, "codex", "智能体指明的交给谁记在单子上");
  assert.equal(detail.dispatchPlan?.items[0]!.target, null, "没指明的留空，卡上取默认值");
  const listed = (await send("GET", "/tasks")).body as unknown as Task[];
  assert.equal(listed.find((task) => task.id === P)?.dispatchPlan?.id, planId, "随列表下发");
  assert.equal((await kidsOf(P)).length, directIds.size, "摆出来时一条都没建");
  console.log("✓ 摆出来：任务停着，刷新后单子还在；有提问时摆不出来，摆了单问不出来");

  // —— 「发回去改」：普通答复，一条都不建；智能体收到那句话。
  const back = await send("POST", `/tasks/${P}/answer`, { answer: "第二条先别做(dp-back)" });
  assert.equal(back.status, 200);
  await waitFor(() => delivered().includes("dp-back"), "发回去的那句话没有送进会话");
  assert.ok(delivered().includes(DISPATCH_PLAN_RETURNED.slice(0, 12)), "答复前面说清一条都没建");
  assert.equal((await taskOf(P)).question, null, "卡收走了");
  assert.equal(((await send("GET", `/tasks/${P}`)).body as unknown as Task).dispatchPlan, null);
  await waitFor(() => settled(P), "续上的那一轮没有结算");
  assert.equal((await kidsOf(P)).length, directIds.size, "发回去改：一条任务都没建");
  const stale = await send("POST", `/tasks/${P}/dispatch-plan/launch`, { planId, order: "serial", items: [{ index: 0, target: { agentType: "claude" } }] });
  assert.equal(stale.status, 409, "发回去之后那张单子作废，按不出去");
  console.log("✓ 发回去改：一条任务都不建，智能体收到那句话");

  // —— 改完再摆一次；摆单的那一轮还没结束时按不出去。
  headers = await inTurn(P);
  const second = await propose(P, headers, { tasks: PLAN, order: "serial" });
  assert.equal(second.status, 200);
  const secondId = String(second.body.planId);
  const early = await send("POST", `/tasks/${P}/dispatch-plan/launch`, { planId: secondId, order: "serial", items: [{ index: 0, target: { agentType: "claude" } }] });
  assert.equal(early.status, 409, "那一轮还在跑：等它停下再派");
  await endTurn(P);

  // —— 「派出去」：换了第三条的人、去掉了第二条、改成同时；拿着旧单子的号按不出去。
  const wrong = await send("POST", `/tasks/${P}/dispatch-plan/launch`, { planId, order: "parallel", items: [{ index: 0, target: { agentType: "claude" } }] });
  assert.equal(wrong.status, 409, "旧单子的号按不出去");
  const pick = [
    { index: 0, target: { agentType: "codex", executorId: null, model: "gpt-5.6", reasoningEffort: null } },
    { index: 2, target: { agentType: "gemini", executorId: null, model: null, reasoningEffort: null } },
  ];
  const launched = await send("POST", `/tasks/${P}/dispatch-plan/launch`, { planId: secondId, order: "parallel", items: pick });
  assert.equal(launched.status, 200, JSON.stringify(launched.body));
  const kids = (await kidsOf(P)).filter((kid) => !directIds.has(kid.id));
  assert.deepEqual(kids.map((kid) => kid.title), ["验收门禁加准备命令", "MCP 接入改成起跑时注入"], "建的正是卡上留下的这几条、这个顺序");
  assert.deepEqual(kids.map((kid) => kid.agentType), ["codex", "gemini"], "交给的正是卡上那一格");
  assert.deepEqual(kids.map((kid) => kid.model), ["gpt-5.6", null]);
  assert.ok(kids[0]!.body.includes("完整说明 A") && kids[1]!.body.includes("完整说明 C"), "正文是单子上的完整说明");
  assert.ok(kids.every((kid) => JSON.parse(kid.creationOrigin ?? "{}").kind === "user"), "建任务的是 ash 照用户按下的那一下建的，不是智能体又调了一次工具");
  const group = (await db.select().from(groups).where(eq(groups.id, kids[0]!.groupId!))).at(0)!;
  assert.equal(group.mode, "parallel", "同时");
  assert.equal((await db.select().from(queueItems).where(inArray(queueItems.taskId, kids.map((kid) => kid.id)))).length, 0, "同时：不排队");
  const answered = (await taskOf(P)).questionHistory ?? "[]";
  const record = (JSON.parse(answered) as { answer: string }[]).at(-1)!;
  assert.equal(record.answer, "派出这 2 个任务\n同时 · 第 2 条交给 gemini · 去掉了「关掉起手式的新建入口」", "你那颗气泡：派出几个、一句改动");
  await waitFor(() => delivered().includes(kids[1]!.id), "续上的会话里没有建好的任务清单");
  const reply = delivered();
  assert.ok(reply.includes(`${kids[0]!.id}「验收门禁加准备命令」→ codex · gpt-5.6`), "智能体拿得到任务号、标题、交给了谁");
  assert.ok(reply.includes("不要再调用建任务的工具重复建"));
  assert.ok(reply.includes("用户去掉了：「关掉起手式的新建入口」"));
  const again = await send("POST", `/tasks/${P}/dispatch-plan/launch`, { planId: secondId, order: "parallel", items: pick });
  assert.equal(again.status, 409, "派过一次的单子再按不再建");
  await waitFor(() => settled(P), "续上的那一轮没有结算");
  assert.equal((await kidsOf(P)).length, directIds.size + 2);
  console.log("✓ 派出去：照卡上此刻的样子建（换人、去掉、同时、顺序），挂在这条名下；智能体续上时拿到清单，再按不重建");

  // —— 一个接一个：串成一条队列，按卡上的顺序；派活单上没指明的那一格取默认值（设成了 codex）。
  headers = await inTurn(P);
  const third = await propose(P, headers, { tasks: PLAN.slice(0, 2), order: "serial" });
  assert.equal(third.status, 200);
  await endTurn(P);
  const serialInput = {
    planId: third.body.planId, order: "serial",
    items: [0, 1].map((index) => ({ index, target: { agentType: "codex", executorId: null, model: "gpt-5.6", reasoningEffort: null } })),
  };
  // 派出中途写库失败（任务已插、队列那一笔失败）：整笔回滚。按两次都一样：一条不留、单子还在。
  const kidsBefore = (await kidsOf(P)).length;
  const launchGroups = async () => (await db.select().from(groups).where(like(groups.name, "派出：%"))).length;
  const groupsBefore = await launchGroups();
  await db.run(sql`CREATE TRIGGER dp_fail_queue BEFORE INSERT ON queue_items BEGIN SELECT RAISE(FAIL, 'simulated queue write failure'); END`);
  for (const attempt of [1, 2]) {
    const failed = await send("POST", `/tasks/${P}/dispatch-plan/launch`, serialInput);
    assert.equal(failed.status, 409, `第 ${attempt} 次：报没派出去`);
    assert.match(String(failed.body.error), /simulated queue write failure/);
    assert.equal((await kidsOf(P)).length, kidsBefore, `第 ${attempt} 次：一条任务都没留下`);
    assert.equal(await launchGroups(), groupsBefore, `第 ${attempt} 次：分组也没留下`);
    const still = (await send("GET", `/tasks/${P}`)).body as unknown as Task;
    assert.equal(still.dispatchPlan?.id, third.body.planId, `第 ${attempt} 次：单子原样还在，卡还在回复框上`);
    assert.equal(still.status, "paused");
  }
  await db.run(sql`DROP TRIGGER dp_fail_queue`);
  console.log("✓ 派出中途写库失败：整笔回滚，一条任务一个分组都不留，单子还在；再按不会越建越多");
  const serial = await send("POST", `/tasks/${P}/dispatch-plan/launch`, serialInput);
  assert.equal(serial.status, 200, JSON.stringify(serial.body));
  assert.equal((await kidsOf(P)).length, kidsBefore + 2, "修好再按：只建这一批");
  const serialKids = serial.body.tasks as Task[];
  const queue = await db.select().from(queueItems).where(inArray(queueItems.taskId, serialKids.map((kid) => kid.id))).orderBy(asc(queueItems.position));
  assert.deepEqual(queue.map((item) => item.taskId), serialKids.map((kid) => kid.id), "一个接一个：一条队列，按卡上的顺序");
  const serialRecord = (JSON.parse((await taskOf(P)).questionHistory ?? "[]") as { answer: string }[]).at(-1)!;
  assert.equal(serialRecord.answer, "派出这 2 个任务\n一个接一个", "跟单子一样就只说一个接一个");
  await waitFor(() => settled(P), "续上的那一轮没有结算");
  console.log("✓ 一个接一个：一条队列；没改动时气泡里只有派出几个和怎么排");
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
