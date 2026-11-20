// 不等用户的那一档（MCP suggest_dispatch 缺省 wait = none，src/dispatch-suggestion*.ts；要等的两档在 test-dispatch-suggestion-wait.ts）：
//   · 智能体在执行回合里挂出来：任务不停，照常结算成完成；刷新（重读任务、列表）后还在；页面拿不到回合令牌；
//   · 只有这条任务自己的执行回合能挂：没在跑、方向身份过期、审查回合、被 `@` 来问一句的，一律拒；挂满了拒；
//   · 「派出去」照那一行此刻的样子建：改过的标题和说明、换过的人、补的那句话（标明是用户补的）；挂在这条任务名下、
//     来源记用户；那一件同一笔摘掉；这条任务的会话里不多一个回合、不多一条待发送；同一件再按一次不再建；
//   · 好几件「一个接一个」：成一组、按顺序排进队列；叉掉一件就没了；
//   · 用户还没处理的不随回合消失：之后又跑完几个执行回合，没重挂的那一件还在；同名的不挂第二件；
//   · 同批前置不被去重、收回弄断：同名的那件有同一批的人等着就照挂；收回被等着的那件，等它的前置划掉；
//   · 智能体收回：要写一句为什么，那一件从框顶拿掉、原因同一笔落库并随任务下发；收回再挂同名的一次就换了说明；
//     要收回的已经不在了不算错；审查回合收不了；
//   · 「建议不见了 ⇒ 原因读得到」不看会话：这条任务一条会话都没有时收回，原因照样在；写的权利没了（方向换了）
//     时两样都不落；收回记录只增不减——收回多少次，最早那一条的原因都还在；
//   · 端到端复现用户遇到的顺序（假 CLI 真跑一个回合）：挂建议 → 同一回合提问停下 → 用户答题 → 续跑回合结束，
//     那一件还在、照样派得出去。
//
// 跑：npm -w @navi/server run test:dispatch-suggestion
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Task } from "@navi/shared";
import { SUGGESTION_EXTRA_HEADING } from "@navi/shared/dispatch-suggestion";
import { releaseTmpDb } from "./tmp-db.js";
import { installExitingClis, installFakeClaude } from "./scheduled-messages-fixture.js";

const root = mkdtempSync(join(tmpdir(), "navi-dispatch-suggestion-"));
const leadLog = join(root, "lead-input.jsonl");
const originalPath = process.env.PATH;
process.env.NAVI_DB = join(root, "ash.db");
process.env.NAVI_RUNS_DIR = join(root, "runs");
process.env.NAVI_TEST_LEAD_LOG = leadLog;
const fakeBin = installFakeClaude(root);
process.env.PATH = `${fakeBin}${delimiter}${originalPath ?? ""}`;
process.env.NAVI_TEST_AGENT_BIN = fakeBin;
await installExitingClis(fakeBin, ["codex", "gemini"]);

const [{ db, ensureSchema }, schema, runs, runRoutes, groupRoutes, taskRoutes, settle] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/runs.js"),
  import("../src/task-run-routes.js"),
  import("../src/group-routes.js"),
  import("../src/task-routes.js"),
  import("../src/settle-status.js"),
]);
const { groups, projects, queueItems, scheduledMessages, sessions, tasks } = schema;
await ensureSchema();
const api = new Hono();
runRoutes.mountTaskRunRoutes(api);
groupRoutes.mountGroupRoutes(api);
taskRoutes.mountTaskRoutes(api);

const at = new Date(Date.now() - 60_000).toISOString();
const projectId = "dispatch-suggestion-project";
const row = (id: string, status: string, extra: Partial<typeof tasks.$inferInsert> = {}): typeof tasks.$inferInsert => ({
  id, projectId, groupId: null, parentId: null, title: `任务 ${id}`, body: "改输入框高度", mode: "single", status,
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
const taskOf = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
const send = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await api.request(path, {
    method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
};
let turn = 0;
const inTurn = async (id: string) => {
  turn += 1;
  await db.update(tasks).set({ status: "running", activeTurnToken: `turn-${turn}`, activeDirectionToken: `dir-${turn}` }).where(eq(tasks.id, id));
  return { "x-navi-client": "mcp", "x-navi-source-task-id": id, "x-navi-turn-token": `turn-${turn}`, "x-navi-direction-token": `dir-${turn}` };
};
/** 那一回合结束：照真结算的判据落位（confirm = 结束前确认过完成）。 */
const endTurn = async (id: string, confirm: boolean) => {
  if (confirm) await db.update(tasks).set({ completeConfirmedAt: new Date().toISOString() }).where(eq(tasks.id, id));
  const result = await settle.settleTaskStatus(id, 0, null);
  await db.update(tasks).set({ status: result.status, activeTurnToken: null, activeDirectionToken: null }).where(eq(tasks.id, id));
  return result.status;
};
const endTurnDone = (id: string) => endTurn(id, true);
const suggest = (id: string, headers: Record<string, string>, items: unknown[] | undefined, withdraw?: unknown[]) =>
  send("POST", `/tasks/${id}/dispatch-suggestions`, { tasks: items, withdraw }, headers);
const shown = async (id: string) => ((await send("GET", `/tasks/${id}`)).body as unknown as Task).dispatchSuggestions ?? [];
/** 页面读到的收回记录（标题、原因）：按先后。 */
const withdrawnOf = async (id: string) => (((await send("GET", `/tasks/${id}`)).body as unknown as Task).dispatchWithdrawals ?? [])
  .map((item) => [item.title, item.reason]);
const kidsOf = async (id: string) => db.select().from(tasks).where(eq(tasks.dispatchedBy, id)).orderBy(asc(tasks.createdAt));
const RED = { title: "修好斜杠菜单那条红测试", body: "## 目标\n让 test-question-card-dom 重新变绿（完整说明 A）", note: "main 上每次验收都被它挡住" };
const claude = { agentType: "claude", executorId: null, model: null, reasoningEffort: null };

const S = "ds-source";
let failure: unknown = null;
try {
  await db.insert(projects).values({ id: projectId, name: "dispatch-suggestion", repoPath: root, apiKeys: null, createdAt: at });
  await db.insert(tasks).values([row(S, "backlog")]);
  await db.insert(sessions).values({ id: `${S}-prev`, taskId: S, role: "single", agentType: "claude", executor: "claude@test", cwd: root, cliSessionId: `${S}-cli`, startedAt: at });

  // —— 没在跑、方向身份过期：挂不上。
  assert.equal((await suggest(S, {}, [RED])).status, 409, "没在跑时挂不上");
  let headers = await inTurn(S);
  assert.equal((await suggest(S, { ...headers, "x-navi-direction-token": "dir-old" }, [RED])).status, 409, "方向身份过期");
  assert.equal((await suggest(S, headers, [{ title: "", body: "x", note: "" }])).status, 400, "标题不能空");
  // 审查回合、被 @ 来问一句的回合：不能挂。
  const reviewer = runs.claimOwnTurn(S, "reviewer");
  assert.ok(reviewer);
  assert.equal((await suggest(S, headers, [RED])).status, 409, "审查回合不能挂");
  runs.releaseTurn(S, reviewer!);
  const summoned = runs.claimOwnTurn(S, "single");
  runs.bindTurnToken(S, `turn-${turn}`, "codex");
  assert.equal((await suggest(S, headers, [RED])).status, 409, "@ 别人来问一句的回合不能挂");
  runs.releaseTurn(S, summoned!);
  console.log("✓ 只有这条任务自己的执行回合能挂：没在跑、身份过期、审查、@ 别人来问一句都拒");

  // —— 挂出来：任务不停，照常结算成完成；刷新后还在；页面拿不到回合令牌。
  const posted = await suggest(S, headers, [RED]);
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  assert.deepEqual(posted.body.hanging, [{ id: (posted.body.ids as string[])[0], title: RED.title }], "回包里是此刻挂着的全部");
  assert.equal((await taskOf(S)).question, null, "不占提问那一格");
  assert.equal(await endTurnDone(S), "done", "照常结算成完成，不落暂停");
  const first = await shown(S);
  assert.equal(first.length, 1, "刷新后还在");
  assert.deepEqual([first[0]!.title, first[0]!.note, first[0]!.base, first[0]!.target], [RED.title, RED.note, "trunk", null]);
  assert.equal("turnToken" in first[0]!, false, "页面拿不到回合令牌");
  const listed = (await send("GET", "/tasks")).body as unknown as Task[];
  assert.equal(listed.find((task) => task.id === S)?.dispatchSuggestions?.length, 1, "随列表下发");
  console.log("✓ 挂出来：任务照常结算成完成，刷新后还在，不占提问那一格");

  // —— 一件「派出去」：照那一行此刻的样子建（改过的标题、说明、换过的人、补的话），挂在这条任务名下；会话里不多回合。
  const sessionsBefore = (await db.select().from(sessions).where(eq(sessions.taskId, S))).length;
  const launched = await send("POST", `/tasks/${S}/dispatch-suggestions/launch`, {
    order: "parallel",
    items: [{ id: first[0]!.id, title: "修好斜杠菜单的红测试（改过）", body: "改过的说明(ds-edited)", extra: "只改测试，别动输入框(ds-extra)",
      target: { agentType: "codex", model: "gpt-5.6" }, worktreeBase: null }],
  });
  assert.equal(launched.status, 200, JSON.stringify(launched.body));
  const [kid] = await kidsOf(S);
  assert.ok(kid, "建出了一条挂在这条任务名下的任务");
  assert.equal(kid!.title, "修好斜杠菜单的红测试（改过）");
  assert.equal(kid!.body, `改过的说明(ds-edited)\n\n${SUGGESTION_EXTRA_HEADING}\n\n只改测试，别动输入框(ds-extra)`, "正文是改过的说明 + 标明是用户补的话");
  assert.deepEqual([kid!.agentType, kid!.model, kid!.groupId], ["codex", "gpt-5.6", null], "交给换过的人；一件就是一条独立任务");
  assert.equal(JSON.parse(kid!.creationOrigin ?? "{}").kind, "user", "来源记用户（会话里那一句「开了新任务」据此认）");
  assert.deepEqual(await shown(S), [], "那一件摘掉了");
  assert.equal((await db.select().from(scheduledMessages).where(eq(scheduledMessages.taskId, S))).length, 0, "没往这条任务送任何话");
  assert.equal((await db.select().from(sessions).where(eq(sessions.taskId, S))).length, sessionsBefore, "这条任务没有多跑回合");
  assert.equal(runs.isTurnClaimed(S), false);
  await waitFor(async () => (await taskOf(kid!.id)).status !== "backlog", "新任务没有起跑");
  const again = await send("POST", `/tasks/${S}/dispatch-suggestions/launch`, {
    items: [{ id: first[0]!.id, title: "x", body: "y", target: claude, worktreeBase: null }],
  });
  assert.equal(again.status, 409, "同一件再按一次不再建");
  assert.equal((await kidsOf(S)).length, 1);
  console.log("✓ 一件派出去：照改过的样子建、补的话标明是用户说的、挂在这条名下并起跑；这条任务不多跑回合；再按不再建");

  // —— 在跑时也照派；好几件「一个接一个」成一组、按顺序排队；叉掉一件就没了；挂满了拒。
  headers = await inTurn(S);
  const three = await suggest(S, headers, [
    { ...RED, title: "第一件" }, { ...RED, title: "第二件", base: "here", agentType: "gemini" }, { ...RED, title: "第三件" },
  ]);
  assert.equal(three.status, 200, JSON.stringify(three.body));
  const listedThree = await shown(S);
  assert.deepEqual(listedThree.map((item) => [item.title, item.base, item.target?.agentType ?? null]),
    [["第一件", "trunk", null], ["第二件", "here", "gemini"], ["第三件", "trunk", null]]);
  const full = await suggest(S, headers, Array.from({ length: 12 }, (_, index) => ({ ...RED, title: `多余 ${index}` })));
  assert.equal(full.status, 200, JSON.stringify(full.body));
  assert.equal((await suggest(S, headers, Array.from({ length: 13 }, (_, index) => ({ ...RED, title: `超一次 ${index}` })))).status, 400, "一次挂太多拒");
  assert.equal((await suggest(S, headers, Array.from({ length: 10 }, (_, index) => ({ ...RED, title: `再多 ${index}` })))).status, 409, "一条任务上挂满了拒");
  const extras = (await shown(S)).filter((item) => item.title.startsWith("多余"));
  for (const extra of extras) assert.equal((await send("DELETE", `/tasks/${S}/dispatch-suggestions/${extra.id}`)).body.closed, false);
  const serial = await send("POST", `/tasks/${S}/dispatch-suggestions/launch`, {
    order: "serial",
    items: [listedThree[1]!, listedThree[0]!].map((item) => ({ id: item.id, title: item.title, body: item.body, target: claude, worktreeBase: null })),
  });
  assert.equal(serial.status, 200, JSON.stringify(serial.body));
  const serialIds = (serial.body.tasks as { id: string }[]).map((item) => item.id);
  const group = (await db.select().from(groups).where(eq(groups.id, String(serial.body.groupId)))).at(0);
  assert.equal(group?.mode, "serial", "好几件一个接一个：成一组");
  const queue = await db.select().from(queueItems).where(eq(queueItems.taskId, serialIds[0]!));
  const order = await db.select().from(queueItems).where(eq(queueItems.queueId, queue[0]!.queueId)).orderBy(asc(queueItems.position));
  assert.deepEqual(order.map((item) => item.taskId), serialIds, "按派出的先后排进队列");
  assert.deepEqual((await Promise.all(serialIds.map(taskOf))).map((task) => task.title), ["第二件", "第一件"]);
  assert.deepEqual((await shown(S)).map((item) => item.title), ["第三件"], "派掉的两件摘掉，剩下的还在");
  const dropped = await send("DELETE", `/tasks/${S}/dispatch-suggestions/${listedThree[2]!.id}`);
  assert.equal(dropped.status, 200);
  assert.deepEqual(await shown(S), [], "叉掉就没了");
  console.log("✓ 在跑时照派；好几件一个接一个成一组、按顺序排队；叉掉就没了；挂满了拒");

  // —— 用户还没处理的不随回合消失：之后又跑完两个执行回合、谁都没重挂，那一件还在；同名的不挂第二件。
  const old = await suggest(S, headers, [{ ...RED, title: "旧回合挂的" }]);
  assert.equal(old.status, 200, JSON.stringify(old.body));
  const oldId = (old.body.ids as string[])[0]!;
  await endTurnDone(S);
  headers = await inTurn(S);
  await endTurnDone(S);
  headers = await inTurn(S);
  assert.deepEqual((await shown(S)).map((item) => item.id), [oldId], "又跑完两个执行回合，没处理的那一件还在");
  const twice = await suggest(S, headers, [{ ...RED, title: "旧回合挂的", body: "记岔了又挂一遍" }, { ...RED, title: "新的" }, { ...RED, title: "新的" }]);
  assert.equal(twice.status, 200, JSON.stringify(twice.body));
  assert.deepEqual([twice.body.suggested, twice.body.already], [1, [{ id: oldId, title: "旧回合挂的" }, { id: (twice.body.ids as string[])[0], title: "新的" }]],
    "跟挂着的、跟同一批里前面的同名：不挂第二件，指回挂着的那一件");
  assert.deepEqual((await shown(S)).map((item) => [item.title, item.body]), [["旧回合挂的", RED.body], ["新的", RED.body]], "挂着的那一件原样没动");
  console.log("✓ 用户还没处理的不随回合消失；同名的不挂第二件");

  // —— 智能体收回：要写为什么；那一件拿掉、原因同一笔落库并随任务下发；收回再挂同名的一次就换了说明。
  assert.equal((await suggest(S, headers, undefined, [{ id: oldId, reason: "" }])).status, 400, "收回要写一句为什么");
  assert.equal((await suggest(S, headers, undefined, undefined)).status, 400, "要挂的和要收回的至少给一样");
  const reviewing = runs.claimOwnTurn(S, "reviewer");
  assert.equal((await suggest(S, headers, undefined, [{ id: oldId, reason: "审查者觉得不用了" }])).status, 409, "审查回合收不了");
  runs.releaseTurn(S, reviewing!);
  const swapped = await suggest(S, headers, [{ ...RED, title: "旧回合挂的", body: "换过的说明(ds-swapped)" }],
    [{ id: oldId, reason: "说明里漏了一处，换成新的(ds-why)" }, { id: "ds-not-there", reason: "早就派掉了" }]);
  assert.equal(swapped.status, 200, JSON.stringify(swapped.body));
  assert.deepEqual([swapped.body.withdrawn, swapped.body.gone, swapped.body.suggested, swapped.body.already], [[oldId], ["ds-not-there"], 1, undefined],
    "先收回再挂：同名的新说明挂得上；要收回的已经不在了不算错");
  const afterSwap = await shown(S);
  assert.deepEqual(afterSwap.map((item) => [item.title, item.body]), [["新的", RED.body], ["旧回合挂的", "换过的说明(ds-swapped)"]]);
  assert.deepEqual(swapped.body.hanging, afterSwap.map((item) => ({ id: item.id, title: item.title })));
  assert.deepEqual(await withdrawnOf(S), [["旧回合挂的", "说明里漏了一处，换成新的(ds-why)"]], "为什么收回随任务下发：页面据它在会话里写一句");
  const listedWithdrawn = (await send("GET", "/tasks")).body as unknown as Task[];
  assert.equal(listedWithdrawn.find((task) => task.id === S)?.dispatchWithdrawals?.length, 1, "随列表下发");
  const only = await suggest(S, headers, undefined, [{ id: afterSwap[0]!.id, reason: "已经在本任务里顺手做了" }]);
  assert.deepEqual([only.status, only.body.suggested, only.body.withdrawn], [200, 0, [afterSwap[0]!.id]], "只收回、不挂新的");
  assert.deepEqual((await shown(S)).map((item) => item.title), ["旧回合挂的"]);
  assert.deepEqual(await withdrawnOf(S), [["旧回合挂的", "说明里漏了一处，换成新的(ds-why)"], ["新的", "已经在本任务里顺手做了"]]);
  await send("DELETE", `/tasks/${S}/dispatch-suggestions/${afterSwap[1]!.id}`);
  assert.equal((await withdrawnOf(S)).length, 2, "用户自己点叉的不记：那是他自己的动作");
  await endTurnDone(S);
  console.log("✓ 智能体收回：写明原因、原因随任务下发；收回再挂同名的一次换说明；不在了的不算错；审查回合收不了");

  // —— 「建议不见了 ⇒ 原因读得到」是同一笔，不看会话：一条会话都没有的任务上收回，原因照样在。
  const B = "ds-bare";
  await db.insert(tasks).values([row(B, "backlog")]);
  let bare = await inTurn(B);
  const lone = await suggest(B, bare, [{ ...RED, title: "没有会话时挂的" }]);
  assert.equal(lone.status, 200, JSON.stringify(lone.body));
  assert.equal((await db.select().from(sessions).where(eq(sessions.taskId, B))).length, 0);
  const loneId = (lone.body.ids as string[])[0]!;
  const bareGone = await suggest(B, bare, undefined, [{ id: loneId, reason: "情况已变化，不应再派" }]);
  assert.deepEqual([bareGone.status, bareGone.body.withdrawn, bareGone.body.hanging], [200, [loneId], []]);
  assert.deepEqual([await shown(B), await withdrawnOf(B)], [[], [["没有会话时挂的", "情况已变化，不应再派"]]], "没有会话可记，原因照样读得到");
  // 写的权利没了（用户补了新要求、方向换了）：拿掉和记原因是同一条更新，两样都不落。
  const stay = await suggest(B, bare, [{ ...RED, title: "方向换了以后还在的" }]);
  await db.update(tasks).set({ activeDirectionToken: "dir-moved" }).where(eq(tasks.id, B));
  assert.equal((await suggest(B, bare, undefined, [{ id: (stay.body.ids as string[])[0]!, reason: "旧方向下想收回" }])).status, 409);
  assert.deepEqual([(await shown(B)).map((item) => item.title), (await withdrawnOf(B)).length], [["方向换了以后还在的"], 1], "没拿掉，也没多记一条");
  // 收回记录只增不减：没有任何东西知道用户看没看过，所以挂了收、收了挂多少轮，最早那一条的原因都还在
  // （一次收回好几件的也一条不少、先后不乱）。
  bare = { ...bare, "x-navi-direction-token": "dir-moved" };
  const ROUNDS = 40;
  for (let round = 0; round < ROUNDS; round += 1) {
    const hung = await suggest(B, bare, [{ ...RED, title: `第 ${round} 轮甲` }, { ...RED, title: `第 ${round} 轮乙` }]);
    const [first, second] = hung.body.ids as string[];
    const back = await suggest(B, bare, undefined, [{ id: first!, reason: `原因 ${round} 甲` }, { id: second!, reason: `原因 ${round} 乙` }]);
    assert.equal(back.status, 200, JSON.stringify(back.body));
  }
  const everything = await withdrawnOf(B);
  assert.deepEqual(everything, [
    ["没有会话时挂的", "情况已变化，不应再派"],
    ...Array.from({ length: ROUNDS }, (_, round) => [[`第 ${round} 轮甲`, `原因 ${round} 甲`], [`第 ${round} 轮乙`, `原因 ${round} 乙`]]).flat(),
  ], "收回了 81 件，81 句原因都在，最早那一句也在");
  // 库里那一份坏了（不是 JSON）：接不上去，这条更新整个不落——建议不会被拿掉而原因没处记。
  const stuck = await suggest(B, bare, [{ ...RED, title: "记录坏了时挂着的" }]);
  const sound = (await taskOf(B)).dispatchWithdrawals;
  await db.update(tasks).set({ dispatchWithdrawals: "不是 JSON" }).where(eq(tasks.id, B));
  const refused = await suggest(B, bare, undefined, [{ id: (stuck.body.ids as string[])[0]!, reason: "记不上的原因" }]);
  assert.equal(refused.status, 500, "原因记不上，收回就不成");
  assert.match(String(refused.body.error), /一样都没落/);
  assert.deepEqual((await shown(B)).map((item) => item.title), ["方向换了以后还在的", "记录坏了时挂着的"], "建议原样还在");
  await db.update(tasks).set({ dispatchWithdrawals: sound }).where(eq(tasks.id, B));
  await endTurnDone(B);
  console.log("✓ 收回和原因同一笔：没有会话也读得到；写的权利没了两样都不落；记录只增不减，记不上就不收回");

  // —— 同批前置不被去重、收回弄断：同名的那件有同一批的人等着就照挂；收回被等着的那件，等它的那条前置跟着划掉。
  const PR = "ds-prereq";
  await db.insert(tasks).values(row(PR, "backlog"));
  const prHeaders = await inTurn(PR);
  assert.equal((await suggest(PR, prHeaders, [{ title: "同名的那件", body: "先挂着的说明", note: "" }])).status, 200);
  const pair = await suggest(PR, prHeaders, [
    { key: "a", title: "同名的那件", body: "这一批的上游", note: "" },
    { key: "b", title: "要等上游的", body: "下游", note: "", prerequisites: ["a"] },
    { title: "同名的那件", body: "没人等的同名件", note: "" },
  ]);
  assert.equal(pair.status, 200, JSON.stringify(pair.body));
  const hungPair = await shown(PR);
  assert.deepEqual(hungPair.map((item) => [item.title, item.body]),
    [["同名的那件", "先挂着的说明"], ["同名的那件", "这一批的上游"], ["要等上游的", "下游"]], "有人等着的同名件照挂，没人等的不挂第二件");
  const [, upstream, downstream] = hungPair;
  const pick = (item: typeof downstream) => ({ id: item!.id, title: item!.title, body: item!.body, target: claude, worktreeBase: null });
  const alone = await send("POST", `/tasks/${PR}/dispatch-suggestions/launch`, { items: [pick(downstream)] });
  assert.equal(alone.status, 409);
  assert.match(String(alone.body.error), /要等同一批的「同名的那件」/, "前置认得出指的是同一批里那件，不是一个不存在的任务");
  assert.equal((await suggest(PR, prHeaders, undefined, [{ id: upstream!.id, reason: "上游不做了" }])).status, 200);
  const freed = (await shown(PR)).find((item) => item.id === downstream!.id)!;
  assert.equal(freed.prerequisites, undefined, "收回了上游：下游那条前置划掉（同用户点叉）");
  const freedLaunch = await send("POST", `/tasks/${PR}/dispatch-suggestions/launch`, { items: [pick(freed)] });
  assert.equal(freedLaunch.status, 200, JSON.stringify(freedLaunch.body));
  assert.equal((await kidsOf(PR)).at(-1)?.title, "要等上游的", "照样派得出去");
  await endTurnDone(PR);
  console.log("✓ 同批前置：有人等着的同名件照挂；收回被等着的那件，等它的那条前置划掉、照样派得出去");

  // —— 端到端复现：挂建议 → 同一回合提问停下 → 用户答题 → 续跑回合（假 CLI 真跑）结束 → 那一件还在、照样派得出去。
  headers = await inTurn(S);
  const kept = await suggest(S, headers, [{ ...RED, title: "提问那一回合挂的" }]);
  assert.equal(kept.status, 200, JSON.stringify(kept.body));
  const asked = await send("POST", `/tasks/${S}/ask`, { question: "规则文件要不要带口令提交？" }, headers);
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.equal(await endTurn(S, false), "paused", "回合停在提问上");
  const answered = await send("POST", `/tasks/${S}/answer`, { answer: "带口令提交(ds-answer)" });
  assert.ok(answered.status < 300, JSON.stringify(answered.body));
  await waitFor(() => existsSync(leadLog) && readFileSync(leadLog, "utf8").includes("ds-answer"), "答复没有送进会话");
  await waitFor(async () => !runs.isTurnClaimed(S) && (await taskOf(S)).status !== "running", "续跑的那一回合没有结算");
  const survived = await shown(S);
  assert.deepEqual(survived.map((item) => item.title), ["提问那一回合挂的"], "用户只是答了一道题，续跑回合结束后那一件还在");
  const kidsBefore = (await kidsOf(S)).length;
  const late = await send("POST", `/tasks/${S}/dispatch-suggestions/launch`, {
    items: [{ id: survived[0]!.id, title: survived[0]!.title, body: survived[0]!.body, target: claude, worktreeBase: null }],
  });
  assert.equal(late.status, 200, JSON.stringify(late.body));
  assert.equal((await kidsOf(S)).at(-1)?.title, "提问那一回合挂的");
  assert.equal((await kidsOf(S)).length, kidsBefore + 1, "照样派得出去");
  assert.deepEqual(await shown(S), []);
  // 刚派出去的那条等它跑完（假 CLI 一轮就退）再收场：它是异步起跑的，留到收尾里才起就跟还原 PATH 抢先后。
  const lateKid = (await kidsOf(S)).at(-1)!.id;
  await waitFor(async () => !runs.isRunning(lateKid) && !["backlog", "queued", "running"].includes((await taskOf(lateKid)).status),
    "最后派出去的那条没有跑完");
  console.log("✓ 端到端：挂建议 → 同回合提问停下 → 答题 → 续跑回合结束，那一件还在、照样派得出去");
} catch (error) {
  failure = error;
  console.error(error);
} finally {
  // 先收回「可以起真执行器」的放行，再动 PATH：PATH 一还原，上面排着还没起跑的任务拿到的就是机器上真的
  // claude（实测漏出过，带着 --dangerously-skip-permissions 在后台跑）。放行收回后晚到的起跑一律被闸住
  // （executors/spawn.ts 的 guardAgentSpawn）。PATH 等全部停下之后才还原。
  delete process.env.NAVI_ALLOW_REAL_AGENT;
  const started = (await db.select({ id: tasks.id }).from(tasks)).map((task) => task.id);
  for (const id of started) if (runs.isRunning(id)) runs.stopTask(id);
  await waitFor(() => started.every((id) => !runs.isRunning(id)), "收尾：还有没停下的假 CLI").catch((error) => {
    // 收尾失败也要说出来：否则前面全是 ✓、退出码却是 1，看不出红在哪。
    console.error(error, "还在跑：", started.filter((id) => runs.isRunning(id)));
    failure ??= error;
  });
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
  process.exit(failure ? 1 : 0);
}
