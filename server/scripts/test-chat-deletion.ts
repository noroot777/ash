// 删群聊：DELETE /chats/:roomId 的不变量。
// ① 房间连同消息、上下文条目、摘要、整理状态、清空点一起消失，别的群一行不动；
// ② 正在跑的回复先被中止，不留一个还在烧执行器、回来写空房间的调用；
// ③ 群里创建过的任务不跟着删——任务有自己的删除入口，聊天记录没了不等于干过的活也该没；
// ④ 任务旁聊不走这条路（它随任务删除，单独删只会在下次打开面板时重建）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { ChatMember } from "@ash/shared/chat";

const stage = mkdtempSync(join(tmpdir(), "ash-chat-delete-"));
process.env.ASH_DB = join(stage, "test.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks, chatRooms, chatMessages, chatContextEntries, chatSummaries, chatContextStates, chatContextResets } = await import("../src/db/schema.js");
const { ChatService } = await import("../src/chat/service.js");
const { mountChatRoutes } = await import("../src/chat/routes.js");
const { setActor, SINGLE_ACTOR } = await import("../src/auth/context.js");
const { setInstanceMode } = await import("../src/auth/mode.js");
await ensureSchema();
await setInstanceMode("single", stage);
const timestamp = new Date().toISOString();
await db.insert(projects).values({ id: "project", name: "删除测试", repoPath: stage, createdAt: timestamp });
const members: ChatMember[] = [{ id: "codex", name: "codex", agentType: "codex", executorId: null, model: null, reasoningEffort: null }];

let entered!: () => void;
const started = new Promise<void>((resolve) => { entered = resolve; });
let aborted = false;
const service = new ChatService(async (_member, _owner, _prompt, signal) => {
  entered();
  try { await delay(10000, undefined, { signal }); }
  catch (error) { aborted = signal.aborted; throw error; }
  return { text: '{"reply":"迟到回答","task":null}' };
});
const app = new Hono();
app.use("*", async (context, next) => { setActor(context, SINGLE_ACTOR); await next(); });
mountChatRoutes(app, service);
const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const remove = (roomId: string) => app.request(`/chats/${roomId}`, { method: "DELETE" });
const dependent = [chatMessages, chatContextEntries, chatSummaries, chatContextStates, chatContextResets];

try {
  const created = await post("/chats", { projectId: "project", name: "自医", members });
  const room = await created.json() as { id: string };
  assert.equal(created.status, 201, JSON.stringify(room));
  const kept = await (await post("/chats", { projectId: "project", name: "留着的群", members })).json() as { id: string };

  // 每张关联表都塞一行：触发器漏掉任何一张都会在这里留下孤儿。
  await db.insert(chatMessages).values({ id: "message", roomId: room.id, role: "user", author: "本机", body: "病史背景", taskId: "task", createdAt: timestamp });
  await db.insert(chatContextEntries).values({ roomId: room.id, messageId: "frozen", content: "背景", tokens: 3 });
  await db.insert(chatSummaries).values({ roomId: room.id, throughSequence: 1, body: "摘要", tokens: 3, createdAt: timestamp });
  await db.insert(chatContextStates).values({ roomId: room.id, status: "idle", updatedAt: timestamp });
  await db.insert(chatContextResets).values({ roomId: room.id, afterSequence: 0, clearedAt: timestamp });
  await db.insert(chatMessages).values({ id: "kept-message", roomId: kept.id, role: "user", author: "本机", body: "别动我", createdAt: timestamp });
  await db.insert(tasks).values({ id: "task", projectId: "project", title: "群里派生的任务", body: "", mode: "single", createdAt: timestamp, updatedAt: timestamp });

  const roomRow = (await db.select().from(chatRooms).where(eq(chatRooms.id, room.id))).at(0)!;
  await service.send(roomRow, "@codex 这个方子有问题吗", "in-flight", "本机");
  await started;

  // 删群聊是用户操作：带任务身份的 agent 请求被 /chats/* 的人类闸挡在门外。
  const byAgent = await app.request(`/chats/${room.id}`, { method: "DELETE", headers: { "x-ash-source-task-id": "task" } });
  assert.equal(byAgent.status, 403, await byAgent.text());
  assert.equal((await db.select().from(chatRooms).where(eq(chatRooms.id, room.id))).length, 1, "agent 删不掉用户的群");

  const deleted = await remove(room.id);
  assert.equal(deleted.status, 200, await deleted.text());
  await delay(30);
  assert.equal(aborted, true, "删除时中止正在跑的回复");
  assert.equal((await db.select().from(chatRooms).where(eq(chatRooms.id, room.id))).length, 0);
  for (const table of dependent) assert.equal((await db.select().from(table).where(eq(table.roomId, room.id))).length, 0, "关联数据不留孤儿");
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, "task"))).length, 1, "群里派生的任务不跟着删");
  assert.equal((await db.select().from(chatMessages).where(eq(chatMessages.roomId, kept.id))).length, 1, "别的群不受影响");
  assert.equal((await app.request(`/chats/${room.id}`)).status, 404, "删完读不到");
  assert.equal((await remove(room.id)).status, 404, "重复删除不装作成功");
  await assert.rejects(service.send(roomRow, "迟到消息", "late", "本机"), /聊天已删除/);

  const side = { id: "side-room", projectId: "project", parentTaskId: "task", kind: "side", ownerUserId: null, name: "旁聊", members: JSON.stringify(members), createdAt: timestamp };
  await db.insert(chatRooms).values(side);
  const refused = await remove(side.id);
  const refusal = await refused.json() as { error: string };
  assert.equal(refused.status, 400, JSON.stringify(refusal));
  assert.match(refusal.error, /随任务一起删除/);
  assert.equal((await db.select().from(chatRooms).where(eq(chatRooms.id, side.id))).length, 1, "被拒绝的旁聊仍在");

  console.log("✓ 删群聊清空全部关联数据、中止在跑回复、保留派生任务与其他群，挡住任务旁聊与 agent 身份");
} finally {
  await delay(30); dbClient.close(); rmSync(stage, { recursive: true, force: true });
}
