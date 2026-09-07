import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { ChatMember, ChatSnapshot } from "@ash/shared/chat";
import { mentionedMembers } from "@ash/shared/chat";

const stage = mkdtempSync(join(tmpdir(), "ash-chat-test-"));
process.env.ASH_DB = join(stage, "test.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
const { db, ensureSchema, dbClient } = await import("../src/db/index.js");
const { projects, tasks, chatMessages, chatRooms, agents } = await import("../src/db/schema.js");
const { ChatService } = await import("../src/chat/service.js");
const { mountChatRoutes } = await import("../src/chat/routes.js");
const { setActor, SINGLE_ACTOR } = await import("../src/auth/context.js");
const { parseChatReply } = await import("../src/chat/prompt.js");
const { invokeChat } = await import("../src/chat/execution.js");
await ensureSchema();
const timestamp = new Date().toISOString();
await db.insert(projects).values({ id: "project", name: "测试项目", repoPath: stage, createdAt: timestamp });

const members: ChatMember[] = ["codex", "claude"].map((name) => ({ id: name, name, agentType: "claude", executorId: null, model: null, reasoningEffort: null }));
assert.deepEqual(mentionedMembers("@codex 请回答 @codex", members).map((member) => member.id), ["codex"]);
assert.deepEqual(mentionedMembers("mail@codex @codex-other `@claude`\n> @claude\n```\n@codex\n```", members), []);
assert.deepEqual(mentionedMembers("@codex，你好 @claude.", members).map((member) => member.id), ["codex", "claude"]);
for (const body of ["@codex 请看看", "请 @codex 看看", "请@codex 看看", "请@codex看看", "（@codex）看看"]) {
  assert.deepEqual(mentionedMembers(body, members).map((member) => member.id), ["codex"], body);
}
const extended = [...members, { ...members[0]!, id: "long", name: "codex设计" }];
assert.deepEqual(mentionedMembers("请@codex设计看看", extended).map((member) => member.id), ["long"]);
assert.deepEqual(mentionedMembers("@codex-other @codex2 邮件mail@codex", extended), []);
await assert.rejects(invokeChat({ ...members[0]!, agentType: "codex" }, null, "请执行命令", new AbortController().signal), /无工具聊天通道/);
assert.throws(() => parseChatReply('{"reply":"ok","task":{}}'));
assert.equal(parseChatReply(JSON.stringify({ reply: "好".repeat(500), task: null })).reply.length, 300);

const invoked: { member: string; prompt: string }[] = [];
const started: string[] = [];
let held = false;
let failStart = false;
const service = new ChatService(async (member, _owner, prompt, signal) => {
  invoked.push({ member: member.id, prompt });
  if (held) await new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new Error("已停止")); return; }
    signal.addEventListener("abort", () => reject(new Error("已停止")), { once: true });
    setTimeout(resolve, 800).unref();
  });
  await delay(10);
  const request = JSON.parse(prompt.split("【本次用户消息】\n").at(-1)!) as string;
  if (request.includes("格式错误")) return "not json";
  return JSON.stringify({ reply: "收到。@claude 不会被我的回复唤醒。", task: request.includes("实现功能") ? { title: "实现聊天功能", body: "实现用户明确要求的聊天功能并运行测试。" } : null });
}, async (taskId) => { started.push(taskId); if (failStart) throw new Error("fixture 启动拒绝"); });
const app = new Hono();
const testActors = new Map<string, Parameters<typeof setActor>[1]>();
app.use("*", async (context, next) => {
  setActor(context, context.req.header("x-test-agent") ? { kind: "agent", userId: null, role: "member", taskId: "source", name: "agent" } : testActors.get(context.req.header("x-test-user") ?? "") ?? SINGLE_ACTOR);
  await next();
});
mountChatRoutes(app, service);
const request = (path: string, body?: unknown, headers: Record<string, string> = {}) => app.request(path, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
const create = await request("/chats", { projectId: "project", name: "研发群", members });
assert.equal((await request("/chats", { projectId: "project", name: "不安全", members: [{ ...members[0], agentType: "codex" }] })).status, 400);
assert.equal(create.status, 201);
const room = await create.json() as { id: string };
const snapshot = async () => (await request(`/chats/${room.id}`)).json() as Promise<ChatSnapshot>;
let sequence = 0;
const send = (body: string, messageId = `message-${++sequence}`) => request(`/chats/${room.id}/messages`, { body, id: messageId });
const settled = async () => {
  for (let tries = 0; tries < 100; tries++) {
    const value = await snapshot();
    if (!value.messages.some((message) => ["queued", "running"].includes(message.status))) return value;
    await delay(20);
  }
  throw new Error("回复没有结算");
};

try {
  assert.equal((await request("/chats", { projectId: "missing", name: "群", members })).status, 404);
  assert.equal((await request("/chats", { projectId: "project", name: "群", members: [members[0], members[0]] })).status, 400);
  assert.equal((await request(`/chats/${room.id}/messages`, { body: "@codex hi", id: "agent-message" }, { "x-test-agent": "1" })).status, 403);
  assert.equal((await request(`/chats/${room.id}/messages`, { body: "@codex hi", id: "agent-message" }, { "x-ash-source-task-id": "source" })).status, 403);
  assert.equal((await request(`/chats/${room.id}/messages`, { body: "@codex hi", id: "fake-role", role: "user" })).status, 400);
  await send("没有点名的私有背景：紫色频道栏");
  assert.equal(invoked.length, 0);
  await send("@codex 你有什么建议？", "idempotent-123");
  await send("@codex 你有什么建议？", "idempotent-123");
  let value = await settled();
  assert.equal(invoked.length, 1);
  assert.equal(value.messages.length, 3);
  assert.ok(invoked[0]!.prompt.includes("紫色频道栏"));
  assert.equal(started.length, 0);
  assert.equal((await send("冲突", "idempotent-123")).status, 409);
  assert.ok(!("context" in value.messages[2]!));
  console.log("✓ 无 @ 不启动；用户点名读取群历史；智能体 @ 不转发；重复消息幂等；咨询不建任务");

  const other = await request("/chats", { projectId: "project", name: "秘密群", members });
  const otherId = (await other.json() as { id: string }).id;
  await request(`/chats/${otherId}/messages`, { id: "secret-message", body: "跨群秘密，不能读取" });
  await send("@codex @claude 请分别给建议");
  await settled();
  assert.equal(invoked.length, 3);
  assert.ok(invoked.every((entry) => !entry.prompt.includes("跨群秘密，不能读取")));
  console.log("✓ 多成员同时点名，历史按群隔离");

  await send("@codex 请实现功能");
  value = await settled();
  assert.equal(started.length, 1);
  assert.equal(value.tasks.length, 1);
  const task = value.tasks[0]!;
  assert.equal(task.id, started[0]);
  assert.equal(task.mode, "single");
  assert.equal(task.workflowMode, "free");
  assert.ok((await db.select().from(tasks).where(eq(tasks.id, task.id)))[0]!.body.includes("@codex 请实现功能"));
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, task.id));
  value = await snapshot();
  assert.equal(value.tasks[0]!.status, "done");
  assert.ok(value.messages.some((message) => message.taskId === task.id));
  console.log("✓ 委派创建真实 ash 任务，关联持久化，状态更新可读");
  failStart = true;
  await send("@codex 请实现功能，测试启动失败");
  await settled();
  await delay(30);
  const failedStart = (await snapshot()).messages.at(-1)!;
  assert.equal(failedStart.status, "failed");
  assert.ok(failedStart.body.includes("任务已创建，但启动失败"));
  assert.ok(failedStart.taskId);
  failStart = false;
  console.log("✓ 启动失败不被正常回复覆盖，保留已创建任务的回链");

  held = true;
  await send("@codex 等待一会");
  await send("@codex 排队的请求");
  await delay(50);
  const beforeStop = invoked.length;
  await request(`/chats/${room.id}/stop`, {});
  await delay(50);
  value = await settled();
  assert.equal(invoked.length, beforeStop);
  assert.equal(value.messages.filter((message) => message.status === "stopped").length, 2);
  assert.ok(value.messages.filter((message) => message.status === "stopped").every((message) => message.body.includes("停止")));
  held = false;
  await send("@codex 重新点名");
  await settled();
  assert.equal(invoked.length, beforeStop + 1);
  console.log("✓ 同成员串行；停止清理排队和运行回复；刷新保留停止状态；重新 @ 可继续");

  await send("@codex 格式错误");
  value = await settled();
  assert.equal(value.messages.at(-1)!.status, "failed");
  await db.insert(chatMessages).values({ id: "restart-pending", roomId: room.id, role: "agent", memberId: "codex", author: "codex", status: "running", createdAt: new Date().toISOString() });
  await service.recover();
  assert.equal((await db.select().from(chatMessages).where(eq(chatMessages.id, "restart-pending")))[0]!.status, "stopped");
  assert.equal((await request(`/chats/${otherId}`)).status, 200);
  const { setInstanceMode } = await import("../src/auth/mode.js");
  const { createUser } = await import("../src/auth/store.js");
  const { addProjectMember } = await import("../src/auth/visibility.js");
  await setInstanceMode("multi", join(stage, "users"));
  for (const name of ["alice", "bob"]) {
    const user = await createUser({ name, role: "member", dirName: name, gitName: name, gitEmail: `${name}@example.test`, createdBy: null });
    testActors.set(name, { kind: "user", userId: user.id, role: "member", name });
    await addProjectMember({ projectId: "project", userId: user.id, role: "member", addedBy: user.id });
  }
  await db.insert(agents).values({ id: "bob-profile", name: "Bob Private", type: "claude", extraArgs: "[]", ownerUserId: testActors.get("bob")!.userId, createdAt: timestamp });
  assert.equal((await request("/chats", { projectId: "project", name: "执行器越权", members: [{ ...members[0], executorId: "bob-profile" }] }, { "x-test-user": "alice" })).status, 400);
  const privateRoom = await request("/chats", { projectId: "project", name: "Alice 的群", members }, { "x-test-user": "alice" });
  assert.equal(privateRoom.status, 201);
  const privateId = (await privateRoom.json() as { id: string }).id;
  assert.equal((await request(`/chats/${privateId}`, undefined, { "x-test-user": "alice" })).status, 200);
  for (const suffix of ["", "/events"]) assert.equal((await request(`/chats/${privateId}${suffix}`, undefined, { "x-test-user": "bob" })).status, 404);
  assert.equal((await request(`/chats/${privateId}/messages`, { id: "intruder-msg", body: "@codex 执行" }, { "x-test-user": "bob" })).status, 404);
  assert.equal((await request(`/chats/${privateId}/stop`, {}, { "x-test-user": "bob" })).status, 404);
  const bobRooms = await (await request("/chats?projectId=project", undefined, { "x-test-user": "bob" })).json() as unknown[];
  assert.equal(bobRooms.length, 0);
  console.log("✓ 多用户群聊归属隔离；其他用户不能读取、监听、发消息、停止或借用执行器");
  await db.delete(projects).where(eq(projects.id, "project"));
  assert.equal((await request(`/chats/${room.id}`)).status, 404);
  console.log("✓ 非法输出诚实失败；重启不自动唤醒；删除项目后群聊不可访问");
  assert.equal((await db.select().from(chatRooms)).length, 3);
} finally {
  await service.stop(room.id);
  await delay(50);
  dbClient.close();
  rmSync(stage, { recursive: true, force: true });
}
console.log("chat regression passed");
