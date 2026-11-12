// 压缩上下文不是它说的话（docs/ui-ux-audit run-9）：服务端插进正文的那两句引用在展示前摘出来，
// 换成执行过程里它发生的那个位置上的一步；压着时进行条那一行说「在压缩上下文」，压完并成一行。
// 跑:npm -w web run test:compaction-markers
import assert from "node:assert/strict";
import { COMPACTED, COMPACTING, liftCompactionMarkers } from "../src/task-detail/compactionMarkers.ts";
import { liveLabel, pastSummary } from "../src/lib/executionWords.ts";
import { hasExecutionNotice } from "../src/components/ExecutionTrace.tsx";

const agent = (markdown, events = []) => ({
  kind: "agent", id: "a", markdown, segments: [{ id: "s", markdown, events, attachments: [], awaiting: false }],
});
const lift = (item) => liftCompactionMarkers([item])[0];

// 压完：正文里一个字都不留，两段话之间并成一行「压缩了上下文」。
const done = lift(agent("先读一遍。\n> 正在压缩上下文…\n\n\n> 上下文已压缩。\n\n接着改。", [{ kind: "tool", label: "Bash", detail: "ls" }]));
assert.doesNotMatch(done.markdown, /压缩/, "复制整条回复时不带那两句");
assert.deepEqual(done.segments.map((segment) => segment.markdown.trim()), ["先读一遍。", "接着改。"]);
assert.deepEqual(done.segments[0].events, [{ kind: "notice", label: "压缩上下文", detail: COMPACTED }], "开始和压完并成一行");
assert.equal(done.segments[1].events[0].label, "Bash", "原来那一段的工具留在后面那段上");
assert.equal(done.segments[0].id, "s", "第一段保住原来的身份");
assert.equal(pastSummary(done.segments[0].events), COMPACTED, "只有压缩的那一段就说它");
assert.equal(hasExecutionNotice(done.segments[0].events), false, "压缩不让折叠条上琥珀");

// 压着：进行条那一行写「在压缩上下文」。
const live = lift(agent("先读一遍。\n> 正在压缩上下文…\n\n"));
assert.equal(live.segments.at(-2).events[0].detail, COMPACTING);
assert.equal(liveLabel(live.segments.at(-2).events, false), COMPACTING, "压着的时候进行条说这件事");

// 没有标记的回复原样返回（同一个对象，不触发重渲染）。
const plain = agent("没压缩。");
assert.equal(lift(plain), plain);
console.log("compaction markers ok");
