// 终态任务上的提问答复是续聊,不认领队列执行占位(2026-11-13 现场:队列里已完成的任务在续聊
// 回合里提了问,用户答复后落成执行型待发送消息,等整条队列跑完)。外加托盘等待原因与「引导会话」
// 可用性随排队消息接口下发。
//
// 跑的是 PATH 上的假 claude(scheduled-messages-fixture.ts),不起真实 CLI;每个保持运行的
// 回合在用例里都显式停掉,不留进程。
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { ScheduledMessage } from "@ash/shared";
import { releaseTmpDb } from "./tmp-db.js";
import { installFakeClaude } from "./scheduled-messages-fixture.js";

const root = mkdtempSync(join(tmpdir(), "ash-answer-follow-up-"));
const leadLog = join(root, "lead-input.jsonl");
const originalPath = process.env.PATH;
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_ALLOW_REAL_AGENT = "1";
process.env.ASH_TEST_LEAD_LOG = leadLog;
process.env.PATH = `${installFakeClaude(root)}${delimiter}${originalPath ?? ""}`;

const [{ db, ensureSchema }, schema, pending, runs, runRoutes, { bus }] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/pending-messages.js"),
  import("../src/runs.js"),
  import("../src/task-run-routes.js"),
  import("../src/bus.js"),
]);
const { projects, queueItems, scheduledMessages, sessions, tasks } = schema;
await ensureSchema();
const api = new Hono();
runRoutes.mountTaskRunRoutes(api);

const statusTrail = new Map<string, string[]>();
bus.subscribe((event) => {
  if (event.type !== "task.status") return;
  statusTrail.set(event.taskId, [...(statusTrail.get(event.taskId) ?? []), event.status]);
});

const at = new Date().toISOString();
const projectId = "answer-follow-up-project";
// 假 claude 只对 `scheduled-single-` 开头的任务保持常驻(见 fixture)。
const T = (name: string) => `scheduled-single-fu-${name}`;
const KEEP = "保持运行等待引导";

const row = (id: string, status: string, extra: Partial<typeof tasks.$inferInsert> = {}): typeof tasks.$inferInsert => ({
  id, projectId, groupId: null, parentId: null, title: `任务 ${id.slice(-2)}`, body: "答复续聊", mode: "single", status,
  labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "claude", executorId: null, autoTitle: false,
  duet: null, team: null, scheduleId: null, createdAt: at, updatedAt: at, useWorktree: false, worktreeBase: null,
  originTaskId: null, ...extra,
});
const withSession = (taskId: string) => db.insert(sessions).values({
  id: `${taskId}-prev`, taskId, role: "single", agentType: "claude", executor: "claude@test", cwd: root,
  cliSessionId: `${taskId}-cli`, startedAt: at,
});
const enqueue = (queueId: string, ids: string[]) =>
  db.insert(queueItems).values(ids.map((taskId, position) => ({ queueId, taskId, position, createdAt: at })));

const waitFor = async (predicate: () => boolean | Promise<boolean>, message: string) => {
  const deadline = Date.now() + 15_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
const countIn = (needle: string) => (existsSync(leadLog) ? readFileSync(leadLog, "utf8") : "").split(needle).length - 1;
const taskOf = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
const pendingOf = (id: string) => db.select().from(scheduledMessages)
  .where(and(eq(scheduledMessages.taskId, id), eq(scheduledMessages.status, "pending")));
// 回合退干净:状态落定、进程与回合锁都放了。
const settled = async (id: string) => {
  const s = (await taskOf(id)).status;
  return s !== "running" && s !== "queued" && !runs.isRunning(id) && !runs.isTurnClaimed(id);
};
const stopWhenLive = async (id: string) => {
  await waitFor(() => runs.isRunning(id), `${id} 的执行进程没有拉起`);
  assert.equal(runs.stopTask(id), true, `测试前提:${id} 的活进程应能被停掉`);
  await waitFor(() => settled(id), `${id} 停止后没有结算`);
};
const answer = async (id: string, text: string) => {
  const res = await api.request(`/tasks/${id}/answer`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: text }),
  });
  assert.equal(res.status, 200, `${id} 的答复应被接住`);
  return res.json() as Promise<{ resumed?: boolean; queued?: boolean; blockedBy?: string[] }>;
};
const trayOf = async (id: string) => (await (await api.request(`/tasks/${id}/scheduled-messages`)).json()) as ScheduledMessage[];
const legacyAnswer = (id: string, taskId: string, text: string, createdAt: string): typeof scheduledMessages.$inferInsert => ({
  id, taskId, text, attachments: "[]", agent: null, mode: "queued", sendAt: createdAt, status: "pending",
  createdAt, sentAt: null, deliveringSince: null, execution: true, answerId: `${id}-answer`,
});

let failure: unknown = null;
try {
  await db.insert(projects).values({ id: projectId, name: "answer-follow-up", repoPath: root, apiKeys: null, createdAt: at });
  const earlier = new Date(Date.now() - 60_000).toISOString();
  const later = new Date(Date.now() + 60_000).toISOString();

  // ── ① 同队有人在跑:答复当场开出续聊回合 ─────────────────────────────────────────
  // 队列 [A(done,续聊里提了问), B(在跑), C(failed,执行型答复在等), D(done,旧版落下的答复)]。
  const [A, B, C, D] = [T("a"), T("b"), T("c"), T("d")];
  await db.insert(tasks).values([
    row(A, "done", { question: "要不要顺手把文档也改了？", endedAt: earlier }),
    row(B, "backlog", { body: KEEP }),
    row(C, "failed", { endedAt: later }),
    row(D, "done", { endedAt: earlier }),
  ]);
  for (const id of [A, C, D]) await withSession(id);
  await enqueue("fu-queue-1", [A, B, C, D]);
  assert.equal((await api.request(`/tasks/${B}/run`, { method: "POST" })).status, 202, "B 应能启动");
  await waitFor(async () => (await taskOf(B)).status === "running" && runs.isRunning(B), "B 没有跑起来");

  const aText = "文档也一起改(fu-answer-a)";
  const aBody = await answer(A, aText);
  assert.equal(aBody.queued, undefined, "终态任务的答复不该报排队:它是续聊,不等队列");
  assert.equal(aBody.resumed, true);
  await waitFor(() => countIn(aText) > 0, "答复没有当场送进 A 的会话");
  assert.equal((await pendingOf(A)).length, 0, "答复不该落成待发送消息");
  await waitFor(() => settled(A), "A 的续聊回合没有结束");
  assert.equal((await taskOf(A)).status, "done", "续聊回合结束后 A 仍是已完成");
  assert.ok(!(statusTrail.get(A) ?? []).includes("queued"), "A 不该经过 queued(没有认领队列占位)");
  assert.equal((await taskOf(B)).status, "running", "B 不受影响");
  assert.ok(runs.isRunning(B), "B 的进程还在");
  console.log("✓ 同队有人在跑:终态任务的答复当场开续聊回合,不落待发送,结束后仍是已完成,B 不受影响");

  // ── ④ 库里已经落下的执行型答复 ──────────────────────────────────────────────────
  // D:旧版 /answer 在 D 已经是 done 之后排下的(createdAt 晚于 endedAt)→ 还原成续聊,当场送出。
  // C:paused 时排下、之后起跑失败落 failed(endedAt 晚于 createdAt)→ 仍是执行型,等 B。
  const dText = "旧版落下的答复(fu-legacy-d)";
  const cText = "暂停时排下的答复(fu-legacy-c)";
  await db.insert(scheduledMessages).values([
    legacyAnswer("fu-legacy-d", D, dText, at),
    legacyAnswer("fu-legacy-c", C, cText, at),
  ]);
  // ⑤ 托盘(扫描之前):C、D 都被 B 挡着时,接口说的是 B,不是「等本任务这一轮」。
  const cTray = await trayOf(C);
  assert.equal(cTray[0]?.wait?.kind, "queue", "被同队挡着的那条要说是在等队列");
  assert.deepEqual(cTray[0]?.wait?.kind === "queue" ? cTray[0].wait.blockers.map((b) => [b.id, b.running]) : null, [[B, true]],
    "要点名挡路的 B,且说它在跑");
  assert.equal(cTray[0]?.steerable, false, "任务不在跑,不给「引导会话」");
  assert.equal((await trayOf(D))[0]?.wait, null, "D 那条按续聊判,没有挡着它的东西");

  await pending.deliverPendingMessages(D);
  await waitFor(() => countIn(dText) > 0, "旧版落下的终态答复没有被扫描送出去");
  await waitFor(async () => (await pendingOf(D)).length === 0, "送出去之后那一行该离开托盘");
  await waitFor(() => settled(D), "D 的续聊回合没有结束");
  assert.equal((await taskOf(D)).status, "done", "D 回到已完成");
  assert.equal((await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, "fu-legacy-d"))).at(0)?.execution, false,
    "扫描把这一行的执行意图写回成续聊");
  await pending.deliverPendingMessages(C);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(countIn(cText), 0, "paused 时排下、之后落 failed 的执行型答复仍要等同队空闲");
  assert.equal((await pendingOf(C))[0]?.execution, true);
  assert.equal((await taskOf(C)).status, "failed");
  console.log("✓ 库存的执行型答复:终态之后排下的还原成续聊送出;paused 时排下、后来落 failed 的仍守队列");

  // ⑤ 托盘:等本任务这一轮的那条是另一种原因,而且能引导。
  await db.insert(scheduledMessages).values({
    id: "fu-b-own", taskId: B, text: "给 B 补一句", attachments: "[]", agent: null, mode: "queued", sendAt: at,
    status: "pending", createdAt: at, sentAt: null, deliveringSince: null,
  });
  const bTray = await trayOf(B);
  assert.equal(bTray[0]?.wait?.kind, "turn", "B 自己在跑,它的消息在等本任务这一轮");
  assert.equal(bTray[0]?.steerable, true, "B 正在执行回合,最早一条自己的消息可以引导");
  console.log("✓ 排队消息接口:同队挡着的点名挡路任务,等本任务回合的是另一种原因;不在跑的不给引导");

  // ── ③ paused 的队列成员(执行回合里提的问):答复仍暂存成执行型 ─────────────────
  const E = T("e");
  await db.insert(tasks).values(row(E, "paused", { question: "继续第二步吗？" }));
  await withSession(E);
  const F = T("f");
  await db.insert(tasks).values(row(F, "backlog", { body: KEEP }));
  await enqueue("fu-queue-3", [F, E]);
  assert.equal((await api.request(`/tasks/${F}/run`, { method: "POST" })).status, 202, "F 应能启动");
  await waitFor(async () => (await taskOf(F)).status === "running" && runs.isRunning(F), "F 没有跑起来");
  const eText = "继续第二步(fu-answer-e)";
  const eBody = await answer(E, eText);
  assert.equal(eBody.queued, true, "paused 成员的答复是执行回合,前项在跑就排队");
  assert.ok(eBody.blockedBy?.includes(F));
  assert.equal((await pendingOf(E))[0]?.execution, true, "仍落成执行型");
  assert.equal((await taskOf(E)).status, "paused");
  assert.equal(countIn(eText), 0);
  console.log("✓ paused 队列成员的答复不变:前项在跑时暂存成执行型");

  // 收尾 ①③④⑤:撤掉还排着的那几条,停掉两个保持运行的回合。
  await db.update(scheduledMessages).set({ status: "canceled" })
    .where(eq(scheduledMessages.status, "pending"));
  await stopWhenLive(B);
  await stopWhenLive(F);

  // ── ② 同队没人在跑:答复不经过 queued,回合结束 / 中途被停止都仍是 done ─────────
  const [G, H] = [T("g"), T("h")];
  await db.insert(tasks).values([
    row(G, "done", { question: "要补测试吗？", endedAt: earlier }),
    row(H, "done", { question: "要不要先跑一下？", endedAt: earlier }),
  ]);
  for (const id of [G, H]) await withSession(id);
  await enqueue("fu-queue-2", [G, H]);
  const gText = "补上测试(fu-answer-g)";
  assert.equal((await answer(G, gText)).queued, undefined);
  await waitFor(() => countIn(gText) > 0, "答复没有送进 G 的会话");
  await waitFor(() => settled(G), "G 的续聊回合没有结束");
  assert.equal((await taskOf(G)).status, "done", "回合结束后 G 仍是已完成");
  assert.ok(!(statusTrail.get(G) ?? []).includes("queued"), "G 不该经过 queued");
  const hText = `先跑一下(fu-answer-h),${KEEP}`;
  assert.equal((await answer(H, hText)).queued, undefined);
  await waitFor(() => countIn(hText) > 0, "答复没有送进 H 的会话");
  assert.equal((await taskOf(H)).followUpFrom, "done", "这一轮是续聊,护着原终态");
  await stopWhenLive(H);
  assert.equal((await taskOf(H)).status, "done", "续聊回合中途被停止,H 仍是已完成");
  assert.ok(!(statusTrail.get(H) ?? []).includes("queued"), "H 不该经过 queued");
  console.log("✓ 同队没人在跑:答复不经过 queued,回合结束与中途停止后都仍是已完成");
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
