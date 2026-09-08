import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { ChatMember, ChatSnapshot } from "@ash/shared/chat";
import { isChatClearCommand } from "@ash/shared/chat";

const stage = mkdtempSync(join(tmpdir(), "ash-chat-context-"));
process.env.ASH_DB = join(stage, "test.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { projects, chatRooms, chatMessages, chatSummaries, chatContextEntries, chatContextStates } = await import("../src/db/schema.js");
const { ChatService } = await import("../src/chat/service.js");
const { ChatContextManager } = await import("../src/chat/context.js");
const { captureChatHistory, readChatHistory, chatContextStatus, contextState, setContextState } = await import("../src/chat/context-store.js");
const { estimateChatTokens, parseChatSummary, contextMessage } = await import("../src/chat/context-format.js");
const { parseChatReply } = await import("../src/chat/prompt.js");
const { limitedChatInvoke } = await import("../src/chat/invocation-queue.js");
const { mountChatRoutes } = await import("../src/chat/routes.js");
const { SINGLE_ACTOR, setActor } = await import("../src/auth/context.js");
const { withGlobalBrowserPolicy } = await import("../src/browser-verification-policy.js");
await dbClient.executeMultiple(`
  CREATE TABLE chat_context_states (room_id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'idle', error TEXT, updated_at TEXT NOT NULL);
  INSERT INTO chat_context_states VALUES ('legacy-failure', 'failed', '旧失败', '2026-09-01T00:00:00.000Z');
  CREATE TABLE chat_messages (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL, role TEXT NOT NULL, member_id TEXT, author TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '', mentions TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'done',
    task_id TEXT, context TEXT, created_at TEXT NOT NULL
  );
  INSERT INTO chat_messages (id, room_id, role, author, body, status, created_at)
    VALUES ('legacy-reply', 'legacy-upgrade', 'agent', 'codex', '旧模型回复', 'done', '2026-09-01T00:00:00.000Z'),
      ('legacy-system-error', 'legacy-upgrade', 'agent', 'codex', '旧系统错误', 'failed', '2026-09-01T00:00:00.001Z');
`);
await ensureSchema();
await ensureSchema();
assert.equal((await contextState("legacy-failure"))?.failedAt, "2026-09-01T00:00:00.000Z");
assert.equal((await db.select().from(chatMessages).where(eq(chatMessages.id, "legacy-reply")))[0]!.modelReply, "旧模型回复");
assert.equal((await db.select().from(chatMessages).where(eq(chatMessages.id, "legacy-system-error")))[0]!.modelReply, null);
const timestamp = "2026-09-01T00:00:00.000Z";
await db.insert(projects).values({ id: "project", name: "上下文测试", repoPath: stage, createdAt: timestamp });
const members: ChatMember[] = ["codex", "claude", "grok"].map((name) => ({ id: name, name, agentType: name as ChatMember["agentType"], executorId: null, model: "fixture-model", reasoningEffort: null }));
const policy = { inputTokens: 12000, backgroundTokens: 6000, recentTokens: 1500, summaryTokens: 500, batchTokens: 6000 };
let serial = 0;
const createRoom = async (name: string) => (await db.insert(chatRooms).values({ id: name, name, projectId: "project", members: JSON.stringify(members), createdAt: timestamp }).returning())[0]!;
async function seed(roomId: string, count: number, size = 800) {
  for (let i = 0; i < count; i++) await db.insert(chatMessages).values({ id: `seed-${++serial}`, roomId, role: "user", author: "用户", body: `KEEP-${i}:${"x".repeat(size)}`, createdAt: new Date(Date.parse(timestamp) + serial * 100).toISOString() });
}
async function eventually(check: () => Promise<boolean>, description: string) {
  for (let i = 0; i < 300; i++) { if (await check()) return; await delay(10); }
  throw new Error(`等待超时：${description}`);
}

const calls: { room: string; summary: boolean; prompt: string; member: string }[] = [];
let mode: "ok" | "invalid" | "hold-summary" | "hold-reply" = "ok";
let releaseReply: (() => void) | undefined;
let inflight = 0;
let maximum = 0;
const invoke: ConstructorParameters<typeof ChatService>[0] = async (member, _owner, prompt, signal, _project, options) => {
  const summary = options?.purpose === "summary";
  calls.push({ room: "", summary, prompt, member: member.id });
  inflight++;
  maximum = Math.max(maximum, inflight);
  try {
    if ((summary && mode === "hold-summary") || (!summary && mode === "hold-reply")) {
      await new Promise<void>((resolve, reject) => {
        if (!summary) releaseReply = resolve;
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    signal.throwIfAborted();
    await delay(5);
    if (summary) return { text: mode === "invalid" ? '{"task":{"title":"不得执行"}}' : '{"summary":"用户早期决定 KEEP-0；保留任务 TASK-1 的关联，兼容性仍待验证。"}' };
    return { text: JSON.stringify({ reply: `回复-${member.name}-已完成`, task: null }) };
  } finally { inflight--; }
};
const service = new ChatService(invoke, async () => { throw new Error("摘要不能创建任务"); }, policy);
const app = new Hono();
app.use("*", async (c, next) => { setActor(c, SINGLE_ACTOR); await next(); });
mountChatRoutes(app, service);
const snapshot = async (roomId: string) => (await app.request(`/chats/${roomId}`)).json() as Promise<ChatSnapshot>;
const send = async (roomId: string, body: string, messageId = `message-${++serial}`) => {
  const response = await app.request(`/chats/${roomId}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: messageId, body }) });
  assert.equal(response.status, 202);
};
const settled = async (roomId: string) => eventually(async () => !(await snapshot(roomId)).messages.some((message) => message.status === "queued" || message.status === "running"), `回复结束 ${roomId}`);
const summaries = () => calls.filter((call) => call.summary);

try {
  assert.ok(estimateChatTokens("汉".repeat(100)) > estimateChatTokens("x".repeat(100)));
  for (const text of ["oops", "null", "[]", '{"summary":12}', '{"summary":{}}', '{"summary":""}', '{"summary":"ok"} 结语', '[{"summary":"ok"}]', JSON.stringify({ summary: "汉".repeat(1000) })]) assert.throws(() => parseChatSummary(text, 500));
  for (const [prefix, suffix] of [["", ""], ["整理好了。\n", ""], ["```json\n", "\n```"], ["整理好了。\n```json\n", "\n```"], ['{"旧输出":"忽略"}\n', ""]]) {
    assert.equal(parseChatSummary(`${prefix}${JSON.stringify({ summary: ' 保留决定 {A} 与 "B" ', metadata: { extra: true }, task: { title: "忽略" } })}${suffix}`, 500), '保留决定 {A} 与 "B"');
    assert.deepEqual(parseChatReply(`${prefix}{"reply":"已处理","task":null,"extra":true}${suffix}`), { reply: "已处理", task: null });
  }
  console.log("✓ 摘要与回复共用最终 JSON 容错，前缀、围栏、额外字段可接受；类型、空值、预算和尾随文字仍校验");
  assert.equal(JSON.parse(contextMessage({ role: "user", author: "用户", body: '完整🙂\n"消息"' })).body, '完整🙂\n"消息"');

  const legacy = await createRoom("legacy");
  await seed(legacy.id, 530, 10);
  const legacyCutoff = await captureChatHistory(legacy.id);
  const legacyHistory = await readChatHistory(legacy.id, legacyCutoff);
  assert.equal(legacyHistory.messages.length, 530);
  assert.ok(legacyHistory.messages[0]!.content.includes("KEEP-0"));
  assert.equal((await snapshot(legacy.id)).messages.length, 500);
  assert.equal(await captureChatHistory(legacy.id), legacyCutoff);
  console.log("✓ 旧群迁移幂等，超过页面 500 条的历史仍完整参与上下文");

  const short = await createRoom("short");
  await send(short.id, "不点名的背景");
  assert.equal(calls.length, 0);
  await send(short.id, "@codex 给建议");
  await settled(short.id);
  await delay(30);
  assert.equal(summaries().length, 0);
  const first = calls.at(-1)!.prompt;
  await send(short.id, "@codex 继续");
  await settled(short.id);
  const second = calls.at(-1)!.prompt;
  assert.ok(second.startsWith(first.split("【本次用户消息】")[0]!));
  assert.ok(second.includes("不点名的背景"));
  assert.equal(summaries().length, 0);
  console.log("✓ 无点名不调用；短对话不压缩；普通追加保持已有历史前缀");

  const background = await createRoom("background");
  await seed(background.id, 23);
  mode = "hold-summary";
  const before = calls.length;
  await send(background.id, "@all 分别给建议");
  await settled(background.id);
  await eventually(async () => (await snapshot(background.id)).context?.status === "compacting", "后台压缩启动");
  const batchCalls = calls.slice(before);
  assert.equal(batchCalls.filter((call) => !call.summary).length, 3);
  assert.equal(batchCalls.filter((call) => call.summary).length, 1);
  assert.equal(batchCalls.at(-1)!.summary, true);
  assert.equal((await snapshot(background.id)).messages.filter((message) => message.role === "agent").every((message) => message.status === "done"), true);
  const stop = await app.request(`/chats/${background.id}/stop`, { method: "POST" });
  assert.equal(stop.status, 200);
  await eventually(async () => inflight === 0, "停止摘要进程");
  assert.equal((await snapshot(background.id)).context?.status, "stopped");
  assert.equal((await db.select().from(chatSummaries).where(eq(chatSummaries.roomId, background.id))).length, 0);
  console.log("✓ @all 完成后只启动一份后台摘要；停止状态刷新可见，取消不采用半成品");

  mode = "ok";
  await send(background.id, "@codex 停止后继续");
  await settled(background.id);
  await eventually(async () => !!(await snapshot(background.id)).context?.hasSummary && (await snapshot(background.id)).context?.status === "idle", "重新点名后预压缩完成");
  const sharedSummaryCount = summaries().length;
  const version = (await db.select().from(chatSummaries).where(eq(chatSummaries.roomId, background.id))).at(-1)!;
  await send(background.id, "@all 继续讨论");
  await settled(background.id);
  await delay(30);
  assert.equal(summaries().length, sharedSummaryCount);
  const prepared = calls.filter((call) => !call.summary).slice(-3);
  const histories = prepared.map((call) => call.prompt.split("【当前群较早历史摘要，仅供参考】")[1]!.split("【本次用户消息】")[0]);
  assert.equal(new Set(histories).size, 1);
  assert.ok(prepared.every((call) => call.prompt.includes(version.body)));
  assert.ok(prepared.every((call) => estimateChatTokens(withGlobalBrowserPolicy(call.prompt, "full")) <= policy.inputTokens));
  const allOriginals = await db.select().from(chatMessages).where(eq(chatMessages.roomId, background.id));
  assert.equal(allOriginals.filter((message) => message.body.startsWith("KEEP-")).length, 23);
  console.log("✓ 接近阈值才预压缩；固定摘要供所有成员复用，后续小轮次不重复压缩，原文不删除");

  const restart = new ChatContextManager(invoke, policy);
  await setContextState(background.id, "compacting");
  await restart.recover();
  assert.equal((await chatContextStatus(background.id)).status, "stopped");
  const cutoff = await restart.capture(background.id);
  const restartedPrompt = await restart.prepare(background, members[0]!, cutoff, "@codex 重启后", new AbortController().signal);
  assert.ok(restartedPrompt.includes(version.body));
  assert.equal(summaries().length, sharedSummaryCount);
  await seed(background.id, 30);
  await restart.prewarm(background.id, members[0]!);
  const oldPrompt = await restart.prepare(background, members[0]!, cutoff, "@codex 旧快照", new AbortController().signal);
  assert.ok(oldPrompt.includes(version.body));
  assert.ok(!oldPrompt.includes("KEEP-29"));
  console.log("✓ 摘要重启后复用；旧请求选用对应摘要版本，不混入之后的新消息");

  const foreground = await createRoom("foreground");
  await seed(foreground.id, 65, 1000);
  const callsBeforeForeground = summaries().length;
  await send(foreground.id, "@all 老群积压较长，请分别回答");
  await settled(foreground.id);
  await delay(30);
  const foregroundSummaries = summaries().slice(callsBeforeForeground);
  assert.ok(foregroundSummaries.length > 1);
  assert.equal(new Set(foregroundSummaries.map((call) => call.prompt)).size, foregroundSummaries.length);
  const foregroundReplies = calls.filter((call) => !call.summary).slice(-3);
  assert.ok(foregroundReplies.every((call) => estimateChatTokens(withGlobalBrowserPolicy(call.prompt, "full")) <= policy.inputTokens));
  assert.equal(new Set(foregroundReplies.map((call) => call.prompt.split("【当前群较早历史摘要，仅供参考】")[1]!.split("【本次用户消息】")[0])).size, 1);
  console.log("✓ 前台超预算兜底按完整消息分批整理；同群多成员去重，输入保持在估算预算内");

  const failure = await createRoom("failure");
  await seed(failure.id, 23);
  mode = "invalid";
  await send(failure.id, "@codex 建议");
  await settled(failure.id);
  await eventually(async () => (await snapshot(failure.id)).context?.status === "failed", "持久摘要失败");
  assert.equal((await snapshot(failure.id)).messages.at(-1)!.status, "done");
  const failedCount = summaries().length;
  await send(failure.id, "@codex 继续");
  await settled(failure.id);
  await delay(30);
  assert.equal(summaries().length, failedCount);
  assert.deepEqual((await snapshot(failure.id)).context, { status: "idle", error: null, hasSummary: false, clearedAt: null });
  const savedFailure = (await contextState(failure.id))?.failedAt;
  const savedCause = (await contextState(failure.id))?.error;
  assert.ok(savedFailure);
  assert.equal(savedCause, "摘要格式无效，原始消息已保留。");
  const afterFailureRestart = new ChatContextManager(invoke, policy);
  await afterFailureRestart.recover();
  await afterFailureRestart.prewarm(failure.id, members[0]!);
  assert.equal(summaries().length, failedCount, "提示归位后及重启后仍保留后台五分钟冷却");
  assert.equal((await contextState(failure.id))?.failedAt, savedFailure);
  assert.equal((await db.select().from(chatSummaries).where(eq(chatSummaries.roomId, failure.id))).length, 0);
  await seed(failure.id, 30);
  await send(failure.id, "@all 超额重试");
  await settled(failure.id);
  assert.equal(summaries().length, failedCount);
  assert.equal((await snapshot(failure.id)).messages.filter((message) => message.role === "agent").slice(-3).every((message) => message.status === "failed"), true);
  assert.ok((await snapshot(failure.id)).messages.filter((message) => message.role === "agent").slice(-3).every((message) => message.body.includes(savedCause!)));
  assert.equal((await chatContextStatus(failure.id)).error, savedCause);
  assert.equal((await chatContextStatus(failure.id)).status, "failed");
  assert.equal((await contextState(failure.id))?.failedAt, savedFailure, "再次显示失败提示不延长冷却");
  assert.ok((await db.select().from(chatContextEntries).where(eq(chatContextEntries.roomId, failure.id))).length > 50);
  await send(failure.id, "/clear");
  assert.equal((await contextState(failure.id))?.failedAt, null, "清空后的新上下文不继承旧失败的冷却");
  console.log("✓ 后台失败保留原文且不覆盖正常回复；失败冷却防止每轮/每成员重复付费重试，超额不静默截断");

  const partial = await createRoom("partial-failure");
  await seed(partial.id, 20, 1100);
  let partialCalls = 0;
  const partialManager = new ChatContextManager(async () => {
    if (++partialCalls === 2) throw new Error("模型上游 503");
    return { text: '整理好了。```json\n{"summary":"保留用户决定 KEEP-0","metadata":{"extra":true}}\n```' };
  }, { ...policy, batchTokens: 3000 });
  await partialManager.prewarm(partial.id, members[0]!);
  assert.equal(partialCalls, 2);
  assert.deepEqual(await chatContextStatus(partial.id), { status: "failed", error: "模型上游 503", hasSummary: true, clearedAt: null });
  const partialCutoff = await captureChatHistory(partial.id);
  const partialHistory = await readChatHistory(partial.id, partialCutoff);
  assert.ok(partialHistory.tokens <= policy.backgroundTokens);
  await db.update(chatContextStates).set({ failedAt: new Date(Date.now() - 300001).toISOString() }).where(eq(chatContextStates.roomId, partial.id));
  await partialManager.prewarm(partial.id, members[0]!);
  assert.equal(partialCalls, 2, "多批整理中途失败后历史已够用，不再调用模型");
  assert.deepEqual(await chatContextStatus(partial.id), { status: "idle", error: null, hasSummary: true, clearedAt: null });
  assert.deepEqual(await readChatHistory(partial.id, partialCutoff), partialHistory);
  const partialPrompt = await partialManager.prepare(partial, members[0]!, partialCutoff, "继续", new AbortController().signal);
  assert.ok(partialPrompt.includes("保留用户决定 KEEP-0"));
  assert.ok(partialPrompt.includes("KEEP-19"));
  await setContextState(partial.id, "failed", "模型上游 503");
  const partialFailureAt = (await contextState(partial.id))?.failedAt;
  await partialManager.prepare(partial, members[0]!, partialCutoff, "正常继续", new AbortController().signal);
  assert.deepEqual(await chatContextStatus(partial.id), { status: "idle", error: null, hasSummary: true, clearedAt: null });
  await seed(partial.id, 40);
  const blockedAfterRestart = new ChatContextManager(async () => { throw new Error("冷却期不能重复调用模型"); }, policy);
  await blockedAfterRestart.recover();
  await assert.rejects(blockedAfterRestart.prepare(partial, members[0]!, await captureChatHistory(partial.id), "超额继续", new AbortController().signal), /请稍后重新 @。模型上游 503/);
  assert.deepEqual(await chatContextStatus(partial.id), { status: "failed", error: "模型上游 503", hasSummary: true, clearedAt: null });
  assert.equal((await contextState(partial.id))?.failedAt, partialFailureAt);
  console.log("✓ 分批整理中途失败后，冷却结束且历史已够用时归位提示，保留已完成摘要与近期原文");

  const tolerant = await createRoom("tolerant-foreground");
  await seed(tolerant.id, 65, 1000);
  await setContextState(tolerant.id, "failed", "旧格式错误");
  await db.update(chatContextStates).set({ failedAt: new Date(Date.now() - 60001).toISOString() }).where(eq(chatContextStates.roomId, tolerant.id));
  const tolerantManager = new ChatContextManager(async () => ({ text: '整理结果：\n{"summary":"KEEP-0 与 TASK-1 已确认","extra":"忽略"}' }), policy);
  const tolerantPrompt = await tolerantManager.prepare(tolerant, members[0]!, await captureChatHistory(tolerant.id), "继续", new AbortController().signal);
  assert.ok(tolerantPrompt.includes("KEEP-0 与 TASK-1 已确认"));
  assert.ok(estimateChatTokens(withGlobalBrowserPolicy(tolerantPrompt, "full")) <= policy.inputTokens);
  assert.equal((await chatContextStatus(tolerant.id)).status, "idle");
  assert.equal((await contextState(tolerant.id))?.failedAt, null, "前台冷却期满后整理成功，清除旧失败时间");
  console.log("✓ 长历史前台整理接受带说明及额外字段的合法摘要，不再因输出包装阻塞回复");

  const frozen = await createRoom("frozen");
  mode = "hold-reply";
  await send(frozen.id, "@codex 第一个请求");
  await eventually(async () => !!releaseReply, "第一个回复在运行");
  await send(frozen.id, "@codex 排队的第二个请求");
  const queued = (await db.select().from(chatMessages).where(and(eq(chatMessages.roomId, frozen.id), eq(chatMessages.status, "queued")))).at(0)!;
  assert.ok(queued);
  mode = "ok";
  releaseReply!();
  await settled(frozen.id);
  assert.ok(!calls.at(-1)!.prompt.includes("回复-codex-已完成"));
  assert.ok(calls.at(-1)!.prompt.includes("第一个请求"));
  console.log("✓ 排队请求保持发送时快照，等待期间完成的回复不会倒灌上下文");

  assert.equal(isChatClearCommand(" /CLEAR "), true);
  for (const body of ["`/clear`", "/clear @codex", "请解释 /clear", "> /clear"]) assert.equal(isChatClearCommand(body), false);
  const callsBeforeClear = calls.length;
  await send(background.id, "/clear", "clear-idempotent");
  await send(background.id, "/clear", "clear-idempotent");
  const cleared = await snapshot(background.id);
  assert.equal(calls.length, callsBeforeClear);
  assert.equal(cleared.context?.hasSummary, false);
  assert.ok(cleared.context?.clearedAt);
  assert.equal(cleared.messages.filter((message) => message.role === "system").length, 1);
  assert.ok(cleared.messages.some((message) => message.body.includes("KEEP-0")));
  await send(background.id, "只用新信息 NEW-ONLY");
  await send(background.id, "@all 清空后继续");
  await settled(background.id);
  for (const call of calls.filter((call) => !call.summary).slice(-3)) {
    assert.ok(call.prompt.includes("NEW-ONLY"));
    assert.ok(!call.prompt.includes("KEEP-"));
    assert.ok(!call.prompt.includes(version.body));
    assert.ok(!call.prompt.includes("/clear"));
  }
  const afterResetRestart = new ChatContextManager(invoke, policy);
  await afterResetRestart.recover();
  const cleanPrompt = await afterResetRestart.prepare(background, members[0]!, await afterResetRestart.capture(background.id), "重启后继续", new AbortController().signal);
  assert.ok(!cleanPrompt.includes("KEEP-"));
  assert.ok(cleanPrompt.includes("NEW-ONLY"));
  assert.equal((await readChatHistory(legacy.id, legacyCutoff)).messages.length, 530);
  console.log("✓ /clear 不调用模型且幂等；原聊天保留，后续全体成员及重启后均不读旧消息或摘要，其他群不受影响");

  mode = "hold-reply";
  releaseReply = undefined;
  await send(frozen.id, "@codex 清空前仍在运行");
  await eventually(async () => !!releaseReply, "清空前回复运行");
  await send(frozen.id, "@codex 清空前排队");
  await send(frozen.id, "/clear");
  await eventually(async () => inflight === 0, "清空取消在途回复");
  assert.ok(!(await snapshot(frozen.id)).messages.some((message) => message.status === "queued" || message.status === "running"));
  mode = "ok";
  await send(frozen.id, "@codex 新会话");
  await settled(frozen.id);
  assert.ok(!calls.at(-1)!.prompt.includes("清空前"));
  assert.ok(!calls.at(-1)!.prompt.includes("第一个请求"));

  const clearBackground = await createRoom("clear-background");
  await seed(clearBackground.id, 23);
  mode = "hold-summary";
  await send(clearBackground.id, "@codex 背景讨论");
  await settled(clearBackground.id);
  await eventually(async () => (await snapshot(clearBackground.id)).context?.status === "compacting", "清空前后台摘要运行");
  await send(clearBackground.id, "/clear");
  assert.equal((await snapshot(clearBackground.id)).context?.hasSummary, false);
  assert.equal((await db.select().from(chatSummaries).where(eq(chatSummaries.roomId, clearBackground.id))).length, 0);
  mode = "ok";
  await send(clearBackground.id, "@all 从这里开始");
  await settled(clearBackground.id);
  assert.ok(calls.filter((call) => !call.summary).slice(-3).every((call) => !call.prompt.includes("KEEP-")));
  console.log("✓ /clear 同时取消当前与排队回复、后台整理，迟到结果不跨越清空边界");

  const atomic = await createRoom("atomic-clear");
  await dbClient.execute("CREATE TRIGGER reject_context_reset BEFORE INSERT ON chat_context_resets BEGIN SELECT RAISE(ABORT, 'fixture reset failure'); END");
  const rejected = await app.request(`/chats/${atomic.id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "atomic-clear-command", body: "/clear" }) });
  assert.equal(rejected.status, 409);
  assert.equal((await snapshot(atomic.id)).messages.length, 0);
  await dbClient.execute("DROP TRIGGER reject_context_reset");
  await send(atomic.id, "/clear", "atomic-clear-command");
  assert.ok((await snapshot(atomic.id)).context?.clearedAt);
  console.log("✓ 清空标记和上下文边界原子保存；失败不会假报成功，同一消息可重试");

  let running = 0;
  let peak = 0;
  const limited = limitedChatInvoke(async (_member, _owner, _prompt, signal) => {
    signal.throwIfAborted(); running++; peak = Math.max(peak, running); await delay(20); running--; return { text: "ok" };
  });
  const canceled = new AbortController();
  const queue = Array.from({ length: 8 }, (_, i) => limited(members[0]!, null, "fixture", i === 7 ? canceled.signal : new AbortController().signal, "project", i % 2 ? { purpose: "summary" } : undefined));
  canceled.abort();
  const results = await Promise.allSettled(queue);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(peak, 4);
  assert.ok(maximum <= 4);
  console.log("✓ 聊天和摘要共用四路调用额度；排队取消不泄漏并发槽位");
  console.log("chat context regression passed");
} finally {
  for (const room of await db.select().from(chatRooms)) await service.stop(room.id);
  await eventually(async () => inflight === 0, "测试调用清理");
  await delay(50);
  dbClient.close();
  rmSync(stage, { recursive: true, force: true });
}
