// 压缩上下文不是它说的话（docs/ui-ux-audit run-9）：它是执行过程里它发生的那个位置上的一步；
// 压着时进行条那一行说「在压缩上下文」，压完并成一行。
//
// 来源只认结构化事件（error 事件上的 compaction）。正文里出现同一句——智能体在解释压缩日志、
// 代码块里引了原文——一个字都不许动，也不许凭空说「在压缩」（第 1 轮审查 F1）。旧会话那一串
// 只在 trace 里整条正文恰好就是它时才认，而且换成步骤之后**原来的先后不变**。
// 跑:npm -w web run test:compaction-markers
import assert from "node:assert/strict";
import { COMPACTED, COMPACTING, stripLegacyCompaction } from "../src/lib/compaction.ts";
import { liveLabel, pastSummary } from "../src/lib/executionWords.ts";
import { hasExecutionNotice } from "../src/components/ExecutionTrace.tsx";
import { awaitingAfterEvent, contentSegments, legacyCompactionCount } from "../src/task-detail/conversationSegments.ts";
import { latestRunFacts } from "../src/task-detail/info/infoRunFacts.ts";

const at = (second) => `2026-11-12T10:00:${String(second).padStart(2, "0")}.000Z`;
const text = (value, second) => ({ at: at(second), event: { kind: "text", text: value } });
const tool = (name, detail, second) => ({ at: at(second), event: { kind: "tool", name, detail } });
const compaction = (phase, second) => ({
  at: at(second),
  event: phase === "failed"
    ? { kind: "error", message: "上下文压缩失败，会话大小原地不动：503", affectsTurn: false, compaction: phase }
    : { kind: "error", message: phase === "start" ? "正在压缩上下文" : "上下文已压缩", level: "notice", affectsTurn: false, compaction: phase },
});
/** 落盘那一路：`.md` 先按 trace 认出来的旧标记摘一遍，再分段（conversationModel 同一个顺序）。 */
const rebuild = (trace, md) => {
  const body = stripLegacyCompaction(md, legacyCompactionCount(trace));
  return { body, segments: contentSegments(trace, body, "t") };
};
const stepsOf = (segments) => segments.flatMap((segment) => segment.events.map((event) => event.kind === "tool" ? event.label : event.detail ?? event.label));
const agentItem = (segments, endedAt = null) => ({ kind: "agent", id: "a", markdown: "", endedAt, segments });

// ① 智能体自己引了那句（代码块里、正文里）：正文原样，不长出压缩那一步，也不说「在压缩」。
{
  const md = "压缩日志长这样：\n\n```text\n> 正在压缩上下文…\n```\n\n还有一句 > 正在压缩上下文… 也是原文。";
  const trace = [text(md, 1)];
  const { body, segments } = rebuild(trace, md);
  assert.equal(body, md, "智能体写的正文一个字都不摘");
  assert.equal(segments.map((segment) => segment.markdown).join(""), md, "分段拼回去仍是原文");
  assert.equal(stepsOf(segments).length, 0, "正文里的同一句不是压缩事件");
  assert.equal(latestRunFacts([agentItem(segments)]).compacting, false, "引一句不等于正在压缩");
}

// ② 真压缩（结构化事件）：Read 先发生就排在前面，压缩那一步在两段正文之间，正文里没有那两句。
{
  const trace = [text("先看看文件。", 1), tool("Read", '{"file_path":"before.ts"}', 2), text("\n\n读完了。", 3), compaction("start", 4), compaction("done", 5), text("完成。", 6)];
  const md = "先看看文件。\n\n读完了。完成。";
  const { segments } = rebuild(trace, md);
  assert.deepEqual(stepsOf(segments), ["Read", COMPACTED], "先读文件、后压缩，开始和压完并成一行");
  const readAt = segments.findIndex((segment) => segment.events.some((event) => event.label === "Read"));
  const compactAt = segments.findIndex((segment) => segment.events.some((event) => event.detail === COMPACTED));
  assert.ok(readAt >= 0 && readAt < compactAt, "Read 那一步不许被挪到压缩之后");
  assert.doesNotMatch(segments.map((segment) => segment.markdown).join(""), /压缩/, "正文里没有压缩那两句");
  const only = segments[compactAt].events;
  assert.equal(pastSummary(only), COMPACTED, "只有压缩的那一段就说它");
  assert.equal(hasExecutionNotice(only), false, "压缩不让折叠条上琥珀");
}

// ③ 压着：进行条说「在压缩上下文」，信息格知道在压；压缩不算「在等上游」。
{
  const { segments } = rebuild([text("先读一遍。", 1), compaction("start", 2)], "先读一遍。");
  const events = segments.flatMap((segment) => segment.events);
  assert.equal(events.at(-1).detail, COMPACTING);
  assert.equal(liveLabel(events, false), COMPACTING, "压着的时候进行条说这件事");
  assert.equal(awaitingAfterEvent(events.at(-1)), false, "压缩不是在等上游回话");
  assert.equal(latestRunFacts([agentItem(segments)]).compacting, true, "回合还开着、停在开压那一步 = 正在压");
  assert.equal(latestRunFacts([agentItem(segments, at(9))]).compacting, false, "回合收口了就不再说在压");
  const failed = rebuild([text("先读一遍。", 1), compaction("start", 2), compaction("failed", 3)], "先读一遍。").segments;
  assert.equal(latestRunFacts([agentItem(failed)]).compacting, false, "没压成也算收口");
  assert.ok(failed.flatMap((segment) => segment.events).some((event) => event.kind === "error"), "没压成照旧是一条异常");
}

// ④ 旧会话：服务端当年插的那一串是 trace 里一条独立的正文。认出来换成步骤，位置跟着它在
//    trace 里的先后走；同一回合里智能体自己代码块里的那句照旧留着。
{
  const own = "```text\n> 正在压缩上下文…\n```";
  const trace = [text("先看看。", 1), tool("Read", '{"file_path":"before.ts"}', 2), text(`\n\n${own}`, 3), text("\n> 正在压缩上下文…\n\n", 4), text("\n> 上下文已压缩。\n\n", 5), text("接着改。", 6)];
  const md = `先看看。\n\n${own}\n> 正在压缩上下文…\n\n\n> 上下文已压缩。\n\n接着改。`;
  const { body, segments } = rebuild(trace, md);
  assert.equal(legacyCompactionCount(trace), 2);
  assert.ok(body.includes(own), "代码块里智能体自己写的那句不摘");
  assert.equal(body.split("正在压缩上下文").length - 1, 1, "只摘 trace 认出来的那一处");
  assert.doesNotMatch(body, /上下文已压缩/);
  assert.deepEqual(stepsOf(segments), ["Read", COMPACTED], "旧标记换成步骤，原来的先后不变");
  assert.equal(segments.at(-1).markdown.trim(), "接着改。");
  assert.ok(segments.slice(0, -1).map((segment) => segment.markdown).join("").includes(own), "压缩之前那段正文完整");
}

// ⑤ `.md` 里有这一串、trace 却不认得（智能体自己整行写了它）：不摘。
assert.equal(stripLegacyCompaction("说明：\n> 正在压缩上下文…\n\n就这样。", 0), "说明：\n> 正在压缩上下文…\n\n就这样。");

console.log("compaction markers ok: 只认结构化事件，正文与代码块原样，旧标记按 trace 认、先后不变，压缩不算等上游");
