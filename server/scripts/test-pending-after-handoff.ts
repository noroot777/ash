// 「等某任务完成后发送」(mode=after)在依赖核验与跨机交接上的回归:
//   ① resolveAfterTarget:回复与接力导入共用的那道核验(自己 / 不存在 / 跨项目 / 团队调度台 / 基线)
//   ② 消费侧兜底:哪个写入口漏核了,跨项目的前置完成也放行不了这条消息
//   ③ 导出:载荷成形那一刻按消息 id 重读消息与前置、同一份视图求「等到了没」—— 源机已等到的
//      不会以空缓存交出去;打包期间前置完成、锁存、被删,早先读到的旧行也降不回「没等到」
//   ④ 导入:外来前置 id 核不过就不绑定(留出口、记一句说明);核过的按本机定基线;已等到的原样认
// 全程不投递:导入只发布托盘、不扫投递,不会拉起真 agent。
// 跑:npm -w server run test:pending-after-handoff
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const root = mkdtempSync(join(tmpdir(), "ash-pending-after-handoff-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_UPLOADS_DIR = join(root, "uploads");
process.env.HOME = join(root, "home");
process.env.USERPROFILE = join(root, "home");
mkdirSync(process.env.HOME, { recursive: true });

const { releaseTmpDb } = await import("./tmp-db.js");
const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks, scheduledMessages } = await import("../src/db/schema.js");
const { latchAfterTask, resolveAfterTarget, withAfterGates } = await import("../src/pending-after.js");
const { setTaskStatus } = await import("../src/status.js");
const { deleteTaskCompletely } = await import("../src/task-delete-routes.js");
const { enqueueMessage } = await import("../src/pending-messages.js");
const { exportHandoffMessages } = await import("../src/handoff-messages.js");
const { importHandoff } = await import("../src/handoff-import.js");
type Manifest = import("../src/handoff-types.js").HandoffManifest;
await ensureSchema();

try {
  const ts = "2026-11-04T00:00:00.000Z";
  mkdirSync(join(root, "repo-a"));
  mkdirSync(join(root, "repo-b"));
  await db.insert(projects).values([
    { id: "proj-a", name: "a", repoPath: join(root, "repo-a"), createdAt: ts },
    { id: "proj-b", name: "b", repoPath: join(root, "repo-b"), createdAt: ts },
  ] as never);
  const task = (id: string, status: string, extra: Record<string, unknown> = {}) =>
    ({ id, projectId: "proj-a", title: id, body: "", status, mode: "single", useWorktree: false, createdAt: ts, updatedAt: ts, ...extra });
  await db.insert(tasks).values([
    task("receiver", "running"),
    task("local-run", "running", { doneSeq: 2 }),
    task("local-idle-done", "done", { doneSeq: 1 }),
    task("team-lead", "idle", { mode: "team" }),
    task("foreign", "done", { projectId: "proj-b", doneSeq: 3 }),
    task("src-pre", "running"),
    task("src-pre-open", "running"),
    task("src-pre-gone", "running"),
  ] as never);

  // ── ① 共用核验 ───────────────────────────────────────────────────────────
  const resolve = (afterTaskId: string) => resolveAfterTarget({ afterTaskId, taskId: "receiver", projectId: "proj-a" });
  assert.deepEqual(await resolve("receiver"), { ok: false, status: 400, error: "不能等这个任务自己完成后再发给它" });
  assert.equal((await resolve("nope") as { status: number }).status, 404);
  assert.match((await resolve("foreign") as { error: string }).error, /同一项目/);
  assert.match((await resolve("team-lead") as { error: string }).error, /团队调度台/);
  assert.deepEqual(await resolve("local-run"), { ok: true, afterSeq: 2 }, "在跑:等下一次");
  assert.deepEqual(await resolve("local-idle-done"), { ok: true, afterSeq: 0 }, "停在 done 上:就是那一次");

  // ── ② 消费侧兜底 ─────────────────────────────────────────────────────────
  const smuggled = await enqueueMessage({ taskId: "receiver", text: "跨项目", mode: "after", afterTaskId: "foreign", afterSeq: 0 });
  const [smuggledGate] = await withAfterGates([smuggled]);
  assert.equal(smuggledGate!.afterDone, false, "别的项目的任务完成了也不放行");
  assert.match(smuggledGate!.afterWaitReason!, /不可见/);
  assert.equal((await db.select().from(scheduledMessages).where(eq(scheduledMessages.id, smuggled.id))).at(0)!.afterDoneAt, null);

  // ── ③ 导出 ───────────────────────────────────────────────────────────────
  // 前置已落 done(计数已加),完成钩子还没来得及补锁存 —— 行上的缓存是空的。
  const ready = await enqueueMessage({ taskId: "receiver", text: "已等到", mode: "after", afterTaskId: "src-pre", afterSeq: 0 });
  const open = await enqueueMessage({ taskId: "receiver", text: "没等到", mode: "after", afterTaskId: "src-pre-open", afterSeq: 0 });
  await db.update(tasks).set({ status: "done", doneSeq: 1, endedAt: "2026-11-04T10:00:00.000Z" }).where(eq(tasks.id, "src-pre"));
  const exported = await exportHandoffMessages([ready.id, open.id]);
  assert.equal(exported[0]!.afterDoneAt, "2026-11-04T10:00:00.000Z", "导出时按完成计数求出已等到,不交出空缓存");
  assert.equal(exported[1]!.afterDoneAt, null, "没等到的照旧没等到");
  assert.equal(exported[0]!.mode, "after");
  assert.deepEqual(exported.map((message) => message.text), ["已等到", "没等到"], "按传入顺序");

  // 打包期间:早先读到这条(空锁存)→ 前置完成 → 锁存落库 → 前置被删。冻结时不能信旧对象。
  const vanishing = await enqueueMessage({ taskId: "receiver", text: "打包期间等到了", mode: "after", afterTaskId: "src-pre-gone", afterSeq: 0 });
  const withdrawn = await enqueueMessage({ taskId: "receiver", text: "打包期间撤回了", mode: "queued" });
  const earlySnapshot = [vanishing, withdrawn];
  assert.equal(earlySnapshot[0]!.afterDoneAt, null);
  await setTaskStatus("src-pre-gone", "done");
  await latchAfterTask("src-pre-gone");
  await deleteTaskCompletely("src-pre-gone");
  await db.update(scheduledMessages).set({ status: "canceled" }).where(eq(scheduledMessages.id, withdrawn.id));
  const frozen = await exportHandoffMessages(earlySnapshot.map((message) => message.id));
  assert.equal(frozen.length, 1, "期间撤回的不再交出去");
  assert.ok(frozen[0]!.afterDoneAt, "前置完成后被删:导出的是库里的锁存,不是旧对象的空值");

  // ── ④ 导入 ───────────────────────────────────────────────────────────────
  const payload = (text: string, afterTaskId: string, afterDoneAt: string | null = null) => ({
    text, attachments: "[]", agent: null, model: null, reasoningEffort: null, sessionRole: null, origin: null,
    reviewRun: null, reviewRound: null, mode: "after", sendAt: ts, createdAt: ts, afterTaskId, afterDoneAt,
  });
  const fp = "a".repeat(64);
  const manifest = {
    version: 1, sourceHost: "A", sourceFingerprint: fp, originFingerprint: fp, targetProjectId: "proj-a",
    transferId: "after-transfer", autoResume: false, sourceWorkspace: null,
    task: { ...task("imported-task", "done"), agentType: "claude", model: null, reasoningEffort: null },
    sessions: [], files: [], git: null,
    messages: [
      payload("跨项目", "foreign"),
      payload("调度台", "team-lead"),
      payload("源机已等到", "gone-elsewhere", "2026-11-04T09:00:00.000Z"),
      payload("本机前置", "local-run"),
      payload("源机的前置", "only-on-source"),
      { ...frozen[0]!, text: "打包期间等到了" },
    ],
  } as unknown as Manifest;
  const result = await importHandoff(manifest);
  assert.equal(result.ok, true);
  const note = result.notes.find((line) => /没有绑定/.test(line)) ?? "";
  assert.match(note, /前置任务不在本机/, `核不过的要照实说原因:${JSON.stringify(result.notes)}`);
  assert.match(note, /同一项目/);
  assert.match(note, /团队调度台/, "同项目的调度台不能也说成「不在本机」");
  const rows = await db.select().from(scheduledMessages).where(eq(scheduledMessages.taskId, "imported-task"));
  const byText = (text: string) => rows.find((row) => row.text === text)!;
  for (const text of ["跨项目", "调度台", "源机的前置"]) {
    assert.equal(byText(text).mode, "after", `${text}:仍是等前置的消息,留在托盘等用户决定`);
    assert.equal(byText(text).afterTaskId, null, `${text}:外来 id 核不过就不绑定`);
    assert.equal(byText(text).afterSeq, null);
  }
  assert.equal(byText("本机前置").afterTaskId, "local-run");
  assert.equal(byText("本机前置").afterSeq, 2, "核过的按本机前置定基线");
  assert.equal(byText("源机已等到").afterDoneAt, "2026-11-04T09:00:00.000Z");
  const gates = await withAfterGates(rows);
  const gateOf = (text: string) => gates.find((row) => row.text === text)!;
  assert.equal(gateOf("源机已等到").afterDone, true, "源机已等到的,目标机不重新解释成没等到");
  assert.equal(gateOf("打包期间等到了").afterDone, true, "前置在源机完成后被删,接力过来仍算等到");
  assert.equal(gateOf("跨项目").afterDone, false, "跨项目的前置早已完成,也不放行");
  assert.equal(gateOf("本机前置").afterDone, false);

  console.log("test-pending-after-handoff ok");
} finally {
  await new Promise((resolve) => setTimeout(resolve, 200));
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
