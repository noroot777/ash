// 崩溃恢复回归（审查第 4 轮 P1）：目录附注在 invoke 返回后立即落到 chat_messages.notice
// 持久列；旧进程在 task.created 时点被 SIGKILL（模拟真实崩溃/重启，闭包彻底消失），新进程
// 的 recover() 必须把附注拼回「服务重启」文案，任务回链保留。两个真实 Node 进程共享同一个
// SQLite 数据库——单进程测试盖不住这条：reply() 闭包里的 notice 在同进程内总能补写。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IS_WINDOWS } from "../src/platform.js";

const script = fileURLToPath(import.meta.url);
const marker = "MUST-SURVIVE-REAL-RECOVERY";
const member = { id: "codex", name: "codex", agentType: "codex" as const, executorId: null, model: null, reasoningEffort: null };

if (process.argv[2] === "seed") {
  // 子进程：种下带附注的委派回合，在任务创建事件上自杀（SIGKILL 不给任何清理机会）。
  const stage = process.env.CHAT_RECOVERY_STAGE!;
  process.env.ASH_DB = join(stage, "test.db");
  process.env.ASH_RUNS_DIR = join(stage, "runs");
  const { db } = await import("../src/db/index.js");
  const { ensureSchema } = await import("../src/db/index.js");
  const { projects, chatRooms, chatMessages: seedMessages } = await import("../src/db/schema.js");
  const { setInstanceMode } = await import("../src/auth/mode.js");
  const { bus } = await import("../src/bus.js");
  const { ChatService } = await import("../src/chat/service.js");
  await ensureSchema();
  await setInstanceMode("single", stage);
  await db.insert(projects).values({ id: "project", name: "崩溃恢复", repoPath: join(stage, "project"), createdAt: new Date().toISOString() });
  const room = { id: "room", projectId: "project", name: "崩溃恢复", members: JSON.stringify([member]), ownerUserId: null, createdAt: new Date().toISOString() };
  await db.insert(chatRooms).values(room);
  const service = new ChatService(async () => ({
    text: '{"reply":"已整理为任务。","task":{"title":"崩溃窗口","body":"验证恢复后附注仍在。"}}',
    notice: `⚠️ 崩溃恢复附注（${marker}）`,
  }), async () => {});
  bus.subscribe((event) => { if (event.type === "task.created") process.kill(process.pid, "SIGKILL"); });
  await service.send(room, "@codex 建个任务", "crash-message", "tester");
  // send 不等回复结算，真正的死亡点在 reply 的 createTasks 里。若回复走到终态还没死，
  // 说明 task.created 上的自杀没触发——打标记再挂住，让父进程跨平台识别假死
  // （spawnSync 超时在 Windows 上同样回 status=1，光看退出码分不出「硬杀」和「超时」）。
  const { setTimeout: sleep } = await import("node:timers/promises");
  for (let tries = 0; tries < 500; tries++) {
    const row = (await db.select().from(seedMessages)).find((message) => message.role === "agent");
    if (row && !["queued", "running"].includes(row.status ?? "")) break;
    await sleep(10);
  }
  console.error("SEED-DID-NOT-DIE");
  await new Promise(() => {});
}

const stage = mkdtempSync(join(tmpdir(), "ash-chat-recovery-"));
process.env.ASH_DB = join(stage, "test.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
process.env.CHAT_RECOVERY_STAGE = stage;
mkdirSync(join(stage, "project"), { recursive: true });
const seed = spawnSync(process.execPath, ["--import", "tsx/esm", script, "seed"], { env: process.env, timeout: 60000, encoding: "utf8" });
// 「确实被硬杀」的证据两个平台不一样（同型断言见 test-scheduled-messages.ts，曾在
// Windows 真机固定失败）：POSIX 下父进程拿到 signal='SIGKILL'；Windows 没有信号，
// process.kill 落到 TerminateProcess，回来的是 status=1 / signal=null。
assert.ok(!seed.error, `seed 子进程没起来：${seed.error?.message ?? ""}`);
assert.ok(!(seed.stderr ?? "").includes("SEED-DID-NOT-DIE"), `task.created 时点的自杀未触发，seed 走到了回复终态：\n${seed.stderr}`);
if (IS_WINDOWS) {
  assert.equal(seed.status, 1, `seed 进程应死于 task.created 时点的硬杀：status=${seed.status}\nstderr: ${seed.stderr}`);
} else {
  assert.equal(seed.signal, "SIGKILL", `seed 进程应死于 task.created 时点的自 SIGKILL：status=${seed.status} signal=${seed.signal}\nstderr: ${seed.stderr}`);
}

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
