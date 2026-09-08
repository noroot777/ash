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
const { projects, chatRooms, chatMessages, chatContextEntries, chatSummaries } = await import("../src/db/schema.js");
const { ChatService, roomMessages } = await import("../src/chat/service.js");
const { ChatContextManager } = await import("../src/chat/context.js");
const { captureChatHistory, captureChatSnapshot, readChatHistory, chatContextStatus } = await import("../src/chat/context-store.js");
const { contextMessage, estimateChatTokens } = await import("../src/chat/context-format.js");
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
      return { text: '{"summary":"顺序正确"}' };
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
    assert.deepEqual(second.tail.map((message) => JSON.parse(message).body), ["成员本轮未能回复。", "ties-d"]);
    await db.update(chatMessages).set({ status: "stopped" }).where(eq(chatMessages.id, "ties-b"));
    const final = await readChatHistory(row.id, await captureChatHistory(row.id));
    assert.deepEqual(final.messages.map((message) => message.messageId), ["ties-a", "ties-b", "ties-c", "ties-d"]);
    assert.deepEqual(final.messages.map((message) => JSON.parse(message.content).body), ["ties-a", "成员本轮回复已停止。", "成员本轮未能回复。", "ties-d"]);
  });

  await check("系统状态在冻结历史、临时尾部和摘要中使用中性系统归属，原界面文案不变", async () => {
    const row = await room("status-context");
    const messages = [
      { id: "status-a", role: "user", status: "done", author: "用户", body: "请回答" },
      { id: "status-b", role: "agent", status: "failed", author: "codex", body: "模型上游 503" },
      { id: "status-c", role: "agent", status: "stopped", author: "claude", body: stoppedBody, taskId: "TASK-KEEP" },
      { id: "status-d", role: "agent", status: "running", author: "grok", body: "" },
      { id: "status-e", role: "agent", status: "failed", author: "codex", body: "接口错误 TAIL" },
      { id: "status-f", role: "agent", status: "done", author: "claude", body: "MODEL-DONE" },
    ];
    for (const [index, message] of messages.entries()) await db.insert(chatMessages).values({ ...message, roomId: row.id, createdAt: new Date(Date.parse(timestamp) + index).toISOString() });
    const snapshot = await captureChatSnapshot(row.id);
    const manager = new ChatContextManager(async () => { throw new Error("短历史不整理"); }, policy);
    const prompt = await manager.prepare(row, members[0]!, snapshot.cutoff, "继续", new AbortController().signal, snapshot.tail);
    for (const body of ["模型上游 503", stoppedBody, "接口错误 TAIL"]) assert.ok(!prompt.includes(body));
    const frozen = (await readChatHistory(row.id, snapshot.cutoff)).messages.map((entry) => JSON.parse(entry.content));
    assert.deepEqual(frozen.slice(1), [
      { role: "system", author: "系统", body: "codex本轮未能回复。" },
      { role: "system", author: "系统", body: "claude已创建任务，后续流程未正常结束；请查看任务卡。", taskId: "TASK-KEEP" },
    ]);
    assert.deepEqual(snapshot.tail.map((content) => JSON.parse(content).role), ["system", "agent"]);
    assert.ok(prompt.includes("MODEL-DONE"));
    await db.update(chatMessages).set({ status: "failed", body: "较早回复失败" }).where(eq(chatMessages.id, "status-d"));
    const final = await captureChatSnapshot(row.id);
    assert.deepEqual(final.tail, []);
    assert.deepEqual((await readChatHistory(row.id, final.cutoff)).messages.map((entry) => entry.messageId), messages.map((message) => message.id));
    assert.equal(await captureChatHistory(row.id), final.cutoff);
    assert.equal(await manager.prepare(row, members[0]!, snapshot.cutoff, "继续", new AbortController().signal, snapshot.tail), prompt);
    const summaryManager = new ChatContextManager(async (_member, _owner, summary) => {
      for (const body of ["模型上游 503", stoppedBody, "接口错误 TAIL", "较早回复失败"]) assert.ok(!summary.includes(body));
      assert.ok(summary.includes('"role":"system"'));
      assert.ok(summary.includes("TASK-KEEP"));
      assert.ok(summary.includes("MODEL-DONE"));
      return { text: '{"summary":"保留对话"}' };
    }, { ...policy, backgroundTokens: 10, recentTokens: 0, summaryTokens: 20 });
    await summaryManager.prewarm(row.id, members[0]!);
    assert.ok((await chatContextStatus(row.id)).hasSummary);
    assert.equal((await roomMessages(row.id)).find((message) => message.id === "status-c")!.body, stoppedBody);
  });

  await check("旧错误归属条目启动时幂等修复，仅重建受影响摘要，不跨 /clear 污染新摘要", async () => {
    for (const cleared of [false, true]) {
      const row = await room(`legacy-status-${cleared}`);
      const message = { id: `legacy-error-${cleared}`, roomId: row.id, role: "agent" as const, author: "codex", status: "failed", body: "模型上游 503", createdAt: timestamp };
      await db.insert(chatMessages).values({ id: `legacy-user-${cleared}`, roomId: row.id, role: "user", author: "用户", body: "已确认的决定", createdAt: "2026-08-31T00:00:00.000Z" });
      await db.insert(chatMessages).values(message);
      const cutoff = await captureChatHistory(row.id);
      const prefix = (await readChatHistory(row.id, cutoff)).messages[0]!;
      await db.insert(chatSummaries).values({ roomId: row.id, throughSequence: prefix.sequence, body: "未受影响的正确摘要", tokens: 20, createdAt: timestamp });
      const original = contextMessage({ ...message, status: undefined });
      await db.update(chatContextEntries).set({ content: original, tokens: estimateChatTokens(`${original}\n`) }).where(eq(chatContextEntries.messageId, message.id));
      await db.insert(chatSummaries).values({ roomId: row.id, throughSequence: cutoff, body: "错误归属的旧摘要", tokens: 20, createdAt: timestamp });
      let currentCutoff = cutoff;
      if (cleared) {
        await service.send(row, "/clear", `legacy-clear-${cleared}`, "用户");
        await service.send(row, "清空后新消息", `legacy-new-${cleared}`, "用户");
        currentCutoff = await captureChatHistory(row.id);
        await db.insert(chatSummaries).values({ roomId: row.id, throughSequence: currentCutoff, body: "清空后的正确摘要", tokens: 20, createdAt: timestamp });
      }
      const manager = new ChatContextManager(async () => { throw new Error("恢复不调用模型"); }, policy);
      await manager.recover();
      const entry = (await db.select().from(chatContextEntries).where(eq(chatContextEntries.messageId, message.id)))[0]!;
      assert.equal(entry.sequence, cutoff);
      assert.equal(JSON.parse(entry.content).role, "system");
      const history = await readChatHistory(row.id, currentCutoff);
      assert.equal(history.summary?.body, cleared ? "清空后的正确摘要" : "未受影响的正确摘要");
      assert.ok(!JSON.stringify(history).includes("模型上游 503"));
      await manager.recover();
      assert.deepEqual(await readChatHistory(row.id, currentCutoff), history);
      assert.equal((await roomMessages(row.id)).find((entry) => entry.id === message.id)!.body, message.body);
    }
  });

  await check("模型回复与任务启动状态独立，启动失败前后及重启后保持同一上下文", async () => {
    const row = await room("task-start-failure");
    let rejectStart: ((error: Error) => void) | undefined;
    const modelReply = "已为登录页创建任务，请在任务卡查看进度。";
    const delegating = new ChatService(async () => ({ text: JSON.stringify({ reply: modelReply, task: { title: "实现登录页", body: "按用户要求实现登录页" } }) }),
      async () => new Promise<void>((_resolve, reject) => { rejectStart = reject; }), policy);
    await delegating.send(row, "@codex 请实现登录页", "task-start-source", "用户");
    await eventually(async () => !!rejectStart, "模型回复成功并创建任务");
    const reply = (await roomMessages(row.id)).find((message) => message.role === "agent")!;
    assert.equal(reply.status, "done");
    assert.ok(reply.taskId);
    const cutoff = await captureChatHistory(row.id);
    const history = await readChatHistory(row.id, cutoff);
    const entry = history.messages.find((message) => message.messageId === reply.id)!;
    assert.deepEqual(JSON.parse(entry.content), { role: "agent", author: "codex", body: modelReply, taskId: reply.taskId });
    rejectStart!(new Error("worktree 创建失败"));
    await eventually(async () => (await roomMessages(row.id)).some((message) => message.id === reply.id && message.status === "failed"), "任务启动失败落库");
    const stored = (await db.select().from(chatMessages).where(eq(chatMessages.id, reply.id)))[0]!;
    assert.ok(stored.body.includes("任务已创建，但启动失败"));
    assert.equal(stored.modelReply, modelReply);
    assert.equal(contextMessage({ ...stored, role: "agent" }), entry.content, "即使启动失败后才首次冻结，内容也相同");
    assert.equal("modelReply" in (await roomMessages(row.id)).find((message) => message.id === reply.id)!, false);
    await delegating.recover();
    assert.deepEqual(await readChatHistory(row.id, await captureChatHistory(row.id)), history);
    const manager = new ChatContextManager(async (_member, _owner, prompt) => {
      assert.ok(prompt.includes(modelReply));
      assert.ok(prompt.includes(reply.taskId!));
      assert.ok(!prompt.includes("本轮未能回复"));
      return { text: '{"summary":"登录页任务已创建"}' };
    }, { ...policy, backgroundTokens: 10, recentTokens: 0, summaryTokens: 30 });
    await manager.prewarm(row.id, members[0]!);
    assert.ok((await chatContextStatus(row.id)).hasSummary);
  });

  await check("旧任务启动失败记录保留完整事实和正确摘要，缺少原发言时不谎称未回复", async () => {
    const row = await room("legacy-task-failure");
    const message = { id: "legacy-task-error", roomId: row.id, role: "agent" as const, author: "codex", status: "failed", taskId: "TASK-77", body: "任务已创建，但启动失败：worktree 创建失败。请打开任务重试。", createdAt: timestamp };
    await db.insert(chatMessages).values(message);
    const cutoff = await captureChatHistory(row.id);
    const fallback = (await readChatHistory(row.id, cutoff)).messages[0]!;
    assert.ok(fallback.content.includes("已创建任务"));
    assert.ok(!fallback.content.includes("未能回复"));
    const original = contextMessage({ ...message, status: undefined });
    await db.update(chatContextEntries).set({ content: original }).where(eq(chatContextEntries.messageId, message.id));
    await db.insert(chatSummaries).values({ roomId: row.id, throughSequence: cutoff, body: "已确认：先做登录页，任务 TASK-77 已建。", tokens: 30, createdAt: timestamp });
    const summariesBefore = await db.select().from(chatSummaries).where(eq(chatSummaries.roomId, row.id));
    const manager = new ChatContextManager(async () => { throw new Error("正确摘要无需重算"); }, policy);
    await manager.recover();
    await manager.recover();
    const repaired = (await db.select().from(chatContextEntries).where(eq(chatContextEntries.messageId, message.id)))[0]!;
    assert.deepEqual(JSON.parse(repaired.content), { role: "system", author: "系统", body: `codex：${message.body}`, taskId: "TASK-77" });
    assert.deepEqual(await db.select().from(chatSummaries).where(eq(chatSummaries.roomId, row.id)), summariesBefore);
  });
  assert.deepEqual(failures, []);
} finally {
  for (const id of rooms) await service.stop(id);
  await eventually(async () => inflight === 0, "清理测试调用");
  await delay(30);
  dbClient.close();
  rmSync(stage, { recursive: true, force: true });
}
