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
const previousSession = { ...session, id: "previous", endedAt: end };
const currentSession = { ...session, id: "current", startedAt: later };
const historyTrace = (events: NativeWorkEvent[]) => events.map((nativeWork) => ({
  at: nativeWork.at!, event: { kind: "tool" as const, name: "Agent", nativeWork },
}));
const allHistory = buildConversationItems([
  { session: previousSession, output: "", trace: historyTrace([spawn, launched, completed]) },
  { session: currentSession, output: "", trace: historyTrace([{ ...spawn, at: later }, { ...launched, at: later }]) },
], [previousSession, currentSession], []);
const historyRows = buildNativeWork(allHistory, "running");
assert.equal(historyRows.length, 2, "同一任务的历史和当前会话子智能体同时保留");
assert.equal(historyRows.find((row) => row.sessionId === "previous")?.status, "completed");
assert.equal(historyRows.find((row) => row.sessionId === "current")?.status, "running");
assert.equal(buildNativeWork(JSON.parse(JSON.stringify(allHistory)), "done").length, 2, "任务结束后历史记录仍可重建");

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
// message/result(快照式正文)的图片记录带 `field`,必须路由到 messageImages/resultImages,
// 不许混进 row.activity(混进去 = 执行记录文档多一条结果,逐目的地对账整组作废)。
{
  const fieldShot = (field: "message" | "result", source: string, path: string, rev = 0, ref = 0): NativeWorkEvent =>
    ({ type: "activity", id: "child", event: { kind: "attachment", field, source, ref, pos: 3, rev, path } });
  const row = rowFrom([
    spawn, launched,
    { type: "activity", id: "child", event: { kind: "text", text: "执行:![k](k.png)\n\n" } },
    { type: "activity", id: "child", event: { kind: "attachment", source: "k.png", ref: 0, pos: 3, path: "/up/k.png" } },
    fieldShot("message", "m.png", "/up/m.png"),
    fieldShot("result", "r.png", "/up/r.png"),
    { ...completed, message: "说明 ![m](m.png)", result: "结果 ![r](r.png)" },
  ]);
  assert.deepEqual(row.messageImages, [{ path: "/up/m.png", source: "m.png", ref: 0, pos: 3, lost: undefined }]);
  assert.deepEqual(row.resultImages, [{ path: "/up/r.png", source: "r.png", ref: 0, pos: 3, lost: undefined }]);
  assert.deepEqual(
    (row.activity ?? []).filter((event) => event.kind === "attachment"),
    [{ kind: "attachment", source: "k.png", ref: 0, pos: 3, path: "/up/k.png" }],
    "field 记录不进执行记录;无 field 的照旧",
  );
  // 记录先于 agent_id 解析到达(挂在 spawn 调用行上)时,行合并后账要跟着走。
  const early = rowFrom([
    spawn,
    { type: "activity", id: "call", event: { kind: "attachment", field: "message", source: "m.png", ref: 0, pos: 0, path: "/up/m.png" } },
    launched,
    { ...completed, message: "![m](m.png)" },
  ]);
  assert.deepEqual(early.messageImages?.map((shot) => shot.source), ["m.png"], "行合并时 field 账跟着搬到 native id 名下");
}

// 代(rev)分组:正文清场/换稿开新代之后,旧代记录说的是已经不在屏幕上的那一版 ——
// 展示端只认最高代那组(审查第 8 轮复审 R1 同线程继续一例:旧代红图顶掉新代蓝图)。
{
  const fieldShot = (rev: number, ref: number, path: string): NativeWorkEvent =>
    ({ type: "activity", id: "child", event: { kind: "attachment", field: "result", source: "shot.png", ref, pos: 6, rev, path } });
  const row = rowFrom([
    spawn, launched,
    fieldShot(0, 0, "/up/rev0.png"),
    fieldShot(1, 1, "/up/rev1.png"),
    { ...completed, result: "续说 ![蓝](shot.png)" },
  ]);
  assert.deepEqual(row.resultImages?.map((shot) => shot.path), ["/up/rev1.png"], "只认最高代:旧代冻结不混进当前正文");
}
// 结果正文从调用行提取到子行时(taskoutput / wait 的 statuses),它名下的 result 图片记录
// 按目的地跟着搬 —— 留在调用行就永远配不上正文(复审 R1 结构化返回结果一例)。
{
  const rows = rowsFrom([
    { type: "agent", id: "child", nativeId: "17", at: start, status: "running" },
    { type: "call", id: "out", name: "taskoutput", at: end, input: { task_id: "17" } },
    { type: "activity", id: "out", event: { kind: "attachment", field: "result", source: "o.png", ref: 0, pos: 2, rev: 0, path: "/up/o.png" } },
    { type: "result", id: "out", at: end, result: "<status>completed</status><output>瞧 ![o](o.png)</output>", failed: false },
  ]);
  const child = rows.find((row) => row.nativeId === "17");
  assert.deepEqual(child?.resultImages?.map((shot) => shot.source), ["o.png"], "taskoutput 提取正文到子行,图片记录跟着搬");
  const statusRows = rowsFrom([
    { type: "call", id: "w", name: "wait", at: start, input: {} },
    { type: "activity", id: "w", event: { kind: "attachment", field: "result", source: "s.png", ref: 0, pos: 2, rev: 0, path: "/up/s.png" } },
    { type: "result", id: "w", at: end, result: '{"statuses":{"childA":{"completed":"甲 ![s](s.png)"},"childB":{"completed":"乙"}}}', failed: false },
  ]);
  const hit = statusRows.find((row) => row.nativeId === "childA");
  const miss = statusRows.find((row) => row.nativeId === "childB");
  assert.deepEqual(hit?.resultImages?.map((shot) => shot.source), ["s.png"], "statuses 按正文含来源与否逐行分发");
  assert.equal(miss?.resultImages, undefined, "正文里没有这个来源的行不接收");
  // 第 9 轮复审 R1 resultRouting:几个子正文引用同一来源时,按「第 n 处引用 ↔ 第 n 条
  // 记录」分发 —— 全给第一个命中的,甲拿双份被逐目的地计数判作废、乙一张都没有。
  const sharedRows = rowsFrom([
    { type: "call", id: "w2", name: "wait", at: start, input: {} },
    { type: "activity", id: "w2", event: { kind: "attachment", field: "result", source: "shot.svg", ref: 0, pos: 10, rev: 0, path: "/up/a.svg" } },
    { type: "activity", id: "w2", event: { kind: "attachment", field: "result", source: "shot.svg", ref: 1, pos: 50, rev: 0, path: "/up/b.svg" } },
    { type: "result", id: "w2", at: end, result: '{"statuses":{"childA":{"completed":"甲 ![甲](shot.svg)"},"childB":{"completed":"乙 ![乙](shot.svg)"}}}', failed: false },
  ]);
  assert.deepEqual(sharedRows.find((row) => row.nativeId === "childA")?.resultImages?.map((shot) => shot.path), ["/up/a.svg"], "同源多记录:第一处给第一个子正文一条");
  assert.deepEqual(sharedRows.find((row) => row.nativeId === "childB")?.resultImages?.map((shot) => shot.path), ["/up/b.svg"], "第二处给第二个子正文,不叠给第一个");
  // 槽位按来源文档顶替:第二轮 wait 的新正文接管子行 result 后,上一轮的记录不许留在槽里
  // 跟新记录比代号 —— rev 是各来源文档局部的,混在一起取最大会让旧文档的高代吞掉新文档。
  const twoRounds = rowsFrom([
    { type: "call", id: "w3", name: "wait", at: start, input: {} },
    { type: "activity", id: "w3", event: { kind: "attachment", field: "result", source: "s.png", ref: 0, pos: 2, rev: 5, path: "/up/old.png" } },
    { type: "result", id: "w3", at: start, result: '{"statuses":{"childC":{"completed":"旧 ![s](s.png)"}}}', failed: false },
    { type: "call", id: "w4", name: "wait", at: end, input: {} },
    { type: "activity", id: "w4", event: { kind: "attachment", field: "result", source: "s.png", ref: 1, pos: 2, rev: 0, path: "/up/new.png" } },
    { type: "result", id: "w4", at: end, result: '{"statuses":{"childC":{"completed":"新 ![s](s.png)"}}}', failed: false },
  ]);
  assert.deepEqual(twoRounds.find((row) => row.nativeId === "childC")?.resultImages?.map((shot) => shot.path), ["/up/new.png"], "换来源文档整组顶替:旧文档的高代号不压新文档的第 0 代");
}
console.log("子智能体模型、待办开工时间、跨日跨度、实时/历史时间与缺失数据回归通过");
