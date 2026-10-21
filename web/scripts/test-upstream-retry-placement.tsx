// 上游重试这类**过程提示**排在哪里。
//
// 起因(用户 2026-10-21 反馈):它们从前走 `kind:"system"` 旁注,而那一路是**回合收口之后**
// 才补落盘的 —— 于是「上游返回 502,正在重试」一整串记录糊在会话结尾那一坨红框里,离它
// 真正发生的那一步隔着整篇回答。可重试成功之后这一轮压根没失败,结尾处根本不该有它。
//
// 现在它走 `kind:"error"` + `level:"notice"`,进 trace,于是落在执行过程里它发生的那个
// 位置(紧跟着上一条命令)。这份用例钉的就是这件事,四条路一起钉:落盘重建、直播追加、
// 回合折叠、duet —— 其中任何一条漏改,提示要么回到结尾,要么变回红色异常。
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentEvent, ServerEvent } from "@ash/shared";
import {
  ExecutionDetails,
  executionBlockTone,
  executionCountsLabel,
  hasExecutionError,
} from "../src/components/ExecutionTrace.tsx";
import { buildConversationItems } from "../src/task-detail/conversationModel.ts";
import type { AgentContentSegment } from "../src/task-detail/conversationModel.ts";
import { awaitingUpstream } from "../src/task-detail/conversationSegments.ts";
import { turnLayout } from "../src/task-detail/turnFold.ts";
import { applyDuetEvent, emptyDuet } from "../src/duet/duetState.ts";

const RETRY = "上游返回 502 server_error，正在重试（第 1/10 次，等 0.6 秒）";
const TURN_START = "2026-10-21T02:26:00.000Z";
const session = {
  id: "s1",
  taskId: "t1",
  agentType: "claude",
  executor: "claude@nodemach",
  role: "main",
  startedAt: TURN_START,
  endedAt: "2026-10-21T03:08:00.000Z",
  turnStartedAt: TURN_START,
  model: "claude-opus-5",
  reasoningEffort: "xhigh",
} as any;

// ── 1) 落盘重建:提示落在它发生的那一步下面,结尾一条都不留 ────────────────────
const traced = (event: AgentEvent | { kind: string; [key: string]: unknown }, offset: number) => ({
  at: new Date(Date.parse(TURN_START) + offset).toISOString(),
  turnStartedAt: TURN_START,
  event,
}) as any;
const trace = [
  traced({ kind: "text", text: "我先读审查报告。\n" }, 1_000),
  traced({ kind: "tool", name: "Bash", detail: JSON.stringify({ command: "ls -la round-1/" }) }, 2_000),
  traced({ kind: "error", message: RETRY, level: "notice" }, 3_000),
  traced({ kind: "tool", name: "Read", detail: JSON.stringify({ file_path: "/repo/server/src/runs.ts" }) }, 4_000),
  traced({ kind: "text", text: "改完了，验证全绿。" }, 5_000),
];
const output = "我先读审查报告。\n改完了，验证全绿。";
const items = buildConversationItems([{ session, output, trace }], [session], []);
assert.deepEqual(
  items.map((item) => item.kind),
  ["agent"],
  "重试提示又跑回会话结尾了（多出来的 event 条目就是那一坨红框）",
);

const agent = items[0] as Extract<(typeof items)[number], { kind: "agent" }>;
const events = agent.segments.flatMap((segment) => segment.events);
assert.deepEqual(
  events.map((event) => `${event.kind}:${event.label}`),
  ["tool:Bash", "notice:提示", "tool:Read"],
  "提示没有紧跟在它发生的那条命令下面",
);
assert.equal(events[1]!.detail, RETRY, "提示的正文走 detail（label 那一格不收缩，长句会把整行撑爆）");
assert.equal(agent.markdown, output, "正文一个字都不许被这条提示挤掉");

// ── 2) 它是提示不是异常:不计异常数、折叠条不标红 ──────────────────────────────
assert.equal(executionCountsLabel(events), "执行过程 · 2 工具 · 1 提示");
assert.equal(hasExecutionError(events), false, "一次可恢复的重试把成功回合标成了有异常");
assert.equal(executionBlockTone(events), " has-notice");
assert.equal(
  executionBlockTone([...events, { kind: "error", label: "真崩了" }]),
  " has-error",
  "真出故障时红色必须压过琥珀",
);
const markup = renderToStaticMarkup(<ExecutionDetails events={events} running={false} />);
assert.ok(markup.includes("task-tool-line--notice"), "提示行没拿到自己那身琥珀");
assert.ok(markup.includes(RETRY), "展开执行过程看不到重试说了什么");
assert.ok(!markup.includes("has-error"), "折叠条被一次重试标成了红的");

// ── 3) 直播:同样追加进那颗气泡的执行过程，不在底下单独横一条 ──────────────────
const live = (id: string, event: AgentEvent) => ({
  kind: "server" as const,
  id,
  event: { taskId: "t1", sessionId: "s1", agentType: "claude", event } as any,
});
const liveItems = buildConversationItems([], [session], [
  live("l1", { kind: "tool", name: "Bash", detail: JSON.stringify({ command: "npm test" }) }),
  live("l2", { kind: "error", message: RETRY, level: "notice" }),
  live("l3", { kind: "text", text: "继续。" }),
]);
assert.deepEqual(liveItems.map((item) => item.kind), ["agent"], "直播到的重试提示又单独成了一行旁注");
const liveAgent = liveItems[0] as Extract<(typeof liveItems)[number], { kind: "agent" }>;
assert.deepEqual(
  liveAgent.segments.flatMap((segment) => segment.events).map((event) => event.kind),
  ["tool", "notice"],
  "直播那一路没把提示并进执行过程",
);

// ── 4) 回合折叠:提示不是「动手」，不能被当成切点 ──────────────────────────────
// 切点落在**最后一次真正动手**的那一步上，它之前的正文折进过程、之后的留在外面。提示
// 讲的恰恰是「什么都没发生」——拿它当切点，上游抽风那一下之前说过的话就全被折没了。
const folded = turnLayout(
  [
    { id: "f0", markdown: "边干边说的那一段。\n", events: [{ kind: "tool", label: "Bash" }], attachments: [] },
    { id: "f1", markdown: "", events: [{ kind: "notice", label: "提示", detail: RETRY }], attachments: [] },
    { id: "f2", markdown: "这是结论。", events: [], attachments: [] },
  ],
  { live: false },
);
assert.equal(
  folded.conclusion.map((segment) => segment.markdown).join(""),
  "边干边说的那一段。\n这是结论。",
  "一次上游重试被当成了动手，把它之前说过的话折进了执行过程",
);

// ── 5) duet:提示进执行过程，不能把一场正常收敛的讨论判失败 ────────────────────
let duet = applyDuetEvent(emptyDuet(), { type: "duet.progress", taskId: "d1", round: 1, speaker: "A", phase: "start" } as ServerEvent);
duet = applyDuetEvent(duet, { type: "agent.event", taskId: "d1", sessionId: "ds1", role: "voiceA", event: { kind: "error", message: RETRY, level: "notice" } } as ServerEvent);
assert.equal(duet.turns[0]!.error, undefined, "一次上游重试把整场讨论判成了失败");
assert.deepEqual(duet.turns[0]!.events.map((event) => event.kind), ["notice"]);

// ── 6) 「此刻还在等上游」只认恢复输出,不认「最后一条事件是提示」 ────────────────
// 折叠条上那句「正在重试」要常驻 —— 上游停摆十分钟时它是用户手上唯一的线索,退回成
// 「智能体委派中」正是 2026-09-24 要治的病。代价是解除条件必须准:恢复后接着流式输出的
// 正文只进 markdown、压根不进 events,照「最后一条事件是提示」判就会在已经恢复回答之后
// 还一直写着正在重试,直到下一次工具调用(第 1 轮审查 F2)。
const seg = (over: Partial<AgentContentSegment>): AgentContentSegment =>
  ({ id: "s", markdown: "", events: [], attachments: [], ...over });
const notice = { kind: "notice" as const, label: "提示", detail: RETRY };
const bash = { kind: "tool" as const, label: "Bash" };
assert.equal(
  awaitingUpstream([seg({ events: [bash, notice] })]),
  true,
  "提示之后一个字都还没说出来,这时就是在等上游 —— 折叠条该把那句话留着",
);
assert.equal(
  awaitingUpstream([seg({ events: [bash, notice], markdown: "上游已经恢复，这是恢复后的正文。" })]),
  false,
  "正文已经恢复,折叠条还会一直写着「正在重试」(F2)",
);
assert.equal(
  awaitingUpstream([seg({ events: [notice, { kind: "tool", label: "Read" }] })]),
  false,
  "提示之后又调了工具,显然早就不在等了",
);
assert.equal(
  awaitingUpstream([seg({ events: [notice], attachments: ["/tmp/shot.png"] })]),
  false,
  "提示之后落了附件,同样是恢复输出",
);
assert.equal(awaitingUpstream([]), false);
assert.equal(
  awaitingUpstream([seg({ id: "a", events: [notice] }), seg({ id: "b", events: [bash] })]),
  false,
  "上一段里的提示是历史记录,不是此刻的状态 —— 只看最后那一段",
);

// 同一条判据接到**真的直播段落**上:上面那几条是手搓的段,这里走一遍 buildConversationItems,
// 确认恢复回来的正文真的落在提示那一段里(appendAgentAux 只在当前段已有正文时才另起一段)。
const liveSegments = (events: ReturnType<typeof live>[]) => {
  const built = buildConversationItems([], [session], events);
  const first = built[0] as Extract<(typeof built)[number], { kind: "agent" }>;
  return first.segments;
};
const stalled = [
  live("a1", { kind: "tool", name: "Bash", detail: JSON.stringify({ command: "npm test" }) }),
  live("a2", { kind: "error", message: RETRY, level: "notice" }),
];
assert.equal(awaitingUpstream(liveSegments(stalled)), true, "重试提示刚到,此刻确实在等上游");
assert.equal(
  awaitingUpstream(liveSegments([...stalled, live("a3", { kind: "text", text: "上游恢复了,接着说。" })])),
  false,
  "上游已经恢复在流式输出正文了,折叠条还会一直写着「正在重试」(F2)",
);

console.log("上游重试排在执行过程里它发生的那一步下面：落盘、直播、折叠、duet 四路一致，不标红，且恢复输出会解除等待");
