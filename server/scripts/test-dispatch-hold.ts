// 「派出的任务」格头那一对键：全部停下 / 接着跑（src/dispatch-hold.ts、判定 src/task-hold.ts）。
//
// 钉住的是这几件事：
//   · 停下后在跑的落 paused 不是 canceled，串行队列没有跳过它起下一条；
//   · 停下后重读状态（含开机补办那一趟）还是停着，被谁按住说得出来；
//   · 已占位、还没起跑的那一轮也被拦住；停着期间新派出去的（分组运行、智能体调 run_task）不起跑；
//   · 排着的消息、哨兵了结后的补推、重跑上一回合都不会把被按住的任务叫起来；
//   · 接着跑后按原顺序续、从原会话续；停之前就停着的没被叫起来；
//   · 同组里不是这条名下的任务一条没受影响；名下再派出的也停了；
//   · 分组暂停和它互不相干：两样都没按住才跑；派活的那条归档了照样能接着跑，被删了名下不再被按住。
//
// 走真实的调度链路（队列推进、分组运行、路由、结算钩子），只换掉「起一个 CLI」那一步：假执行器
// 记下每一回合拿到的输入与续的是哪条原生会话，回合一直挂着，直到测试放它走或者它被停掉。
//
// 跑：npm -w server run test:dispatch-hold
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AgentEvent } from "@ash/shared";

const root = mkdtempSync(join(tmpdir(), "ash-dispatch-hold-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
// 「exit 0 即 done」：本文件测的是停 / 续，不是完成协议。
process.env.ASH_LAX_DONE = "1";
delete process.env.ASH_ALLOW_REAL_AGENT;

const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const schema = await import("../src/db/schema.js");
const { tasks } = schema;
const runs = await import("../src/runs.js");
const { ClaudeExecutor } = await import("../src/executors/claude.js");
const { CodexExecutor } = await import("../src/executors/codex.js");
const { mountTaskRunRoutes } = await import("../src/task-run-routes.js");
const { mountDispatchHoldRoutes } = await import("../src/dispatch-hold-routes.js");
const { mountGroupRoutes } = await import("../src/group-routes.js");
const { advanceQueue, pauseGroup, recoverQueueAdvances, runGroup } = await import("../src/scheduler.js");
const { dispatchHoldOf, taskHoldOf } = await import("../src/task-hold.js");
const { turnFreezeReason } = await import("../src/turn-freeze.js");
const { sweepReleasedQueueMembers } = await import("../src/queue-monitor-hold.js");
const { deliverPendingMessages, enqueueMessage } = await import("../src/pending-messages.js");
const { pendingMessagePresence } = await import("../src/pending-wait.js");
const { readRetryTurnFacts, retryTurnRejection } = await import("../src/task-retry-turn.js");
const { deleteTaskCompletely } = await import("../src/task-delete-routes.js");
await ensureSchema();

const api = new Hono();
mountTaskRunRoutes(api);
mountDispatchHoldRoutes(api);
mountGroupRoutes(api);

// ── 假执行器：回合挂着，测试 finish() 放它走、或者被 stopTask 杀掉 ─────────────────────────
type Turn = { prompt: string; resume: string | undefined };
const turns = new Map<string, Turn[]>();
const gates = new Map<string, () => void>();
const turnsOf = (taskId: string) => turns.get(taskId) ?? [];

const run = (opts: { prompt: string; sessionId?: string; env?: Record<string, string | undefined> }) => {
  const taskId = opts.env!.ASH_TASK_ID!;
  turns.set(taskId, [...turnsOf(taskId), { prompt: opts.prompt, resume: opts.sessionId }]);
  const native = opts.sessionId ?? `native-${taskId}`;
  let release!: () => void;
  const ended = new Promise<void>((resolve) => { release = resolve; });
  gates.set(taskId, release);
  return {
    sessionId: native, commandLine: "dispatch hold fixture; no CLI",
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
    if (Date.now() > deadline) throw new Error(`等不到：${label}`);
    await sleep(25);
  }
}
const row = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
const statusOf = async (taskId: string) => (await row(taskId)).status;
const idle = (taskId: string) => !runs.isTurnClaimed(taskId) && !runs.isRunning(taskId);
const running = (taskId: string) => until(`${taskId} 在跑`, async () => runs.isRunning(taskId) && await statusOf(taskId) === "running");
const settled = (taskId: string, status: string) =>
  until(`${taskId} 落 ${status}`, async () => idle(taskId) && await statusOf(taskId) === status);
/** 放这一回合走（正常跑完 → LAX 下落 done）。 */
function finish(taskId: string): void {
  const release = gates.get(taskId);
  assert.ok(release, `${taskId} 此刻没有回合可放`);
  gates.delete(taskId);
  release();
}
const post = (path: string, headers: Record<string, string> = {}) =>
  api.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });

// ── 夹具 ──────────────────────────────────────────────────────────────────────────
// H 派出 A、B（同一条串行队列，A 在前）、C（同组不在队列）；A 又派出 D（没有分组）。
// O 跟 C 同组，但是用户手建的（不在 H 名下）。E 停之前就在等答复，F 停之前就被用户停掉了。
// P 在另一个分组 G2：拿来看分组暂停和名下全部停下互不相干。N 是停着期间新派出去的。
const at = new Date().toISOString();
await db.insert(schema.projects).values({ id: "p", name: "dispatch hold", repoPath: root, createdAt: at });
await db.insert(schema.agents).values({ id: "fixture-claude", name: "claude@fixture", type: "claude", isDefault: true });
await db.insert(schema.groups).values([
  { id: "G", projectId: "p", name: "共用的组", mode: "parallel", paused: false, createdAt: at },
  { id: "G2", projectId: "p", name: "另一个组", mode: "parallel", paused: false, createdAt: at },
]);
const task = (id: string, over: Partial<typeof tasks.$inferInsert> = {}): typeof tasks.$inferInsert => ({
  id, projectId: "p", title: `任务 ${id}`, body: id, status: "backlog", mode: "single", agentType: "claude",
  executorId: "fixture-claude", useWorktree: false, autoTitle: false, createdAt: at, updatedAt: at, ...over,
});
await db.insert(tasks).values([
  task("H", { status: "done", title: "派活的那条" }),
  task("A", { groupId: "G", dispatchedBy: "H" }),
  task("B", { groupId: "G", dispatchedBy: "H" }),
  task("C", { groupId: "G", dispatchedBy: "H" }),
  task("D", { dispatchedBy: "A" }),
  task("O", { groupId: "G" }),
  task("E", { dispatchedBy: "H", status: "paused", question: "要哪一种？" }),
  task("F", { dispatchedBy: "H", status: "canceled" }),
  task("P", { groupId: "G2", dispatchedBy: "H" }),
  task("H2", { status: "done", title: "会被删掉的派活人" }),
  task("K", { dispatchedBy: "H2" }),
]);
await db.insert(schema.queueItems).values([
  { taskId: "A", queueId: "Q", position: 0, createdAt: at },
  { taskId: "B", queueId: "Q", position: 1, createdAt: at },
]);

let failure: unknown = null;
try {
  // ── 起跑：分组运行拉起 C、O，推队列拉起 A；D、P、K 用户点运行 ──────────────────────
  // runParallel 会等它拉起的那几位整轮跑完才返回，回合在这里一直挂着，所以不等它。
  void runGroup("G").catch((error) => console.error(error));
  await advanceQueue("Q");
  await Promise.all(["A", "C", "O"].map(running));
  for (const id of ["D", "P", "K"]) {
    assert.equal((await post(`/tasks/${id}/run`)).status, 202, `${id} 起得来`);
    await running(id);
  }
  assert.equal(turnsOf("B").length, 0, "B 排在 A 后面，还没轮到");

  // ── 全部停下 ────────────────────────────────────────────────────────────────────
  const held = await post("/tasks/H/dispatched/hold");
  assert.equal(held.status, 200);
  assert.ok((await held.json() as { dispatchHoldAt: string | null }).dispatchHoldAt, "停着记在派活那条上，随任务下发");
  for (const id of ["A", "C", "D", "P"]) await settled(id, "paused");
  assert.ok(runs.isRunning("O") && await statusOf("O") === "running", "同组里不是 H 名下的 O 照常跑");
  assert.ok(runs.isRunning("K"), "别的派活人名下的 K 不受影响");
  assert.equal(await statusOf("H"), "done", "派活的那条自己不停");
  await sleep(400);
  assert.equal(turnsOf("B").length, 0, "A 停成 paused 占住队首：队列没有跳过它起 B");
  assert.equal(await statusOf("B"), "backlog");
  for (const id of ["A", "C", "D", "P"]) assert.equal((await row(id)).holdOwedBy, "H", `${id} 记着欠一次起跑`);
  assert.equal(await statusOf("E"), "paused");
  assert.equal(await statusOf("F"), "canceled");
  assert.equal((await row("E")).holdOwedBy, null, "停之前就在等答复的不记欠账");
  assert.equal((await row("F")).holdOwedBy, null, "停之前就取消了的不记欠账");
  assert.deepEqual(await dispatchHoldOf("D"), { byTaskId: "H", byTitle: "派活的那条" }, "名下再派出的那一层也认得出是 H 按的");
  assert.equal((await taskHoldOf(await row("O")))?.kind, undefined, "O 没被按住");

  // ── 重读 / 开机补办：还是停着 ─────────────────────────────────────────────────────
  await recoverQueueAdvances();
  await advanceQueue("Q");
  await sleep(300);
  assert.equal(turnsOf("A").length, 1, "推队列不会把被按住的 A 叫起来");
  assert.equal(turnsOf("B").length, 0, "也不越过 A 起 B");
  assert.ok((await row("H")).dispatchHoldAt, "停着的标记还在库里");

  // ── 已占位、还没起跑的那一轮 ──────────────────────────────────────────────────────
  await db.insert(tasks).values(task("X", { dispatchedBy: "H", status: "done" }));
  const claimed = runs.claimOwnTurn("X");
  assert.ok(claimed);
  assert.equal((await post("/tasks/H/dispatched/hold")).status, 200, "已经停着再按一次：再扫一遍");
  const frozen = await turnFreezeReason("X");
  assert.equal(frozen?.source, "dispatch-hold", "已占位的那一轮在起跑前被撤回");
  assert.match(frozen?.reason ?? "", /「派活的那条」名下已全部停下/, "撤回那一句指得到是谁按的");
  runs.releaseTurn("X", claimed);
  assert.equal((await turnFreezeReason("X", true))?.source, "dispatch-hold", "查库那一档同样认得出");

  // ── 停着期间新派出去的：建得出来，不起跑 ──────────────────────────────────────────
  await db.insert(tasks).values([task("N", { groupId: "G", dispatchedBy: "H" }), task("N2", { dispatchedBy: "C" })]);
  await runGroup("G");
  const agentRun = await post("/tasks/N2/run", { "x-ash-client": "mcp" });
  assert.equal(agentRun.status, 409, "智能体调 run_task 起被按住的任务：拒掉");
  assert.match((await agentRun.json() as { error: string }).error, /名下已全部停下/);
  await sleep(300);
  assert.equal(turnsOf("N").length, 0, "分组运行不起新派出去的 N");
  assert.equal(turnsOf("N2").length, 0);
  assert.equal((await row("N")).holdOwedBy, "H", "N 记着欠一次起跑");
  assert.equal((await row("N2")).holdOwedBy, "H");
  assert.equal(turnsOf("O").length, 1, "O 还是那一回合");

  // ── 排着的消息、哨兵补推、重跑上一回合都叫不起来 ──────────────────────────────────
  const queued = await enqueueMessage({ taskId: "A", text: "停下前排的那句", execution: true });
  const later = await enqueueMessage({ taskId: "C", text: "到点叫醒它", mode: "scheduled", sendAt: new Date(Date.now() - 1_000) });
  await deliverPendingMessages();
  await sleep(300);
  assert.equal(turnsOf("A").length, 1, "执行型的排队消息不送");
  assert.equal(turnsOf("C").length, 1, "到点的定时消息也不把停着的 C 叫起来");
  const [tray] = await pendingMessagePresence("A", [(await db.select().from(schema.scheduledMessages)
    .where(eq(schema.scheduledMessages.id, queued.id)))[0]!]);
  assert.deepEqual(tray?.wait, { kind: "dispatchHeld", by: { id: "H", title: "派活的那条" } }, "托盘说得出是谁按的停");
  await db.delete(schema.scheduledMessages).where(eq(schema.scheduledMessages.id, queued.id));
  await db.delete(schema.scheduledMessages).where(eq(schema.scheduledMessages.id, later.id));

  await db.update(tasks).set({ monitorHoldAt: new Date().toISOString() }).where(eq(tasks.id, "A"));
  await sweepReleasedQueueMembers();
  await sleep(300);
  assert.equal(turnsOf("A").length, 1, "哨兵了结后的补推不叫被按住的 A");
  await db.update(tasks).set({ monitorHoldAt: null }).where(eq(tasks.id, "A"));

  const retry = await readRetryTurnFacts("A");
  assert.ok(retry);
  assert.equal(retry.facts.dispatchHold?.byTaskId, "H", "重跑上一回合读得到按住它的那条");
  // 判据本身用纯函数喂一个「上一回合崩了的已完成任务」：只看按住这一条拦不拦、话怎么说。
  const crashed = retryTurnRejection({
    task: { archived: false, mode: "single", status: "done", verifyRound: null },
    latest: { id: "s", role: "single", turnStartedAt: null, startedAt: at, exitStatus: 1 },
    dispatchHold: retry.facts.dispatchHold,
  });
  assert.equal(crashed?.error, "「派活的那条」名下已全部停下，先到那一条里接着跑再重试", "重跑上一回合被拒，提示指到那条任务");
  assert.deepEqual(crashed?.detail, { heldBy: "H", heldByTitle: "派活的那条" });

  // ── 分组暂停叠上来：两样都没按住才跑 ──────────────────────────────────────────────
  await pauseGroup("G2");

  // ── 接着跑（派活的那条已经归档也照样能按）──────────────────────────────────────────
  await db.update(tasks).set({ archived: true }).where(eq(tasks.id, "H"));
  const released = await post("/tasks/H/dispatched/release");
  assert.equal(released.status, 200);
  assert.equal((await released.json() as { dispatchHoldAt: string | null }).dispatchHoldAt, null);
  for (const id of ["A", "C", "D", "N", "N2"]) await until(`${id} 接着跑`, () => turnsOf(id).length >= (id.startsWith("N") ? 1 : 2));
  assert.equal(turnsOf("A")[1]!.resume, "native-A", "A 从原会话续上");
  assert.equal(turnsOf("C")[1]!.resume, "native-C", "C 从原会话续上");
  assert.equal(turnsOf("D")[1]!.resume, "native-D", "名下再派出的 D 从原会话续上");
  assert.equal(turnsOf("B").length, 0, "队列按原顺序：A 还在跑，B 不起");
  await sleep(300);
  assert.equal(await statusOf("E"), "paused", "停之前就在等答复的 E 原样");
  assert.equal((await row("E")).question, "要哪一种？");
  assert.equal(await statusOf("F"), "canceled", "停之前就取消了的 F 原样");
  assert.equal(turnsOf("P").length, 1, "P 所在分组还停着：名下接着跑了它也不跑");
  for (const id of ["A", "C", "D", "N", "N2", "P"]) assert.equal((await row(id)).holdOwedBy, null, `${id} 的欠账清掉`);
  finish("A");
  await until("A 跑完后队列起 B", () => turnsOf("B").length === 1);
  assert.equal(await statusOf("A"), "done");

  // 分组恢复：P 这才从原会话续上。
  assert.equal((await post("/groups/G2/run")).status, 202);
  await until("P 随分组恢复续上", () => turnsOf("P").length === 2);
  assert.equal(turnsOf("P")[1]!.resume, "native-P");

  // ── 派活的那条被删掉：名下不再被按住，原地留着、不替用户跑起来 ───────────────────────
  assert.equal((await post("/tasks/H2/dispatched/hold")).status, 200);
  await settled("K", "paused");
  assert.equal((await row("K")).holdOwedBy, "H2");
  await deleteTaskCompletely("H2");
  assert.equal(await dispatchHoldOf("K"), null, "派活人没了，K 不再被按住");
  assert.equal((await row("K")).holdOwedBy, null, "欠账一并清掉");
  await sleep(300);
  assert.equal(await statusOf("K"), "paused", "原地留着");
  assert.equal(turnsOf("K").length, 1, "不替用户跑起来");

  console.log("dispatch hold: ok");
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
