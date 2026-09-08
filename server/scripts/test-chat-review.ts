import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { mock } from "node:test";
import { eq } from "drizzle-orm";
import type { ChatMember } from "@ash/shared/chat";

const stage = mkdtempSync(join(tmpdir(), "ash-chat-review-"));
process.env.ASH_DB = join(stage, "test.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { projects, chatRooms, chatMessages } = await import("../src/db/schema.js");
const { ChatService, roomMessages } = await import("../src/chat/service.js");
const { ChatContextManager } = await import("../src/chat/context.js");
const { captureChatHistory, captureChatSnapshot, readChatHistory, chatContextStatus } = await import("../src/chat/context-store.js");
await ensureSchema();
const timestamp = "2026-09-01T00:00:00.000Z";
await db.insert(projects).values({ id: "project", name: "审查回归", repoPath: stage, createdAt: timestamp });
const members: ChatMember[] = ["codex", "claude", "grok"].map((name) => ({ id: name, name, agentType: name as ChatMember["agentType"], executorId: null, model: null, reasoningEffort: null }));
const policy = { inputTokens: 12000, backgroundTokens: 6000, recentTokens: 1500, summaryTokens: 500, batchTokens: 6000 };
const stoppedBody = "你已停止这次回复。再次 @ 才会继续；已创建的任务可在任务卡中管理。";
const stoppedContext = "你已停止历史整理；摘要和原文已保留，下次点名时按需继续。";
const rooms: string[] = [];
let sequence = 0;
let calls = 0;
let inflight = 0;
const service = new ChatService(async (_member, _owner, _prompt, signal) => {
  calls++; inflight++;
  try {
    await new Promise<void>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    throw new Error("held invocation unexpectedly resolved");
  } finally { inflight--; }
}, async () => {}, policy);
async function room(name: string, count = 0) {
  rooms.push(name);
  const row = (await db.insert(chatRooms).values({ id: name, name, projectId: "project", members: JSON.stringify(members), createdAt: timestamp }).returning())[0]!;
  for (let i = 0; i < count; i++) await db.insert(chatMessages).values({ id: `history-${++sequence}`, roomId: name, role: "user", author: "用户", body: "背景".repeat(400), createdAt: new Date(Date.parse(timestamp) + sequence * 100).toISOString() });
  return row;
}
async function eventually(check: () => Promise<boolean>, description: string) {
  for (let i = 0; i < 300; i++) { if (await check()) return; await delay(10); }
  throw new Error(`等待超时：${description}`);
}
const failures: string[] = [];
async function check(name: string, run: () => Promise<void>) {
  try { await run(); console.log(`✓ ${name}`); }
  catch (error) { failures.push(name); console.error(`✗ ${name}: ${error instanceof Error ? error.message : error}`); }
}

try {
  await check("F1: 前台摘要锁等待期间停止与 /clear，全部成员保留完整中文停止文案", async () => {
    for (const clear of [false, true]) {
      const row = await room(clear ? "clear-compaction" : "stop-compaction", 20);
      const before = calls;
      await service.send(row, "@all 请分别回答", `message-${++sequence}`, "用户");
      await eventually(async () => calls > before && (await roomMessages(row.id)).filter((message) => message.status === "running").length === 3, "一人在整理，另外两人等上下文锁");
      assert.equal(calls - before, 1);
      if (clear) await service.send(row, "/clear", `message-${++sequence}`, "用户");
      else await service.stop(row.id);
      await eventually(async () => inflight === 0 && (await chatContextStatus(row.id)).status !== "compacting", "停止结算");
      await delay(30);
      const replies = (await roomMessages(row.id)).filter((message) => message.role === "agent");
      assert.equal(replies.length, 3);
      assert.deepEqual(replies.map((message) => ({ status: message.status, body: message.body })), members.map(() => ({ status: "stopped", body: stoppedBody })));
      const context = await chatContextStatus(row.id);
      assert.equal(context.error, clear ? null : stoppedContext);
      if (clear) assert.ok(context.clearedAt);
    }
  });

  await check("F2: 从未整理过历史的短群停止 running 回复，不伪造历史整理状态", async () => {
    const row = await room("short-stop");
    const before = calls;
    await service.send(row, "@codex 等待", `message-${++sequence}`, "用户");
    await eventually(async () => calls > before, "真正进入回复调用");
    await service.stop(row.id);
    await eventually(async () => inflight === 0, "短群回复停止");
    await delay(30);
    assert.deepEqual(await chatContextStatus(row.id), { status: "idle", error: null, hasSummary: false, clearedAt: null });
    assert.equal((await roomMessages(row.id)).at(-1)!.body, stoppedBody);
  });

  await check("D2: 后台预压缩硬超时持久保留中文原因与原文，前台不透传 DOMException", async () => {
    const row = await room("timeout-compaction", 20);
    const cutoff = await captureChatHistory(row.id);
    const before = await readChatHistory(row.id, cutoff);
    let started = false;
    const manager = new ChatContextManager(async (_member, _owner, _prompt, signal) => {
      started = true;
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      throw new Error("held summary unexpectedly resolved");
    }, policy);
    const timeoutBody = "历史整理超时，已停止；摘要和原文已保留，下次点名时按需继续。";
    const originalTimeout = AbortSignal.timeout;
    const timer = mock.method(AbortSignal, "timeout", (ms: number) => originalTimeout(ms === 300000 ? 50 : ms));
    try {
      const prewarm = manager.prewarm(row.id, members[0]!);
      await eventually(async () => (await chatContextStatus(row.id)).status === "stopped", "后台预压缩超时结算");
      await prewarm;
      assert.ok(started);
      assert.deepEqual(await chatContextStatus(row.id), { status: "stopped", error: timeoutBody, hasSummary: false, clearedAt: null });
      assert.deepEqual(await readChatHistory(row.id, cutoff), before);
      await Promise.all([
        assert.rejects(manager.prepare(row, members[0]!, cutoff, "超时验证", new AbortController().signal), { message: timeoutBody }),
        delay(100),
      ]);
      const abort = new AbortController();
      const prepare = manager.prepare(row, members[0]!, cutoff, "默认取消验证", abort.signal);
      const rejected = assert.rejects(prepare, { message: "历史整理已停止；摘要和原文已保留，下次点名时按需继续。" });
      await eventually(async () => (await chatContextStatus(row.id)).status === "compacting", "前台整理开始");
      abort.abort();
      await rejected;
      assert.equal((await chatContextStatus(row.id)).error, "历史整理已停止；摘要和原文已保留，下次点名时按需继续。");
    } finally { timer.mock.restore(); }
  });

  await check("F3: 慢回复按原消息时间进入历史与摘要，后发消息不插队", async () => {
    const row = await room("ordered");
    const messages = [
      { id: "order-a", role: "user", author: "用户", body: "FIRST-A", status: "done" },
      { id: "order-r", role: "agent", author: "grok", body: "REPLY-R", status: "running" },
      { id: "order-b", role: "user", author: "用户", body: "LATER-B", status: "done" },
    ];
    for (const [index, message] of messages.entries()) await db.insert(chatMessages).values({ ...message, roomId: row.id, createdAt: new Date(Date.parse(timestamp) + index * 1000).toISOString() });
    const waiting = await captureChatSnapshot(row.id);
    assert.deepEqual((await readChatHistory(row.id, waiting.cutoff)).messages.map((message) => JSON.parse(message.content).body), ["FIRST-A"]);
    assert.deepEqual(waiting.tail.map((message) => JSON.parse(message).body), ["LATER-B"]);
    const snapshotManager = new ChatContextManager(async () => { throw new Error("短历史不应触发模型调用"); }, policy);
    const beforeCompletion = await snapshotManager.prepare(row, members[0]!, waiting.cutoff, "当前请求 C", new AbortController().signal, waiting.tail);
    assert.ok(beforeCompletion.includes("LATER-B"));
    assert.ok(!beforeCompletion.includes("REPLY-R"));
    await db.update(chatMessages).set({ status: "done" }).where(eq(chatMessages.id, "order-r"));
    const history = await readChatHistory(row.id, await captureChatHistory(row.id));
    assert.deepEqual(history.messages.map((message) => JSON.parse(message.content).body), ["FIRST-A", "REPLY-R", "LATER-B"]);
    assert.equal(await snapshotManager.prepare(row, members[0]!, waiting.cutoff, "当前请求 C", new AbortController().signal, waiting.tail), beforeCompletion);
    await assert.rejects(snapshotManager.prepare(row, members[0]!, waiting.cutoff, "当前请求 C", new AbortController().signal, ["x".repeat(policy.inputTokens * 4)]), /后续消息已超出上下文预算/);
    let summarized = false;
    const manager = new ChatContextManager(async (_member, _owner, prompt) => {
      assert.ok(prompt.indexOf("FIRST-A") < prompt.indexOf("REPLY-R"));
      assert.ok(prompt.indexOf("REPLY-R") < prompt.indexOf("LATER-B"));
      summarized = true;
      return '{"summary":"顺序正确"}';
    }, { ...policy, backgroundTokens: 10, recentTokens: 0, summaryTokens: 20 });
    await manager.prewarm(row.id, members[0]!);
    assert.ok(summarized);
    assert.equal((await chatContextStatus(row.id)).status, "idle");
  });
  await check("F3: 同一时间戳及多个慢成员的完成顺序不改变原消息顺序", async () => {
    const row = await room("ordered-ties");
    const messages = [
      { id: "ties-a", status: "done" }, { id: "ties-b", status: "queued" },
      { id: "ties-c", status: "running" }, { id: "ties-d", status: "done" },
    ];
    for (const message of messages) await db.insert(chatMessages).values({ ...message, roomId: row.id, role: "agent", author: "成员", body: message.id, createdAt: timestamp });
    const first = await captureChatSnapshot(row.id);
    assert.deepEqual(first.tail.map((message) => JSON.parse(message).body), ["ties-d"]);
    await db.update(chatMessages).set({ status: "failed" }).where(eq(chatMessages.id, "ties-c"));
    const second = await captureChatSnapshot(row.id);
    assert.equal(second.cutoff, first.cutoff);
    assert.deepEqual(second.tail.map((message) => JSON.parse(message).body), ["ties-c", "ties-d"]);
    await db.update(chatMessages).set({ status: "stopped" }).where(eq(chatMessages.id, "ties-b"));
    const final = await readChatHistory(row.id, await captureChatHistory(row.id));
    assert.deepEqual(final.messages.map((message) => JSON.parse(message.content).body), ["ties-a", "ties-b", "ties-c", "ties-d"]);
  });
  assert.deepEqual(failures, []);
} finally {
  for (const id of rooms) await service.stop(id);
  await eventually(async () => inflight === 0, "清理测试调用");
  await delay(30);
  dbClient.close();
  rmSync(stage, { recursive: true, force: true });
}
