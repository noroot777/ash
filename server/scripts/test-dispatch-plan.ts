// 派活单（src/dispatch-plan*.ts、MCP propose_dispatch）：
//   · 摆出来之后任务停着：写下的是 task.question，结算落 paused；刷新（重读任务、列表）后单子还在；
//   · 同一时刻只等用户一样东西：有提问在等时摆不出来，摆了单之后也问不出来，两边的拒绝说得清；
//     同一回合里同时发出提问和派活单，只有一个写得进去，另一个明说被谁占了（不是两边都说成功）；
//   · 「发回去改」就是对那一问的普通答复：一条任务都不建，智能体收到的是那句话（带一句「没有派出」）；
//   · 「派出去」由 navi 照卡上此刻的样子建（换的人、去掉的条、一个接一个 / 同时、顺序），挂在这条任务名下；
//     建任务的不是智能体（来源记的是用户），续上会话的那段答复里有建好的任务号、标题、交给了谁；
//   · 派过一次的单子再按一次、拿着旧单子的号来按，都不再建；
//   · 派出去就算完成（afterLaunch 缺省 done）：当场结成完成、不叫醒智能体；清单记在问答记录上，用户接着聊时随
//     下一回合开头补交一次，交过就不再交；会话里认得出它，不画成气泡（continue 那一路的答复同样认得出）；
//   · 派出中途写库失败（队列那一笔）：整笔回滚，一条任务、一个分组都不留，单子原样还在；再按还是那样，修好再按只建一批；
//   · 建好之后的「让人看见」出错（刷新前置视图写库失败）：照派出了报，那一组照常起跑，答复照常送进会话；
//   · 起跑不记派活单自己的账：该开工的几条（同时：每一条；一个接一个：队首）跟建任务同一笔挂上「等齐就起」，
//     之后全是那一套——同组最多同时四条、腾出名额再起；排在名额后面被停掉的不起、开机补办不挂回；进程没了开机补办照样起；
//     告诉智能体的是「已交给调度」，不是「已起跑」；
//   · 一个接一个时前面的等后面的成果（队列与前置合起来互相等住）：摆单时拒；卡上改成一个接一个再派时拒，单子留着、不建；
//   · 「派出去的活交给谁」：派活单上没指明的那几条默认交给它，智能体绕过派活单直接建任务没给执行器时也交给它。
//
// 跑的是 PATH 上的假 CLI（scheduled-messages-fixture.ts），不起真实 CLI：claude 是会应答的那份，
// 「换人」那几条交给的 codex / gemini 是一起就退的垫片——它们只用来看建出来的任务照不照卡上那一格。
// 跑：npm -w @navi/server run test:dispatch-plan
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { asc, eq, inArray, like, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Task } from "@navi/shared";
import { isDispatchLaunchReply } from "@navi/shared/dispatch-plan";
import { releaseTmpDb } from "./tmp-db.js";
import { installExitingClis, installFakeClaude } from "./scheduled-messages-fixture.js";

const root = mkdtempSync(join(tmpdir(), "navi-dispatch-plan-"));
const leadLog = join(root, "lead-input.jsonl");
const originalPath = process.env.PATH;
process.env.NAVI_DB = join(root, "ash.db");
process.env.NAVI_RUNS_DIR = join(root, "runs");
process.env.NAVI_TEST_LEAD_LOG = leadLog;
const fakeBin = installFakeClaude(root);
process.env.PATH = `${fakeBin}${delimiter}${originalPath ?? ""}`;
process.env.NAVI_TEST_AGENT_BIN = fakeBin;
await installExitingClis(fakeBin, ["codex", "gemini"]);

const [{ db, ensureSchema }, schema, runs, runRoutes, groupRoutes, taskRoutes, question, settle, plan, launch] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/runs.js"),
  import("../src/task-run-routes.js"),
  import("../src/group-routes.js"),
  import("../src/task-routes.js"),
  import("../src/task-question.js"),
  import("../src/settle-status.js"),
  import("../src/dispatch-plan.js"),
  import("../src/launch-request.js"),
]);
const { DISPATCH_PLAN_RETURNED } = await import("../src/task-question-record.js");
const { groups, projects, queueItems, sessions, taskPrerequisiteLaunches, taskPrerequisites, tasks } = schema;
await ensureSchema();
// 派出去之后的起跑全走「等齐就起」那一套：开机那一下挂上事件总线、名额空出来就补放（跟 main.ts 一样）。
await (await import("../src/prerequisite-launch.js")).startPrerequisiteLaunches(60_000);
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
  return { "x-navi-client": "mcp", "x-navi-source-task-id": id, "x-navi-turn-token": `turn-${turn}`, "x-navi-direction-token": `dir-${turn}` };
};
/** 那一回合结束：照真结算的判据落位（提问 / 派活单在等就是 paused）。 */
const endTurn = async (id: string) => {
  const result = await settle.settleTaskStatus(id, 0, null);
  await db.update(tasks).set({ status: result.status, activeTurnToken: null }).where(eq(tasks.id, id));
  return result.status;
};
const kidsOf = async (id: string) => db.select().from(tasks).where(eq(tasks.dispatchedBy, id)).orderBy(asc(tasks.createdAt));
// 下面多数场景看的是「清单续上会话」那一路，所以缺省按 continue 摆；「派出去就算完成」那一段显式不传。
const propose = (id: string, headers: Record<string, string>, body: object) =>
  send("POST", `/tasks/${id}/dispatch-plan`, { afterLaunch: "continue", ...body }, headers);
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
  assert.ok(kids.every((kid) => JSON.parse(kid.creationOrigin ?? "{}").kind === "user"), "建任务的是 navi 照用户按下的那一下建的，不是智能体又调了一次工具");
  const group = (await db.select().from(groups).where(eq(groups.id, kids[0]!.groupId!))).at(0)!;
  assert.equal(group.mode, "parallel", "同时");
  assert.equal((await db.select().from(queueItems).where(inArray(queueItems.taskId, kids.map((kid) => kid.id)))).length, 0, "同时：不排队");
  const answered = (await taskOf(P)).questionHistory ?? "[]";
  const record = (JSON.parse(answered) as { answer: string; reply: string }[]).at(-1)!;
  assert.equal(record.answer, "派出这 2 个任务\n同时 · 第 2 条交给 gemini · 去掉了「关掉起手式的新建入口」", "问答记录里答的那一句：派出几个、一句改动");
  // 会话里认得出这段答复（不再画成一颗气泡，那一下由「开了新任务」说）：认法跟写法是同一个开头。
  assert.ok(isDispatchLaunchReply(record.reply), "派出去续上会话的答复认得出是派出回执");
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

  // —— 派出去就算完成（不传 afterLaunch = done）：当场结成完成，不叫醒智能体；清单留到下一回合开头补交一次。
  headers = await inTurn(P);
  const finale = await send("POST", `/tasks/${P}/dispatch-plan`, { tasks: [{ title: "收尾那一条", body: "派出去就算完成(dp-done)", note: "" }] }, headers);
  assert.equal(finale.status, 200, JSON.stringify(finale.body));
  assert.equal(finale.body.afterLaunch, "done", "缺省是派出去就算完成");
  await endTurn(P);
  const doneSeqBefore = (await taskOf(P)).doneSeq;
  const leadBefore = delivered().length;
  const finished = await send("POST", `/tasks/${P}/dispatch-plan/launch`, {
    planId: finale.body.planId, order: "serial", items: [{ index: 0, target: { agentType: "claude", executorId: null, model: null, reasoningEffort: null } }],
  });
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
  const finaleKid = (finished.body.tasks as { id: string }[])[0]!;
  await waitFor(async () => (await taskOf(P)).status === "done", "派出去之后没有结成完成");
  assert.equal((await taskOf(P)).doneSeq, doneSeqBefore + 1, "记的是一次完成（等它完成后发送的消息认这一次）");
  await new Promise((resolve) => setTimeout(resolve, 500));
  // 日志里记着每一次起跑的输入：新建的那一条自己会起跑，这里只看这条任务有没有被叫起来。
  assert.ok(!delivered().slice(leadBefore).includes(P), "没有叫醒智能体");
  assert.equal(runs.isRunning(P), false);
  const finaleRecord = (JSON.parse((await taskOf(P)).questionHistory ?? "[]") as { reply: string; undelivered?: boolean }[]).at(-1)!;
  assert.equal(finaleRecord.undelivered, true, "清单记在问答记录上，还没交给智能体");
  assert.ok(isDispatchLaunchReply(finaleRecord.reply) && !finaleRecord.reply.startsWith("【答复】"), "补交的那段认得出，且不冒充答复");
  const chat = await send("POST", `/tasks/${P}/reply`, { text: "接着聊一句(dp-after)" });
  assert.ok(chat.status < 300, JSON.stringify(chat.body));
  await waitFor(() => delivered().includes("dp-after"), "接着聊的那句没有送进会话");
  const turnInput = (marker: string) => delivered().split("\n").find((line) => line.includes(marker)) ?? "";
  const carriedTurn = turnInput("dp-after");
  assert.ok(carriedTurn.includes(finaleKid.id) && carriedTurn.includes("随即结成了完成"), "下一回合开头补交了建好的清单");
  assert.ok(carriedTurn.indexOf(finaleKid.id) < carriedTurn.indexOf("dp-after"), "补交的在用户这句话前面");
  await waitFor(() => settled(P), "接着聊的那一轮没有结算");
  assert.equal((JSON.parse((await taskOf(P)).questionHistory ?? "[]") as { undelivered?: boolean }[]).at(-1)!.undelivered, undefined, "交过就划掉");
  assert.ok((await send("POST", `/tasks/${P}/reply`, { text: "再聊一句(dp-again)" })).status < 300);
  await waitFor(() => delivered().includes("dp-again"), "再聊的那句没有送进会话");
  assert.ok(!turnInput("dp-again").includes(finaleKid.id), "补交只交一次");
  await waitFor(() => settled(P), "再聊的那一轮没有结算");
  console.log("✓ 派出去就算完成：当场结成完成、不叫醒；清单在下一回合开头补交一次，交过就不再交");

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
  await waitFor(async () => (await taskOf(serialKids[0]!.id)).status !== "backlog", "队首没有起跑（它那笔请求经队列推进起跑）");
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

  // —— 派出去之后，派活单自己不记「起没起」：该开工的那几条各挂一笔「等齐就起」，之后全交给那一套。
  //    这里的几条任务正文让假 claude 一直跑，直到被停掉，好占住同组名额。
  const HOLD = "保持运行等待引导";
  const requestOf = async (id: string) => (await db.select().from(taskPrerequisiteLaunches).where(eq(taskPrerequisiteLaunches.taskId, id))).at(0)?.requestedAt ?? null;
  const dispatch = async (items: { title: string; body: string; prerequisites?: string[] }[], order: "serial" | "parallel") => {
    const proposedNow = await propose(P, await inTurn(P), { tasks: items.map((item) => ({ ...item, note: "" })), order });
    assert.equal(proposedNow.status, 200, JSON.stringify(proposedNow.body));
    await endTurn(P);
    const sent = await send("POST", `/tasks/${P}/dispatch-plan/launch`, {
      planId: proposedNow.body.planId, order,
      items: items.map((_item, index) => ({ index, target: { agentType: "claude", executorId: null, model: null, reasoningEffort: null } })),
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const ids = (sent.body.tasks as { id: string }[]).map((kid) => kid.id);
    await waitFor(() => delivered().includes(ids.at(-1)!), "答复没有送进会话");
    await waitFor(() => settled(P), "续上的那一轮没有结算");
    return { ids, groupId: String(sent.body.groupId) };
  };
  const stopAll = async (ids: string[]) => {
    for (const id of ids) runs.stopTask(id);
    await waitFor(async () => (await Promise.all(ids.map(settled))).every(Boolean), "停掉的假 CLI 没有收尾");
  };
  const running = (ids: string[]) => ids.filter((id) => runs.isRunning(id));
  assert.ok(delivered().includes("已交给调度"), "告诉智能体的是「交给调度」，不是「已起跑」：可能还在等名额、等前置、排队");

  // 一个接一个跟前置合在一起会互相等住（前面的等后面的成果，后面的又排不到）：摆单时就拒；摆成「同时」、卡上改成
  // 「一个接一个」再派的，派出时拒，单子原样留着、一条不建；改回「同时」照常派。
  const backward = [{ key: "use", title: "消费前置成果", body: HOLD, note: "", prerequisites: ["make"] }, { key: "make", title: "生产前置成果", body: HOLD, note: "" }];
  const refusedSerial = await propose(P, await inTurn(P), { tasks: backward, order: "serial" });
  assert.equal(refusedSerial.status, 400, JSON.stringify(refusedSerial.body));
  assert.match(String(refusedSerial.body.error), /「消费前置成果」要等「生产前置成果」先完成.*互相等住/);
  const crossed = await propose(P, await inTurn(P), { tasks: backward, order: "parallel" });
  assert.equal(crossed.status, 200, JSON.stringify(crossed.body));
  await endTurn(P);
  const kidsBeforeCross = (await kidsOf(P)).length;
  const crossPick = [0, 1].map((index) => ({ index, target: { agentType: "claude", executorId: null, model: null, reasoningEffort: null } }));
  const flipped = await send("POST", `/tasks/${P}/dispatch-plan/launch`, { planId: crossed.body.planId, order: "serial", items: crossPick });
  assert.equal(flipped.status, 409, JSON.stringify(flipped.body));
  assert.match(String(flipped.body.error), /互相等住。改成「同时」再派/);
  assert.equal((await kidsOf(P)).length, kidsBeforeCross, "一条都没建");
  assert.equal(((await send("GET", `/tasks/${P}`)).body as unknown as Task).dispatchPlan?.id, crossed.body.planId, "单子原样还在");
  const asParallel = await send("POST", `/tasks/${P}/dispatch-plan/launch`, { planId: crossed.body.planId, order: "parallel", items: crossPick });
  assert.equal(asParallel.status, 200, JSON.stringify(asParallel.body));
  const crossIds = (asParallel.body.tasks as { id: string }[]).map((kid) => kid.id);
  await waitFor(() => delivered().includes(crossIds[1]!), "答复没有送进会话");
  await waitFor(() => settled(P), "续上的那一轮没有结算");
  await waitFor(() => runs.isRunning(crossIds[1]!), "同时派出：被等的那条照常起跑");
  await stopAll([crossIds[1]!]);
  await send("POST", `/tasks/${crossIds[0]}/stop`);
  console.log("✓ 一个接一个时前面的等后面的：摆单就拒，卡上改成一个接一个再派也拒（单子留着、不建）；同时照常派");

  // 同时派出六条：同组同时最多四条，其余挂着请求等名额；用户停掉排在名额后面的那一条，腾出名额之后它不起，
  // 开机补办那一扫也不替它挂回去；剩下那一条照常接着起。
  const six = await dispatch(Array.from({ length: 6 }, (_v, i) => ({ title: `占名额 ${i + 1}`, body: HOLD })), "parallel");
  await waitFor(() => running(six.ids).length === 4, "没有起满同组四条");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(running(six.ids).length, 4, "同时在跑的不超过同组名额");
  const behind = six.ids.filter((id) => !runs.isRunning(id));
  assert.equal(behind.length, 2);
  assert.ok(await requestOf(behind[0]!) && await requestOf(behind[1]!), "排在名额后面的两条挂着「等齐就起」");
  const cut = await send("POST", `/tasks/${behind[0]}/stop`);
  assert.equal(cut.status, 200, JSON.stringify(cut.body));
  assert.equal(await requestOf(behind[0]!), null, "停止撤掉了那一笔");
  await stopAll(running(six.ids));
  await waitFor(() => runs.isRunning(behind[1]!), "腾出名额之后剩下那一条没有接着起");
  await launch.sweepLaunchRequests(); // 开机补办那一扫
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await requestOf(behind[0]!), null, "补办没有替停掉的那条挂回去");
  assert.equal((await taskOf(behind[0]!)).status, "backlog", "停掉的那条没有被起");
  await stopAll([behind[1]!]);
  console.log("✓ 同时派出六条：同组最多四条，腾出名额再起；排在名额后面被停掉的那条不起、补办也不挂回");

  // 重启扛得住：上一个进程把任务和请求都落了库就没了（名额、内存里什么都不剩），开机那一扫照样起。
  const ORPHAN = "dp-orphan";
  await db.insert(groups).values({ id: "dp-orphan-group", projectId, name: "派出：没来得及起跑", mode: "parallel", paused: false, createdAt: at });
  await db.insert(tasks).values(row(ORPHAN, "backlog", { groupId: "dp-orphan-group", dispatchedBy: P }));
  await db.insert(taskPrerequisiteLaunches).values({ taskId: ORPHAN, requestedAt: at, source: "run", actingUserId: null });
  await launch.sweepLaunchRequests();
  await waitFor(async () => (await taskOf(ORPHAN)).status !== "backlog", "开机补办没有起那一条");
  await waitFor(() => settled(ORPHAN), "补起的那条没有结算");
  assert.equal(await requestOf(ORPHAN), null, "起了之后那一笔了结");
  console.log("✓ 派出后进程没了：开机补办照样起，起了就了结");

  // 一个接一个：只有队首挂请求，后面的由队列推进；队首有没站稳的前置时等它，不越过去。
  const UP = "dp-upstream";
  await db.insert(tasks).values(row(UP, "backlog"));
  const chain = await dispatch([{ title: "队首等前置", body: HOLD, prerequisites: [UP] }, { title: "排在后面", body: HOLD }], "serial");
  assert.ok(await requestOf(chain.ids[0]!), "队首挂着请求");
  assert.equal(await requestOf(chain.ids[1]!), null, "后面的不挂，由队列推进");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(chain.ids.map((id) => runs.isRunning(id)), [false, false], "前置没站稳：队首等着，后面的也不越过去");
  const chainStop = await send("POST", `/tasks/${chain.ids[0]}/stop`);
  assert.equal(chainStop.status, 200, JSON.stringify(chainStop.body));
  assert.equal(await requestOf(chain.ids[0]!), null);
  await launch.sweepLaunchRequests();
  assert.equal(await requestOf(chain.ids[0]!), null, "停掉之后补办不挂回");
  console.log("✓ 一个接一个：只给队首挂请求，前置没站稳就等；停掉之后补办不挂回");
} catch (error) {
  failure = error;
  console.error(error);
} finally {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  // 这条测试起过的回合一个不留：还在跑的逐个停掉，等到它们的进程收尾再删临时目录。
  const started = (await db.select({ id: tasks.id }).from(tasks)).map((task) => task.id);
  for (const id of started) if (runs.isRunning(id)) runs.stopTask(id);
  await waitFor(() => started.every((id) => !runs.isRunning(id)), "收尾：还有没停下的假 CLI").catch((error) => { failure ??= error; });
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
  process.exit(failure ? 1 : 0);
}
