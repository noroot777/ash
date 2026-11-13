// 压缩上下文不是它说的话（docs/ui-ux-audit run-9）：它是执行过程里它发生的那个位置上的一步；
// 压着时进行条那一行说「在压缩上下文」，压完并成一行。
//
// 来源只认结构化事件（error 事件上的 compaction）。**正文永远是正文**：智能体在解释压缩日志、
// 代码块里引了原文、文字块恰好切在那一句上、甚至整条回复就是一个 `constructor`——一个字都
// 不许动，也不许凭空说「在压缩」「在等上游」（第 1、2 轮审查）。旧会话里服务端当年插的那两句
// 引用不转换，照原样留在正文里。
// 跑:npm -w web run test:compaction-markers
import assert from "node:assert/strict";
import { COMPACTED, COMPACTING, COMPACT_SKIPPED } from "../src/lib/compaction.ts";
import { liveLabel, pastSummary } from "../src/lib/executionWords.ts";
import { hasExecutionNotice } from "../src/components/ExecutionTrace.tsx";
import { awaitingAfterEvent, contentSegments } from "../src/task-detail/conversationSegments.ts";
import { buildConversationItems } from "../src/task-detail/conversationModel.ts";
import { latestRunFacts } from "../src/task-detail/info/infoRunFacts.ts";

const at = (second) => `2026-11-12T10:00:${String(second).padStart(2, "0")}.000Z`;
const text = (value, second) => ({ at: at(second), event: { kind: "text", text: value } });
const tool = (name, detail, second) => ({ at: at(second), event: { kind: "tool", name, detail } });
const compaction = (phase, second) => ({
  at: at(second),
  event: phase === "failed"
    ? { kind: "error", message: "上下文压缩失败，会话大小原地不动：503", affectsTurn: false, compaction: phase }
    : { kind: "error", message: phase, level: "notice", affectsTurn: false, compaction: phase },
});
/** 落盘那一路：正文就是 `.md`，trace 只定位步骤插在哪（conversationModel 同一个调用）。 */
const rebuild = (trace, md) => ({ body: md, segments: contentSegments(trace, md, "t") });
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

// ④ 旧会话：服务端当年插的那一串（不论在 trace 里是不是一条独立的正文），照原样是正文；
//    跟它同文的普通引文、切在三个文字块里的代码示例同样原样。
{
  const quote = "> 正在压缩上下文…";
  const trace = [text("先引一句：\n\n", 1), text(`${quote}\n\n`, 2), tool("Read", '{"file_path":"before.ts"}', 3), text("\n> 正在压缩上下文…\n\n", 4), text("\n> 上下文已压缩。\n\n", 5), text("接着改。", 6)];
  const md = trace.filter((entry) => entry.event.kind === "text").map((entry) => entry.event.text).join("");
  const { segments } = rebuild(trace, md);
  assert.equal(segments.map((segment) => segment.markdown).join(""), md, "旧会话正文一个字不摘");
  assert.deepEqual(stepsOf(segments), ["Read"], "旧标记不转成步骤");
  assert.equal(latestRunFacts([agentItem(segments)]).compacting, false, "旧标记不让信息格说在压");
}

// ⑤ 直播：每一片正文都是正文——哪怕恰好是旧标记那一串、是被切开的代码示例、是 Object 原型上的
//    名字。不长出步骤，不说「在等上游」。
{
  const session = { id: "s1", taskId: "t1", agentType: "codex", role: "main", startedAt: at(0), endedAt: null };
  const live = (chunks) => buildConversationItems([], [session], chunks.map((chunk, index) => ({
    kind: "server",
    id: `live:${index}`,
    event: { type: "agent.event", taskId: "t1", sessionId: "s1", role: "main", agentType: "codex", event: { kind: "text", text: chunk } },
  }))).filter((item) => item.kind === "agent");
  for (const chunks of [
    ["constructor"], ["toString"], ["__proto__"], ["hasOwnProperty"],
    ["```text\n", "\n> 正在压缩上下文…\n\n", "```"],
    ["\n> 上下文已压缩。\n\n"],
  ]) {
    const [item] = live(chunks);
    assert.equal(item.markdown, chunks.join(""), `直播正文原样：${JSON.stringify(chunks)}`);
    assert.equal(item.segments.flatMap((segment) => segment.events).length, 0, `直播正文不长出步骤：${JSON.stringify(chunks)}`);
    assert.equal(item.segments.some((segment) => segment.awaiting), false, `直播正文不说在等上游：${JSON.stringify(chunks)}`);
  }
}

// ⑥ 被 PreCompact hook 拦下：结束了、没压，不谎报「压缩了」，也不一直说在压。
{
  const { segments } = rebuild([text("先读一遍。", 1), compaction("start", 2), compaction("cancelled", 3)], "先读一遍。");
  const events = segments.flatMap((segment) => segment.events);
  assert.deepEqual(stepsOf(segments), [COMPACT_SKIPPED], "开始和被拦下并成一行");
  assert.equal(latestRunFacts([agentItem(segments)]).compacting, false, "被拦下了就不再说在压");
  assert.equal(liveLabel(events, false), COMPACT_SKIPPED, "进行条说被拦下，不说压缩了");
}

// ⑦ 独立审查另开的会话排在会话流最后，信息格的上下文、「压缩设置」仍是任务执行者那条会话的。
//    走真实的组装链路：直播里审查会话行还没到时，徽标已被审查区间补成「第 1 轮」，归属不能跟着徽标走。
{
  const own = { id: "s-own", taskId: "t1", role: "single", agentType: "claude", executor: "claude 执行者", startedAt: at(0), endedAt: at(10), context: { used: 264270, window: 1000000 } };
  const reviewer = { id: "s-rev", taskId: "t1", role: "reviewer", agentType: "codex", executor: "codex 审查者", startedAt: at(20), endedAt: null, context: { used: 155683, window: 258400 } };
  const live = (session, event, index) => ({
    kind: "server",
    id: `live:${index}`,
    event: { type: "agent.event", taskId: "t1", sessionId: session.id, role: session.role, agentType: session.agentType, event },
  });
  const timeline = [
    live(own, { kind: "text", text: "执行者已完成" }, 1),
    live(own, { kind: "context", context: own.context }, 2),
    live(own, { kind: "system", text: "自由工作流第 1 轮审查开始", at: at(20), aside: true }, 3),
    live(reviewer, { kind: "text", text: "独立审查正在进行" }, 4),
    live(reviewer, { kind: "context", context: reviewer.context }, 5),
  ];
  for (const [label, sessions] of [["审查会话已加载", [own, reviewer]], ["直播里审查会话行还没到", [own]]]) {
    const items = buildConversationItems([], sessions, timeline);
    const review = items.filter((item) => item.kind === "agent").at(-1);
    assert.equal(review.sessionId, reviewer.id, `${label}：审查者的气泡排在最后`);
    assert.ok(review.reviewer, `${label}：审查者的气泡认得出是审查`);
    const facts = latestRunFacts(items);
    assert.equal(facts.session?.id, own.id, `${label}：压缩设置指向任务自己的执行器`);
    assert.equal(facts.context?.window, own.context.window, `${label}：上下文是执行者的窗口，不是审查者的`);
  }
  assert.deepEqual(
    buildConversationItems([], [own], timeline).filter((item) => item.kind === "agent").at(-1).reviewer,
    { round: 1 },
    "前提：会话行没到时徽标已被补成第 1 轮（这正是不能拿徽标认归属的原因）",
  );
  const bubble = (session, extra = {}) => ({ ...agentItem([], at(9)), sessionId: session.id, sessionRole: session.role, session, ...extra });
  const inline = { ...bubble(own, { reviewer: { round: 1 } }), sessionContext: { used: 300000, window: 1000000 } };
  assert.equal(latestRunFacts([bubble(own), inline]).context.used, 300000, "就地验证轮搭在任务自己的会话上，照常取最新那份");
  assert.equal(latestRunFacts([bubble(reviewer, { reviewer: { round: null } })]).session, null, "只有审查者说过话就没有任务自己的上下文");
}

console.log("compaction markers ok: 只认结构化事件，直播与落盘正文一律原样（旧标记、分片、原型属性名），被拦下的压缩如实收口，压缩不算等上游，信息格不取审查者的会话");
