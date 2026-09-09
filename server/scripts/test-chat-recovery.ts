// 崩溃恢复回归，两个场景都用两个真实 Node 进程共享同一个 SQLite——单进程测试盖不住：
// reply() 闭包里的 notice 在同进程内总能靠 preserveNotice 补写。
// ① 审查第 4 轮 P1：running 消息在 task.created 时点被 SIGKILL，新进程 recover() 必须把
//    附注拼回「服务重启」文案，任务回链保留。
// ② 新审查第 1 轮 P1：stop() 先落了不带附注的停止正文，notice UPDATE 提交后进程立即崩溃
//    （preserveNotice 没来得及跑）。recover() 不碰 stopped 行，可见性只能靠那条 UPDATE 本身
//    原子补正文——断言停止正文里附注恰好出现一次。
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IS_WINDOWS } from "../src/platform.js";

const script = fileURLToPath(import.meta.url);
const marker = "MUST-SURVIVE-REAL-RECOVERY";
const stopMarker = "STOP-BEFORE-NOTICE-CRASH";
const member = { id: "codex", name: "codex", agentType: "codex" as const, executorId: null, model: null, reasoningEffort: null };

async function seedEnvironment(stage: string) {
  process.env.ASH_DB = join(stage, "test.db");
  process.env.ASH_RUNS_DIR = join(stage, "runs");
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, chatRooms, chatMessages } = await import("../src/db/schema.js");
  const { setInstanceMode } = await import("../src/auth/mode.js");
  const { ChatService } = await import("../src/chat/service.js");
  await ensureSchema();
  await setInstanceMode("single", stage);
  await db.insert(projects).values({ id: "project", name: "崩溃恢复", repoPath: join(stage, "project"), createdAt: new Date().toISOString() });
  const room = { id: "room", projectId: "project", name: "崩溃恢复", members: JSON.stringify([member]), ownerUserId: null, createdAt: new Date().toISOString() };
  await db.insert(chatRooms).values(room);
  return { db, chatMessages, ChatService, room };
}

// 自杀时点没触发时（回复走到了终态），打标记再挂住，让父进程跨平台识别假死
// （spawnSync 超时在 Windows 上同样回 status=1，光看退出码分不出「硬杀」和「超时」）。
async function reportSurvival(db: Awaited<ReturnType<typeof seedEnvironment>>["db"], chatMessages: Awaited<ReturnType<typeof seedEnvironment>>["chatMessages"], settled: (row: { status: string | null; body: string | null }) => boolean) {
  const { setTimeout: sleep } = await import("node:timers/promises");
  for (let tries = 0; tries < 500; tries++) {
    const row = (await db.select().from(chatMessages)).find((message) => message.role === "agent");
    if (row && settled({ status: row.status, body: row.body })) break;
    await sleep(10);
  }
  console.error("SEED-DID-NOT-DIE");
  await new Promise(() => {});
}

if (process.argv[2] === "seed") {
  // 场景 ① 子进程：种下带附注的委派回合，在任务创建事件上自杀（SIGKILL 不给任何清理机会）。
  const { db, chatMessages, ChatService, room } = await seedEnvironment(process.env.CHAT_RECOVERY_STAGE!);
  const { bus } = await import("../src/bus.js");
  const service = new ChatService(async () => ({
    text: '{"reply":"已整理为任务。","task":{"title":"崩溃窗口","body":"验证恢复后附注仍在。"}}',
    notice: `⚠️ 崩溃恢复附注（${marker}）`,
  }), async () => {});
  bus.subscribe((event) => { if (event.type === "task.created") process.kill(process.pid, "SIGKILL"); });
  await service.send(room, "@codex 建个任务", "crash-message", "tester");
  await reportSurvival(db, chatMessages, (row) => !["queued", "running"].includes(row.status ?? ""));
}

if (process.argv[2] === "seed-stop") {
  // 场景 ② 子进程：invoke 内部先 stop()（停止正文落库、notice 列还是 NULL），随后返回附注；
  // 拦下「notice 落列」那条 UPDATE，在它提交成功的同一时点 SIGKILL——preserveNotice 永远没机会跑。
  const { db, chatMessages, ChatService, room } = await seedEnvironment(process.env.CHAT_RECOVERY_STAGE!);
  const originalUpdate = db.update.bind(db);
  (db as { update: unknown }).update = (table: Parameters<typeof originalUpdate>[0]) => {
    const builder = originalUpdate(table);
    const originalSet = builder.set.bind(builder);
    (builder as { set: unknown }).set = (values: Record<string, unknown>) => {
      const afterSet = originalSet(values as Parameters<typeof originalSet>[0]);
      if (!("notice" in values)) return afterSet;
      const originalWhere = afterSet.where.bind(afterSet);
      (afterSet as { where: unknown }).where = (condition: Parameters<typeof originalWhere>[0]) => {
        const query = originalWhere(condition);
        const originalThen = query.then.bind(query);
        (query as { then: unknown }).then = (onFulfilled: unknown, onRejected: (reason: unknown) => void) =>
          originalThen(() => { process.kill(process.pid, "SIGKILL"); }, onRejected);
        return query;
      };
      return afterSet;
    };
    return builder;
  };
  const service: InstanceType<typeof ChatService> = new ChatService(async () => {
    await service.stop(room.id);
    return { text: '{"reply":"停止后才返回。"}', notice: `⚠️ 停止后崩溃附注（${stopMarker}）` };
  }, async () => {});
  await service.send(room, "@codex 咨询", "stop-crash-message", "tester");
  await reportSurvival(db, chatMessages, (row) => (row.body ?? "").includes(stopMarker));
}

if (process.argv[2] === "check-stop") {
  // 场景 ② 校验进程：全新进程跑真实 recover()（它只处理 queued/running，不该碰这行），
  // 停止正文必须已带附注——证明可见性来自崩溃前那条原子 UPDATE，而非任何存活闭包。
  const stage = process.env.CHAT_RECOVERY_STAGE!;
  process.env.ASH_DB = join(stage, "test.db");
  process.env.ASH_RUNS_DIR = join(stage, "runs");
  const { db, ensureSchema, dbClient } = await import("../src/db/index.js");
  const { chatMessages } = await import("../src/db/schema.js");
  const { ChatService } = await import("../src/chat/service.js");
  await ensureSchema();
  const service = new ChatService(async () => { throw new Error("恢复不应触发 invoke"); }, async () => { throw new Error("恢复不应启动任务"); });
  await service.recover();
  const row = (await db.select().from(chatMessages)).find((message) => message.role === "agent");
  assert.ok(row, "崩溃前的 agent 消息应已持久化");
  assert.equal(row!.status, "stopped");
  assert.match(row!.body, /你已停止这次回复/);
  assert.equal(row!.body.split(stopMarker).length, 2, `停止正文必须恰好带一次崩溃前已落列的附注：\n${row!.body}`);
  assert.equal(row!.notice, `⚠️ 停止后崩溃附注（${stopMarker}）`, "notice 持久列应在崩溃前已提交");
  dbClient.close();
  console.log("CHECK-STOP-OK");
  process.exit(0);
}

// 「确实被硬杀」的证据两个平台不一样（同型断言见 test-scheduled-messages.ts，曾在
// Windows 真机固定失败）：POSIX 下父进程拿到 signal='SIGKILL'；Windows 没有信号，
// process.kill 落到 TerminateProcess，回来的是 status=1 / signal=null。
function assertHardKilled(result: SpawnSyncReturns<string>, when: string) {
  assert.ok(!result.error, `seed 子进程没起来：${result.error?.message ?? ""}`);
  assert.ok(!(result.stderr ?? "").includes("SEED-DID-NOT-DIE"), `${when}的自杀未触发，seed 走到了回复终态：\n${result.stderr}`);
  if (IS_WINDOWS) {
    assert.equal(result.status, 1, `seed 进程应死于${when}的硬杀：status=${result.status}\nstderr: ${result.stderr}`);
  } else {
    assert.equal(result.signal, "SIGKILL", `seed 进程应死于${when}的自 SIGKILL：status=${result.status} signal=${result.signal}\nstderr: ${result.stderr}`);
  }
}

// —— 场景 ②：stop 终态在先、notice 落列在后的崩溃（子进程种下 + 子进程校验，互不共享连接）——
const stopStage = mkdtempSync(join(tmpdir(), "ash-chat-stop-crash-"));
mkdirSync(join(stopStage, "project"), { recursive: true });
try {
  const stopEnv = { ...process.env, CHAT_RECOVERY_STAGE: stopStage };
  assertHardKilled(spawnSync(process.execPath, ["--import", "tsx/esm", script, "seed-stop"], { env: stopEnv, timeout: 60000, encoding: "utf8" }), "notice 落列时点");
  const check = spawnSync(process.execPath, ["--import", "tsx/esm", script, "check-stop"], { env: stopEnv, timeout: 60000, encoding: "utf8" });
  assert.equal(check.status, 0, `stopped 行的附注可见性校验失败：\nstdout: ${check.stdout}\nstderr: ${check.stderr}`);
  assert.ok((check.stdout ?? "").includes("CHECK-STOP-OK"));
  console.log("chat recovery: stop 终态在先时，notice 落列的同一条 UPDATE 原子补回正文，崩溃后仍可见且不重复");
} finally {
  rmSync(stopStage, { recursive: true, force: true });
}

// —— 场景 ①：running 消息在任务创建时点崩溃，新进程 recover() 拼回附注 ——
const stage = mkdtempSync(join(tmpdir(), "ash-chat-recovery-"));
process.env.ASH_DB = join(stage, "test.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
process.env.CHAT_RECOVERY_STAGE = stage;
mkdirSync(join(stage, "project"), { recursive: true });
assertHardKilled(spawnSync(process.execPath, ["--import", "tsx/esm", script, "seed"], { env: process.env, timeout: 60000, encoding: "utf8" }), "task.created 时点");

const { db, ensureSchema, dbClient } = await import("../src/db/index.js");
const { chatMessages, tasks } = await import("../src/db/schema.js");
const { ChatService } = await import("../src/chat/service.js");
try {
  await ensureSchema();
  const service = new ChatService(async () => { throw new Error("恢复不应触发 invoke"); }, async () => { throw new Error("恢复不应启动任务"); });
  await service.recover();
  const row = (await db.select().from(chatMessages)).find((message) => message.role === "agent");
  assert.ok(row, "崩溃前的 agent 消息应已持久化");
  assert.equal(row!.status, "stopped");
  assert.match(row!.body, /服务重启，回复已中断/);
  assert.ok(row!.body.includes(marker), "重启恢复后目录附注必须还在正文里");
  assert.equal(row!.notice, `⚠️ 崩溃恢复附注（${marker}）`, "notice 持久列应在 invoke 返回后即落库");
  assert.ok(row!.taskId, "任务回链保留");
  assert.equal((await db.select().from(tasks)).length, 1, "崩溃前创建的任务应存在");
  console.log("chat recovery: 崩溃后新进程 recover() 从持久列拼回目录附注；服务重启文案、任务回链齐全");
} finally {
  dbClient.close();
  rmSync(stage, { recursive: true, force: true });
}
