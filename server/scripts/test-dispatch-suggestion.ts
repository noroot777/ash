// 可以派出去的活（src/dispatch-suggestion*.ts、MCP suggest_dispatch）：
//   · 智能体在执行回合里挂出来：任务不停，照常结算成完成；刷新（重读任务、列表）后还在；页面拿不到回合令牌；
//   · 只有这条任务自己的执行回合能挂：没在跑、方向身份过期、审查回合、被 `@` 来问一句的，一律拒；挂满了拒；
//   · 「派出去」照那一行此刻的样子建：改过的标题和说明、换过的人、补的那句话（标明是用户补的）；挂在这条任务名下、
//     来源记用户；那一件同一笔摘掉；这条任务的会话里不多一个回合、不多一条待发送；同一件再按一次不再建；
//   · 好几件「一个接一个」：成一组、按顺序排进队列；叉掉一件就没了；
//   · 这条任务自己的执行器又跑完一个执行回合：之前挂着的收掉、那一回合挂的留下；审查、旁路、`@` 别人来问一句不算；
//     端到端走一次真回合（假 CLI），跑完旧的没了，会话里没有多出字。
//
// 跑：npm -w @ash/server run test:dispatch-suggestion
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Task } from "@ash/shared";
import { SUGGESTION_EXTRA_HEADING } from "@ash/shared/dispatch-suggestion";
import { releaseTmpDb } from "./tmp-db.js";
import { installExitingClis, installFakeClaude } from "./scheduled-messages-fixture.js";

const root = mkdtempSync(join(tmpdir(), "ash-dispatch-suggestion-"));
const leadLog = join(root, "lead-input.jsonl");
const originalPath = process.env.PATH;
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_TEST_LEAD_LOG = leadLog;
const fakeBin = installFakeClaude(root);
process.env.PATH = `${fakeBin}${delimiter}${originalPath ?? ""}`;
process.env.ASH_TEST_AGENT_BIN = fakeBin;
await installExitingClis(fakeBin, ["codex", "gemini"]);

const [{ db, ensureSchema }, schema, runs, runRoutes, groupRoutes, taskRoutes, settle, suggestion] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/runs.js"),
  import("../src/task-run-routes.js"),
  import("../src/group-routes.js"),
  import("../src/task-routes.js"),
  import("../src/settle-status.js"),
  import("../src/dispatch-suggestion.js"),
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
  return { "x-ash-client": "mcp", "x-ash-source-task-id": id, "x-ash-turn-token": `turn-${turn}`, "x-ash-direction-token": `dir-${turn}` };
};
/** 那一回合确认完成后结束：照真结算的判据落位。 */
const endTurnDone = async (id: string) => {
  await db.update(tasks).set({ completeConfirmedAt: new Date().toISOString() }).where(eq(tasks.id, id));
  const result = await settle.settleTaskStatus(id, 0, null);
  await db.update(tasks).set({ status: result.status, activeTurnToken: null, activeDirectionToken: null }).where(eq(tasks.id, id));
  return result.status;
};
const suggest = (id: string, headers: Record<string, string>, items: unknown[]) => send("POST", `/tasks/${id}/dispatch-suggestions`, { tasks: items }, headers);
const shown = async (id: string) => ((await send("GET", `/tasks/${id}`)).body as unknown as Task).dispatchSuggestions ?? [];
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
  assert.equal((await suggest(S, { ...headers, "x-ash-direction-token": "dir-old" }, [RED])).status, 409, "方向身份过期");
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
  const full = await suggest(S, headers, Array.from({ length: 6 }, (_, index) => ({ ...RED, title: `多余 ${index}` })));
  assert.equal(full.status, 200);
  assert.equal((await suggest(S, headers, Array.from({ length: 4 }, (_, index) => ({ ...RED, title: `再多 ${index}` })))).status, 409, "一条任务上挂满了拒");
  const extras = (await shown(S)).filter((item) => item.title.startsWith("多余"));
  for (const extra of extras) assert.equal((await send("DELETE", `/tasks/${S}/dispatch-suggestions/${extra.id}`)).status, 200);
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

  // —— 回合结束收旧的：判据只认这条任务自己的执行器跑完的执行回合。
  assert.equal((await suggest(S, headers, [{ ...RED, title: "旧回合挂的" }])).status, 200);
  headers = await inTurn(S);
  assert.equal((await suggest(S, headers, [{ ...RED, title: "这一回合挂的" }])).status, 200);
  const session = (id: string, extra: Partial<typeof sessions.$inferInsert>) => ({
    id, taskId: S, role: "single", agentType: "claude", executor: "claude@test", cwd: root, startedAt: at, ...extra,
  });
  await db.insert(sessions).values([
    session("ds-side", { sideTurn: true }), session("ds-reviewer", { role: "reviewer" }), session("ds-codex", { agentType: "codex" }),
  ]);
  assert.equal(await suggestion.turnSuggestionPrune(S, "ds-side"), undefined, "旁路回合（就地验证、讨论的一段）不算");
  assert.equal(await suggestion.turnSuggestionPrune(S, "ds-reviewer"), undefined, "审查回合不算");
  assert.equal(await suggestion.turnSuggestionPrune(S, "ds-codex"), undefined, "@ 别人来问一句不算");
  assert.equal(await suggestion.turnSuggestionPrune(S, `${S}-prev`), `turn-${turn}`, "自己的执行回合：留下这一回合挂的");
  assert.equal(await suggestion.pruneSuggestions(S, `turn-${turn}`), true);
  assert.deepEqual((await shown(S)).map((item) => item.title), ["这一回合挂的"], "之前挂的收掉，这一回合挂的留下");
  await endTurnDone(S);
  console.log("✓ 回合结束收旧的：只认自己的执行回合，这一回合挂的留下");

  // —— 端到端：这条任务真跑完一个执行回合（假 CLI），没处理的旧建议没了；会话里没有多出字。
  const replied = await send("POST", `/tasks/${S}/reply`, { text: "接着看看(ds-reply)" });
  assert.ok(replied.status < 300, JSON.stringify(replied.body));
  await waitFor(() => existsSync(leadLog) && readFileSync(leadLog, "utf8").includes("ds-reply"), "那一回合没有送进会话");
  await waitFor(async () => !runs.isTurnClaimed(S) && (await taskOf(S)).status !== "running", "那一回合没有结算");
  await waitFor(async () => (await shown(S)).length === 0, "跑完一个执行回合后旧建议没收掉");
  const md = readdirSync(join(root, "runs", S)).filter((name) => name.endsWith(".md")).map((name) => readFileSync(join(root, "runs", S, name), "utf8")).join("\n");
  assert.equal(/可以派出去|这一回合挂的/.test(md), false, "收掉时会话里不留字");
  console.log("✓ 端到端：自己的执行器跑完一个执行回合，旧建议收掉，会话里不留字");
} catch (error) {
  failure = error;
  console.error(error);
} finally {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  const started = (await db.select({ id: tasks.id }).from(tasks)).map((task) => task.id);
  for (const id of started) if (runs.isRunning(id)) runs.stopTask(id);
  await waitFor(() => started.every((id) => !runs.isRunning(id)), "收尾：还有没停下的假 CLI").catch((error) => { failure ??= error; });
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
  process.exit(failure ? 1 : 0);
}
