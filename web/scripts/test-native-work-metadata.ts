import assert from "node:assert/strict";
import type { AgentEvent, NativeWorkEvent, Session } from "@ash/shared";
import { codexChildWork, codexNativeWork, nativePlanSnapshot, NativeWorkTrace } from "../../server/src/executors/native-work.ts";
import { childActivity } from "../../server/src/executors/native-agent-activity.ts";
import { buildConversationItems, type ConversationItem } from "../src/task-detail/conversationModel.ts";
import { buildNativeWork } from "../src/task-detail/nativeWorkModel.ts";
import { nativeWorkDate, nativeWorkDuration } from "../src/task-detail/nativeWorkTiming.ts";

const start = "2026-09-08T23:59:00.000Z";
const end = "2026-09-09T00:01:05.000Z";
const later = "2026-09-09T01:00:00.000Z";
const session = { id: "meta", taskId: "task", role: "single", agentType: "codex", executor: "codex@test",
  model: "gpt-5.6", startedAt: "2026-09-08T23:00:00.000Z", endedAt: null } as Session;
const rowsFrom = (events: NativeWorkEvent[], persisted = false, status: "running" | "done" = "running") => {
  const tool = (nativeWork: NativeWorkEvent): AgentEvent => ({ kind: "tool", name: "Agent", nativeWork });
  const items = persisted
    ? buildConversationItems([{ session, output: "", trace: events.map((event) => ({ at: event.at!, event: tool(event) })) }], [session], [])
    : buildConversationItems([], [session], events.map((event, i) => ({ kind: "server", id: String(i), event: {
      type: "agent.event", taskId: "task", sessionId: session.id, role: "single", model: session.model, event: tool(event),
    } })));
  return buildNativeWork(items, status);
};
const rowFrom = (...args: Parameters<typeof rowsFrom>) => rowsFrom(...args)[0];
const spawn: NativeWorkEvent = { type: "call", id: "call", name: "spawn_agent", at: start,
  input: { description: "跨日验证", model: "gpt-5.6-sol" } };
const launched: NativeWorkEvent = { type: "result", id: "call", at: start, result: '{"agent_id":"child"}', failed: false };
const completed: NativeWorkEvent = { type: "agent", id: "child", at: end, status: "completed", result: "完成" };
const running = rowFrom([spawn, launched]);
assert.equal(running.startedAt, start);
assert.equal(running.endedAt, undefined, "派活工具返回不等于子智能体结束");
assert.equal(running.model, undefined, "调用参数不能冒充运行记录");
assert.equal(running.requestedModel, "gpt-5.6-sol");
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
assert.equal(defaultModel.model, undefined);
assert.equal("sessionModel" in defaultModel, false, "子智能体不借用主会话模型");

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
for (const persisted of [false, true]) {
  for (const name of ["TodoWrite", "update_plan"]) {
    const snapshot = (at: string, statuses: string[]): NativeWorkEvent => ({ type: "call", id: "snapshot", name, at,
      input: name === "TodoWrite" ? { todos: statuses.map((status, i) => ({ content: `步骤 ${i}`, status })) }
        : { plan: statuses.map((status, i) => ({ step: `步骤 ${i}`, status })) } });
    const initial = snapshot(start, ["completed", "in_progress", "pending", "pending"]);
    const initialRows = rowsFrom([initial], persisted);
    assert.equal(initialRows[0].startedAt, undefined, "首次记录即完成的步骤不能补造开始时间");
    assert.equal(initialRows[0].endedAt, start);
    assert.equal(nativeWorkDuration(initialRows[0], Date.parse(later)), "未记录");
    assert.equal(initialRows[1].startedAt, start);
    for (const row of initialRows.slice(2)) {
      assert.equal(row.startedAt, undefined, "快照中的待处理步骤尚未开始");
      assert.equal(row.endedAt, undefined);
      assert.equal(nativeWorkDuration(row, Date.parse(later)), "未记录", "待处理步骤不计算实时跨度");
    }
    const next = snapshot(end, ["completed", "completed", "in_progress", "pending"]);
    const nextRows = rowsFrom([initial, next], persisted);
    assert.equal(nextRows[1].startedAt, start);
    assert.equal(nextRows[1].endedAt, end);
    assert.equal(nextRows[2].startedAt, end, "开始时间来自真正转为运行中的快照");
    assert.equal(nextRows[3].startedAt, undefined);
    const finished = rowsFrom([initial, next, snapshot(later, ["completed", "completed", "completed", "pending"])], persisted);
    assert.equal(finished[2].startedAt, end);
    assert.equal(finished[2].endedAt, later);
    assert.equal(nativeWorkDuration(finished[2], Date.parse(later)), "58分 55秒");
  }
  const created: NativeWorkEvent[] = [
    { type: "call", id: "create", name: "TaskCreate", at: start, input: { subject: "等候开工" } },
    { type: "result", id: "create", at: start, result: '{"task":{"id":"17"}}', failed: false },
  ];
  assert.equal(rowFrom(created, persisted).startedAt, undefined, "TaskCreate 的时间不是开工时间");
  const started = [...created,
    { type: "call", id: "update", name: "TaskUpdate", at: end, input: { taskId: "17", status: "in_progress" } } as NativeWorkEvent,
    { type: "result", id: "update", at: end, result: "updated", failed: false } as NativeWorkEvent,
  ];
  assert.equal(rowFrom(started, persisted).startedAt, end);
  const finished = rowFrom([...started,
    { type: "call", id: "finish", name: "TaskUpdate", at: later, input: { taskId: "17", status: "completed" } },
    { type: "result", id: "finish", at: later, result: "updated", failed: false },
  ], persisted);
  assert.equal(finished.startedAt, end);
  assert.equal(finished.endedAt, later);
  assert.equal(nativeWorkDuration(finished, Date.parse(later)), "58分 55秒");
}
const queuedAgent: NativeWorkEvent = { type: "agent", id: "queued-agent", status: "pending", at: start };
assert.equal(rowFrom([queuedAgent]).startedAt, undefined);
assert.equal(rowFrom([queuedAgent, { ...queuedAgent, status: "running", at: end }]).startedAt, end);
assert.equal(nativeWorkDuration({ ...running, status: "pending" }, Date.parse(later)), "未记录", "即便带有早期开始时间，待处理状态也不继续计时");
const finalEnd = "2026-09-09T10:00:00.000Z";
const multipleTurns = rowFrom([spawn, launched, completed,
  { type: "agent", id: "child", at: "2026-09-09T09:00:00.000Z", status: "running" },
  { ...completed, at: finalEnd },
]);
assert.equal(multipleTurns.startedAt, start);
assert.equal(multipleTurns.endedAt, finalEnd);
assert.equal(nativeWorkDuration(multipleTurns, Date.parse(finalEnd)), "10小时 1分", "显示首末时间跨度，包含两轮之间的空闲");
const unknown = { ...done, startedAt: undefined };
assert.equal(nativeWorkDuration(unknown, Date.now()), "未记录");
assert.equal(nativeWorkDate("invalid"), null);
assert.equal(nativeWorkDuration({ ...done, startedAt: end, endedAt: start }, Date.now()), "未记录");
assert.equal(nativeWorkDuration({ ...done, endedAt: "2026-09-10T02:02:00.000Z" }, Date.now()), "1天 2小时 3分");

const reported = new NativeWorkTrace().claudeMessage({ type: "assistant", parent_tool_use_id: "child",
  message: { model: "claude-sonnet-4-6", content: [] } });
assert.ok(reported.some((event) => event.kind === "tool" && event.nativeWork?.type === "agent"
  && event.nativeWork.model === "claude-sonnet-4-6" && Number.isFinite(Date.parse(event.nativeWork.at!))));
const tracker = new NativeWorkTrace();
const stamped = [
  tracker.call("Agent", { description: "验证时间戳" }, "stamp"), tracker.result("stamp", "完成"),
  nativePlanSnapshot("plan", [{ step: "验证", status: "pending" }]),
  ...codexNativeWork({ type: "todo_list", id: "todos", items: [{ text: "验证", completed: false }] }),
  ...codexNativeWork({ type: "collab_tool_call", tool: "spawnAgent", receiver_thread_ids: ["child"], status: "completed" }),
  ...codexChildWork("turn/started", { threadId: "child" }),
  ...codexChildWork("turn/completed", { threadId: "child", turn: { status: "completed" } }),
  childActivity("child", { kind: "text", text: "执行记录" }), ...reported,
];
assert.equal(stamped.length, 9);
for (const event of stamped) {
  assert.ok(event?.kind === "tool" && event.nativeWork?.at && Number.isFinite(Date.parse(event.nativeWork.at)),
    "各 nativeWork 生产路径在进入实时流前均提供有效时间戳");
}
console.log("子智能体模型、待办开工时间、跨日跨度、实时/历史时间与缺失数据回归通过");
