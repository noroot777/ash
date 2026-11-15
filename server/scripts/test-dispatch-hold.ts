// 「派出的任务」格头那一对键：全部停下 / 接着跑（src/dispatch-hold.ts、判定 src/task-hold.ts）。
//
// 钉住的是这几件事：
//   · 停下后在跑的落 paused 不是 canceled，串行队列没有跳过它起下一条；
//   · 停下后重读状态（含开机补办那一趟）还是停着，被谁按住说得出来；
//   · 已占位、还没起跑的那一轮也被拦住；停着期间新派出去的（分组运行、智能体调 run_task）不起跑；
//   · 排着的消息、哨兵了结后的补推、重跑上一回合都不会把被按住的任务叫起来；
//   · 接着跑后按原顺序续、从原会话续；停之前就停着的没被叫起来；
//   · 同组里不是这条名下的任务一条没受影响；名下再派出的也停了；
//   · 分组暂停和它互不相干：两样都没按住才跑；派活的那条归档了照样能接着跑，被删了名下不再被按住；
//   · 欠账只在真起跑时销：停完马上接着跑（进程还在退出）不丢那一次，被分组拦着的账留着；
//   · 智能体的起跑过了入口检查才碰上停，起跑前最后一道闸照样拦下、记成欠账；
//   · 先落「停着」再清点名下（清点途中新起跑的那一位逃不出去）；
//   · 到点启动的入口读到旧答案时，占位之后那一次复查拦下它、不消费班次，放开后照常开新的一轮；
//     那次复查读库失败时把占位还掉，下一个 tick 照常起；放行之前按的停不记欠账（责任只在班次上），
//     整件事只跑一次；正常停下的那一笔不因为恰好有一班定时到期被吞掉，接着跑照样从原会话续；
//   · 停到一半出错：「还没停完」留着，tick 接着停完；推进途中停了又放，这次起跑交成欠账不丢；
//     一组被按住的接着跑时照样受分组并发上限管；同一位被分组运行和接着跑各排了一次名额，只起一遍；
//     名额集中还回、又来新的，同组总数也不越过上限；等名额期间进了队列的按队列顺序起、换了组的占新组的名额。
//
// 走真实的调度链路（队列推进、分组运行、路由、结算钩子），只换掉「起一个 CLI」那一步：假执行器
// 记下每一回合拿到的输入与续的是哪条原生会话，回合一直挂着，直到测试放它走或者它被停掉。
//
// 跑：npm -w server run test:dispatch-hold
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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
const { resumeOrRunTask } = await import("../src/task-resume.js");
const { holdDispatched } = await import("../src/dispatch-hold.js");
const { tick } = await import("../src/schedules.js");
const { serializeQueueClaims } = await import("../src/queue-seat.js");
const { acquireGroupSlot, groupSlotUsage, releaseGroupSlot } = await import("../src/group-slots.js");
await ensureSchema();

const api = new Hono();
mountTaskRunRoutes(api);
mountDispatchHoldRoutes(api);
mountGroupRoutes(api);

// ── 假执行器：回合挂着，测试 finish() 放它走、或者被 stopTask 杀掉 ─────────────────────────
type Turn = { prompt: string; resume: string | undefined };
const turns = new Map<string, Turn[]>();
const gates = new Map<string, () => void>();
/** 被停掉之后还要这么久才退干净（毫秒）：拿来复现「停止请求返回时进程还在退出」。 */
const killDelay = new Map<string, number>();
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
    kill() {
      const delay = killDelay.get(taskId);
      if (delay) setTimeout(release, delay);
      else release();
    },
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
  { id: "G3", projectId: "p", name: "六条的组", mode: "parallel", paused: false, createdAt: at },
  { id: "G4", projectId: "p", name: "等名额时挪走的组", mode: "parallel", paused: false, createdAt: at },
  { id: "G5", projectId: "p", name: "挪进来的组", mode: "parallel", paused: false, createdAt: at },
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
  task("H3", { status: "done", title: "停完马上接着跑" }),
  task("S1", { dispatchedBy: "H3" }),
  task("H4", { status: "done", title: "智能体晚到的起跑" }),
  task("S2", { dispatchedBy: "H4" }),
  task("H5", { status: "done", title: "先落标记再清点" }),
  task("S3", { dispatchedBy: "H5" }),
  // 到点启动：S4 离派活的 H6 隔着 30 层，入口那次判定要一层层往上读。
  task("H6", { status: "done", title: "到点启动碰上停" }),
  ...Array.from({ length: 30 }, (_, index) => task(`M${index + 1}`, { status: "done", dispatchedBy: index ? `M${index}` : "H6" })),
  task("S4", { dispatchedBy: "M30" }),
  task("H7", { status: "done", title: "到点启动读库失败" }),
  task("S5", { dispatchedBy: "H7" }),
  task("H8", { status: "done", title: "撤账写失败" }),
  task("S6", { dispatchedBy: "H8" }),
  task("H9", { status: "done", title: "停下的同时有定时到期" }),
  task("R1", { dispatchedBy: "H9" }),
  task("R2", { dispatchedBy: "H9" }),
  task("HA", { status: "done", title: "停到一半出错" }),
  task("P1", { dispatchedBy: "HA" }),
  task("HB", { status: "done", title: "推进途中停了又放" }),
  task("B2", { dispatchedBy: "HB" }),
  task("HG", { status: "done", title: "一组六条" }),
  ...["G1", "G2x", "G3", "G4", "G5", "G6"].map((id) => task(id, { groupId: "G3", dispatchedBy: "HG" })),
  task("HM", { status: "done", title: "等名额时被挪走" }),
  ...["M61", "M62", "M63", "M64", "M65", "M66"].map((id) => task(id, { groupId: "G4", dispatchedBy: "HM" })),
]);
await db.insert(schema.queueItems).values([
  { taskId: "A", queueId: "Q", position: 0, createdAt: at },
  { taskId: "B", queueId: "Q", position: 1, createdAt: at },
  { taskId: "B2", queueId: "Q2", position: 0, createdAt: at },
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
  for (const id of ["A", "C", "D", "N", "N2"]) assert.equal((await row(id)).holdOwedBy, null, `${id} 真起跑了，欠账销掉`);
  assert.equal((await row("P")).holdOwedBy, "H", "P 被分组拦着没起跑：账还挂着");
  finish("A");
  await until("A 跑完后队列起 B", () => turnsOf("B").length === 1);
  assert.equal(await statusOf("A"), "done");

  // 分组恢复：P 这才从原会话续上。
  assert.equal((await post("/groups/G2/run")).status, 202);
  await until("P 随分组恢复续上", () => turnsOf("P").length === 2);
  assert.equal(turnsOf("P")[1]!.resume, "native-P");
  await until("P 真起跑后欠账销掉", async () => (await row("P")).holdOwedBy === null);

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

  // ── 停完马上接着跑：停止请求返回时进程还在退出，账不能在这一刻丢 ───────────────────────
  assert.equal((await post("/tasks/S1/run")).status, 202);
  await running("S1");
  killDelay.set("S1", 400);
  assert.equal((await post("/tasks/H3/dispatched/hold")).status, 200);
  assert.equal((await post("/tasks/H3/dispatched/release")).status, 200);
  assert.equal(await statusOf("S1"), "running", "放开那一刻 S1 还没退干净");
  assert.equal((await row("S1")).holdOwedBy, "H3", "此刻接不上：账留着，不在放开时一把清掉");
  await until("S1 退干净后接着跑", () => turnsOf("S1").length === 2);
  assert.equal(turnsOf("S1")[1]!.resume, "native-S1", "从原会话续上");
  await until("S1 真起跑后欠账销掉", async () => (await row("S1")).holdOwedBy === null);
  killDelay.delete("S1");

  // ── 智能体的起跑请求过了入口检查、之后才碰上停：起跑前最后一道闸照样拦 ─────────────────
  assert.equal((await post("/tasks/H4/dispatched/hold")).status, 200);
  const agentTurn = runs.claimOwnTurn("S2");
  assert.ok(agentTurn);
  try {
    await resumeOrRunTask("S2", { origin: "agent", reason: "run", turnHeld: agentTurn });
  } finally {
    runs.releaseTurn("S2", agentTurn);
  }
  await sleep(200);
  assert.equal(turnsOf("S2").length, 0, "晚到的智能体起跑没起来");
  assert.equal(await statusOf("S2"), "paused");
  assert.equal((await row("S2")).holdOwedBy, "H4", "被拦下的这一次记成欠账");
  assert.equal((await post("/tasks/H4/dispatched/release")).status, 200);
  await until("S2 接着跑时兑现", () => turnsOf("S2").length === 1);

  // ── 先落标记再清点：清点名下的那一刻，派活那条已经是停着的 ─────────────────────────────
  const peek = new DatabaseSync(process.env.ASH_DB!, { readOnly: true });
  const select = db.select;
  const flagAtFirstRead: unknown[] = [];
  (db as { select: unknown }).select = function (this: unknown, ...args: unknown[]) {
    if (!flagAtFirstRead.length) {
      flagAtFirstRead.push((peek.prepare("SELECT dispatch_hold_at AS at FROM tasks WHERE id = 'H5'").get() as { at: unknown }).at);
    }
    return (select as (...a: unknown[]) => unknown).apply(this, args);
  };
  try {
    // 直接调：路由在调它之前会先读一次派活的那条（找不找得到），那一次不算清点。
    assert.deepEqual((await holdDispatched("H5")).tree, ["S3"]);
  } finally {
    (db as { select: unknown }).select = select;
    peek.close();
  }
  assert.equal(flagAtFirstRead.length, 1);
  assert.ok(flagAtFirstRead[0], "第一次读库（清点名下）之前，停着的标记已经落库");

  // ── 到点启动：入口读祖先读到一半时按了停，入口拿到旧答案 —— 占位之后那一次复查拦下，不消费班次 ─────
  // 入口那次判定读完 H6（真读数：此刻还没停）之后、交回入口之前，让一次「全部停下」整个做完 ——
  // 等于停落在入口判定与占位之间。读数不伪造，判据、回合锁、起跑函数都是真的。
  await db.insert(schema.schedules).values({ id: "once-S4", taskId: "S4", kind: "once", at: new Date(Date.now() - 1_000).toISOString(), createdAt: at });
  const execute = dbClient.execute.bind(dbClient);
  let armed = true;
  const entryReads: unknown[] = [];
  (dbClient as { execute: unknown }).execute = async (stmt: Parameters<typeof execute>[0]) => {
    const result = await execute(stmt);
    const text = typeof stmt === "string" ? stmt : stmt.sql;
    const args = typeof stmt === "string" ? [] : Object.values(stmt.args ?? {});
    if (text.includes('"dispatch_hold_at"') && text.includes('"dispatched_by"') && args.includes("H6")) {
      entryReads.push(result.rows[0]?.[result.columns.indexOf("dispatch_hold_at")] ?? null);
      if (armed) {
        armed = false;
        assert.deepEqual((await holdDispatched("H6")).tree.at(-1), "S4");
      }
    }
    return result;
  };
  try {
    await tick();
  } finally {
    (dbClient as { execute: unknown }).execute = execute;
  }
  assert.equal(entryReads[0], null, "复现成立：入口一路读到 H6 时还没读到停着");
  assert.ok((await row("H6")).dispatchHoldAt, "停已经落下");
  await sleep(200);
  assert.equal(turnsOf("S4").length, 0, "到点启动没有穿过「全部停下」");
  assert.equal(await statusOf("S4"), "backlog", "原样留着");
  assert.equal((await row("S4")).holdOwedBy, null, "责任留在班次上，不另记欠账");
  const shift = (await db.select().from(schema.schedules).where(eq(schema.schedules.id, "once-S4")))[0]!;
  assert.equal(shift.enabled, true, "once 班次没被消费");
  assert.equal(shift.lastRunAt, null);
  assert.equal((await post("/tasks/H6/dispatched/release")).status, 200);
  await tick();
  await until("放开后下一个 tick 照常开新的一轮", () => turnsOf("S4").length === 1);
  assert.equal(turnsOf("S4")[0]!.resume, undefined, "定时开的是新一轮，不续旧会话");
  assert.equal((await db.select().from(schema.schedules).where(eq(schema.schedules.id, "once-S4")))[0]!.enabled, false, "这才消费班次");

  // ── 到点启动占位之后那次复查读库失败一次：锁还掉、班次不消费，下一个 tick 照常起，手动也起得来 ─────
  await db.insert(schema.schedules).values({ id: "once-S5", taskId: "S5", kind: "once", at: new Date(Date.now() - 1_000).toISOString(), createdAt: at });
  let faulted = 0;
  let claimedAtFault = false;
  (dbClient as { execute: unknown }).execute = async (stmt: Parameters<typeof execute>[0]) => {
    const text = typeof stmt === "string" ? stmt : stmt.sql;
    const args = typeof stmt === "string" ? [] : Object.values(stmt.args ?? {});
    if (!faulted && text.startsWith('select "archived", "group_id"') && args.includes("S5")) {
      faulted += 1;
      claimedAtFault = runs.isTurnClaimed("S5");
      throw new Error("注入：一次临时读库失败");
    }
    return execute(stmt);
  };
  try {
    await tick();
  } finally {
    (dbClient as { execute: unknown }).execute = execute;
  }
  assert.equal(faulted, 1, "故障打在占位之后那次复查上");
  assert.ok(claimedAtFault, "出错那一刻锁确实占着");
  assert.ok(!runs.isTurnClaimed("S5"), "出错之后锁还掉了");
  assert.equal(turnsOf("S5").length, 0);
  const faultShift = (await db.select().from(schema.schedules).where(eq(schema.schedules.id, "once-S5")))[0]!;
  assert.equal(faultShift.enabled, true, "班次没被消费");
  assert.equal(faultShift.lastRunAt, null);
  await tick();
  await until("故障过去后下一个 tick 照常起", () => turnsOf("S5").length === 1);

  // ── 到点启动已占位、还没放行时按停：只撤回、不记欠账 —— 起跑的责任只在班次上，整件事只跑一次
  //    （第 4 轮审查 F1：以前记了欠账、撤账写失败后放开各起一次）───────────────────────────────
  await db.insert(schema.schedules).values({ id: "once-S6", taskId: "S6", kind: "once", at: new Date(Date.now() - 1_000).toISOString(), createdAt: at });
  let heldDuringClaim = false;
  (dbClient as { execute: unknown }).execute = async (stmt: Parameters<typeof execute>[0]) => {
    const text = typeof stmt === "string" ? stmt : stmt.sql;
    const args = typeof stmt === "string" ? [] : Object.values(stmt.args ?? {});
    // 占位之后那次复查一开口：此刻锁占着，让一次「全部停下」整个做完（它看得见这一位占着回合）。
    if (!heldDuringClaim && text.startsWith('select "archived", "group_id"') && args.includes("S6")) {
      heldDuringClaim = true;
      assert.ok(runs.isTurnClaimed("S6"));
      assert.deepEqual((await holdDispatched("H8")).tree, ["S6"]);
    }
    return execute(stmt);
  };
  try {
    await tick();
  } finally {
    (dbClient as { execute: unknown }).execute = execute;
  }
  assert.ok(heldDuringClaim, "排列成立：放行之前按的停");
  assert.equal((await row("S6")).holdOwedBy, null, "不记欠账：这一次起跑的责任在班次上");
  assert.equal((await db.select().from(schema.schedules).where(eq(schema.schedules.id, "once-S6")))[0]!.enabled, true, "班次没消费");
  assert.ok(!runs.isTurnClaimed("S6"));
  assert.equal(await statusOf("S6"), "backlog", "原样留着");
  assert.equal((await post("/tasks/H8/dispatched/release")).status, 200);
  await sleep(300);
  assert.equal(turnsOf("S6").length, 0, "接着跑没有欠账可兑现");
  await tick();
  await until("班次开新的一轮", () => turnsOf("S6").length === 1);
  assert.equal(turnsOf("S6")[0]!.resume, undefined);
  finish("S6");
  await settled("S6", "done");
  await tick();
  await sleep(300);
  assert.equal(turnsOf("S6").length, 1, "整件事只跑了一次");

  // ── 正常停下的那一笔欠账不因为恰好有一班定时到期而被吞掉：接着跑从原会话续（第 5 轮审查 F1）──
  for (const [id, shift] of [["R1", { kind: "once", at: new Date(Date.now() - 1_000).toISOString() }], ["R2", { kind: "cron", cron: "* * * * *" }]] as const) {
    assert.equal((await post(`/tasks/${id}/run`)).status, 202);
    await running(id);
    assert.equal((await post("/tasks/H9/dispatched/hold")).status, 200);
    await settled(id, "paused");
    assert.equal((await row(id)).holdOwedBy, "H9");
    await db.insert(schema.schedules).values({ id: `shift-${id}`, taskId: id, createdAt: at, ...shift });
    assert.equal((await post("/tasks/H9/dispatched/release")).status, 200);
    await until(`${id} 接着跑`, () => turnsOf(id).length === 2);
    assert.equal(turnsOf(id)[1]!.resume, `native-${id}`, `${id}（${shift.kind}）从原会话续，不被到期的班次顶成新一轮`);
    await until(`${id} 真起跑后欠账销掉`, async () => (await row(id)).holdOwedBy === null);
    await db.delete(schema.schedules).where(eq(schema.schedules.id, `shift-${id}`));
  }

  // ── 停到一半出错：「还没停完」留着，页面不说已全部停下；tick 接着停完，停完才清（第 1 轮复审 F1）──────
  assert.equal((await post("/tasks/P1/run")).status, 202);
  await running("P1");
  let oweFailed = 0;
  (dbClient as { execute: unknown }).execute = async (stmt: Parameters<typeof execute>[0]) => {
    const text = typeof stmt === "string" ? stmt : stmt.sql;
    const args = typeof stmt === "string" ? [] : Object.values(stmt.args ?? {});
    if (!oweFailed && text.startsWith('update "tasks" set "hold_owed_by"') && args[0] === "HA" && args.includes("P1")) {
      oweFailed += 1;
      throw new Error("注入：记欠账那一笔写失败");
    }
    return execute(stmt);
  };
  let failedHold: Response;
  try {
    failedHold = await post("/tasks/HA/dispatched/hold");
  } finally {
    (dbClient as { execute: unknown }).execute = execute;
  }
  assert.equal(oweFailed, 1);
  assert.notEqual(failedHold.status, 200, "这一次停没做完，如实报错");
  assert.ok((await row("HA")).dispatchHoldAt, "停着的标记已经落下（新的起跑照样被拦）");
  assert.ok((await row("HA")).dispatchHoldPendingAt, "「还没停完」留着：页面据它说正在停下、给再停一次");
  assert.ok(runs.isRunning("P1"), "P1 还在跑（就是没停完的那一条）");
  await tick();
  await settled("P1", "paused");
  assert.equal((await row("P1")).holdOwedBy, "HA", "补停之后记上欠账");
  assert.equal((await row("HA")).dispatchHoldPendingAt, null, "停完了才清");
  assert.equal((await post("/tasks/HA/dispatched/release")).status, 200);
  await until("P1 接着跑", () => turnsOf("P1").length === 2);
  assert.equal(turnsOf("P1")[1]!.resume, "native-P1");

  // ── 推进已经接受、还没挑人时停了又马上放开：这一趟作废时把起跑交成欠账，放开后照样起（第 1 轮复审 F2）──
  let unblock!: () => void;
  const blocker = serializeQueueClaims(() => new Promise<void>((resolve) => { unblock = resolve; }));
  const advancing = advanceQueue("Q2");
  await until("推进意图落库", async () => (await db.select().from(schema.queueAdvanceIntents)
    .where(eq(schema.queueAdvanceIntents.queueId, "Q2"))).length === 1);
  await holdDispatched("HB");
  assert.equal((await post("/tasks/HB/dispatched/release")).status, 200);
  unblock();
  await blocker;
  await advancing;
  await until("B2 照样起跑", () => turnsOf("B2").length === 1);

  // ── 一组六条被按住、接着跑：照样受分组的并发上限管，同时至多四条（第 1 轮复审 F3）──────────────
  const six = ["G1", "G2x", "G3", "G4", "G5", "G6"];
  assert.equal((await post("/tasks/HG/dispatched/hold")).status, 200);
  await runGroup("G3");
  for (const id of six) assert.equal((await row(id)).holdOwedBy, "HG", `${id} 记着欠一次起跑`);
  assert.equal((await post("/tasks/HG/dispatched/release")).status, 200);
  await until("先起四条", () => six.filter((id) => turnsOf(id).length === 1).length === 4);
  await sleep(400);
  assert.equal(six.filter((id) => runs.isRunning(id)).length, 4, "同时至多四条在跑");
  // 这时再运行一遍这组：没起的两条又排一次名额，排在欠账那两笔后面（第 2 轮复审 F1）。
  const early = six.filter((id) => turnsOf(id).length === 1);
  const late = six.filter((id) => !early.includes(id));
  const rerun = runGroup("G3");
  await sleep(100);
  finish(early[0]!);
  finish(early[1]!);
  await until("欠着的两条补上", () => six.every((id) => turnsOf(id).length === 1));
  assert.equal(six.filter((id) => runs.isRunning(id)).length, 4);
  finish(late[0]!);
  await settled(late[0]!, "done");
  await sleep(400);
  assert.equal(turnsOf(late[0]!).length, 1, "已经做完的那条不被分组运行的旧请求再起一遍");
  assert.equal(turnsOf(late[1]!).length, 1, "在跑的那条也不被再起");
  for (const id of [early[2]!, early[3]!, late[1]!]) finish(id);
  await rerun;

  // ── 等名额的期间被挪走：进了队列的交回队列按位置起，换了组的按新组的名额起（第 3 轮复审 F1）──────
  const sixM = ["M61", "M62", "M63", "M64", "M65", "M66"];
  assert.equal((await post("/tasks/HM/dispatched/hold")).status, 200);
  await runGroup("G4");
  assert.equal((await post("/tasks/HM/dispatched/release")).status, 200);
  await until("先起四条", () => sixM.filter((id) => turnsOf(id).length === 1).length === 4);
  const [m0, m1, m2, m3] = sixM.filter((id) => turnsOf(id).length === 1);
  const [queuedLate, movedLate] = sixM.filter((id) => turnsOf(id).length === 0);
  // 照入队接口的落库：排到正在跑的 m0 后面；另一条挪进另一个组。
  await db.insert(schema.queueItems).values([
    { taskId: m0!, queueId: "Q6", position: 0, createdAt: at },
    { taskId: queuedLate!, queueId: "Q6", position: 1, createdAt: at },
  ]);
  await db.update(tasks).set({ groupId: "G5" }).where(eq(tasks.id, movedLate!));
  finish(m1!);
  await until(`${movedLate} 按新组起跑`, () => turnsOf(movedLate!).length === 1);
  await sleep(300);
  assert.equal(turnsOf(queuedLate!).length, 0, "排在正在跑的那条后面，不抢跑");
  assert.equal(groupSlotUsage("G4").used, 3, "旧组只剩还在跑的三条占名额");
  assert.equal(groupSlotUsage("G5").used, 1, "挪过去的那条占的是新组的名额");
  finish(m0!);
  await until(`${queuedLate} 等前一条做完才起`, () => turnsOf(queuedLate!).length === 1);
  assert.ok(!runs.isRunning(m0!));
  for (const id of [m2!, m3!, movedLate!, queuedLate!]) finish(id);

  // ── 分组名额本身：集中还名额、再来新的，同组总数照样至多四个（第 2 轮复审 F2）────────────────
  let active = 0;
  let peak = 0;
  const holds: Array<() => void> = [];
  const occupy = async () => {
    const slot = await acquireGroupSlot("slot-probe");
    peak = Math.max(peak, ++active);
    await new Promise<void>((resolve) => holds.push(resolve));
    active -= 1;
    releaseGroupSlot("slot-probe", slot);
  };
  const firstFour = [0, 1, 2, 3].map(occupy);
  const waiter = occupy();
  await sleep(10);
  assert.equal(holds.length, 4);
  for (const resolve of holds.splice(0)) resolve();
  await Promise.all(firstFour);
  const nextFour = [0, 1, 2, 3].map(occupy);
  for (let i = 0; i < 6; i += 1) {
    await sleep(10);
    assert.ok(active <= 4, `同组同时 ${active} 个`);
    for (const resolve of holds.splice(0)) resolve();
  }
  await Promise.all([waiter, ...nextFour]);
  assert.equal(peak, 4, "峰值就是四个");
  assert.deepEqual(groupSlotUsage("slot-probe"), { used: 0, waiting: 0 }, "都还完了，记录也收掉");

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
