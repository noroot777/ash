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

// 等待状态由归约层维护(第 2 轮审查 F2):讨论回合的 text/events 都是整轮累积的,
// 「正文为空」「最后一条事件是提示」这类倒推在本轮早先说过话之后就永远失真。
const agentEvent = (event: AgentEvent): ServerEvent =>
  ({ type: "agent.event", taskId: "d1", sessionId: "ds1", role: "voiceA", event }) as ServerEvent;
let spoke = applyDuetEvent(emptyDuet(), { type: "duet.progress", taskId: "d1", round: 1, speaker: "A", phase: "start" } as ServerEvent);
spoke = applyDuetEvent(spoke, agentEvent({ kind: "text", text: "我先摆一下本轮的判断。" }));
spoke = applyDuetEvent(spoke, agentEvent({ kind: "tool", name: "Bash", detail: "{}" } as AgentEvent));
assert.equal(spoke.turns[0]!.awaiting, false, "还没出提示就说在等上游");
spoke = applyDuetEvent(spoke, agentEvent({ kind: "error", message: RETRY, level: "notice" }));
assert.equal(
  spoke.turns[0]!.awaiting,
  true,
  "本轮早先说过话,于是上游停摆时折叠条退回「智能体委派中」(F2)",
);
spoke = applyDuetEvent(spoke, agentEvent({ kind: "text", text: "上游回来了,接着说。" }));
assert.equal(spoke.turns[0]!.awaiting, false, "上游已经恢复输出,等待提示还常驻着");
spoke = applyDuetEvent(spoke, agentEvent({ kind: "error", message: RETRY, level: "notice" }));
spoke = applyDuetEvent(spoke, { type: "duet.progress", taskId: "d1", round: 1, speaker: "A", phase: "end" } as ServerEvent);
assert.equal(spoke.turns[0]!.awaiting, false, "回合都结束了还挂着「正在等上游」");

// ── 6) 「此刻还在等上游」由归约层按事件顺序维护,展示层只读那一位 ────────────────
// 折叠条上那句「正在重试」要常驻 —— 上游停摆十分钟时它是用户手上唯一的线索,退回成
// 「智能体委派中」正是 2026-09-24 要治的病。而解除条件必须准,两轮审查各错过一次:
// 恢复后的正文只进 markdown(第 1 轮 F2)、提示之前落的附件被当成了提示之后的恢复
// (第 3 轮 F2)。成品段落里正文/附件/事件是混在一起的累积结果,读不出谁先谁后,所以
// 判据只能在**写入那一刻**记下来 —— 下面全部走真实归约层,不手搓段落。
const liveSegments = (events: ReturnType<typeof live>[]) => {
  const built = buildConversationItems([], [session], events);
  const first = built[0] as Extract<(typeof built)[number], { kind: "agent" }>;
  return first.segments;
};
// 落盘重建路。第三个参数就是**服务端给的那一位**(`Session.awaitingUpstream`):重建不许
// 自己从 trace 末条反推,这一路的等待状态只能从它来(第 5 轮审查 F2,详见下面第 7 节)。
const tracedSegments = (
  events: (AgentEvent | { kind: string; [key: string]: unknown })[],
  output = "",
  awaiting?: boolean,
) => {
  const row = { ...session, ...(awaiting === undefined ? {} : { awaitingUpstream: awaiting }) };
  const built = buildConversationItems(
    [{ session: row, output, trace: events.map((event, index) => traced(event, 1_000 * (index + 1))) }],
    [row],
    [],
  );
  const first = built[0] as Extract<(typeof built)[number], { kind: "agent" }>;
  return first.segments;
};

const BASH = { kind: "tool", name: "Bash", detail: JSON.stringify({ command: "npm test" }) } as AgentEvent;
const NOTICE = { kind: "error", message: RETRY, level: "notice" } as AgentEvent;
const SHOT = { kind: "attachment", path: "/tmp/shot.png" } as unknown as AgentEvent;
// 直播路(SSE 边跑边追加)。
const stalled = [live("a1", BASH), live("a2", NOTICE)];
assert.equal(awaitingUpstream(liveSegments(stalled)), true, "重试提示刚到,此刻确实在等上游");
assert.equal(
  awaitingUpstream(liveSegments([...stalled, live("a3", { kind: "text", text: "上游恢复了,接着说。" })])),
  false,
  "上游已经恢复在流式输出正文了,折叠条还会一直写着「正在重试」(第 1 轮 F2)",
);
assert.equal(
  awaitingUpstream(liveSegments([...stalled, live("a4", { kind: "tool", name: "Read", detail: "{}" } as AgentEvent)])),
  false,
  "提示之后又调了工具,显然早就不在等了",
);
// **附件先到、随后才重试**:claude-stream 会从工具结果生成附件(executors/claude-stream.ts),
// 紧接着的下一次上游请求就可能重试。照「末段有附件就算恢复」判,这一下等待当场消失,
// 折叠条 3.6 秒后退回「执行过程 · 1 提示」,而上游其实还一个字都没回(第 3 轮审查 F2)。
assert.equal(
  awaitingUpstream(liveSegments([live("b1", SHOT), live("b2", NOTICE)])),
  true,
  "附件是提示之前的事,它不能把提示之后的等待解除掉(第 3 轮 F2)",
);
assert.equal(
  awaitingUpstream(liveSegments([live("b1", NOTICE), live("b2", SHOT)])),
  false,
  "提示之后落了附件,那是真的恢复输出",
);
assert.equal(awaitingUpstream([]), false);

// **用量不进执行过程,却是实打实的「上游回了话」**:直播只拿它记账、重建前又把它整条滤掉,
// 于是同一串事件在普通任务判「还在等」、在讨论判「已恢复」—— 同一件事两套口径(第 4 轮 N1)。
const USAGE = { kind: "usage", usage: { inputTokens: 12, outputTokens: 34 } } as unknown as AgentEvent;
assert.equal(
  awaitingUpstream(liveSegments([live("c1", BASH), live("c2", NOTICE), live("c3", USAGE)])),
  false,
  "用量都回来了(请求显然已经回话),直播还说在等上游(N1)",
);

// ── 7) 刷新重建:等待状态认服务端那一位,**一个字都不从 trace 反推**(第 5 轮审查 F2) ──
// 两份落盘产物的缓冲进度不一样:`.md` 边流边写,trace 的正文却攒在 `pendingTraceText` 里,
// 要等下一条非 text 事件或回合收口才落。于是「重试过、随后正常答完」的回合刷新时,`.md`
// 已经是完整答复、trace 还停在那条提示上 —— 照 trace 末条反推,那句「正在重试」就永久挂在
// 答案上方,正是这个任务要修的现象换到了重建这一路。
const RECOVERED = { kind: "text", text: "上游回来了,这是结论。" } as AgentEvent;
assert.equal(
  awaitingUpstream(tracedSegments([BASH, NOTICE])),
  false,
  "服务端说不在等了,重建却自己从 trace 的末条推出一个等待(第 5 轮 F2)",
);
assert.equal(
  awaitingUpstream(tracedSegments([BASH, NOTICE, USAGE])),
  false,
  "同上:trace 里有什么都不该左右这一位",
);
// 这一条是 F2 的现场:trace 停在提示上,而 .md 里恢复后的正文已经落全了。
assert.equal(
  awaitingUpstream(tracedSegments([BASH, NOTICE], "上游回来了,这是结论。")),
  false,
  "trace 落后于正文,重建据它判出了一个根本不存在的等待(第 5 轮 F2)",
);
// 反过来:服务端说**此刻还在等**,刷新之后那句「正在重试」必须还在(sticky)。
assert.equal(
  awaitingUpstream(tracedSegments([BASH, NOTICE], "", true)),
  true,
  "服务端说还在等上游,刷新一下那句「正在重试」就没了",
);
// 连「trace 里压根没有提示」都不影响它:判据是服务端按回合身份判出来的那一位,不是落盘产物。
assert.equal(
  awaitingUpstream(tracedSegments([BASH], "先说了半句。", true)),
  true,
  "服务端那一位没被带到重建出来的气泡上",
);
// 对齐失败那一路(部分写入 / 历史 trace):正文只能整块给,但「此刻还在不在等」不跟着丢。
const unaligned = tracedSegments(
  [BASH, { kind: "text", text: "trace 里这半句" } as AgentEvent, NOTICE],
  "库里那份正文跟 trace 对不上。",
  true,
);
assert.equal(unaligned.length, 1, "这份用例要的就是对不齐、退成一整段那一路");
assert.equal(awaitingUpstream(unaligned), true, "对不齐那一路把等待状态丢了");
// 落在**画得出东西**的末段上:折叠条先滤掉空段再取最后一段(AgentTurnBody),落错了就看不见。
const withBlankTail = tracedSegments(
  [{ kind: "text", text: "说完了。" } as AgentEvent, NOTICE, RECOVERED],
  "说完了。上游回来了,这是结论。",
  true,
);
assert.ok(withBlankTail.length >= 1);
assert.equal(awaitingUpstream(withBlankTail), true, "等待那一位落到了折叠条读不到的段上");

console.log("上游重试排在执行过程里它发生的那一步下面：落盘、直播、折叠、duet 四路一致，不标红，恢复输出(含只记账的用量)会解除等待；刷新重建认服务端那一位");
