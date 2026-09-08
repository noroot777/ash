import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { AGENT_TYPES } from "@ash/shared";
import type { ChatMember, ChatSnapshot } from "@ash/shared/chat";
import { isAllMention, mentionedMembers } from "@ash/shared/chat";

const stage = mkdtempSync(join(tmpdir(), "ash-chat-test-"));
process.env.ASH_DB = join(stage, "test.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
const { db, ensureSchema, dbClient } = await import("../src/db/index.js");
const { projects, tasks, chatMessages, chatRooms, agents } = await import("../src/db/schema.js");
const { ChatService } = await import("../src/chat/service.js");
const { mountChatRoutes } = await import("../src/chat/routes.js");
const { setActor, SINGLE_ACTOR } = await import("../src/auth/context.js");
const { parseChatReply } = await import("../src/chat/prompt.js");
await ensureSchema();
const timestamp = new Date().toISOString();
await db.insert(projects).values({ id: "project", name: "测试项目", repoPath: stage, createdAt: timestamp });

const members: ChatMember[] = ["codex", "claude"].map((name) => ({ id: name, name, agentType: name as ChatMember["agentType"], executorId: null, model: null, reasoningEffort: null }));
assert.deepEqual(mentionedMembers("@codex 请回答 @codex", members).map((member) => member.id), ["codex"]);
assert.deepEqual(mentionedMembers("mail@codex @codex-other `@claude`\n> @claude\n```\n@codex\n```", members), []);
assert.deepEqual(mentionedMembers("@codex，你好 @claude.", members).map((member) => member.id), ["codex", "claude"]);
for (const body of ["@codex 请看看", "请 @codex 看看", "请@codex 看看", "请@codex看看", "（@codex）看看"]) {
  assert.deepEqual(mentionedMembers(body, members).map((member) => member.id), ["codex"], body);
}
const extended = [...members, { ...members[0]!, id: "long", name: "codex设计" }];
assert.deepEqual(mentionedMembers("请@codex设计看看", extended).map((member) => member.id), ["long"]);
assert.deepEqual(mentionedMembers("@codex-other @codex2 邮件mail@codex", extended), []);
for (const body of ["@all 都来看看", "@All 都来看看", "@ALL", "请 @所有人 看看", "（@all）", "@all，请给建议"]) {
  assert.deepEqual(mentionedMembers(body, members).map((member) => member.id), ["codex", "claude"], body);
}
for (const body of ["@allen 看看", "mail@all", "`@all`", "> @all"]) {
  assert.deepEqual(mentionedMembers(body, members).map((member) => member.id), [], body);
}
// 汉字不算词边界（同一条规则让「@codex设计」这类中文成员名可用），所以「@所有人员」照样按全体处理。
assert.deepEqual(mentionedMembers("@所有人员请注意", members).map((member) => member.id), ["codex", "claude"]);
assert.deepEqual(mentionedMembers("@all 但是这个群只有一个人", [members[0]!]).map((member) => member.id), ["codex"]);
// 别名和成员名同长时成员优先：老群里真有人叫 all，@all 仍然只叫他。
assert.deepEqual(mentionedMembers("@all 看看", [...members, { ...members[0]!, id: "literal", name: "all" }]).map((member) => member.id), ["literal"]);
assert.deepEqual(mentionedMembers("@al 看看", [...members, { ...members[0]!, id: "short", name: "al" }]).map((member) => member.id), ["short"]);
assert.deepEqual(mentionedMembers("@all 看看", [...members, { ...members[0]!, id: "short", name: "al" }]).map((member) => member.id), ["codex", "claude", "short"]);
assert.equal(isAllMention("All"), true);
assert.equal(isAllMention("所有人"), true);
assert.equal(isAllMention("codex"), false);
assert.throws(() => parseChatReply('{"reply":"ok","task":{}}'));
assert.throws(() => parseChatReply('{"reply":"ok","task":null} unexpected tail'));
assert.deepEqual(parseChatReply('我先查看项目文件。{"reply":"建议简化导航","task":null}'), { reply: "建议简化导航", task: null });
assert.equal(parseChatReply('读取完成。```json\n{"reply":"已整理目标","task":{"title":"改登录页","body":"实现指定布局"}}\n```').task?.title, "改登录页");
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
const patch = (roomId: string, body: unknown) => app.request(`/chats/${roomId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const create = await request("/chats", { projectId: "project", name: "研发群", members });
assert.equal((await request("/chats", { projectId: "project", name: "无效类型", members: [{ ...members[0], agentType: "not-an-agent" }] })).status, 400);
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

  const beforeAllMention = invoked.length;
  await send("@all 请所有人给一句建议");
  await settled();
  assert.equal(invoked.length - beforeAllMention, 2);
  assert.equal((await request("/chats", { projectId: "project", name: "保留名", members: [{ ...members[0], name: "all" }] })).status, 400);
  assert.equal((await request("/chats", { projectId: "project", name: "保留名", members: [{ ...members[0], name: "所有人" }] })).status, 400);
  console.log("✓ @all 唤醒全部成员；all / 所有人 被保留为全体点名，不能当成员名");

  await send("@codex 请实现功能");
  value = await settled();
  assert.equal(started.length, 1);
  assert.equal(value.tasks.length, 1);
  const task = value.tasks[0]!;
  assert.equal(task.id, started[0]);
  assert.equal(task.mode, "single");
  assert.equal(task.workflowMode, "free");
  assert.equal(task.agentType, "codex");
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
  // 改名不碰在跑的回复，所以忙时允许（设置面板会连成员原样一起提交）；真换人才 409。
  assert.equal((await patch(room.id, { name: "研发群 · 忙时改名", members })).status, 200);
  assert.equal((await patch(room.id, { members: [members[0]] })).status, 409);
  assert.equal((await snapshot()).room.name, "研发群 · 忙时改名");
  assert.equal((await snapshot()).room.members.length, 2);
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
  const allMembers = AGENT_TYPES.map((agentType) => ({ ...members[0]!, id: agentType, name: agentType, agentType }));
  const allRoomResponse = await request("/chats", { projectId: "project", name: "所有智能体", members: allMembers });
  assert.equal(allRoomResponse.status, 201);
  const allRoom = await allRoomResponse.json() as { id: string; members: ChatMember[] };
  assert.deepEqual(allRoom.members.map((member) => member.agentType), [...AGENT_TYPES]);
  const patched = await patch(allRoom.id, { members: allMembers });
  assert.equal(patched.status, 200);
  assert.equal((await patch(allRoom.id, { name: "  全员群  " })).status, 200);
  assert.equal((await (await request(`/chats/${allRoom.id}`)).json() as ChatSnapshot).room.name, "全员群");
  assert.deepEqual(((await (await request("/chats?projectId=project")).json() as { id: string; name: string }[]).find((entry) => entry.id === allRoom.id))?.name, "全员群");
  assert.equal((await patch(allRoom.id, { name: "   " })).status, 400);
  assert.equal((await patch(allRoom.id, { name: "长".repeat(81) })).status, 400);
  assert.equal((await patch(allRoom.id, {})).status, 400);
  assert.equal((await patch(allRoom.id, { members: [{ ...allMembers[0], name: "所有人" }] })).status, 400);
  assert.equal((await (await request(`/chats/${allRoom.id}`)).json() as ChatSnapshot).room.members.length, AGENT_TYPES.length);
  console.log("✓ 群聊可改名（保存前去空白）、改名与换成员各自校验，失败不写坏成员");

  // 执行器 profile 被删之后，设置面板仍会把陈旧成员连同新名字一起提交；存量成员不该因此挡住改名。
  await db.insert(agents).values({ id: "stale-profile", name: "会被删掉的执行器", type: "codex", extraArgs: "[]", createdAt: timestamp });
  const staleMembers = [{ ...members[0]!, executorId: "stale-profile" }, members[1]!];
  const staleRoomResponse = await request("/chats", { projectId: "project", name: "执行器会被删的群", members: staleMembers });
  assert.equal(staleRoomResponse.status, 201);
  const staleRoom = await staleRoomResponse.json() as { id: string };
  await db.delete(agents).where(eq(agents.id, "stale-profile"));
  assert.equal((await request("/chats", { projectId: "project", name: "新群不放行已删执行器", members: staleMembers })).status, 400);
  const renamedStale = await patch(staleRoom.id, { name: "改完名的群", members: staleMembers });
  assert.equal(renamedStale.status, 200, await renamedStale.clone().text());
  const staleSnapshot = await (await request(`/chats/${staleRoom.id}`)).json() as ChatSnapshot;
  assert.equal(staleSnapshot.room.name, "改完名的群");
  assert.equal(staleSnapshot.room.members[0]!.executorId, "stale-profile");
  assert.equal((await patch(staleRoom.id, { members: [{ ...staleMembers[0], executorId: "never-existed" }, members[1]] })).status, 400);
  assert.equal((await patch(staleRoom.id, { members: [...staleMembers, { ...members[0], id: "another-member", name: "借用已删执行器", executorId: "stale-profile" }] })).status, 400);
  console.log("✓ 执行器被删后仍能只改群名：存量成员原样回传放行，新填/挪用同一个已删执行器仍被拒");
  const beforeAll = invoked.length;
  await request(`/chats/${allRoom.id}/messages`, { id: "all-agents-message", body: allMembers.map((member) => `@${member.name}`).join(" ") + " 请给建议" });
  let allSnapshot: ChatSnapshot | undefined;
  for (let tries = 0; tries < 100; tries++) {
    allSnapshot = await (await request(`/chats/${allRoom.id}`)).json() as ChatSnapshot;
    if (allSnapshot.messages.every((message) => message.status === "done")) break;
    await delay(20);
  }
  assert.equal(invoked.length - beforeAll, AGENT_TYPES.length);
  assert.equal(allSnapshot!.messages.filter((message) => message.role === "agent" && message.status === "done").length, AGENT_TYPES.length);
  console.log("✓ 所有注册类型均可创建/更新成员、被用户点名后回复；任务保留真实智能体类型");
  const { setInstanceMode } = await import("../src/auth/mode.js");
  const { createUser } = await import("../src/auth/store.js");
  const { addProjectMember } = await import("../src/auth/visibility.js");
  await setInstanceMode("multi", join(stage, "users"));
  for (const name of ["alice", "bob"]) {
    const user = await createUser({ name, role: "member", dirName: name, gitName: name, gitEmail: `${name}@example.test`, createdBy: null });
    testActors.set(name, { kind: "user", userId: user.id, role: "member", name });
    await addProjectMember({ projectId: "project", userId: user.id, role: "member", addedBy: user.id });
  }
  await db.insert(agents).values({ id: "bob-profile", name: "Bob Private", type: "codex", extraArgs: "[]", ownerUserId: testActors.get("bob")!.userId, createdAt: timestamp });
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
  assert.equal((await db.select().from(chatRooms)).length, 5);
} finally {
  await service.stop(room.id);
  await delay(50);
  dbClient.close();
  rmSync(stage, { recursive: true, force: true });
}
console.log("chat regression passed");
