import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentEvent, Session } from "@ash/shared";
import { readClaudeAgentModel, readCodexAgentModel } from "../src/executors/native-agent-models.js";
import { openCodexAppServer } from "../src/executors/codex-app-server.js";
import { NativeWorkTrace } from "../src/executors/native-work.js";
import { enrichNativeWorkModels } from "../src/native-work-models.js";
import { parseSessionTrace } from "../src/transcript.js";
import { buildConversationItems } from "../../web/src/task-detail/conversationModel.ts";
import { buildNativeWork } from "../../web/src/task-detail/nativeWorkModel.ts";

const root = await mkdtemp(join(tmpdir(), "ash-native-models-"));
const parent = "11111111-1111-1111-1111-111111111111";
const child = "22222222-2222-2222-2222-222222222222";
const at = "2026-09-10T00:00:00.000Z";
const jsonl = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
const file = join(root, "codex", "sessions", "2026", "09", "10", `rollout-${child}.jsonl`);
const meta = { type: "session_meta", payload: { id: child, session_id: parent, parent_thread_id: parent,
  forked_from_id: parent, subagent_history_start_ordinal: 2 } };
const inherited = { type: "turn_context", payload: { model: "parent-model" } };
const context = (model: string) => ({ type: "turn_context", payload: { model } });
try {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, jsonl([meta, inherited]));
  assert.equal(await readCodexAgentModel(child, parent, join(root, "codex")), null, "复制来的主会话模型不算子代理记录");
  await writeFile(file, jsonl([meta, inherited, context("actual-codex")]) + '{"type":"turn_context"');
  assert.equal(await readCodexAgentModel(child, parent, join(root, "codex")), "actual-codex", "容忍日志尾部未写完");
  assert.equal(await readCodexAgentModel(child, child, join(root, "codex")), null);
  assert.equal(await readCodexAgentModel(child, "33333333-3333-3333-3333-333333333333", join(root, "codex")), null);
  assert.equal(await readCodexAgentModel(child, parent, join(root, "other-owner")), null, "不回落到其他用户目录");
  assert.equal(await readCodexAgentModel("../../other", parent, root), null);
  await writeFile(file, jsonl([meta, inherited, context("actual-codex"), context("new-codex-model")]));
  assert.equal(await readCodexAgentModel(child, parent, join(root, "codex")), "new-codex-model", "日志增长后更新缓存");

  const events: AgentEvent[] = [
    { kind: "tool", name: "spawn_agent", nativeWork: { type: "call", id: "call", name: "spawn_agent", input: { model: "requested-model" } } },
    { kind: "tool", name: "spawn_agent", nativeWork: { type: "result", id: "call", result: JSON.stringify({ agent_id: child }), failed: false } },
    { kind: "tool", name: "Agent", nativeWork: { type: "agent", id: child, status: "completed", result: "保留结果" } },
  ];
  const trace = parseSessionTrace(jsonl(events.map((event) => ({ event, at, turnStartedAt: at }))));
  const session = { id: "ash-session", taskId: "task", agentType: "codex", executor: "codex@test", role: "single",
    cliSessionId: parent, cwd: root, startedAt: at, endedAt: at, model: "parent-model" } as Session;
  const enriched = await enrichNativeWorkModels(trace, session, join(root, "codex"));
  const rows = buildNativeWork(buildConversationItems([{ session, output: "", trace: enriched }], [session], []), "done");
  assert.equal(trace.length, 3, "历史读取不改写原始记录");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, "new-codex-model");
  assert.equal(rows[0].requestedModel, "requested-model");
  assert.equal(rows[0].status, "completed", "补模型不把已完成项改成运行中");
  assert.equal(rows[0].result, "保留结果");
  assert.equal(rows[0].endedAt, at);
  assert.equal("sessionModel" in rows[0], false);

  await writeFile(file, jsonl([{ ...meta, payload: { ...meta.payload, subagent_history_start_ordinal: undefined } }, inherited]));
  assert.equal(await readCodexAgentModel(child, parent, join(root, "codex")), null, "不知道继承边界时不猜测");
  const unknown = await enrichNativeWorkModels(trace, session, join(root, "missing"));
  assert.deepEqual(unknown, trace, "日志不可读不影响原有执行记录");

  const agent = "a12345";
  const claudeFile = join(root, "claude", "projects", root.replace(/[^A-Za-z0-9]/g, "-"), parent, "subagents", `agent-${agent}.jsonl`);
  await mkdir(dirname(claudeFile), { recursive: true });
  const response = (model: string, agentId = agent, sessionId = parent) => ({ type: "assistant", agentId, sessionId, message: { model } });
  await writeFile(claudeFile, jsonl([response("actual-claude"), response("other-agent", "another"), response("other-session", agent, child), response("<synthetic>")]));
  assert.equal(await readClaudeAgentModel(agent, parent, root, join(root, "claude")), "actual-claude");
  assert.equal(await readClaudeAgentModel(agent, parent, root, join(root, "other-owner")), null);
  assert.equal(await readClaudeAgentModel("../a12345", parent, root, join(root, "claude")), null);
  const claudeTrace = parseSessionTrace(jsonl([
    { kind: "tool", name: "Agent", nativeWork: { type: "call", id: "toolu-child", name: "Agent", input: { model: "sonnet" } } },
    { kind: "tool", name: "Agent", nativeWork: { type: "result", id: "toolu-child", result: `agentId: ${agent}`, failed: false } },
  ].map((event) => ({ event, at, turnStartedAt: at }))));
  const claudeEnriched = await enrichNativeWorkModels(claudeTrace, { ...session, agentType: "claude" }, join(root, "claude"));
  const claudeRows = buildNativeWork(buildConversationItems([{ session, output: "", trace: claudeEnriched }], [session], []), "done");
  assert.equal(claudeRows.length, 1);
  assert.equal(claudeRows[0].model, "actual-claude");

  const stream = new NativeWorkTrace();
  const started = stream.claudeMessage({ type: "stream_event", parent_tool_use_id: "toolu-child",
    event: { type: "message_start", message: { model: "claude-stream-model" } } });
  assert.ok(started.some((event) => event.kind === "tool" && event.nativeWork?.type === "agent" && event.nativeWork.model === "claude-stream-model"));
  assert.deepEqual(stream.claudeMessage({ type: "assistant", parent_tool_use_id: "toolu-child", message: { model: "<synthetic>", content: [] } }), []);
} finally {
  await rm(root, { recursive: true, force: true });
}

for (const mode of ["reported", "unsupported", "wrong-thread", "missing-model"]) {
  const handle = openCodexAppServer({ bin: "fixture", args: [], cwd: process.cwd(), prompt: "fixture", startProcess: () => spawn(process.execPath, ["-e", `
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: {} });
  if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'main', model: 'parent-model' } } });
  if (m.method === 'turn/start') {
    send({ id: m.id, result: { turn: { id: 'turn' } } });
    send({ method: 'turn/started', params: { threadId: 'child', turn: { id: 'child-turn' } } });
  }
  if (m.method === 'thread/read') {
    if (m.params.threadId !== 'child' || m.params.includeTurns !== false) process.exit(3);
    if ('${mode}' === 'unsupported') send({ id: m.id, error: { message: 'unsupported method' } });
    else send({ id: m.id, result: { thread: { id: '${mode}' === 'wrong-thread' ? 'main' : 'child', model: '${mode}' === 'missing-model' ? undefined : 'actual-child-model' } } });
    setTimeout(() => send({ method: 'turn/completed', params: { threadId: 'main', turn: { status: 'completed' } } }), 20);
  }
});
`], { stdio: ["pipe", "pipe", "pipe"] }) });
  const events: AgentEvent[] = [];
  for await (const event of handle.events) events.push(event);
  const models = events.flatMap((event) => event.kind === "tool" && event.nativeWork?.type === "agent" && event.nativeWork.model ? [event.nativeWork.model] : []);
  assert.deepEqual(models, mode === "reported" ? ["actual-child-model"] : []);
  assert.equal(events.some((event) => event.kind === "error"), false, "可选模型查询失败不影响执行");
  assert.ok(events.some((event) => event.kind === "done" && event.exitStatus === 0));
}
console.log("子代理实际模型：Codex/Claude 读取、继承边界、历史补充、归属隔离和查询失败回归通过");
