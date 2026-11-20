// 要等用户的那一批派活（MCP suggest_dispatch 的 wait = done / continue，src/dispatch-suggestion*.ts）：
//   · 摆出来之后任务停着：写下的是 task.question（一句看得懂的清单），结算落 paused；刷新（重读任务、列表）后那一批还在；
//   · 同一时刻只等用户一样东西：有提问在等时摆不出来，摆了之后也问不出来，两边的拒绝说得清；同一回合里同时发出
//     提问和要等的一批，只有一个写得进去，另一个明说被谁占了；
//   · 「发回去改」就是对那一问的普通答复：一条任务都不建，那一批从框顶撤下，智能体收到那句话（带一句「没有派出」）；
//   · 派出去由 navi 照那几行此刻的样子建（换的人、同时 / 一个接一个），挂在这条任务名下、来源记用户；可以分几下处理：
//     先派一件、再叉一件、最后派剩下的——最后一件了结那一下才算处理完；同批前置：被等的那件还挂着时不能单派等它的那件，
//     先派出去的那件之后接得上（前置换成它建出来的任务号），叉掉的那件从前置里划掉；
//   · continue：处理完把清单（任务号、标题、交给谁、去掉了哪几件）作为答复续上会话叫醒它；处理完之后再按不再建；
//   · done：处理完当场结成完成、不叫醒；清单下一回合开头补交一次，交过就不再交；全点叉了也一样结成完成；
//   · 派出中途写库失败：整笔回滚，一条任务、一个分组都不留，那一批原样还在；修好再按只建一批；
//   · 建好之后的「让人看见」出错：照派出了报，那一组照常起跑，答复照常送进会话；
//   · 起跑不记自己的账：该开工的几条跟建任务同一笔挂上「等齐就起」，同组名额、停止撤回、开机补办全是那一套；
//   · 一个接一个时前面的等后面的成果：摆的时候拒；派出那一下改成一个接一个时拒，那一批留着、不建；
//   · 「派出去的活交给谁」：没指明交给谁的那几件默认交给它，智能体绕过框顶直接建任务没给执行器时也交给它；
//   · 上线前摆的派活单（tasks.dispatch_plan）照旧能看、能派（按 continue 叫醒）、能发回去改。
//
// 跑的是 PATH 上的假 CLI（scheduled-messages-fixture.ts），不起真实 CLI：claude 是会应答的那份，
// 「换人」那几条交给的 codex / gemini 是一起就退的垫片。
// 跑：npm -w @navi/server run test:dispatch-suggestion
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { asc, eq, inArray, like, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Task } from "@navi/shared";
import { isDispatchLaunchReply, type DispatchSuggestion } from "@navi/shared/dispatch-suggestion";
import { releaseTmpDb } from "./tmp-db.js";
import { installExitingClis, installFakeClaude } from "./scheduled-messages-fixture.js";

const root = mkdtempSync(join(tmpdir(), "navi-dispatch-wait-"));
const leadLog = join(root, "lead-input.jsonl");
const originalPath = process.env.PATH;
process.env.NAVI_DB = join(root, "ash.db");
process.env.NAVI_RUNS_DIR = join(root, "runs");
process.env.NAVI_TEST_LEAD_LOG = leadLog;
const fakeBin = installFakeClaude(root);
process.env.PATH = `${fakeBin}${delimiter}${originalPath ?? ""}`;
process.env.NAVI_TEST_AGENT_BIN = fakeBin;
await installExitingClis(fakeBin, ["codex", "gemini"]);

const [{ db, ensureSchema }, schema, runs, runRoutes, groupRoutes, taskRoutes, question, settle, wait, launch] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/runs.js"),
  import("../src/task-run-routes.js"),
  import("../src/group-routes.js"),
  import("../src/task-routes.js"),
  import("../src/task-question.js"),
  import("../src/settle-status.js"),
  import("../src/dispatch-suggestion-wait.js"),
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
const projectId = "dispatch-wait-project";
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
/** 那一回合结束：照真结算的判据落位（提问 / 等着的那一批在等就是 paused）。 */
const endTurn = async (id: string) => {
  const result = await settle.settleTaskStatus(id, 0, null);
  await db.update(tasks).set({ status: result.status, activeTurnToken: null }).where(eq(tasks.id, id));
  return result.status;
};
const kidsOf = async (id: string) => db.select().from(tasks).where(eq(tasks.dispatchedBy, id)).orderBy(asc(tasks.createdAt));
const detailOf = async (id: string) => (await send("GET", `/tasks/${id}`)).body as unknown as Task;
const waitingOf = async (id: string) => ((await detailOf(id)).dispatchSuggestions ?? []).filter((item) => item.wait !== "none");
// 多数场景看的是「清单续上会话」那一路，所以缺省按 continue 摆；done 那一段显式传。
const propose = (id: string, headers: Record<string, string>, body: object) =>
  send("POST", `/tasks/${id}/dispatch-suggestions`, { wait: "continue", ...body }, headers);
const target = (agentType: string, model: string | null = null) => ({ agentType, executorId: null, model, reasoningEffort: null });
const pickOf = (item: DispatchSuggestion, to = target("claude")) => ({ id: item.id, title: item.title, body: item.body, target: to });
const launchOf = (id: string, order: string, items: unknown[]) => send("POST", `/tasks/${id}/dispatch-suggestions/launch`, { order, items });
const PLAN = [
  { key: "gate", title: "验收门禁加准备命令", body: "在快照里现装依赖（完整说明 A）", note: "不再自己拒绝起跑" },
  { key: "entry", title: "关掉起手式的新建入口", body: "只关入口（完整说明 B）", note: "代码不动", prerequisites: ["gate"] },
  { title: "MCP 接入改成起跑时注入", body: "要上 Windows 真机验证（完整说明 C）", note: "要上真机", agentType: "codex", prerequisites: ["entry"] },
];

const [P, Q, R, L] = ["dw-lead", "dw-asking", "dw-race", "dw-legacy"];
let failure: unknown = null;
try {
  await db.insert(projects).values({ id: projectId, name: "dispatch-wait", repoPath: root, apiKeys: null, createdAt: at });
  await db.insert(tasks).values([row(P, "backlog"), row(Q, "backlog"), row(R, "backlog")]);
  for (const id of [P, Q, R]) {
    await db.insert(sessions).values({ id: `${id}-prev`, taskId: id, role: "single", agentType: "claude", executor: "claude@test", cwd: root, cliSessionId: `${id}-cli`, startedAt: at });
  }

  // —— 同一时刻只等用户一样东西：已经在问的，摆不出要等的一批（不等的照挂）。
  const qHeaders = await inTurn(Q);
  assert.equal(await question.setTaskQuestion({ taskId: Q, question: "先改哪一块？" }), true);
  const refused = await propose(Q, qHeaders, { tasks: PLAN });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, wait.QUESTION_BLOCKS_DISPATCH_WAIT, "拒绝说得清：有提问在等");
  assert.equal((await propose(Q, qHeaders, { tasks: PLAN.slice(0, 1), wait: "none" })).status, 200, "不等的一批不占那一格，照挂");

  // —— 同一回合里同时发出提问和要等的一批：各在一笔立即加锁的事务里判，只有一个写进去，另一个说清被谁占了。
  const rHeaders = await inTurn(R);
  const [racePlan, raceAsk] = await Promise.all([
    propose(R, rHeaders, { tasks: PLAN.slice(0, 1) }),
    send("POST", `/tasks/${R}/ask`, { question: "先回答我，还是先派活？" }, rHeaders),
  ]);
  assert.deepEqual([racePlan.status, raceAsk.status].sort(), [200, 409], `只有一个写得进去：${JSON.stringify([racePlan.body, raceAsk.body])}`);
  const raced = await taskOf(R);
  if (racePlan.status === 200) {
    assert.equal(raceAsk.body.error, wait.DISPATCH_WAIT_BLOCKS_ASK);
    assert.ok(raced.question?.startsWith("派出这 1 个任务") && (await waitingOf(R)).length === 1, "留下的就是说成功的那一个");
  } else {
    assert.equal(racePlan.body.error, wait.QUESTION_BLOCKS_DISPATCH_WAIT);
    assert.equal(raced.question, "先回答我，还是先派活？");
    assert.equal((await waitingOf(R)).length, 0);
  }
  console.log("✓ 同时提问和摆要等的一批：只有一个写进去，另一个明说被谁占了；有提问时不等的照挂");

  // —— 智能体在回合里绕过框顶直接建：没给执行器的交给「同这里」（这条任务自己的那一套）。
  let headers = await inTurn(P);
  await db.insert(groups).values({ id: "dw-group", projectId, name: "直接建", mode: "parallel", paused: false, createdAt: at });
  const direct = await send("POST", "/groups/dw-group/tasks/batch", {
    tasks: [{ title: "直接建·没指明", body: "x" }, { title: "直接建·指明了", body: "y", agentType: "gemini" }],
  }, headers);
  assert.equal(direct.status, 201);
  const [same, named] = direct.body.tasks as Task[];
  assert.equal(same!.dispatchedBy, P);
  assert.deepEqual([same!.agentType, same!.model], ["claude", "fable-5-2"], "没指明执行器：同这里");
  assert.equal(named!.agentType, "gemini", "指明了的一个字不碰");
  // —— 「派出去的活交给谁」设成另一个执行器：直接建、框顶没指明的几件都交给它。
  const setTarget = await send("PUT", `/tasks/${P}/dispatch-target`, { target: { agentType: "codex", model: "gpt-5.6" } });
  assert.equal(setTarget.status, 200);
  assert.deepEqual((setTarget.body as unknown as Task).dispatchTarget, target("codex", "gpt-5.6"));
  const direct2 = await send("POST", "/groups/dw-group/tasks/batch", { tasks: [{ title: "直接建·默认改过之后", body: "z" }] }, headers);
  assert.deepEqual([(direct2.body.tasks as Task[])[0]!.agentType, (direct2.body.tasks as Task[])[0]!.model], ["codex", "gpt-5.6"], "没指明执行器：交给设的那个");
  console.log("✓ 默认交给谁：同这里时跟这条任务；设了之后直接建任务没给执行器的交给它，指明了的不碰");
  const directIds = new Set((await kidsOf(P)).map((kid) => kid.id));
  const newKids = async () => (await kidsOf(P)).filter((kid) => !directIds.has(kid.id));

  // —— 摆出来：写下的是那一问，任务停着；刷新后那一批还在；摆了之后问不出来。
  const proposed = await propose(P, headers, { tasks: PLAN, order: "serial" });
  assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
  assert.equal(proposed.body.willSettleAs, "paused");
  const firstIds = proposed.body.ids as string[];
  const asked = await send("POST", `/tasks/${P}/ask`, { question: "顺便问一句" }, headers);
  assert.equal(asked.status, 409);
  assert.equal(asked.body.error, wait.DISPATCH_WAIT_BLOCKS_ASK, "摆了之后问不出来，拒绝说得清");
  assert.equal(await endTurn(P), "paused", "结算落 paused，队列不会自动续跑");
  const detail = await detailOf(P);
  assert.deepEqual((await waitingOf(P)).map((item) => item.id), firstIds, "刷新后那一批还在");
  assert.match(detail.question ?? "", /^派出这 3 个任务（一个接一个）：\n1\. 验收门禁加准备命令 —— 不再自己拒绝起跑（交给 codex · gpt-5\.6）/,
    "写下的那一问是一句看得懂的清单：别的端不认识框顶也看得出它在等什么");
  assert.match(detail.question ?? "", /3\. MCP 接入改成起跑时注入 —— 要上真机（交给 codex）/);
  const listedPlan = await waitingOf(P);
  assert.deepEqual(listedPlan.map((item) => [item.wait, item.order, item.target?.agentType ?? null]),
    [["continue", "serial", null], ["continue", "serial", null], ["continue", "serial", "codex"]], "指明的交给谁记着，没指明的留空");
  assert.equal(((await send("GET", "/tasks")).body as unknown as Task[]).find((task) => task.id === P)?.dispatchSuggestions?.length, 3, "随列表下发");
  assert.equal((await newKids()).length, 0, "摆出来时一条都没建");
  console.log("✓ 摆出来：任务停着，刷新后那一批还在；有提问时摆不出来，摆了之后问不出来");

  // —— 「发回去改」：普通答复，一条都不建；那一批从框顶撤下，智能体收到那句话。
  const back = await send("POST", `/tasks/${P}/answer`, { answer: "第二条先别做(dw-back)" });
  assert.equal(back.status, 200);
  await waitFor(() => delivered().includes("dw-back"), "发回去的那句话没有送进会话");
  assert.ok(delivered().includes(DISPATCH_PLAN_RETURNED.slice(0, 12)), "答复前面说清一条都没建");
  assert.equal((await taskOf(P)).question, null, "那一问收走了");
  assert.deepEqual(await waitingOf(P), [], "那一批从框顶撤下");
  await waitFor(() => settled(P), "续上的那一轮没有结算");
  assert.equal((await newKids()).length, 0, "发回去改：一条任务都没建");
  assert.equal((await launchOf(P, "serial", [pickOf(listedPlan[0]!)])).status, 409, "发回去之后那一批作废，派不出去");
  console.log("✓ 发回去改：一条任务都不建，那一批撤下，智能体收到那句话");

  // —— 改完再摆一次；摆的那一轮还没结束时派不出去。
  headers = await inTurn(P);
  assert.equal((await propose(P, headers, { tasks: PLAN, order: "serial" })).status, 200);
  const batch = await waitingOf(P);
  assert.equal((await launchOf(P, "serial", [pickOf(batch[0]!)])).status, 409, "那一轮还在跑：等它停下再派");
  await endTurn(P);
  assert.equal((await launchOf(P, "parallel", [pickOf(listedPlan[0]!)])).status, 409, "旧一批的那几件派不出去");

  // —— 分几下处理：被等的那件还挂着时不能单派等它的那件；先派第一件（不算处理完）、叉掉第二件、最后派第三件（换了人）。
  const early = await launchOf(P, "parallel", [pickOf(batch[1]!)]);
  assert.equal(early.status, 409);
  assert.match(String(early.body.error), /要等同一批的「验收门禁加准备命令」：一起派，或先把「验收门禁加准备命令」点叉/);
  const one = await launchOf(P, "parallel", [pickOf(batch[0]!, target("codex", "gpt-5.6"))]);
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.equal(one.body.closed, false, "还有挂着的：没处理完");
  const gateKid = (one.body.tasks as { id: string }[])[0]!.id;
  assert.equal((await taskOf(P)).status, "paused");
  assert.ok((await taskOf(P)).question, "那一问还在");
  assert.deepEqual((await waitingOf(P)).map((item) => [item.title, item.prerequisites ?? null]),
    [["关掉起手式的新建入口", [gateKid]], ["MCP 接入改成起跑时注入", ["entry"]]], "先派出去的那件：等它的那件前置换成它的任务号");
  const drop = await send("DELETE", `/tasks/${P}/dispatch-suggestions/${batch[1]!.id}`);
  assert.deepEqual([drop.status, drop.body.dropped, drop.body.closed], [200, true, false], "叉掉一件：还没处理完");
  assert.deepEqual((await waitingOf(P)).map((item) => [item.title, item.prerequisites ?? null]), [["MCP 接入改成起跑时注入", null]],
    "叉掉的那件从前置里划掉");
  const last = await launchOf(P, "parallel", [pickOf(batch[2]!, target("gemini"))]);
  assert.equal(last.status, 200, JSON.stringify(last.body));
  assert.equal(last.body.closed, true, "最后一件了结：处理完");
  const kids = await newKids();
  assert.deepEqual(kids.map((kid) => kid.title), ["验收门禁加准备命令", "MCP 接入改成起跑时注入"], "建的正是派出去的那两件");
  assert.deepEqual(kids.map((kid) => [kid.agentType, kid.model]), [["codex", "gpt-5.6"], ["gemini", null]], "交给的正是那一行上的那一格");
  assert.ok(kids[0]!.body.includes("完整说明 A") && kids[1]!.body.includes("完整说明 C"), "正文是那一件的完整说明");
  assert.ok(kids.every((kid) => JSON.parse(kid.creationOrigin ?? "{}").kind === "user"), "建任务的是 navi 照用户按下的那一下建的");
  assert.equal((await db.select().from(taskPrerequisites).where(inArray(taskPrerequisites.taskId, kids.map((kid) => kid.id)))).length, 0,
    "等的那件叉掉了：最后那件不再带它的前置");
  const record = (JSON.parse((await taskOf(P)).questionHistory ?? "[]") as { answer: string; reply: string }[]).at(-1)!;
  assert.equal(record.answer, "派出这 2 个任务\n同时 · 第 2 条交给 gemini · 去掉了「关掉起手式的新建入口」", "问答记录里答的那一句：派出几个、一句改动");
  assert.ok(isDispatchLaunchReply(record.reply), "续上会话的答复认得出是派出回执（会话里不画成气泡）");
  await waitFor(() => delivered().includes(kids[1]!.id), "续上的会话里没有建好的任务清单");
  const reply = delivered();
  assert.ok(reply.includes(`${kids[0]!.id}「验收门禁加准备命令」→ codex · gpt-5.6`), "智能体拿得到任务号、标题、交给了谁（早先那一下派的也在）");
  assert.ok(reply.includes("不要再调用建任务的工具重复建"));
  assert.ok(reply.includes("用户去掉了：「关掉起手式的新建入口」"));
  assert.ok(reply.includes("已交给调度"), "告诉智能体的是「交给调度」，不是「已起跑」");
  assert.equal((await launchOf(P, "parallel", [pickOf(batch[2]!)])).status, 409, "处理完之后再按不再建");
  assert.deepEqual(await waitingOf(P), [], "处理完整批拿掉");
  await waitFor(() => settled(P), "续上的那一轮没有结算");
  console.log("✓ continue：分几下处理（派一件、叉一件、再派一件），最后一件了结时叫醒它、交上全部清单；同批前置跟着改；再按不重建");

  // —— done：处理完当场结成完成，不叫醒；清单留到下一回合开头补交一次。
  headers = await inTurn(P);
  const finale = await propose(P, headers, { wait: "done", tasks: [{ title: "收尾那一条", body: "派完就算完成(dw-done)", note: "" }] });
  assert.equal(finale.status, 200, JSON.stringify(finale.body));
  assert.equal(finale.body.wait, "done");
  await endTurn(P);
  const doneSeqBefore = (await taskOf(P)).doneSeq;
  const leadBefore = delivered().length;
  const finished = await launchOf(P, "serial", [pickOf((await waitingOf(P))[0]!)]);
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
  const finaleKid = (finished.body.tasks as { id: string }[])[0]!;
  await waitFor(async () => (await taskOf(P)).status === "done", "处理完之后没有结成完成");
  assert.equal((await taskOf(P)).doneSeq, doneSeqBefore + 1, "记的是一次完成");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(!delivered().slice(leadBefore).includes(P), "没有叫醒智能体");
  assert.equal(runs.isRunning(P), false);
  const finaleRecord = (JSON.parse((await taskOf(P)).questionHistory ?? "[]") as { reply: string; undelivered?: boolean }[]).at(-1)!;
  assert.equal(finaleRecord.undelivered, true, "清单记在问答记录上，还没交给智能体");
  assert.ok(isDispatchLaunchReply(finaleRecord.reply) && !finaleRecord.reply.startsWith("【答复】"), "补交的那段认得出，且不冒充答复");
  const chat = await send("POST", `/tasks/${P}/reply`, { text: "接着聊一句(dw-after)" });
  assert.ok(chat.status < 300, JSON.stringify(chat.body));
  await waitFor(() => delivered().includes("dw-after"), "接着聊的那句没有送进会话");
  const turnInput = (marker: string) => delivered().split("\n").find((line) => line.includes(marker)) ?? "";
  const carriedTurn = turnInput("dw-after");
  assert.ok(carriedTurn.includes(finaleKid.id) && carriedTurn.includes("随即结成了完成"), "下一回合开头补交了建好的清单");
  assert.ok(carriedTurn.indexOf(finaleKid.id) < carriedTurn.indexOf("dw-after"), "补交的在用户这句话前面");
  await waitFor(() => settled(P), "接着聊的那一轮没有结算");
  assert.equal((JSON.parse((await taskOf(P)).questionHistory ?? "[]") as { undelivered?: boolean }[]).at(-1)!.undelivered, undefined, "交过就划掉");
  assert.ok((await send("POST", `/tasks/${P}/reply`, { text: "再聊一句(dw-again)" })).status < 300);
  await waitFor(() => delivered().includes("dw-again"), "再聊的那句没有送进会话");
  assert.ok(!turnInput("dw-again").includes(finaleKid.id), "补交只交一次");
  await waitFor(() => settled(P), "再聊的那一轮没有结算");
  // 全点叉了也是处理完：照样结成完成、不叫醒。
  const D = "dw-dropall";
  await db.insert(tasks).values(row(D, "backlog"));
  const dropAll = await propose(D, await inTurn(D), { wait: "done", tasks: [{ title: "其实不用派", body: "全点叉(dw-dropall)", note: "" }] });
  assert.equal(dropAll.status, 200, JSON.stringify(dropAll.body));
  await endTurn(D);
  const crossed = await send("DELETE", `/tasks/${D}/dispatch-suggestions/${(dropAll.body.ids as string[])[0]}`);
  assert.deepEqual([crossed.body.dropped, crossed.body.closed], [true, true]);
  await waitFor(async () => (await taskOf(D)).status === "done", "全点叉之后没有结成完成");
  const dropRecord = (JSON.parse((await taskOf(D)).questionHistory ?? "[]") as { answer: string; reply: string }[]).at(-1)!;
  assert.equal(dropRecord.answer, "这 1 个任务一个都没派（全部去掉了）");
  assert.match(dropRecord.reply, /全部去掉了，一条都没建/);
  assert.equal((await kidsOf(D)).length, 0);
  console.log("✓ done：处理完结成完成、不叫醒；清单下一回合开头补交一次；全点叉了也结成完成");

  // —— 一个接一个：串成一条队列，按派出的顺序；没指明的那一格取默认值。派出中途写库失败：整笔回滚。
  headers = await inTurn(P);
  assert.equal((await propose(P, headers, { tasks: PLAN.slice(0, 2), order: "serial" })).status, 200);
  await endTurn(P);
  const third = await waitingOf(P);
  const serialPick = third.map((item) => pickOf(item, target("codex", "gpt-5.6")));
  const kidsBefore = (await kidsOf(P)).length;
  const launchGroups = async () => (await db.select().from(groups).where(like(groups.name, "派出：%"))).length;
  const groupsBefore = await launchGroups();
  await db.run(sql`CREATE TRIGGER dw_fail_queue BEFORE INSERT ON queue_items BEGIN SELECT RAISE(FAIL, 'simulated queue write failure'); END`);
  for (const attempt of [1, 2]) {
    const failed = await launchOf(P, "serial", serialPick);
    assert.equal(failed.status, 409, `第 ${attempt} 次：报没派出去`);
    assert.match(String(failed.body.error), /simulated queue write failure/);
    assert.equal((await kidsOf(P)).length, kidsBefore, `第 ${attempt} 次：一条任务都没留下`);
    assert.equal(await launchGroups(), groupsBefore, `第 ${attempt} 次：分组也没留下`);
    assert.deepEqual((await waitingOf(P)).map((item) => item.id), third.map((item) => item.id), `第 ${attempt} 次：那一批原样还在`);
    assert.equal((await taskOf(P)).status, "paused");
  }
  await db.run(sql`DROP TRIGGER dw_fail_queue`);
  console.log("✓ 派出中途写库失败：整笔回滚，一条任务一个分组都不留，那一批还在；再按不会越建越多");
  const serial = await launchOf(P, "serial", serialPick);
  assert.equal(serial.status, 200, JSON.stringify(serial.body));
  assert.equal((await kidsOf(P)).length, kidsBefore + 2, "修好再按：只建这一批");
  const serialKids = serial.body.tasks as Task[];
  const queue = await db.select().from(queueItems).where(inArray(queueItems.taskId, serialKids.map((kid) => kid.id))).orderBy(asc(queueItems.position));
  assert.deepEqual(queue.map((item) => item.taskId), serialKids.map((kid) => kid.id), "一个接一个：一条队列，按派出的顺序");
  assert.equal((JSON.parse((await taskOf(P)).questionHistory ?? "[]") as { answer: string }[]).at(-1)!.answer, "派出这 2 个任务\n一个接一个",
    "没改动就只说派出几个和怎么排");
  await waitFor(() => delivered().includes(serialKids[1]!.id), "续上的会话里没有建好的任务清单");
  await waitFor(() => settled(P), "续上的那一轮没有结算");
  await waitFor(async () => (await taskOf(serialKids[0]!.id)).status !== "backlog", "队首没有起跑（它那笔请求经队列推进起跑）");
  console.log("✓ 一个接一个：一条队列，同批前置照 key 接上");

  // —— 建好之后的「让人看见」出错：刷新已有前置的视图那一笔写库失败。照派出了报，起跑和答复都不受它挡。
  const PRE = "dw-prereq";
  await db.insert(tasks).values(row(PRE, "done", { stage: "accepted" }));
  headers = await inTurn(P);
  assert.equal((await propose(P, headers, { tasks: [{ title: "接在已有任务后面", body: "提交后出错也照派(dw-post)", note: "", prerequisites: [PRE] }] })).status, 200);
  await endTurn(P);
  await db.run(sql`CREATE TRIGGER dw_fail_view BEFORE INSERT ON task_background_revisions WHEN NEW.task_id = 'dw-prereq' BEGIN SELECT RAISE(FAIL, 'simulated background revision write failure'); END`);
  const post = await launchOf(P, "serial", [pickOf((await waitingOf(P))[0]!)]);
  assert.equal(post.status, 200, `建好了就是派出了：${JSON.stringify(post.body)}`);
  const postKid = (post.body.tasks as { id: string; title: string }[])[0]!;
  assert.equal(postKid.title, "接在已有任务后面", "回给页面的清单就是建好的那几条");
  await waitFor(() => delivered().includes(postKid.id), "答复没有送进会话");
  await waitFor(async () => (await taskOf(postKid.id)).status !== "backlog"
    || !!(await db.select().from(taskPrerequisiteLaunches).where(eq(taskPrerequisiteLaunches.taskId, postKid.id))).at(0)?.requestedAt,
  "那一组没有起跑");
  assert.equal((await taskOf(P)).question, null, "那一问收走了");
  await db.run(sql`DROP TRIGGER dw_fail_view`);
  await waitFor(() => settled(P), "续上的那一轮没有结算");
  console.log("✓ 建好之后刷新视图出错：照派出了报，那一组照常起跑、答复送进会话");

  // —— 派出去之后不记自己的账：该开工的那几条各挂一笔「等齐就起」。几条任务正文让假 claude 一直跑，好占住同组名额。
  const HOLD = "保持运行等待引导";
  const requestOf = async (id: string) => (await db.select().from(taskPrerequisiteLaunches).where(eq(taskPrerequisiteLaunches.taskId, id))).at(0)?.requestedAt ?? null;
  const dispatch = async (items: { title: string; body: string; prerequisites?: string[] }[], order: "serial" | "parallel") => {
    const proposedNow = await propose(P, await inTurn(P), { tasks: items.map((item) => ({ ...item, note: "" })), order });
    assert.equal(proposedNow.status, 200, JSON.stringify(proposedNow.body));
    await endTurn(P);
    const sent = await launchOf(P, order, (await waitingOf(P)).map((item) => pickOf(item)));
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const ids = (sent.body.tasks as { id: string }[]).map((kid) => kid.id);
    await waitFor(() => delivered().includes(ids.at(-1)!), "答复没有送进会话");
    await waitFor(() => settled(P), "续上的那一轮没有结算");
    return ids;
  };
  const stopAll = async (ids: string[]) => {
    for (const id of ids) runs.stopTask(id);
    await waitFor(async () => (await Promise.all(ids.map(settled))).every(Boolean), "停掉的假 CLI 没有收尾");
  };
  const running = (ids: string[]) => ids.filter((id) => runs.isRunning(id));

  // 一个接一个跟前置合在一起会互相等住：摆的时候就拒；摆成「同时」、派出那一下改成「一个接一个」的，派出时拒、那一批留着。
  const backward = [{ key: "use", title: "消费前置成果", body: HOLD, note: "", prerequisites: ["make"] }, { key: "make", title: "生产前置成果", body: HOLD, note: "" }];
  const refusedSerial = await propose(P, await inTurn(P), { tasks: backward, order: "serial" });
  assert.equal(refusedSerial.status, 400, JSON.stringify(refusedSerial.body));
  assert.match(String(refusedSerial.body.error), /「消费前置成果」要等「生产前置成果」先完成.*互相等住/);
  assert.equal((await propose(P, await inTurn(P), { tasks: backward, order: "parallel" })).status, 200);
  await endTurn(P);
  const crossBatch = await waitingOf(P);
  const kidsBeforeCross = (await kidsOf(P)).length;
  const flipped = await launchOf(P, "serial", crossBatch.map((item) => pickOf(item)));
  assert.equal(flipped.status, 409, JSON.stringify(flipped.body));
  assert.match(String(flipped.body.error), /互相等住。改成「同时」再派/);
  assert.equal((await kidsOf(P)).length, kidsBeforeCross, "一条都没建");
  assert.equal((await waitingOf(P)).length, 2, "那一批原样还在");
  const asParallel = await launchOf(P, "parallel", crossBatch.map((item) => pickOf(item)));
  assert.equal(asParallel.status, 200, JSON.stringify(asParallel.body));
  const crossIds = (asParallel.body.tasks as { id: string }[]).map((kid) => kid.id);
  await waitFor(() => delivered().includes(crossIds[1]!), "答复没有送进会话");
  await waitFor(() => settled(P), "续上的那一轮没有结算");
  await waitFor(() => runs.isRunning(crossIds[1]!), "同时派出：被等的那条照常起跑");
  await stopAll([crossIds[1]!]);
  await send("POST", `/tasks/${crossIds[0]}/stop`);
  console.log("✓ 一个接一个时前面的等后面的：摆的时候拒，派出时改成一个接一个也拒（那一批留着、不建）；同时照常派");

  // 同时派出六条：同组同时最多四条，其余挂着请求等名额；停掉排在名额后面的那一条，腾出名额后它不起，开机补办也不挂回。
  const six = await dispatch(Array.from({ length: 6 }, (_v, i) => ({ title: `占名额 ${i + 1}`, body: HOLD })), "parallel");
  await waitFor(() => running(six).length === 4, "没有起满同组四条");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(running(six).length, 4, "同时在跑的不超过同组名额");
  const behind = six.filter((id) => !runs.isRunning(id));
  assert.equal(behind.length, 2);
  assert.ok(await requestOf(behind[0]!) && await requestOf(behind[1]!), "排在名额后面的两条挂着「等齐就起」");
  assert.equal((await send("POST", `/tasks/${behind[0]}/stop`)).status, 200);
  assert.equal(await requestOf(behind[0]!), null, "停止撤掉了那一笔");
  await stopAll(running(six));
  await waitFor(() => runs.isRunning(behind[1]!), "腾出名额之后剩下那一条没有接着起");
  await launch.sweepLaunchRequests();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await requestOf(behind[0]!), null, "补办没有替停掉的那条挂回去");
  assert.equal((await taskOf(behind[0]!)).status, "backlog", "停掉的那条没有被起");
  await stopAll([behind[1]!]);
  console.log("✓ 同时派出六条：同组最多四条，腾出名额再起；排在名额后面被停掉的那条不起、补办也不挂回");

  // 重启扛得住：上一个进程把任务和请求都落了库就没了，开机那一扫照样起。
  const ORPHAN = "dw-orphan";
  await db.insert(groups).values({ id: "dw-orphan-group", projectId, name: "派出：没来得及起跑", mode: "parallel", paused: false, createdAt: at });
  await db.insert(tasks).values(row(ORPHAN, "backlog", { groupId: "dw-orphan-group", dispatchedBy: P }));
  await db.insert(taskPrerequisiteLaunches).values({ taskId: ORPHAN, requestedAt: at, source: "run", actingUserId: null });
  await launch.sweepLaunchRequests();
  await waitFor(async () => (await taskOf(ORPHAN)).status !== "backlog", "开机补办没有起那一条");
  await waitFor(() => settled(ORPHAN), "补起的那条没有结算");
  assert.equal(await requestOf(ORPHAN), null, "起了之后那一笔了结");
  console.log("✓ 派出后进程没了：开机补办照样起，起了就了结");

  // 一个接一个：只有队首挂请求，后面的由队列推进；队首有没站稳的前置时等它，不越过去。
  const UP = "dw-upstream";
  await db.insert(tasks).values(row(UP, "backlog"));
  const chain = await dispatch([{ title: "队首等前置", body: HOLD, prerequisites: [UP] }, { title: "排在后面", body: HOLD }], "serial");
  assert.ok(await requestOf(chain[0]!), "队首挂着请求");
  assert.equal(await requestOf(chain[1]!), null, "后面的不挂，由队列推进");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(chain.map((id) => runs.isRunning(id)), [false, false], "前置没站稳：队首等着，后面的也不越过去");
  assert.equal((await send("POST", `/tasks/${chain[0]}/stop`)).status, 200);
  await launch.sweepLaunchRequests();
  assert.equal(await requestOf(chain[0]!), null, "停掉之后补办不挂回");
  console.log("✓ 一个接一个：只给队首挂请求，前置没站稳就等；停掉之后补办不挂回");

  // —— 上线前摆的派活单（只有 tasks.dispatch_plan 那一列，旁边还挂着一件老格式的建议）：照旧能看、能派、能发回去改。
  const legacyPlan = (planId: string, questionText: string) => JSON.stringify({
    id: planId, question: questionText, order: "parallel", proposedAt: at,
    items: [{ key: "a", title: "老单子第一条", body: "老说明 A(dw-legacy)", note: "", target: null },
      { title: "老单子第二条", body: "老说明 B", note: "", target: null, prerequisites: ["a"] }],
  });
  const oldSuggestion = JSON.stringify([{ id: "dw-old-sg", title: "老格式的建议", body: "没有 batch/wait", note: "", target: null, base: "trunk", proposedAt: at, turnToken: "t" }]);
  const legacyQuestion = "派出这 2 个任务（同时）：\n1. 老单子第一条（交给 claude）\n2. 老单子第二条（交给 claude）";
  await db.insert(tasks).values(row(L, "paused", { question: legacyQuestion, dispatchPlan: legacyPlan("dw-plan", legacyQuestion), dispatchSuggestions: oldSuggestion }));
  await db.insert(sessions).values({ id: `${L}-prev`, taskId: L, role: "single", agentType: "claude", executor: "claude@test", cwd: root, cliSessionId: `${L}-cli`, startedAt: at });
  const legacy = (await detailOf(L)).dispatchSuggestions ?? [];
  assert.deepEqual(legacy.map((item) => [item.id, item.wait, item.batch]),
    [["dw-old-sg", "none", "dw-old-sg"], ["dw-plan-0", "continue", "dw-plan"], ["dw-plan-1", "continue", "dw-plan"]],
    "老建议读成不等的一件；老派活单读成等着的一批（没说 afterLaunch 的按 continue）");
  assert.equal("turnToken" in legacy[0]!, false, "页面拿不到老数据里的回合令牌");
  const legacyAsk = await send("POST", `/tasks/${L}/ask`, { question: "插一句" }, await inTurn(L));
  assert.equal(legacyAsk.body.error, wait.DISPATCH_WAIT_BLOCKS_ASK, "老派活单在等时同样问不出来");
  await db.update(tasks).set({ status: "paused", activeTurnToken: null, activeDirectionToken: null }).where(eq(tasks.id, L));
  const legacyLaunch = await launchOf(L, "parallel", legacy.slice(1).map((item) => pickOf(item)));
  assert.equal(legacyLaunch.status, 200, JSON.stringify(legacyLaunch.body));
  assert.equal(legacyLaunch.body.closed, true);
  const legacyKids = await kidsOf(L);
  assert.deepEqual(legacyKids.map((kid) => kid.title), ["老单子第一条", "老单子第二条"]);
  assert.equal((await db.select().from(taskPrerequisites).where(eq(taskPrerequisites.taskId, legacyKids[1]!.id))).at(0)?.prerequisiteId, legacyKids[0]!.id,
    "老单子里同批的前置照 key 接上");
  await waitFor(() => delivered().includes(legacyKids[1]!.id), "老派活单派出去之后没有续上会话");
  await waitFor(() => settled(L), "续上的那一轮没有结算");
  const afterLegacy = await taskOf(L);
  assert.equal(afterLegacy.dispatchPlan, null, "写回一次就落成新的那一列、清掉旧列");
  assert.deepEqual(((await detailOf(L)).dispatchSuggestions ?? []).map((item) => item.id), ["dw-old-sg"], "老建议原样挂着");
  const oldDrop = await send("DELETE", `/tasks/${L}/dispatch-suggestions/dw-old-sg`);
  assert.deepEqual([oldDrop.body.dropped, oldDrop.body.closed], [true, false], "老建议照样叉得掉");
  // 另一张老单子：发回去改。
  const L2 = "dw-legacy-back";
  await db.insert(tasks).values(row(L2, "paused", { question: legacyQuestion, dispatchPlan: legacyPlan("dw-plan-2", legacyQuestion) }));
  await db.insert(sessions).values({ id: `${L2}-prev`, taskId: L2, role: "single", agentType: "claude", executor: "claude@test", cwd: root, cliSessionId: `${L2}-cli`, startedAt: at });
  assert.equal((await send("POST", `/tasks/${L2}/answer`, { answer: "老单子先别派(dw-legacy-back)" })).status, 200);
  await waitFor(() => delivered().includes("dw-legacy-back"), "发回去的那句没有送进会话");
  assert.ok(delivered().split("\n").find((line) => line.includes("dw-legacy-back"))?.includes(DISPATCH_PLAN_RETURNED.slice(0, 12)), "说清一条没建");
  assert.deepEqual([(await taskOf(L2)).dispatchPlan, (await detailOf(L2)).dispatchSuggestions], [null, []], "老单子撤下");
  await waitFor(() => settled(L2), "续上的那一轮没有结算");
  assert.equal((await kidsOf(L2)).length, 0);
  console.log("✓ 上线前的老派活单、老建议：照旧能看、能派（续上会话）、能发回去改");
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
