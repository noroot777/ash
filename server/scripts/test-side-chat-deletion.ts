import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { ChatMember } from "@ash/shared/chat";

const stage = mkdtempSync(join(tmpdir(), "ash-side-delete-"));
process.env.ASH_DB = join(stage, "test.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks, chatRooms, chatMessages, chatContextEntries, chatSummaries, chatContextStates, chatContextResets, scheduledMessages } = await import("../src/db/schema.js");
const { ChatService } = await import("../src/chat/service.js");
const { ChatContextManager } = await import("../src/chat/context.js");
const { setContextState } = await import("../src/chat/context-store.js");
const { deleteTaskSideChats } = await import("../src/chat/lifecycle.js");
const { mountTaskRoutes } = await import("../src/task-routes.js");
const { setInstanceMode } = await import("../src/auth/mode.js");
await ensureSchema();
await setInstanceMode("single", stage);
const timestamp = new Date().toISOString();
const member: ChatMember = { id: "member", name: "侧聊助手", agentType: "codex", executorId: null, model: null, reasoningEffort: null };
await db.insert(projects).values({ id: "p", name: "delete", repoPath: stage, createdAt: timestamp });
const seed = async (id: string) => {
  await db.insert(tasks).values({ id, projectId: "p", title: id, body: "", mode: "single", createdAt: timestamp, updatedAt: timestamp });
  const room = { id: `side-${id}`, projectId: "p", parentTaskId: id, kind: "side", ownerUserId: null, name: "侧聊", members: JSON.stringify([member]), createdAt: timestamp };
  await db.insert(chatRooms).values(room);
  await db.insert(chatMessages).values({ id: `message-${id}`, roomId: room.id, role: "user", author: "user", body: "已讨论背景", createdAt: timestamp });
  return room;
};
const dependentTables = [chatMessages, chatContextEntries, chatSummaries, chatContextStates, chatContextResets];
const emptyRoom = async (roomId: string) => {
  assert.equal((await db.select().from(chatRooms).where(eq(chatRooms.id, roomId))).length, 0);
  for (const table of dependentTables) assert.equal((await db.select().from(table).where(eq(table.roomId, roomId))).length, 0);
};
try {
  const room = await seed("parent");
  const other = await seed("other");
  await db.insert(chatContextEntries).values({ roomId: room.id, messageId: "frozen", content: "背景", tokens: 3 });
  await db.insert(chatSummaries).values({ roomId: room.id, throughSequence: 1, body: "摘要", tokens: 3, createdAt: timestamp });
  await db.insert(chatContextStates).values({ roomId: room.id, status: "idle", updatedAt: timestamp });
  await db.insert(chatContextResets).values({ roomId: room.id, afterSequence: 0, clearedAt: timestamp });
  await db.insert(scheduledMessages).values({ id: "pending", taskId: "parent", text: "待投递", mode: "queued", sendAt: timestamp, createdAt: timestamp });
  const app = new Hono(); mountTaskRoutes(app);
  const deleted = await app.request("/tasks/parent", { method: "DELETE" });
  assert.equal(deleted.status, 200, await deleted.text());
  await emptyRoom(room.id);
  assert.equal((await db.select().from(scheduledMessages)).length, 0);
  assert.equal((await db.select().from(chatMessages).where(eq(chatMessages.roomId, other.id))).length, 1);

  const runningRoom = await seed("running-side");
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  let aborted = false;
  const service = new ChatService(async (_member, _owner, _prompt, signal) => {
    started();
    try { await delay(10000, undefined, { signal }); }
    catch (error) { aborted = signal.aborted; throw error; }
    return { text: '{"reply":"迟到回答","forward":null}' };
  });
  await service.send(runningRoom, "解释方案", "running-question", "user");
  await entered;
  await deleteTaskSideChats("running-side", service);
  await db.delete(tasks).where(eq(tasks.id, "running-side"));
  await delay(30);
  assert.equal(aborted, true, "删除时中止侧聊执行器");
  await emptyRoom(runningRoom.id);
  await assert.rejects(service.send(runningRoom, "迟到请求", "late-question", "user"), /主任务不存在|聊天已删除/);

  const summaryRoom = await seed("summary-race");
  const policy = { inputTokens: 3000, batchTokens: 1500, recentTokens: 100, summaryTokens: 300, backgroundTokens: 500 };
  for (let i = 0; i < 5; i++) await db.insert(chatContextEntries).values({ roomId: summaryRoom.id, messageId: `entry-${i}`, content: "背景".repeat(300), tokens: 900 });
  let summaryStarted!: () => void;
  const summaryEntered = new Promise<void>((resolve) => { summaryStarted = resolve; });
  let finishSummary!: (value: { text: string }) => void;
  const manager = new ChatContextManager(async () => {
    summaryStarted();
    return new Promise((resolve) => { finishSummary = resolve; });
  }, policy);
  const job = manager.prepare(summaryRoom, member, 1000000, "总结", new AbortController().signal, [], () => "短提示");
  const rejected = assert.rejects(job, /聊天已删除/);
  await summaryEntered;
  await db.delete(tasks).where(eq(tasks.id, "summary-race"));
  finishSummary({ text: '{"summary":"保存的结论"}' });
  await rejected;
  await setContextState(summaryRoom.id, "failed", "迟到的后台状态");
  await emptyRoom(summaryRoom.id);

  const createRace = await seed("create-race");
  await deleteTaskSideChats("create-race");
  await db.insert(chatRooms).values({ ...createRace, id: "new-during-delete" });
  await db.insert(chatMessages).values({ id: "race-message", roomId: "new-during-delete", role: "user", author: "user", createdAt: timestamp });
  await db.insert(scheduledMessages).values({ id: "race-forward", taskId: "create-race", text: "清理期间的回传", mode: "queued", sendAt: timestamp, createdAt: timestamp });
  await db.delete(tasks).where(eq(tasks.id, "create-race"));
  await emptyRoom("new-during-delete");
  assert.equal((await db.select().from(scheduledMessages)).length, 0, "删除清理期间新增的回传也不留孤儿");
  console.log("✓ 删除主任务清理全部侧聊数据、停止执行器、隔离其他任务，并阻止迟到摘要/状态/新房间留下孤儿");
} finally {
  await delay(30); dbClient.close(); rmSync(stage, { recursive: true, force: true });
}
