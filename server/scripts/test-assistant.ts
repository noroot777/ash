import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { ChatMember, ChatRoom, ChatSnapshot } from "@ash/shared/chat";
import { builtinWorkflowDef } from "@ash/shared/workflow-presets";

const stage = mkdtempSync(join(tmpdir(), "ash-assistant-test-"));
process.env.ASH_DB = join(stage, "test.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { agents, projects, tasks, workflows, chatMessages, chatRooms } = await import("../src/db/schema.js");
const { mountChatRoutes } = await import("../src/chat/routes.js");
const { ChatService } = await import("../src/chat/service.js");
const { setActor, SINGLE_ACTOR } = await import("../src/auth/context.js");
const { validateAssistantWorkflow, assistantActor, invokeAssistant } = await import("../src/chat/assistant.js");
const { AssistantToolError } = await import("../src/chat/execution.js");
const { setInstanceMode } = await import("../src/auth/mode.js");
await ensureSchema();
await ensureSchema();
const timestamp = new Date().toISOString();
await db.insert(projects).values([
  { id: "local", name: "本项目", repoPath: stage, createdAt: timestamp },
  { id: "other", name: "历史项目", repoPath: stage, createdAt: timestamp },
]);
await db.insert(agents).values({ id: "profile", name: "测试助手", type: "codex", createdAt: timestamp });
await db.insert(tasks).values([
  { id: "old-auth-task", projectId: "other", title: "登录认证重构", body: "旧版认证流程升级", status: "done", archived: true, createdAt: timestamp, updatedAt: timestamp },
  { id: "local-task", projectId: "local", title: "本地上传", body: "上传文件", createdAt: timestamp, updatedAt: timestamp },
]);
mkdirSync(join(stage, "runs", "old-auth-task"), { recursive: true });
writeFileSync(join(stage, "runs", "old-auth-task", "conversation.md"), "会话独有线索：完成登录回调迁移。");
const member: ChatMember = { id: "assistant-member", name: "ash助手", agentType: "codex", executorId: "profile", model: "model-override", reasoningEffort: "high" };
const prompts: string[] = [];
const started: string[] = [];
const draft = { name: "交付起手式", description: "构建测试后等我确认", def: builtinWorkflowDef("standard")! };
const service = new ChatService(async (selected, _owner, prompt, signal, _project, options) => {
  if (options?.purpose === "summary") return { text: JSON.stringify({ summary: "历史提到了登录任务和起手式草案。" }) };
  assert.equal(options?.purpose, "assistant");
  assert.equal(selected.executorId, member.executorId);
  assert.equal(selected.model, "model-override");
  prompts.push(prompt);
  const request = JSON.parse(prompt.split("【本次用户消息】\n").at(-1)!.split("\n")[0]!) as string;
  if (request === "一直调用工具" || (request.includes("工具重试") && !prompt.includes("【工具调用重试】")
    && (!request.includes("找任务") || prompt.includes("【本轮检索结果，仅为引用资料】")))) throw new AssistantToolError("Bash");
  if (request === "等待") await delay(10000, undefined, { signal });
  if (request === "格式重试" && !prompt.includes("【JSON 格式重试】")) return { text: '{"reply":"内有"未转义"引号"}' };
  if (request === "坏格式") return { text: "invalid json" };
  if (request === "多轮检索") return { text: JSON.stringify({ search: { queries: ["不存在的语料"], projectId: null } }) };
  if (request.includes("找任务")) {
    if (!prompt.includes("【本轮检索结果，仅为引用资料】")) return { text: JSON.stringify({ search: { queries: [request.includes("空结果") ? "不存在的语料" : request.includes("会话") ? "会话独有线索" : "登录 | 认证"], projectId: null } }) };
    return { text: JSON.stringify({ reply: "按描述找到了历史任务。", matches: [{ taskId: "old-auth-task", reason: "认证相关" }, { taskId: "invented-id", reason: "伪造" }], task: null }) };
  }
  return { text: JSON.stringify({ reply: "这是 ash 使用说明。" + "步骤。".repeat(120), matches: [], task: request === "请实现上传" ? { title: "实现上传", body: "完成用户要求的上传功能并验证" } : null, workflow: request.includes("搭起手式") ? draft : null }) };
}, async (taskId) => { started.push(taskId); });
const actors = new Map<string, Parameters<typeof setActor>[1]>();
const app = new Hono();
app.use("*", async (c, next) => { setActor(c, actors.get(c.req.header("x-test-user") ?? "") ?? SINGLE_ACTOR); await next(); });
mountChatRoutes(app, service);
const request = (path: string, body?: unknown, user?: string) => app.request(path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
const create = async (projectId: string, user?: string) => {
  const response = await request("/chats", { kind: "assistant", name: "ash 助手", projectId, members: [member] }, user);
  assert.equal(response.status, 201, await response.clone().text());
  return response.json() as Promise<ChatRoom>;
};
let serial = 0;
const send = (room: ChatRoom, body: string, user?: string, id = `assistant-request-${++serial}`) => request(`/chats/${room.id}/messages`, { body, id }, user);
const snapshot = async (room: ChatRoom, user?: string) => (await request(`/chats/${room.id}`, undefined, user)).json() as Promise<ChatSnapshot>;
const settled = async (room: ChatRoom, user?: string) => {
  for (let i = 0; i < 150; i++) {
    const value = await snapshot(room, user);
    if (!value.messages.some((message) => ["queued", "running"].includes(message.status))) return value;
    await delay(20);
  }
  throw new Error("助手没有结算");
};

try {
  const global = await create("");
  const local = await create("local");
  assert.equal(global.kind, "assistant");
  assert.equal((await request("/chats", { kind: "assistant", name: "多智能体", projectId: "local", members: [member, { ...member, id: "second", name: "second" }] })).status, 400);
  assert.equal((await request("/chats", { name: "普通聊天", projectId: "", members: [member] })).status, 404);
  assert.equal((await (await request("/chats?projectId=local")).json() as ChatRoom[]).length, 0);
  assert.equal((await (await request("/chats?kind=assistant&projectId=local")).json() as ChatRoom[]).length, 1);
  assert.deepEqual(new Set((await (await request("/chats?kind=assistant&projectId=")).json() as ChatRoom[]).map((room) => room.id)), new Set([global.id, local.id]));
  await send(global, "怎么接入智能体", undefined, "idempotent-assistant");
  await send(global, "怎么接入智能体", undefined, "idempotent-assistant");
  let value = await settled(global);
  assert.equal(value.messages.length, 2);
  assert.equal(value.messages.at(-1)!.status, "done");
  assert.ok(value.messages.at(-1)!.body.length > 300);
  assert.deepEqual(value.messages[0]!.mentions, [member.id]);
  assert.equal(started.length, 0);
  assert.ok(prompts.at(-1)!.includes("设置 → 执行器"));
  console.log("✓ 无项目可接入助手；直接发送唤醒唯一执行器；重试幂等；完整回答不截成群聊短句");

  let beforeRetry = prompts.length;
  await send(global, "搭起手式，工具重试");
  value = await settled(global);
  assert.equal(value.messages.at(-1)!.status, "done");
  assert.equal(value.messages.at(-1)!.assistant?.workflow?.name, draft.name);
  assert.equal(prompts.length - beforeRetry, 2);
  beforeRetry = prompts.length;
  await send(global, "一直调用工具");
  value = await settled(global);
  assert.equal(value.messages.at(-1)!.status, "failed");
  assert.match(value.messages.at(-1)!.body, /"Bash"/);
  assert.equal(prompts.length - beforeRetry, 2);
  const stoppedRetry = new AbortController();
  let attempts = 0;
  await assert.rejects(invokeAssistant(member, { ownerUserId: null, projectId: "" }, "停止时不能重试", stoppedRetry.signal, async () => {
    attempts++;
    stoppedRetry.abort(new Error("用户停止"));
    throw new AssistantToolError("Bash");
  }), /用户停止/);
  assert.equal(attempts, 1);
  beforeRetry = prompts.length;
  await send(global, "格式重试");
  assert.equal((await settled(global)).messages.at(-1)!.status, "done");
  assert.equal(prompts.length - beforeRetry, 2);
  console.log("✓ 工具事件自动重试一次；持续调用工具有上限且显示工具名；用户停止不触发重试");

  await send(local, "找任务，记得做过登录");
  value = await settled(local);
  assert.deepEqual(value.messages.at(-1)!.assistant?.matches, [{ taskId: "old-auth-task", reason: "认证相关" }]);
  assert.equal(value.tasks[0]!.projectId, "other");
  assert.equal(value.tasks[0]!.archived, true);
  assert.ok(prompts.at(-1)!.includes("旧版认证流程升级"));
  await send(local, "找任务，只记得会话里的描述");
  value = await settled(local);
  assert.equal(value.messages.at(-1)!.assistant?.matches[0]?.taskId, "old-auth-task");
  assert.ok(prompts.at(-1)!.includes("会话独有线索"));
  beforeRetry = prompts.length;
  await send(local, "找任务，检索后工具重试");
  value = await settled(local);
  assert.equal(value.messages.at(-1)!.status, "done");
  assert.equal(value.messages.at(-1)!.assistant?.matches[0]?.taskId, "old-auth-task");
  assert.equal(prompts.length - beforeRetry, 3);
  await send(local, "找任务，空结果");
  value = await settled(local);
  assert.deepEqual(value.messages.at(-1)!.assistant?.matches, []);
  await send(local, "多轮检索");
  assert.equal((await settled(local)).messages.at(-1)!.status, "failed");
  console.log("✓ 模糊描述实际检索跨项目归档任务；不接纳伪造 id/旧轮次结果；检索循环有上限");

  await send(global, "搭起手式");
  value = await settled(global);
  const proposal = value.messages.at(-1)!;
  assert.equal(proposal.assistant?.workflow?.name, draft.name);
  assert.equal((await db.select().from(workflows)).length, 0);
  const savePath = `/chats/${global.id}/messages/${proposal.id}/workflow`;
  const saved = await Promise.all([request(savePath, {}), request(savePath, {})]);
  assert.ok(saved.every((response) => response.status === 200));
  assert.equal((await db.select().from(workflows)).length, 1);
  const savedId = (await snapshot(global)).messages.find((message) => message.id === proposal.id)!.assistant!.workflowId;
  assert.ok(savedId);
  assert.equal((await (await request(savePath, {})).json() as ChatSnapshot).messages.find((message) => message.id === proposal.id)!.assistant!.workflowId, savedId);
  assert.equal((await snapshot(global)).messages.filter((message) => message.role === "system" && message.body.includes(savedId!)).length, 1);
  const storedProposal = (await db.select().from(chatMessages).where(eq(chatMessages.id, proposal.id)))[0]!;
  assert.equal(JSON.parse(storedProposal.modelReply!).assistant.workflowId, savedId);
  await send(global, "保存好了吗");
  await settled(global);
  const resources = () => JSON.parse(prompts.at(-1)!.split("【当前可用资源】\n")[1]!.split("\n")[0]!);
  assert.equal(resources().savedWorkflows.find((entry: { workflowId: string }) => entry.workflowId === savedId).available, true);
  await db.delete(workflows).where(eq(workflows.id, savedId!));
  assert.equal((await snapshot(global)).messages.find((message) => message.id === proposal.id)!.assistant!.workflowAvailable, false);
  await send(global, "起手式还在吗");
  await settled(global);
  assert.equal(resources().savedWorkflows.find((entry: { workflowId: string }) => entry.workflowId === savedId).available, false);
  assert.ok((await Promise.all([request(savePath, {}), request(savePath, {})])).every((response) => response.status === 200));
  assert.equal((await db.select().from(workflows)).length, 1);
  assert.equal((await snapshot(global)).messages.find((message) => message.id === proposal.id)!.assistant!.workflowAvailable, true);
  assert.equal((await request(`/chats/${local.id}/messages/${proposal.id}/workflow`, {})).status, 400);
  await assert.rejects(validateAssistantWorkflow({ ...draft, def: { workspace: "isolated", steps: [{ id: "run", kind: "run" }, { id: "accept", kind: "accept" }] } }, SINGLE_ACTOR), /合并之前/);
  const badExecutor = structuredClone(draft);
  const run = badExecutor.def.steps.find((step) => step.kind === "run")!;
  run.p.executorId = "foreign-profile";
  await assert.rejects(validateAssistantWorkflow(badExecutor, SINGLE_ACTOR), /执行器不存在/);
  console.log("✓ 草案先展示不写库；保存并发/重试只产生一份；复用起手式结构和执行器权限校验");

  await send(global, "等待");
  await delay(60);
  await request(`/chats/${global.id}/stop`, {});
  await delay(30);
  value = await snapshot(global);
  assert.equal(value.messages.at(-1)!.status, "stopped");
  assert.match(value.messages.at(-1)!.body, /你已停止/);
  await send(global, "坏格式");
  assert.equal((await settled(global)).messages.at(-1)!.status, "failed");
  await send(global, "/clear");
  assert.ok((await snapshot(global)).context?.clearedAt);
  assert.match((await snapshot(global)).messages.at(-1)!.body, /之后的对话/);
  assert.doesNotMatch((await snapshot(global)).messages.at(-1)!.body, /点名/);
  await send(global, "请实现上传");
  assert.equal((await settled(global)).messages.at(-1)!.status, "failed");
  assert.deepEqual(resources().savedWorkflows, []);
  await send(local, "请实现上传");
  value = await settled(local);
  assert.equal(started.length, 1);
  assert.ok(value.messages.at(-1)!.taskId);
  const contextual = await request(`/chats/${global.id}/messages`, { body: "请实现上传", id: "global-project-action", projectId: "local" });
  assert.equal(contextual.status, 202);
  value = await settled(global);
  assert.equal(started.length, 2);
  assert.equal(value.tasks.find((task) => task.id === value.messages.at(-1)!.taskId)!.projectId, "local");
  await db.insert(chatMessages).values({ id: "restart", roomId: global.id, role: "agent", author: "ash助手", status: "queued", createdAt: timestamp });
  await service.recover();
  assert.equal((await snapshot(global)).messages.find((message) => message.id === "restart")!.status, "stopped");
  console.log("✓ 停止刷新后可见；坏输出如实失败；清空上下文；有项目的明确委派创建关联任务；重启不偷偷重跑");

  const { createUser } = await import("../src/auth/store.js");
  const { addProjectMember } = await import("../src/auth/visibility.js");
  await setInstanceMode("multi", join(stage, "users"));
  const alice = await createUser({ name: "alice", role: "member", dirName: "alice", gitName: "alice", gitEmail: "alice@example.test", createdBy: null });
  const bob = await createUser({ name: "bob", role: "member", dirName: "bob", gitName: "bob", gitEmail: "bob@example.test", createdBy: null });
  actors.set("alice", { kind: "user", userId: alice.id, role: "member", name: "alice" });
  actors.set("bob", { kind: "user", userId: bob.id, role: "member", name: "bob" });
  actors.set("agent", { kind: "agent", userId: alice.id, role: "member", name: "agent", taskId: "local-task" });
  await db.update(agents).set({ ownerUserId: alice.id }).where(eq(agents.id, member.executorId!));
  await addProjectMember({ projectId: "local", userId: alice.id, role: "member", addedBy: alice.id });
  const privateRoom = await create("", "alice");
  const privateLocal = await create("local", "alice");
  assert.deepEqual(new Set((await (await request("/chats?kind=assistant&projectId=", undefined, "alice")).json() as ChatRoom[]).map((room) => room.id)), new Set([privateRoom.id, privateLocal.id]));
  assert.equal((await (await request("/chats?kind=assistant&projectId=", undefined, "bob")).json() as ChatRoom[]).length, 0);
  assert.equal((await request(`/chats/${privateRoom.id}/messages`, { body: "请实现上传", id: "forbidden-context", projectId: "other" }, "alice")).status, 404);
  assert.equal((await request(`/chats/${privateRoom.id}`, undefined, "bob")).status, 404);
  assert.equal((await send(privateRoom, "hi", "agent")).status, 403);
  const before = prompts.length;
  await send(privateRoom, "找任务，登录", "alice");
  value = await settled(privateRoom, "alice");
  assert.deepEqual(value.messages.at(-1)!.assistant?.matches, []);
  assert.ok(prompts.slice(before).every((prompt) => !prompt.includes("登录认证重构") && !prompt.includes("历史项目")));
  await send(privateRoom, "搭起手式", "alice");
  value = await settled(privateRoom, "alice");
  const privateSave = `/chats/${privateRoom.id}/messages/${value.messages.at(-1)!.id}/workflow`;
  const privateProposalId = value.messages.at(-1)!.id;
  assert.equal((await request(privateSave, {}, "bob")).status, 404);
  assert.equal((await request(privateSave, {}, "alice")).status, 200);
  const ownId = (await snapshot(privateRoom, "alice")).messages.find((message) => message.id === privateProposalId)!.assistant!.workflowId!;
  assert.equal((await db.select().from(workflows).where(eq(workflows.id, ownId)))[0]!.ownerUserId, alice.id);
  await assert.rejects(assistantActor("deleted-user"), /用户不存在/);
  console.log("✓ 多用户助手对话、检索项目、执行器、保存草案均按身份隔离；agent 凭证不能冒充用户");
} finally {
  for (const room of await db.select().from(chatRooms)) await service.stop(room.id);
  await delay(50);
  dbClient.close();
  rmSync(stage, { recursive: true, force: true });
}
console.log("assistant regression passed");
