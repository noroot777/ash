// 终态任务上的提问答复是续聊,不认领队列执行占位(2026-11-13 现场:队列里已完成的任务在续聊
// 回合里提了问,用户答复后落成执行型待发送消息,等整条队列跑完)。外加托盘等待原因与「引导会话」
// 可用性随排队消息接口下发。
//
// 跑的是 PATH 上的假 claude(scheduled-messages-fixture.ts),不起真实 CLI;每个保持运行的
// 回合在用例里都显式停掉,不留进程。
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
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

const [{ db, ensureSchema }, schema, pending, runs, runRoutes, { bus }, legacy, notes, transcript, scheduler, status] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/pending-messages.js"),
  import("../src/runs.js"),
  import("../src/task-run-routes.js"),
  import("../src/bus.js"),
  import("../src/legacy-answer-intent.js"),
  import("../src/question-settle-notes.js"),
  import("../src/transcript.js"),
  import("../src/scheduler.js"),
  import("../src/status.js"),
]);
const { groups, projects, queueItems, scheduledMessages, sessions, tasks } = schema;
await ensureSchema();
const api = new Hono();
runRoutes.mountTaskRunRoutes(api);

const statusTrail = new Map<string, string[]>();
const trayEvents: string[] = [];
bus.subscribe((event) => {
  if (event.type === "task.pendingMessages") trayEvents.push(event.taskId);
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
// 提问那一轮结算时落进会话的那句说明,写法与 single-run.ts 落盘一致(TURN_SENTINEL + JSON)。
const writeQuestionNote = (taskId: string, text: string, noteAt: string) => {
  const path = transcript.sessionTranscriptPath(taskId, `${taskId}-prev`);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `\n${transcript.TURN_SENTINEL}${JSON.stringify({ t: "system", agent: "claude", text, level: "notice", at: noteAt })}\n`);
};
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
  const [A, B, C, D, D2, C2] = [T("a"), T("b"), T("c"), T("d"), T("d2"), T("c2")];
  const askedD2 = "要不要也更新截图？";
  await db.insert(tasks).values([
    row(A, "done", { question: "要不要顺手把文档也改了？", endedAt: earlier }),
    row(B, "backlog", { body: KEEP }),
    row(C, "failed", { endedAt: later }),
    row(D, "done", { endedAt: earlier }),
    // 答复排下之后又续聊过一轮:endedAt 被那一轮重写到了答复之后。
    row(D2, "done", { endedAt: later, questionHistory: JSON.stringify([{ id: "fu-legacy-d2-answer", question: askedD2,
      questionOptions: null, questionItems: null, answeredAt: at, answer: "要", reply: "【答复】\n要" }]) }),
    // 执行回合里问的题,答复排下后起跑失败落 failed,恰好同一毫秒。
    row(C2, "failed", { endedAt: at }),
  ]);
  for (const id of [A, C, D, D2, C2]) await withSession(id);
  await enqueue("fu-queue-1", [A, B, C, D, D2, C2]);
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

  // ── ④ 库里已经落下的执行型答复:开机认一次身份并写回(legacy-answer-intent.ts) ─────
  // D :排下时任务已经是 done(createdAt 严格晚于 endedAt)→ 续聊。
  // D2:之后又续聊过一轮、endedAt 晚于排下时刻,但会话里那道题的结算说明是「续聊回合以提问结束」→ 续聊。
  // C :执行回合里问的(会话里最近那句是「本回合以提问暂停」),后来起跑失败落 failed → 仍执行型。
  // C2:同上但 endedAt 恰与排下同一毫秒,会话里也读不到说明 → 不确定就留着执行型。
  const dText = "旧版落下的答复(fu-legacy-d)";
  const cText = "暂停时排下的答复(fu-legacy-c)";
  writeQuestionNote(D2, notes.followUpQuestionNote(askedD2, "已完成"), earlier);
  writeQuestionNote(C, notes.followUpQuestionNote("更早一轮续聊里的题", "已完成"), new Date(Date.now() - 120_000).toISOString());
  writeQuestionNote(C, notes.pausedQuestionNote("继续第三步吗？"), earlier);
  await db.insert(scheduledMessages).values([
    legacyAnswer("fu-legacy-d", D, dText, at),
    legacyAnswer("fu-legacy-d2", D2, "截图也更新(fu-legacy-d2)", at),
    legacyAnswer("fu-legacy-c", C, cText, at),
    legacyAnswer("fu-legacy-c2", C2, "同一毫秒的答复(fu-legacy-c2)", at),
  ]);
  // ⑤ 托盘:C 被 B 挡着时,接口说的是 B,不是「等本任务这一轮」。
  const cTray = await trayOf(C);
  assert.equal(cTray[0]?.wait?.kind, "queue", "被同队挡着的那条要说是在等队列");
  assert.deepEqual(cTray[0]?.wait?.kind === "queue" ? cTray[0].wait.blockers.map((b) => [b.id, b.running]) : null, [[B, true]],
    "要点名挡路的 B,且说它在跑");
  assert.equal(cTray[0]?.steerable, false, "任务不在跑,不给「引导会话」");

  assert.equal(await legacy.restoreFollowUpAnswers(), 2, "只认回 D 与 D2");
  const executionOf = async (id: string) =>
    (await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, id))).at(0)?.execution;
  assert.equal(await executionOf("fu-legacy-d"), false, "排下时已是终态 → 续聊");
  assert.equal(await executionOf("fu-legacy-d2"), false, "endedAt 被后来的续聊重写,也按提问那一轮的记录认成续聊");
  assert.equal(await executionOf("fu-legacy-c"), true, "执行回合里问的题仍是执行型");
  assert.equal(await executionOf("fu-legacy-c2"), true, "同一毫秒不算排下时已是终态");
  assert.equal(await legacy.restoreFollowUpAnswers(), 0, "认过一次就写进行里,再跑不重复");
  assert.equal((await trayOf(D))[0]?.wait, null, "D 那条按续聊判,没有挡着它的东西");

  await pending.deliverPendingMessages(D);
  await waitFor(() => countIn(dText) > 0, "认回续聊的旧答复没有被扫描送出去");
  await waitFor(async () => (await pendingOf(D)).length === 0, "送出去之后那一行该离开托盘");
  await waitFor(() => settled(D), "D 的续聊回合没有结束");
  assert.equal((await taskOf(D)).status, "done", "D 回到已完成");
  await pending.deliverPendingMessages(C);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(countIn(cText), 0, "paused 时排下、之后落 failed 的执行型答复仍要等同队空闲");
  assert.equal((await pendingOf(C))[0]?.execution, true);
  assert.equal((await taskOf(C)).status, "failed");
  console.log("✓ 库存的执行型答复:按提问那一轮的记录认身份并写回,后来的续聊改不了它;执行回合的、拿不准的仍守队列");

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

  // ── ⑥ 等待说明的失效通知:没人在跑时暂停分组、同队成员换状态,托盘都收到重拉信号 ─────
  const [P1, P2] = [T("p1"), T("p2")];
  await db.insert(groups).values({ id: "fu-group", projectId, name: "fu-group", mode: "serial", createdAt: at });
  await db.insert(tasks).values([
    row(P1, "backlog", { groupId: "fu-group" }),
    row(P2, "paused", { groupId: "fu-group" }),
  ]);
  await enqueue("fu-queue-6", [P1, P2]);
  await db.insert(scheduledMessages).values({ ...legacyAnswer("fu-p2", P2, "等前项(fu-p2)", at), answerId: null });
  assert.equal((await trayOf(P2))[0]?.wait?.kind, "queue", "暂停前在等排在前面的 P1");
  trayEvents.length = 0;
  await scheduler.pauseGroup("fu-group");
  await waitFor(() => trayEvents.includes(P2), "分组暂停(没有成员在跑)没有通知托盘重拉");
  assert.equal((await trayOf(P2))[0]?.wait?.kind, "groupPaused", "重拉拿到的是「分组已暂停」");
  trayEvents.length = 0;
  await status.setTaskStatus(P1, "failed");
  await waitFor(() => trayEvents.includes(P2), "同队成员换状态没有通知托盘重拉");
  console.log("✓ 等待说明失效通知:分组暂停、同队成员换状态都让托盘重拉");

  // 收尾 ①③④⑤⑥:撤掉还排着的那几条,停掉两个保持运行的回合。
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
