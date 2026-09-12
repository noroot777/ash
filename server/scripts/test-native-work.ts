import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, Session } from "@ash/shared";
import { parseClaudeStream } from "../src/executors/claude.js";
import { parseCodexStream } from "../src/executors/codex.js";
import { openCodexAppServer } from "../src/executors/codex-app-server.js";
import { codexChildWork, codexNativeWork, codexSubAgentWork, NativeWorkTrace } from "../src/executors/native-work.js";
import { ClaudeChildActivity, CodexChildActivity } from "../src/executors/native-agent-activity.js";
import { parseSessionTrace } from "../src/transcript.js";
import { buildConversationItems, type TimelineEntry } from "../../web/src/task-detail/conversationModel.ts";
import { buildNativeWork } from "../../web/src/task-detail/nativeWorkModel.ts";
import { isVisibleExecutionEvent } from "../../web/src/lib/executionTrace.ts";
import { nativeAgentSegments } from "../../web/src/task-detail/nativeAgentSegments.ts";

const at = "2026-09-08T01:00:00.000Z";
const session = { id: "session", role: "single", agentType: "claude", executor: "claude@test", startedAt: at,
  endedAt: null, turnStartedAt: at, taskId: "test", usage: null, context: null } as Session;
const emit = (lines: unknown[]) => spawn(process.execPath, ["-e", "process.stdout.write(process.argv[1])", lines.map((line) => JSON.stringify(line)).join("\n") + "\n"], { stdio: ["ignore", "pipe", "pipe"] });
const assistant = (id: string, name: string, input: unknown, parent?: string) => ({ type: "assistant", parent_tool_use_id: parent,
  message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id: string, content: string, failed = false, parent?: string) => ({ type: "user", parent_tool_use_id: parent,
  message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: failed }] } });

const lines = [
  assistant("bash", "Bash", { command: "npm run build" }),
  { type: "system", subtype: "task_started", task_id: "bash-1", tool_use_id: "bash", task_type: "local_bash", is_backgrounded: false, description: "npm run build" },
  { type: "system", subtype: "task_progress", task_id: "bash-1", tool_use_id: "bash" },
  { type: "system", subtype: "task_notification", task_id: "bash-1", status: "completed", summary: "编译通过" },
  { type: "system", subtype: "task_started", task_id: "background-bash", tool_use_id: "bash-2", task_type: "local_bash", is_backgrounded: true },
  { type: "system", subtype: "task_notification", task_id: "background-bash", status: "completed" },
  assistant("a", "Agent", { description: "检查侧栏", prompt: "调研\n" + "完整说明".repeat(500), run_in_background: true }),
  result("a", "Async agent launched successfully.\nagentId: native-a"),
  { type: "system", subtype: "task_started", task_id: "native-a", tool_use_id: "a", description: "检查侧栏" },
  { type: "system", subtype: "task_progress", task_id: "native-a", tool_use_id: "a", description: "Running Read executorRunSummary and schema", last_tool_name: "Bash" },
  { type: "stream_event", parent_tool_use_id: "a", event: { type: "content_block_delta", delta: { type: "text_delta", text: "子智能体正文不能混入主回复\n" } } },
  { type: "assistant", parent_tool_use_id: "a", message: { content: [{ type: "text", text: "子智能体独立进展" }] } },
  assistant("child-task", "TaskCreate", { subject: "子智能体自己的清单", description: "说明" }, "a"),
  result("child-task", "Task #1 created successfully: 子智能体自己的清单", false, "a"),
  assistant("task", "TaskCreate", { subject: "主会话清单", description: "实施侧栏" }),
  result("task", "Task #1 created successfully: 主会话清单"),
  assistant("update", "TaskUpdate", { taskId: "1", status: "completed", owner: "主智能体" }),
  result("update", "Updated task #1 status"),
  assistant("bad-update", "TaskUpdate", { taskId: "1", status: "in_progress" }),
  result("bad-update", "Task update rejected", true),
  { type: "system", subtype: "task_notification", task_id: "native-a", status: "completed", summary: "已找到侧栏入口" },
  { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "主回复\n" } } },
  { type: "result", subtype: "success" },
];
const events: AgentEvent[] = [];
for await (const event of parseClaudeStream(emit(lines) as any)) events.push(event);
assert.equal(events.filter((event) => event.kind === "text").map((event) => event.text).join(""), "主回复\n");
const tools = events.filter((event): event is Extract<AgentEvent, { kind: "tool" }> => event.kind === "tool");
assert.equal(tools.filter((event) => event.name === "Bash").length, 1);
assert.ok(!tools.some((event) => event.nativeWork?.type === "agent" && event.nativeWork.nativeId?.includes("bash")), "前台/后台Bash状态通知都不是子智能体，也不增加执行过程工具行");
const timeline: TimelineEntry[] = tools.map((event, index) => ({ kind: "server", id: `live-${index}`, event: {
  type: "agent.event", taskId: "test", sessionId: session.id, agentType: "claude", executor: session.executor, event,
} }));
const live = buildNativeWork(buildConversationItems([], [session], timeline), "running");
assert.equal(live.length, 3, "工具结果和重复通知应更新原行");
assert.equal(live.find((row) => row.kind === "agent")?.status, "completed");
assert.equal(live.find((row) => row.kind === "agent")?.result, "已找到侧栏入口");
assert.equal(live.find((row) => row.kind === "agent")?.title, "检查侧栏", "进度描述不得覆盖派活标题");
assert.ok(live.find((row) => row.kind === "agent")!.description!.length > 1500, "完整派活说明不再被截成半截JSON");
assert.equal(live.find((row) => row.title === "主会话清单")?.status, "completed", "失败的TaskUpdate不得覆盖已确认状态");
assert.equal(live.find((row) => row.title === "子智能体自己的清单")?.status, "pending", "不同父智能体的task #1不串号");
assert.equal(live.find((row) => row.title === "子智能体自己的清单")?.parentId, "session:a");

const trace = parseSessionTrace(tools.map((event) => JSON.stringify({ event, at, turnStartedAt: at })).join("\n"));
const restored = buildNativeWork(buildConversationItems([{ session, output: "", trace }], [session], []), "running");
assert.deepEqual(restored, live, "真实落盘解析和刷新重建应与SSE一致");
const visible = tools.map((event) => ({ ...event, label: event.name })).filter(isVisibleExecutionEvent);
assert.equal(visible.filter((event) => event.name === "Agent").length, 1, "主执行过程仅保留一次派活工具调用");
assert.ok(visible.every((event) => !event.nativeWork || event.nativeWork.type === "call" && !event.nativeWork.parentId), "子智能体进度/结果及其内部任务只在侧栏呈现");

const tracker = new NativeWorkTrace();
const codexEvents = [
  ...codexNativeWork({ type: "collabAgentToolCall", tool: "spawnAgent", receiverThreadIds: ["c"], prompt: "搜索实现", status: "completed" }),
  ...codexNativeWork({ type: "collabAgentToolCall", tool: "wait", receiverThreadIds: ["c"], status: "completed" }),
];
assert.equal(codexEvents[0].kind === "tool" && codexEvents[0].nativeWork?.type === "agent" && codexEvents[0].nativeWork.status, "running",
  "spawn工具完成不等于子智能体完成");
const fromTools = (values: AgentEvent[]) => buildNativeWork(buildConversationItems([], [session], values.map((event, index) => ({ kind: "server", id: `c-${index}`,
  event: { type: "agent.event", taskId: "test", sessionId: session.id, agentType: "codex", event } }))), "running");
assert.equal(fromTools(codexEvents)[0].status, "running", "wait超时/缺状态不得虚构完成");
codexEvents.push(...codexNativeWork({ type: "collab_tool_call", tool: "wait", receiver_thread_ids: ["c"], agents_states: { c: { status: "completed", message: "找到实现" } } }));
assert.equal(fromTools(codexEvents)[0].status, "completed");
assert.equal(fromTools(codexEvents)[0].description, "搜索实现");
codexEvents.push(...codexNativeWork({ type: "collabAgentToolCall", tool: "closeAgent", receiverThreadIds: ["c"], status: "completed", agentsStates: { c: { status: "completed", message: "找到实现" } } }));
assert.equal(fromTools(codexEvents)[0].status, "completed", "正常回收保留子智能体完成状态");
assert.equal(fromTools(codexEvents)[0].message, undefined, "回收结果不重复贴成最近动态");
assert.equal(fromTools([...codexEvents, ...codexNativeWork({ type: "collabAgentToolCall", tool: "closeAgent", receiverThreadIds: ["c"], status: "completed" })])[0].status, "completed",
  "close缺少子状态时也不抹掉此前的完成状态");
assert.equal(fromTools(codexNativeWork({ type: "collabAgentToolCall", tool: "closeAgent", receiverThreadIds: ["interrupted"], status: "completed" }))[0].status, "stopped");
assert.equal(codexChildWork("turn/completed", { threadId: "child", turn: { status: "failed" } })[0].kind, "tool");

// codex 0.153+ 的派活通道:subAgentActivity。正文拿不到(上游加密),但名字、状态、父子关系都在。
const subAgent = (kind: string, threadId = "root", agentThreadId = "sub", agentPath = "/root/page_audit") =>
  codexSubAgentWork("item/started", { threadId, item: { type: "subAgentActivity", id: `call-${kind}`, kind, agentThreadId, agentPath } }, "root");
const spawnRow = fromTools(subAgent("started"))[0];
assert.equal(spawnRow.title, "page_audit", "派活那一刻就有真名字，不留一截线程 id");
assert.equal(spawnRow.status, "running");
assert.equal(spawnRow.description, "", "codex 的派活正文在上游已加密，不编造一份");
assert.equal(subAgent("started")[0].detail, "page_audit", "主会话那一行要看得出派的是谁");
assert.ok(subAgent("started").every((event) => isVisibleExecutionEvent({ ...event, label: event.name })),
  "主会话执行过程里要看得见「派出了谁」");
assert.equal(fromTools([...subAgent("started"), ...subAgent("completed")])[0].status, "completed");
assert.equal(fromTools([...subAgent("started"), ...subAgent("interrupted")])[0].status, "stopped");
assert.equal(fromTools([...subAgent("started"), ...subAgent("completed"), ...subAgent("interacted")])[0].status, "completed",
  "来回交互既不算开工也不算收工，不得把已完成的子智能体翻回进行中");
assert.deepEqual(subAgent("started", "sub", "root", "/root"), [], "子智能体反过来找主会话不是一条新工作");
const grandchild = fromTools([...subAgent("started"), ...subAgent("started", "sub", "grandchild", "/root/page_audit/deep")]);
assert.equal(grandchild.length, 2);
assert.equal(grandchild[1].parentId, `${session.id}:sub`, "孙子辈挂在它自己的上级身上");
assert.ok(!isVisibleExecutionEvent({ ...subAgent("started", "sub", "grandchild")[0], label: "spawn_agent" } as any),
  "子智能体内部的派活只在它自己的抽屉里，不冒到主会话");
assert.deepEqual(codexSubAgentWork("item/completed", { threadId: "root", item: { type: "subAgentActivity", kind: "completed", agentThreadId: "sub" } }, "root"), [],
  "started/completed 成对上报，只认一次免得重复建行");

// 两条派活记录同时在（subAgentActivity 给明文名字、spawn_agent 工具调用只有密文正文）:
// 合并时逐项挑好的那个，密文既不当标题也不当「收到的输入」。
const cipher = "gAAAAABqo_u_VtwGeVm-UUnyDT6WzBrO2w8cC0tvngRe22ckG80toEp82YynFdQxfkIMT3M4YHHi";
const ciphered = new NativeWorkTrace();
const bothChannels = fromTools([
  ciphered.call("spawn_agent", { message: cipher }, "cipher-call")!,
  ...subAgent("started", "root", "sub", "/root/page_audit"),
  ciphered.result("cipher-call", { agent_id: "sub" })!,
]);
assert.equal(bothChannels.length, 1, "同一次派活的两条记录合成一行");
assert.equal(bothChannels[0].title, "page_audit", "明文名字不得被密文正文盖掉");
assert.equal(bothChannels[0].description, "", "密文不是可展示的输入");
const cipherOnly = fromTools([
  ciphered.call("spawn_agent", { message: cipher }, "lonely-call")!,
  ciphered.result("lonely-call", { agent_id: "lonely" })!,
]);
assert.equal(cipherOnly[0].description, "", "只有密文时如实留空，由界面说明原因");
assert.equal(cipherOnly[0].title, "子智能体 lonely", "没有明文名字就退回占位标题，不拿密文当标题");

const plan = [tracker.call("update_plan", { plan: [{ step: "实现", status: "in_progress" }, { step: "验证", status: "pending" }] }, "p")!,
  tracker.call("update_plan", { plan: [{ step: "实现", status: "completed" }, { step: "验证", status: "in_progress" }] }, "p")!];
assert.deepEqual(fromTools(plan).map((row) => [row.title, row.status]), [["实现", "completed"], ["验证", "running"]]);
assert.equal(tracker.call("Bash", { command: "ls" }, "b"), null);
assert.equal(tracker.result("unrelated", "not native"), null);

const legacy = fromTools([{ kind: "tool", name: "Agent", detail: '{"description":"旧调研","prompt":"半截说明' },
  { kind: "tool", name: "TaskCreate", detail: '{"subject":"旧清单","description":"半截' }]);
assert.deepEqual(legacy.map((row) => [row.title, row.status, row.legacy]), [["旧调研", "unknown", true], ["旧清单", "unknown", true]]);
const legacyTasks = fromTools([
  ...Array.from({ length: 6 }, (_, i) => ({ kind: "tool" as const, name: "TaskCreate", detail: JSON.stringify({ subject: `旧任务${i + 1}`, description: `说明${i + 1}` }) })),
  ...Array.from({ length: 6 }, (_, i) => ({ kind: "tool" as const, name: "TaskUpdate", detail: JSON.stringify({ taskId: String(i + 1), status: "completed" }) })),
]);
assert.equal(legacyTasks.length, 6, "旧清单的创建与更新按顺序编号关联，不产生双份空壳");
assert.ok(legacyTasks.every((row, i) => row.title === `旧任务${i + 1}` && row.nativeId === String(i + 1) && row.status === "completed"));
const historicalSpawn = buildConversationItems([], [session], [
  { kind: "server", id: "spawn", event: { type: "agent.event", taskId: "test", sessionId: session.id, agentType: "codex", event: tracker.call("spawn_agent", { message: "历史后台子任务" }, "old-spawn")! } },
  { kind: "server", id: "spawn-result", event: { type: "agent.event", taskId: "test", sessionId: session.id, agentType: "codex", event: tracker.result("old-spawn", { agent_id: "old-native" })! } },
]);
historicalSpawn.forEach((item) => { if (item.kind === "agent") item.endedAt = at; });
assert.equal(buildNativeWork(historicalSpawn, "running")[0].status, "unknown", "spawn重编号保留所属历史回合结束标记");

const codexStream: AgentEvent[] = [];
for await (const event of parseCodexStream(emit([
  { type: "item.started", item: { type: "collab_tool_call", tool: "spawn_agent", receiver_thread_ids: ["cli-child"], prompt: "旧JSON通道" } },
  { type: "item.completed", item: { type: "collab_tool_call", tool: "wait", agents_states: { "cli-child": { status: "completed", message: "完成" } } } },
  { type: "turn.completed" },
]) as any, undefined, { stopRequested: false }, { initialThreadId: "", contextNotBeforeMs: Date.now() })) codexStream.push(event);
assert.equal(fromTools(codexStream)[0].status, "completed", "Codex exec JSON与App Server使用同一子智能体状态协议");

const imageDir = mkdtempSync(join(tmpdir(), "ash-native-attachments-"));
const sourceImage = join(imageDir, "child.svg");
const attachments: string[] = [];
try {
  writeFileSync(sourceImage, '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>');
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
  for await (const event of parseClaudeStream(emit([
    assistant("images", "Agent", { description: "截图" }),
    { type: "user", parent_tool_use_id: "images", message: { content: [{ type: "tool_result", tool_use_id: "read-image", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png } }] }] } },
    { type: "assistant", parent_tool_use_id: "images", message: { content: [{ type: "text", text: `![截图](${sourceImage})` }] } },
  ]) as any)) {
    assert.notEqual(event.kind, "attachment", "子智能体附件不混入主会话");
    if (event.kind === "tool" && event.nativeWork?.type === "activity" && event.nativeWork.event.kind === "attachment") attachments.push(event.nativeWork.event.path);
  }
  assert.equal(attachments.length, 2, "子智能体tool_result与Markdown图片均保留");
  assert.ok(attachments.every((path) => existsSync(path) && readFileSync(path).length > 0));
} finally {
  attachments.forEach((path) => rmSync(path, { force: true }));
  rmSync(imageDir, { recursive: true, force: true });
}

const app = openCodexAppServer({ bin: "codex", args: [], cwd: process.cwd(), prompt: "fixture", startProcess: () => spawn(process.execPath, ["-e", `
const rl = require('node:readline').createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: {} });
  if (m.method === 'thread/archive') send({ id: m.id, result: {} });
  if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'main' } } });
  if (m.method === 'turn/start') {
    send({ id: m.id, result: { turn: { id: 'turn' } } });
    send({ method: 'item/started', params: { threadId: 'main', item: { type: 'subAgentActivity', id: 'spawn', kind: 'started', agentThreadId: 'child', agentPath: '/root/verify_child' } } });
    send({ method: 'item/agentMessage/delta', params: { threadId: 'child', itemId: 'child-msg', delta: 'CHILD MUST STAY SEPARATE' } });
    send({ method: 'item/reasoning/summaryTextDelta', params: { threadId: 'child', itemId: 'child-reason', delta: '检查子会话隔离' } });
    send({ method: 'item/completed', params: { threadId: 'child', item: { type: 'reasoning', id: 'child-reason', summary: ['检查子会话隔离'] } } });
    send({ method: 'item/started', params: { threadId: 'child', item: { type: 'commandExecution', id: 'child-exec', command: 'npm run verify-child' } } });
    send({ method: 'item/completed', params: { threadId: 'child', item: { type: 'commandExecution', id: 'child-exec', aggregatedOutput: '验证成功', exitCode: 0 } } });
    send({ method: 'item/completed', params: { threadId: 'child', item: { type: 'agentMessage', id: 'child-msg', text: '子结果' } } });
    send({ method: 'turn/completed', params: { threadId: 'child', turn: { status: 'completed' } } });
    send({ method: 'item/completed', params: { threadId: 'main', item: { type: 'agentMessage', id: 'main-msg', text: '主回复仍继续' } } });
    send({ method: 'turn/completed', params: { threadId: 'main', turn: { status: 'completed' } } });
  }
});
`], { stdio: ["pipe", "pipe", "pipe"] }) });
const appEvents: AgentEvent[] = [];
for await (const event of app.events) appEvents.push(event);
assert.equal(appEvents.filter((event) => event.kind === "text").map((event) => event.text).join(""), "主回复仍继续\n\n");
assert.equal(appEvents.filter((event) => event.kind === "done").length, 1, "子线程结束不提前结束主回合");
assert.equal(fromTools(appEvents)[0].status, "completed");
const child = fromTools(appEvents)[0];
assert.equal(child.title, "verify_child", "App Server 的派活记录给子智能体一个真名字");
assert.equal(fromTools(appEvents).length, 1, "派活记录与子线程事件合成同一行，不建两份");
assert.equal(child.activity?.filter((event) => event.kind === "text").map((event) => event.text).join(""), "CHILD MUST STAY SEPARATE\n\n", "完整消息不重复追加已收到的流式正文");
assert.equal(child.activity?.filter((event) => event.kind === "thinking").map((event) => event.text).join(""), "检查子会话隔离\n\n");
assert.ok(child.activity?.some((event) => event.kind === "tool" && event.detail === "npm run verify-child"));
assert.ok(child.activity?.some((event) => event.kind === "tool" && event.detail?.includes("验证成功")));
const childTrace = parseSessionTrace(appEvents.filter((event) => event.kind === "tool").map((event) => JSON.stringify({ event, at, turnStartedAt: at })).join("\n"));
assert.deepEqual(buildNativeWork(buildConversationItems([{ session, output: "", trace: childTrace }], [session], []), "running"), [child], "子执行全文经过落盘解析后与实时会话一致");

const streaming = new CodexChildActivity();
const sendChild = (threadId: string, method: string, value: object) => streaming.notification(method, { threadId, ...value });
const interleaved = [
  ...sendChild("one", "item/agentMessage/delta", { itemId: "same", delta: "第一位" }),
  ...sendChild("two", "item/completed", { item: { type: "agentMessage", id: "same", text: "第二位" } }),
  ...sendChild("one", "item/agentMessage/delta", { itemId: "same", delta: "继续" }),
  ...sendChild("one", "item/completed", { item: { type: "agentMessage", id: "same", text: "第一位继续" } }),
  ...sendChild("one", "error", { error: { message: "子任务工具失败" } }),
];
const independent = fromTools(interleaved);
assert.equal(independent.length, 2);
assert.equal(nativeAgentSegments(independent[0].activity!)[0].markdown, "第一位继续\n\n");
assert.equal(nativeAgentSegments(independent[1].activity!)[0].markdown, "第二位\n\n", "相同item id的并行子线程互不影响");
assert.ok(nativeAgentSegments(independent[0].activity!).some((segment) => segment.events.some((event) => event.label === "子任务工具失败")));
assert.equal(fromTools([...codexChildWork("turn/completed", { threadId: "one", turn: { status: "completed" } }),
  ...codexChildWork("turn/started", { threadId: "one" })])[0].status, "running", "子智能体续跑及时恢复进行中状态");

const claudeChild = new ClaudeChildActivity();
const claudeMessages = [
  { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "流式正文" } } },
  { type: "assistant", message: { content: [{ type: "text", text: "流式正文" }, { type: "tool_use", id: "read", name: "Read", input: { file_path: "src/main.ts" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read", content: "文件内容" }] } },
  { type: "assistant", message: { content: [{ type: "thinking", thinking: "下一步分析" }, { type: "text", text: "没有delta也能显示" }] } },
].flatMap((message) => claudeChild.message({ ...message, parent_tool_use_id: "claude-child" }));
const claudeActivity = fromTools(claudeMessages)[0].activity!;
assert.equal(claudeActivity.filter((event) => event.kind === "text").map((event) => event.text).join(""), "流式正文\n\n没有delta也能显示\n\n");
assert.ok(claudeActivity.some((event) => event.kind === "tool" && event.name === "Read 结果" && event.detail === "文件内容"));
assert.ok(claudeActivity.some((event) => event.kind === "thinking" && event.text === "下一步分析"));
const earlyChild = fromTools([
  tracker.call("spawn_agent", { message: "先到的子消息" }, "early-spawn")!,
  ...sendChild("early-child", "item/completed", { item: { type: "agentMessage", id: "early", text: "已经开始" } }),
  ...codexChildWork("turn/completed", { threadId: "early-child", turn: { status: "completed" } }),
  tracker.result("early-spawn", { agent_id: "early-child" })!,
]);
assert.equal(earlyChild.length, 1, "派活结果晚到时合并已出现的子线程");
assert.equal(earlyChild[0].status, "completed");
assert.equal(earlyChild[0].activity?.filter((event) => event.kind === "text").map((event) => event.text).join(""), "已经开始\n\n");
console.log("子智能体解析、任务编号隔离、异步状态、计划更新、历史兼容与刷新一致性通过");
