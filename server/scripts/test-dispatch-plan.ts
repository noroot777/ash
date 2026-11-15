// 派活单（src/dispatch-plan*.ts、MCP propose_dispatch）：
//   · 摆出来之后任务停着：写下的是 task.question，结算落 paused；刷新（重读任务、列表）后单子还在；
//   · 同一时刻只等用户一样东西：有提问在等时摆不出来，摆了单之后也问不出来，两边的拒绝说得清；
//     同一回合里同时发出提问和派活单，只有一个写得进去，另一个明说被谁占了（不是两边都说成功）；
//   · 「发回去改」就是对那一问的普通答复：一条任务都不建，智能体收到的是那句话（带一句「没有派出」）；
//   · 「派出去」由 ash 照卡上此刻的样子建（换的人、去掉的条、一个接一个 / 同时、顺序），挂在这条任务名下；
//     建任务的不是智能体（来源记的是用户），续上会话的那段答复里有建好的任务号、标题、交给了谁；
//   · 派过一次的单子再按一次、拿着旧单子的号来按，都不再建；
//   · 派出中途写库失败（队列那一笔）：整笔回滚，一条任务、一个分组都不留，单子原样还在；再按还是那样，修好再按只建一批；
//   · 建好之后的「让人看见」出错（刷新前置视图写库失败）：照派出了报，那一组照常起跑，答复照常送进会话；
//   · 「欠一次起跑」跟建任务同一笔落库：进程在起跑之前没了，重启补起（recoverDispatchLaunchStarts）；
//     起组和失败交代都读库失败、起组函数照样「正常」回来时，账不销、退避再起；重启那一扫读库失败也退避再扫；
//     用户对其中一条按了停止（撤掉「前置站齐就开工」），之后的补起不会替它把请求挂回去；
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

const [{ db, dbClient, ensureSchema }, schema, runs, runRoutes, groupRoutes, taskRoutes, question, settle, plan, launch] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/runs.js"),
  import("../src/task-run-routes.js"),
  import("../src/group-routes.js"),
  import("../src/task-routes.js"),
  import("../src/task-question.js"),
  import("../src/settle-status.js"),
  import("../src/dispatch-plan.js"),
  import("../src/dispatch-launch-start.js"),
]);
const { DISPATCH_PLAN_RETURNED } = await import("../src/task-question-record.js");
const { slotsTaken } = await import("../src/launch-slots.js");
const { dispatchStartDebts, groups, projects, queueItems, sessions, taskPrerequisiteLaunches, taskPrerequisites, tasks } = schema;
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
  await waitFor(() => delivered().includes(serialKids[1]!.id), "续上的会话里没有建好的任务清单");
  await waitFor(() => settled(P), "续上的那一轮没有结算");
  console.log("✓ 一个接一个：一条队列；没改动时气泡里只有派出几个和怎么排");

  // —— 建好之后的「让人看见」出错：刷新已有前置的视图那一笔写库失败。照派出了报，起跑和答复都不受它挡。
  const PRE = "dp-prereq";
  await db.insert(tasks).values(row(PRE, "done", { stage: "accepted" }));
  headers = await inTurn(P);
  const fourth = await propose(P, headers, { tasks: [{ title: "接在已有任务后面", body: "提交后出错也照派(dp-post)", note: "", prerequisites: [PRE] }] });
  assert.equal(fourth.status, 200, JSON.stringify(fourth.body));
  await endTurn(P);
  await db.run(sql`CREATE TRIGGER dp_fail_view BEFORE INSERT ON task_background_revisions WHEN NEW.task_id = 'dp-prereq' BEGIN SELECT RAISE(FAIL, 'simulated background revision write failure'); END`);
  const post = await send("POST", `/tasks/${P}/dispatch-plan/launch`, {
    planId: fourth.body.planId, order: "serial", items: [{ index: 0, target: { agentType: "claude", executorId: null, model: null, reasoningEffort: null } }],
  });
  assert.equal(post.status, 200, `建好了就是派出了：${JSON.stringify(post.body)}`);
  const postKid = (post.body.tasks as { id: string; title: string }[])[0]!;
  assert.equal(postKid.title, "接在已有任务后面", "回给页面的清单就是建好的那几条，不因读回出错变成空的");
  await waitFor(() => delivered().includes(postKid.id), "答复没有送进会话");
  // 起这一组 = 那条去开工：要么已经跑起来，要么开工请求挂在前置上（前置站稳就起，prerequisite-gate.ts）。
  await waitFor(async () => (await taskOf(postKid.id)).status !== "backlog"
    || !!(await db.select().from(taskPrerequisiteLaunches).where(eq(taskPrerequisiteLaunches.taskId, postKid.id))).at(0)?.requestedAt,
  "那一组没有起跑");
  assert.equal((await taskOf(P)).question, null, "单子收走了");
  await db.run(sql`DROP TRIGGER dp_fail_view`);
  await waitFor(() => settled(P), "续上的那一轮没有结算");
  console.log("✓ 建好之后刷新视图出错：照派出了报，那一组照常起跑、答复送进会话");

  // —— 欠着的起跑扛得住重启：上一个进程派出了（任务、记录都落了）就没了，重启时补起。
  const ORPHAN = "dp-orphan";
  await db.insert(groups).values({ id: "dp-orphan-group", projectId, name: "派出：没来得及起跑", mode: "parallel", paused: false, createdAt: at });
  await db.insert(tasks).values(row(ORPHAN, "backlog", { groupId: "dp-orphan-group", dispatchedBy: P }));
  await db.insert(dispatchStartDebts).values({ taskId: ORPHAN, groupId: "dp-orphan-group", leadTaskId: P, createdAt: at });
  await launch.recoverDispatchLaunchStarts();
  await waitFor(async () => (await taskOf(ORPHAN)).status !== "backlog", "重启后没有补起那一组");
  await waitFor(() => settled(ORPHAN), "补起的那条没有结算");
  await waitFor(async () => !(await db.select().from(dispatchStartDebts).where(eq(dispatchStartDebts.groupId, "dp-orphan-group"))).length,
    "那一组那一趟跑完之后记录没有销掉");
  console.log("✓ 欠着的起跑扛得住重启：补起之后销账");

  // —— 读库抖一下：起组读不到组、失败交代也读不到组，起组函数照样「正常」回来。账不能因此销掉：
  //    核实还有人欠着就留账，退避再起，下一趟起成了才销。
  const execute = dbClient.execute.bind(dbClient);
  const failReads = (pattern: RegExp, times: number) => {
    let left = times;
    dbClient.execute = (async (statement: Parameters<typeof execute>[0], ...rest: unknown[]) => {
      const text = typeof statement === "string" ? statement : statement.sql;
      if (left > 0 && /^select\b/i.test(text) && pattern.test(text)) {
        left -= 1;
        throw new Error("simulated transient read failure");
      }
      return (execute as (...args: unknown[]) => ReturnType<typeof execute>)(statement, ...rest);
    }) as typeof dbClient.execute;
    return () => left;
  };
  const SHAKY = "dp-shaky";
  await db.insert(groups).values({ id: "dp-shaky-group", projectId, name: "派出：读库抖了一下", mode: "parallel", paused: false, createdAt: at });
  await db.insert(tasks).values(row(SHAKY, "backlog", { groupId: "dp-shaky-group", dispatchedBy: P }));
  await db.insert(dispatchStartDebts).values({ taskId: SHAKY, groupId: "dp-shaky-group", leadTaskId: P, createdAt: at });
  const groupReadsLeft = failReads(/from\s+"groups"\s+where\s+"groups"\."id"/i, 2);
  try {
    await launch.startDispatchedGroup("dp-shaky-group");
    assert.equal(groupReadsLeft(), 0, "起组和失败交代两次读组都撞上了失败");
  } finally {
    dbClient.execute = execute;
  }
  assert.equal((await taskOf(SHAKY)).status, "backlog", "这一趟确实没起来");
  assert.equal((await db.select().from(dispatchStartDebts).where(eq(dispatchStartDebts.groupId, "dp-shaky-group"))).length, 1,
    "起组函数回来了不等于有人接走了起跑：账留着");
  await waitFor(async () => (await taskOf(SHAKY)).status !== "backlog", "退避之后没有再起");
  await waitFor(() => settled(SHAKY), "再起的那条没有结算");
  await waitFor(async () => !(await db.select().from(dispatchStartDebts).where(eq(dispatchStartDebts.groupId, "dp-shaky-group"))).length,
    "再起成了之后账没有销");
  console.log("✓ 起组和失败交代都读库失败：账不销，退避再起，起成了才销");

  // —— 重启那一扫读库失败：退避再扫，不是记一句日志就没人管了。
  const LATE = "dp-late";
  await db.insert(groups).values({ id: "dp-late-group", projectId, name: "派出：重启那一扫读失败", mode: "parallel", paused: false, createdAt: at });
  await db.insert(tasks).values(row(LATE, "backlog", { groupId: "dp-late-group", dispatchedBy: P }));
  await db.insert(dispatchStartDebts).values({ taskId: LATE, groupId: "dp-late-group", leadTaskId: P, createdAt: at });
  const scanReadsLeft = failReads(/from\s+"dispatch_start_debts"/i, 1);
  try {
    await launch.recoverDispatchLaunchStarts();
    assert.equal(scanReadsLeft(), 0, "那一扫撞上了读失败");
  } finally {
    dbClient.execute = execute;
  }
  assert.equal((await taskOf(LATE)).status, "backlog");
  await waitFor(async () => (await taskOf(LATE)).status !== "backlog", "那一扫读失败之后没有再扫");
  await waitFor(() => settled(LATE), "补起的那条没有结算");
  await waitFor(async () => !(await db.select().from(dispatchStartDebts)).length, "补起之后账没有销");
  console.log("✓ 重启那一扫读库失败：退避再扫，照样补起、销账");

  // —— 撤销是终局的：同一批派出的两条，一条在等前置，另一条被重启打断（failed）。用户停掉在等前置的那条之后
  //    重启补起，不能把「前置站齐就开工」替它挂回去。
  const [UP, WAITS, CUT] = ["dp-upstream", "dp-waits", "dp-cut"];
  await db.insert(groups).values({ id: "dp-stop-group", projectId, name: "派出：停掉一条", mode: "parallel", paused: false, createdAt: at });
  await db.insert(tasks).values([row(UP, "backlog"), row(WAITS, "backlog", { groupId: "dp-stop-group", dispatchedBy: P }),
    row(CUT, "failed", { groupId: "dp-stop-group", dispatchedBy: P })]);
  await db.insert(taskPrerequisites).values({ taskId: WAITS, prerequisiteId: UP, createdAt: at });
  await db.insert(dispatchStartDebts).values([WAITS, CUT].map((taskId) => ({ taskId, groupId: "dp-stop-group", leadTaskId: P, createdAt: at })));
  const waiting = await send("POST", `/tasks/${WAITS}/run`);
  assert.equal(waiting.body.waiting, true, `先挂在前置上：${JSON.stringify(waiting.body)}`);
  const requestOf = async () => (await db.select().from(taskPrerequisiteLaunches).where(eq(taskPrerequisiteLaunches.taskId, WAITS))).at(0)?.requestedAt ?? null;
  assert.ok(await requestOf());
  const stopped = await send("POST", `/tasks/${WAITS}/stop`);
  assert.equal(stopped.status, 200, JSON.stringify(stopped.body));
  assert.equal(await requestOf(), null, "停止撤掉了开工请求");
  assert.equal((await db.select().from(dispatchStartDebts).where(eq(dispatchStartDebts.taskId, WAITS))).length, 0, "停止那一下划掉了它那笔派出请求");
  await launch.recoverDispatchLaunchStarts();
  await waitFor(async () => !(await db.select().from(dispatchStartDebts).where(eq(dispatchStartDebts.groupId, "dp-stop-group"))).length,
    "那一组的账没有核清");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await requestOf(), null, "补起没有替停掉的那条把开工请求挂回去");
  assert.equal((await taskOf(WAITS)).status, "backlog");
  assert.equal((await taskOf(CUT)).status, "failed", "被打断判了失败的那条也没被补起");
  console.log("✓ 停掉在等前置的那条之后重启补起：不替它挂回开工请求，被打断的那条也不重跑");

  // —— 首次派出同样认这一笔：五条一起派出，前四条占满同组名额，第五条（有前置）排在名额后面；用户先运行、再停掉它，
  //    前四条腾出名额之后，首次那一趟轮到它时也不能把开工请求挂回去。
  const HOLD = "保持运行等待引导"; // 假 claude 见到这句就一直跑，直到被停掉
  const seedDispatched = async (groupId: string, count: number) => {
    await db.insert(groups).values({ id: groupId, projectId, name: groupId, mode: "parallel", paused: false, createdAt: at });
    const members = Array.from({ length: count }, (_, i) => `${groupId}-${i + 1}`);
    await db.insert(tasks).values(members.map((id) => row(id, "backlog", { groupId, dispatchedBy: P, body: HOLD })));
    await db.insert(dispatchStartDebts).values(members.map((taskId) => ({ taskId, groupId, leadTaskId: P, createdAt: at })));
    return members;
  };
  const stopAll = async (members: string[]) => {
    for (const id of members) runs.stopTask(id);
    await waitFor(async () => (await Promise.all(members.map(settled))).every(Boolean), "停掉的假 CLI 没有收尾");
  };
  const first = await seedDispatched("dp-first", 5);
  const fifth = first[4]!;
  await db.insert(taskPrerequisites).values({ taskId: fifth, prerequisiteId: UP, createdAt: at });
  const firstLaunch = launch.startDispatchedGroup("dp-first");
  await waitFor(() => first.slice(0, 4).every((id) => runs.isRunning(id)), "前四条没有起跑");
  assert.equal(slotsTaken("dp-first"), 4, "首次派出占满同组名额");
  const fifthRequest = async () => (await db.select().from(taskPrerequisiteLaunches).where(eq(taskPrerequisiteLaunches.taskId, fifth))).at(0)?.requestedAt ?? null;
  assert.equal((await send("POST", `/tasks/${fifth}/run`)).body.waiting, true, "第五条手动运行，挂在前置上");
  assert.equal((await send("POST", `/tasks/${fifth}/stop`)).status, 200);
  assert.equal(await fifthRequest(), null);
  await stopAll(first.slice(0, 4));
  await firstLaunch;
  assert.equal(await fifthRequest(), null, "首次那一趟轮到停掉的那条时没有替它把开工请求挂回去");
  assert.equal((await taskOf(fifth)).status, "backlog");
  console.log("✓ 首次派出排在名额后面的那条被停掉：轮到它时也不起、不挂回开工请求");

  // —— 补起守同组名额：六条欠着起跑的一起补起，同时在跑的不超过四条，前面的跑完再接着起。
  const six = await seedDispatched("dp-six", 6);
  await launch.recoverDispatchLaunchStarts();
  await waitFor(() => six.filter((id) => runs.isRunning(id)).length === 4, "补起没有起满四条");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(six.filter((id) => runs.isRunning(id)).length, 4, "同时在跑的不超过同组名额");
  assert.equal(slotsTaken("dp-six"), 4);
  const firstFour = six.filter((id) => runs.isRunning(id));
  await stopAll(firstFour);
  const rest = six.filter((id) => !firstFour.includes(id));
  await waitFor(() => rest.every((id) => runs.isRunning(id)), "前四条停下之后剩下的两条没有接着起");
  await stopAll(rest);
  console.log("✓ 重启补起六条：同时最多四条，腾出名额再起剩下的");
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
