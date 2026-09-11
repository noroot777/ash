import { acceptedSideRequests, rejectedSideRequests } from "./side-authorization-cases.js";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { ChatMember, ChatSnapshot } from "@ash/shared/chat";

const stage = mkdtempSync(join(tmpdir(), "ash-side-chat-test-"));
process.env.ASH_DB = join(stage, "test.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
const { db, ensureSchema, dbClient } = await import("../src/db/index.js");
const { projects, tasks, sessions, chatRooms, chatMessages, scheduledMessages, chatContextEntries, users, projectMembers } = await import("../src/db/schema.js");
const { ChatService, roomMessages } = await import("../src/chat/service.js");
const { mountChatRoutes } = await import("../src/chat/routes.js");
const { sideChatHistory } = await import("../src/chat/side-routes.js");
const { settleSideChat } = await import("../src/chat/side-delivery.js");
const { sideForwardAuthorized, parseSideChatReply } = await import("../src/chat/side-prompt.js");
const { setActor, SINGLE_ACTOR } = await import("../src/auth/context.js");
const { setInstanceMode } = await import("../src/auth/mode.js");
const runs = await import("../src/runs.js");
const { deliveryVerdict } = await import("../src/pending-messages.js");
await ensureSchema();
await setInstanceMode("single", stage);
const timestamp = new Date().toISOString();
const member: ChatMember = { id: "member", name: "侧聊助手", agentType: "codex", executorId: null, model: null, reasoningEffort: null };
await db.insert(projects).values({ id: "p", name: "side test", repoPath: stage, createdAt: timestamp });
await db.insert(tasks).values({ id: "parent", projectId: "p", title: "主任务", body: "主任务原始目标", mode: "single", status: "running", agentType: "codex", activeTurnToken: "turn", activeDirectionToken: "direction", createdAt: timestamp, updatedAt: timestamp });
await db.insert(sessions).values({ id: "session", taskId: "parent", role: "single", executor: "fixture", agentType: "codex", startedAt: timestamp, endedAt: timestamp });
const parentPath = join(stage, "runs", "parent");
mkdirSync(parentPath, { recursive: true });
writeFileSync(join(parentPath, "session.md"), '方案 A 简单。\n\x1e{"t":"user","text":"请比较 B"}\n方案 B 更灵活。\n\x1e{"t":"system","text":"隐藏系统状态"}\n');
let held = false;
let invalidForward = false;
let authorizeWholeMessage = false;
let fakeReply = "保留主任务节奏，在这里比较方案。";
const prompts: string[] = [];
let summaryCalls = 0;
const service = new ChatService(async (_member, _owner, prompt, signal, _project, options) => {
  if (options?.purpose === "summary") { summaryCalls++; return { text: '{"summary":"主任务原始目标，比较方案 A/B；其余为重复背景。"}' }; }
  prompts.push(prompt);
  if (held) await delay(10000, undefined, { signal });
  const source = JSON.parse(prompt.split("【当前用户消息】\n").at(-1)!) as string;
  await delay(5);
  return { text: JSON.stringify({ reply: fakeReply, forward: source.includes("告诉主任务") || invalidForward ? { text: "按方案 B 继续，先补验证。", authorization: authorizeWholeMessage ? source : invalidForward ? "把结论告诉主任务" : source } : null }) };
}, async () => { throw new Error("侧聊不应创建任务"); });
const app = new Hono();
app.use("*", async (c, next) => {
  const who = c.req.header("x-user");
  setActor(c, who ? { kind: "user", userId: who, name: who, role: "member" } : c.req.header("x-agent") ? { kind: "agent", userId: null, role: "member", taskId: "parent", name: "agent" } : SINGLE_ACTOR);
  await next();
});
mountChatRoutes(app, service);
const req = (path: string, body?: unknown, headers: Record<string, string> = {}) => app.request(path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
const snapshot = async (room: string) => await (await req(`/chats/${room}`)).json() as ChatSnapshot;
const until = async (check: () => Promise<boolean>) => { for (let i = 0; i < 200; i++) { if (await check()) return; await delay(10); } throw new Error("等待侧聊状态超时"); };
const send = async (body: string, id: string, room = "side-room") => {
  const response = await req(`/chats/${room}/messages`, { body, id });
  assert.equal(response.status, 202, await response.text());
  await until(async () => (await snapshot(room)).messages.every((message) => !["queued", "running"].includes(message.status)));
  return (await snapshot(room)).messages.at(-1)!;
};
let kills = 0;
const handle = { kill: () => { kills++; } };
runs.claimTurn("parent", "single"); runs.trackRun("parent", handle);
try {
  assert.equal((await req("/tasks/parent/side-chats", { id: "side-room", member })).status, 201);
  assert.equal((await req("/tasks/parent/side-chats", { id: "side-room", member })).status, 200);
  assert.equal((await req("/tasks/parent/side-chats", { id: "agent-room", member }, { "x-agent": "1" })).status, 404);
  const source = await db.select().from(chatContextEntries).where(eq(chatContextEntries.roomId, "side-room"));
  assert.match(source.map((row) => row.content).join("\n"), /主任务原始目标.*方案 A.*方案 B/s);
  assert.doesNotMatch(source.map((row) => row.content).join("\n"), /隐藏系统状态/);
  appendFileSync(join(parentPath, "session.md"), "\n后续主任务新内容，不属于旧侧聊。\n");
  await send("分析方案", "user-first");
  assert.match(prompts[0]!, /方案 A.*方案 B/s);
  assert.doesNotMatch(prompts[0]!, /后续主任务新内容/);
  fakeReply = "继续分析的详细结论。";
  await send("接着说", "user-second");
  assert.match(prompts[1]!, /保留主任务节奏/);
  assert.equal((await send("把结论告诉主任务", "user-forward")).forward?.status, "queued");
  assert.equal(kills, 0, "不支持 native 时不能 kill 主任务");
  await req("/chats/side-room/messages", { body: "把结论告诉主任务", id: "user-forward" });
  assert.equal((await db.select().from(scheduledMessages)).length, 1, "重复请求只创建一条回传消息");
  const queued = (await db.select().from(scheduledMessages))[0]!;
  assert.match(queued.text, /^【来自侧聊.*方案 B/s);
  assert.equal(queued.taskId, "parent");
  assert.equal(deliveryVerdict(queued, { mode: "single", status: "done", archived: false }, new Date()).action, "deliver", "空闲主任务复用现有续跑链路");
  assert.equal(deliveryVerdict(queued, { mode: "single", status: "running", archived: false }, new Date()).action, "wait");
  await db.update(scheduledMessages).set({ status: "canceled" }).where(eq(scheduledMessages.id, queued.id));
  assert.equal((await snapshot("side-room")).messages.find((row) => row.forward)?.forward?.status, "canceled");
  const delivered: string[] = [];
  const native = { kill: () => { kills++; }, steer: async (text: string) => { delivered.push(text); } };
  runs.untrackRun("parent", handle); runs.trackRun("parent", native);
  runs.bindNativeSteer("parent", native, { agentType: "codex", record: (text) => { assert.match(text, /来自侧聊/); } });
  await send("把结论告诉主任务，以后都按这个来", "user-native");
  await until(async () => (await snapshot("side-room")).messages.at(-1)?.forward?.status === "sent");
  assert.equal(delivered.length, 1); assert.equal(kills, 0);
  assert.match(delivered[0]!, /当前方向身份/);
  runs.untrackRun("parent", native); runs.trackRun("parent", handle);
  const count = (await db.select().from(scheduledMessages)).length;
  invalidForward = true;
  const rejected = await send("上轮发过了，请解释方案", "user-history");
  assert.equal(rejected.status, "done");
  assert.equal(rejected.body, fakeReply);
  assert.match(rejected.forwardError!, /没有明确/);
  assert.equal(rejected.forward, undefined);
  assert.match((await db.select().from(chatMessages).where(eq(chatMessages.id, rejected.id)))[0]!.modelReply!, /继续分析的详细结论.*未发送/s);
  for (const command of acceptedSideRequests) assert.equal(sideForwardAuthorized(command, command), true, command);
  for (const command of rejectedSideRequests) {
    assert.equal(sideForwardAuthorized(command, command), false, command);
    for (const excerpt of ["把结论告诉主任务", "告诉主任务", "发给主任务"]) {
      if (command.includes(excerpt)) assert.equal(sideForwardAuthorized(command, excerpt), false, `${command} / 模型只引用 ${excerpt}`);
    }
  }
  for (const separator of ["，", "。", "！", "\n", "; "]) {
    for (const withdrawal of ["哦不对，先不要", "等等，我再想想", "除非它已经开始做了", "不过要等我确认", "不过这条只是我随口说的", "暂且搁置"]) {
      const command = `把结论告诉主任务${separator}${withdrawal}`;
      assert.equal(sideForwardAuthorized(command, "把结论告诉主任务"), false, command);
      assert.equal(sideForwardAuthorized(command, command), false, command);
    }
  }
  authorizeWholeMessage = true;
  runs.untrackRun("parent", handle); runs.trackRun("parent", native);
  runs.bindNativeSteer("parent", native, { agentType: "codex", record: () => {} });
  for (const [index, command] of rejectedSideRequests.entries()) {
    const rejected = await send(command, `review-rejected-${index}`);
    assert.equal(rejected.status, "done");
    assert.equal(rejected.body, fakeReply);
    assert.ok(rejected.forwardError, command);
    assert.equal(rejected.forward, undefined);
    assert.equal((await db.select().from(scheduledMessages)).length, count, "拒绝回传不入队");
    assert.equal(delivered.length, 1, "即使 native 可用也不投递");
  }
  runs.untrackRun("parent", native); runs.trackRun("parent", handle);
  authorizeWholeMessage = false;
  for (const text of ["不要把结论告诉主任务", "如果把结论告诉主任务会怎样", "引用：『把结论告诉主任务』", "`把结论告诉主任务`", "> 把结论告诉主任务", "请解释如何把结论告诉主任务", "稍后把结论告诉主任务", "把结论告诉主任务，是不是会影响当前执行？"]) {
    assert.equal(sideForwardAuthorized(text, "把结论告诉主任务"), false, text);
  }
  assert.equal(sideForwardAuthorized("把结论告诉主任务，后续按方案 B 做", "把结论告诉主任务"), true);
  for (const suffix of ["以后都按这个来", "说一下怎么改", "等它跑完再看", "比如先补一版验证"]) {
    const command = `把结论告诉主任务，${suffix}`;
    assert.equal(sideForwardAuthorized(command, command), true, command);
    assert.equal(sideForwardAuthorized(command, "把结论告诉主任务"), true, command);
  }
  for (const command of ['把「方案 B」的结论告诉主任务', '把"方案 B"的结论告诉主任务', "「把结论告诉主任务」", "「把结论告诉主任务」。", "把刚才的结论告诉主任务", "把之前讨论的方案告诉主任务"]) {
    assert.equal(sideForwardAuthorized(command, command), true, command);
  }
  for (const command of ["把结论告诉主任务，如果它已经开始做了就算了", "之前把结论告诉主任务", "别， 把结论告诉主任务", "比如，把结论告诉主任务", "把结论告诉主任务，不能发了", "把结论告诉主任务，不用了", "把结论告诉主任务，等我确认再发", "把结论告诉主任务，稍后发送"]) {
    assert.equal(sideForwardAuthorized(command, "把结论告诉主任务"), false, command);
  }
  const overlong = "保留正文".repeat(4000);
  assert.equal(parseSideChatReply(JSON.stringify({ reply: overlong }), "解释方案").reply, overlong);
  const malformed = parseSideChatReply(JSON.stringify({ reply: fakeReply, forward: { text: "x".repeat(8001), authorization: "把结论告诉主任务" } }), "把结论告诉主任务");
  assert.equal(malformed.reply, fakeReply);
  assert.equal(malformed.forward, null);
  assert.match(malformed.forwardError!, /8000/);
  for (const command of ["把结论告诉主任务。", "请给主聊天发一条消息，后续用方案 B。", "把结论交给主任务", "Please send the conclusion to the main thread."]) {
    assert.equal(sideForwardAuthorized(command, command), true, command);
  }
  invalidForward = false;
  held = true;
  await req("/chats/side-room/messages", { body: "等待长回复", id: "user-stop" });
  await until(async () => (await snapshot("side-room")).messages.at(-1)?.status === "running");
  assert.equal((await req("/chats/side-room/messages", { body: "竞争消息", id: "user-concurrent" })).status, 409);
  await req("/chats/side-room/stop", {});
  await delay(20);
  assert.equal((await snapshot("side-room")).messages.at(-1)?.status, "stopped");
  assert.equal((await db.select().from(tasks).where(eq(tasks.id, "parent")))[0]!.status, "running");
  assert.equal(kills, 0);
  held = false;
  await send("停止后继续", "user-after-stop");
  const room = (await db.select().from(chatRooms).where(eq(chatRooms.id, "side-room")))[0]!;
  await db.insert(chatMessages).values({ id: "race-stopped", roomId: room.id, role: "agent", author: "侧聊", status: "stopped", body: "已停止", createdAt: timestamp });
  assert.equal(await settleSideChat(room, "race-stopped", { reply: "ok", task: null, forward: { text: "不能发", authorization: "把结论告诉主任务" } }, undefined, new AbortController().signal), undefined);
  assert.equal((await db.select().from(scheduledMessages)).length, count);
  await db.insert(chatMessages).values({ id: "recover-running", roomId: room.id, role: "agent", author: "侧聊", status: "running", body: "", createdAt: timestamp });
  await new ChatService().recover();
  assert.equal((await roomMessages(room.id)).find((row) => row.id === "recover-running")?.status, "stopped");
  assert.equal((await roomMessages(room.id)).filter((row) => row.forward).length, 2, "重启后回执仍在");
  await db.update(tasks).set({ archived: true }).where(eq(tasks.id, "parent"));
  const archived = await send("把结论告诉主任务", "user-archived");
  assert.equal(archived.status, "done");
  assert.equal(archived.body, fakeReply);
  assert.match(archived.forwardError!, /归档/);
  assert.equal((await db.select().from(scheduledMessages)).length, count);
  await db.update(tasks).set({ archived: false }).where(eq(tasks.id, "parent"));
  await db.update(tasks).set({ handoff: JSON.stringify({ direction: "out" }) }).where(eq(tasks.id, "parent"));
  const handoff = await send("把结论告诉主任务", "user-handoff");
  assert.equal(handoff.body, fakeReply);
  assert.match(handoff.forwardError!, /接力/);
  assert.equal((await db.select().from(scheduledMessages)).length, count);
  await db.update(tasks).set({ handoff: null }).where(eq(tasks.id, "parent"));
  fakeReply = "回答正文".repeat(3100);
  assert.equal((await send("长回答", "user-long-answer")).body, fakeReply);
  fakeReply = "继续分析的详细结论。";
  const callsBeforeScale = summaryCalls;
  for (const bytes of [256 * 1024, 1024 * 1024, 4 * 1024 * 1024]) {
    writeFileSync(join(parentPath, "session.md"), "A".repeat(bytes));
    const response = await req("/tasks/parent/side-chats", { id: `scale-room-${bytes}`, member });
    assert.equal(response.status, 400);
    assert.match(await response.text(), /超过/);
    assert.equal((await db.select().from(chatRooms).where(eq(chatRooms.id, `scale-room-${bytes}`))).length, 0);
  }
  assert.equal(summaryCalls, callsBeforeScale, "大体积创建拒绝不调用模型");
  writeFileSync(join(parentPath, "session.md"), "长篇资料。".repeat(4000));
  assert.equal((await req("/tasks/parent/side-chats", { id: "long-room", member })).status, 201);
  await send("总结主任务", "user-long", "long-room");
  assert.ok(summaryCalls > callsBeforeScale && summaryCalls - callsBeforeScale <= 3, "允许的近上限快照首次回复最多整理三批，不截断历史");
  const parent = (await db.select().from(tasks).where(eq(tasks.id, "parent")))[0]!;
  rmSync(join(parentPath, "session.md"));
  await assert.rejects(sideChatHistory(parent), /ENOENT/, "已结束的会话正文丢失时不能生成不完整快照");
  await setInstanceMode("multi", stage);
  await db.insert(users).values([{ id: "alice", name: "Alice", dirName: "alice", status: "active", createdAt: timestamp }, { id: "bob", name: "Bob", dirName: "bob", status: "active", createdAt: timestamp }]);
  await db.insert(projectMembers).values([{ projectId: "p", userId: "alice", role: "member", addedAt: timestamp }, { projectId: "p", userId: "bob", role: "member", addedAt: timestamp }]);
  await db.update(chatRooms).set({ ownerUserId: "alice" }).where(eq(chatRooms.id, room.id));
  assert.equal((await req(`/chats/${room.id}`, undefined, { "x-user": "alice" })).status, 200);
  assert.equal((await req(`/chats/${room.id}`, undefined, { "x-user": "bob" })).status, 404);
  assert.deepEqual(await (await req("/tasks/parent/side-chats", undefined, { "x-user": "bob" })).json(), []);
  await db.delete(projectMembers).where(and(eq(projectMembers.projectId, "p"), eq(projectMembers.userId, "alice")));
  assert.equal((await req(`/chats/${room.id}`, undefined, { "x-user": "alice" })).status, 404);
  console.log("✓ 侧聊快照、连续历史、长历史整理、自然回传授权、幂等、native/排队、停止/恢复、归档与权限隔离通过");
} finally {
  await service.stop("side-room"); await service.stop("long-room");
  runs.untrackRun("parent", handle); runs.releaseTurn("parent");
  await delay(30); dbClient.close(); rmSync(stage, { recursive: true, force: true });
}
