import assert from "node:assert/strict";
import type { AgentEvent, NativeWorkEvent, Session } from "@ash/shared";
import { NativeWorkTrace } from "../../server/src/executors/native-work.ts";
import { buildConversationItems, type ConversationItem } from "../src/task-detail/conversationModel.ts";
import { buildNativeWork } from "../src/task-detail/nativeWorkModel.ts";
import { nativeWorkDate, nativeWorkDuration } from "../src/task-detail/nativeWorkTiming.ts";

const start = "2026-09-08T23:59:00.000Z";
const end = "2026-09-09T00:01:05.000Z";
const later = "2026-09-09T01:00:00.000Z";
const session = { id: "meta", taskId: "task", role: "single", agentType: "codex", executor: "codex@test",
  model: "gpt-5.6", startedAt: "2026-09-08T23:00:00.000Z", endedAt: null } as Session;
const rowFrom = (events: NativeWorkEvent[], persisted = false, status: "running" | "done" = "running") => {
  const tool = (nativeWork: NativeWorkEvent): AgentEvent => ({ kind: "tool", name: "Agent", nativeWork });
  const items = persisted
    ? buildConversationItems([{ session, output: "", trace: events.map((event) => ({ at: event.at!, event: tool(event) })) }], [session], [])
    : buildConversationItems([], [session], events.map((event, i) => ({ kind: "server", id: String(i), event: {
      type: "agent.event", taskId: "task", sessionId: session.id, role: "single", model: session.model, event: tool(event),
    } })));
  return buildNativeWork(items, status)[0];
};
const spawn: NativeWorkEvent = { type: "call", id: "call", name: "spawn_agent", at: start,
  input: { description: "跨日验证", model: "gpt-5.6-sol" } };
const launched: NativeWorkEvent = { type: "result", id: "call", at: start, result: '{"agent_id":"child"}', failed: false };
const completed: NativeWorkEvent = { type: "agent", id: "child", at: end, status: "completed", result: "完成" };
const running = rowFrom([spawn, launched]);
assert.equal(running.startedAt, start);
assert.equal(running.endedAt, undefined, "派活工具返回不等于子智能体结束");
assert.equal(running.model, "gpt-5.6-sol");
assert.equal(nativeWorkDuration(running, Date.parse(end)), "2分 5秒");
const done = rowFrom([spawn, launched, completed]);
assert.deepEqual(rowFrom([spawn, launched, completed], true), done, "实时流和刷新恢复的时间、模型保持一致");
assert.equal(done.endedAt, end);
assert.equal(nativeWorkDuration(done, Date.parse(later)), "2分 5秒", "完成后计时停止");
const closed = rowFrom([spawn, launched, completed, { type: "agent", id: "child", at: later, status: "stopped", closed: true }]);
assert.equal(closed.endedAt, end, "回收与重复终态不能延长执行跨度");
const missingEnd = rowFrom([spawn, launched, { ...completed, at: undefined },
  { type: "agent", id: "child", at: later, status: "stopped", closed: true }]);
assert.equal(missingEnd.endedAt, undefined, "缺失的结束时间不能用后来的回收时间补造");
const resumed = rowFrom([spawn, launched, completed, { type: "agent", id: "child", at: later, status: "running" }]);
assert.equal(resumed.startedAt, start);
assert.equal(resumed.endedAt, undefined, "恢复执行后清除旧结束时间");
const stale = rowFrom([spawn, launched], false, "done");
assert.equal(stale.status, "unknown");
assert.equal(stale.endedAt, undefined, "主任务结束不能冒充子任务结束");
assert.equal(nativeWorkDuration(stale, Date.parse(later)), "未记录");

for (const status of ["completed", "failed", "stopped"] as const) {
  const row = rowFrom([spawn, launched, { ...completed, status }]);
  assert.equal(row.endedAt, end);
  assert.equal(nativeWorkDuration(row, Date.parse(later)), "2分 5秒");
}
const reordered = rowFrom([spawn, { type: "agent", id: "child", at: end, status: "completed", model: "reported-model" }, launched]);
assert.equal(reordered.startedAt, start);
assert.equal(reordered.endedAt, end);
assert.equal(reordered.model, "reported-model", "native id 合并保留已上报的实际模型与时间");
const defaultModel = rowFrom([{ ...spawn, input: { description: "默认模型" } }, launched]);
assert.equal(defaultModel.model, "");
assert.equal(defaultModel.sessionModel, "gpt-5.6", "会话默认模型与子智能体已确认模型分开存放");

const historical = buildConversationItems([{ session, output: "", trace: [
  { at: start, event: { kind: "tool", name: "spawn_agent", nativeWork: { ...spawn, at: undefined } } },
  { at: start, event: { kind: "tool", name: "spawn_agent", nativeWork: { ...launched, at: undefined } } },
  { at: end, event: { kind: "tool", name: "Agent", nativeWork: { ...completed, at: undefined } } },
] }], [session], []);
assert.equal(buildNativeWork(historical, "done")[0].endedAt, end, "旧版结构化 trace 从持久事件时间还原");
assert.equal(buildNativeWork(historical, "done")[0].startedAt, start);
const legacy: ConversationItem = { kind: "agent", id: "old", sessionId: session.id, label: "旧会话", at: session.startedAt,
  markdown: "", segments: [{ id: "old", markdown: "", attachments: [], events: [
    { kind: "tool", label: "Agent", at: start, detail: '{"description":"旧任务"}' },
  ] }] };
assert.equal(buildNativeWork([legacy], "done")[0].startedAt, start);
legacy.segments[0].events[0].at = undefined;
assert.equal(buildNativeWork([legacy], "done")[0].startedAt, undefined, "没有时间时不拿来源会话开始时间补造");

const plan = (at: string, status: string): NativeWorkEvent => ({ type: "call", id: "plan", name: "update_plan", at,
  input: { plan: [{ step: "实现", status }] } });
assert.equal(rowFrom([plan(start, "in_progress"), plan(end, "completed")]).startedAt, start, "计划快照更新保留原始开始时间");
assert.equal(rowFrom([plan(start, "in_progress"), plan(end, "completed")]).endedAt, end);
const unknown = { ...done, startedAt: undefined };
assert.equal(nativeWorkDuration(unknown, Date.now()), "未记录");
assert.equal(nativeWorkDate("invalid"), null);
assert.equal(nativeWorkDuration({ ...done, startedAt: end, endedAt: start }, Date.now()), "未记录");
assert.equal(nativeWorkDuration({ ...done, endedAt: "2026-09-10T02:02:00.000Z" }, Date.now()), "1天 2小时 3分");

const reported = new NativeWorkTrace().claudeMessage({ type: "assistant", parent_tool_use_id: "child",
  message: { model: "claude-sonnet-4-6", content: [] } });
assert.ok(reported.some((event) => event.kind === "tool" && event.nativeWork?.type === "agent"
  && event.nativeWork.model === "claude-sonnet-4-6" && Number.isFinite(Date.parse(event.nativeWork.at!))));
console.log("子智能体模型、跨日耗时、实时/历史时间、恢复和缺失数据回归通过");
