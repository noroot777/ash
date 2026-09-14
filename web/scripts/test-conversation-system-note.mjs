// 任务时间线旁注（预约审查、验收阶段更新…）落在回合中间时，会话该怎么排。
//
// 病症一（用户 2026-08-29 报的 1qsWWVsvfIvT）：agent 刚吐出一个「我」字，「已预约完成后
// 审查」这条旁注就落了盘。.md 在 sentinel 处把正文切成两段 agent，trace 却没跟着切 ——
// 于是那颗只有一个字的气泡领走了整组 trace（236 次工具、7 张附件），真正写了 2700 字
// 报告的那一段一个事件都没有。
//
// 病症二（用户 2026-09-14 报的）：被劈出来的上半截**本来就不是一条回复**，却照样拿到了
// 结束时刻 —— 于是提前折叠、还挂出「派生新任务」（派生要拿整条回复当上下文，半截不算）。
// 根因是拿旁注当了回合边界：它不是说给 agent 听的话，落在哪一秒纯属偶然。
//
// 现在的排法：旁注**不切回合、不定回合起止**，上下两截并回同一颗气泡，旁注自己排在这
// 一回合后面。真正的回合起点（「继续（从中断处）」）和落在两回合之间的旁注不受影响。
import assert from "node:assert/strict";
import { buildConversationItems } from "../src/task-detail/conversationModel.ts";

const SESSION_STARTED = "2026-08-29T05:30:56.111Z";
const NOTE_AT = "2026-08-29T05:31:03.481Z";
const TEXT_AT = "2026-08-29T05:31:04.413Z";

const session = {
  id: "s1",
  taskId: "t1",
  agentType: "claude",
  role: "single",
  executor: "claude@ccb",
  startedAt: SESSION_STARTED,
  endedAt: "2026-08-29T06:15:15.000Z",
};

const sentinel = (payload) => `\n\x1e${JSON.stringify(payload)}\n`;
const traced = (at, event, turnStartedAt = SESSION_STARTED) => ({ at, turnStartedAt, event });
const agents = (items) => items.filter((item) => item.kind === "agent");
const events = (items) => items.filter((item) => item.kind === "event");

// .md：「我」→ 旁注 → 剩下的正文。trace：一条跨了旁注的合并正文事件 + 两次工具。
const output = [
  "我",
  sentinel({ t: "system", agent: "claude", text: "已预约完成后审查：5.5审查。", at: NOTE_AT }),
  "先看这两张图。\n\n改完了：三处都换成了新判据。\n",
].join("");
const trace = [
  traced(TEXT_AT, { kind: "text", text: "我先看这两张图。\n\n" }),
  traced("2026-08-29T05:31:05.000Z", { kind: "tool", name: "Read", detail: "a.png" }),
  traced("2026-08-29T05:31:06.000Z", { kind: "attachment", path: "shot.png" }),
  traced("2026-08-29T05:40:00.000Z", { kind: "tool", name: "Edit", detail: "x.ts" }),
  traced("2026-08-29T05:41:00.000Z", { kind: "text", text: "改完了：三处都换成了新判据。\n" }),
];

const items = buildConversationItems([{ session, output, trace }], [session], []);
const bubbles = agents(items);
assert.equal(bubbles.length, 1, "旁注不该把一条回复劈成两颗气泡");

const [turn] = bubbles;
// 1. 事件、附件都在这一回合里，一件不落（原来它们全被那颗「我」气泡领走了）。
assert.deepEqual(turn.segments.flatMap((s) => s.events).map((e) => e.label), ["Read", "Edit"]);
assert.deepEqual(turn.segments.flatMap((s) => s.attachments), ["shot.png"]);

// 2. 正文：旁注前后两截接回一整段，且一个字不重（trace 那条正文多出来的「我」已由上半截
//    显示过）。分段拼回去必须跟气泡正文**一个字不丢不重**——复制/派生读 markdown，渲染读
//    segments，两者不能漂（接缝处的空白不算：每一段各自渲染成独立的块）。
assert.equal(turn.markdown, "我\n\n先看这两张图。\n\n改完了：三处都换成了新判据。");
const compact = (text) => text.replace(/\s+/g, "");
assert.equal(
  compact(turn.segments.map((s) => s.markdown).join("")),
  compact(turn.markdown),
  "分段拼回去必须等于气泡正文",
);
assert.equal(turn.segments.filter((s) => s.markdown.includes("我")).length, 1, "「我」被重复渲染了一遍");

// 3. 对齐成功才有交错结构可切；否则整条回合退回单段，折叠无从下手。
assert.ok(turn.segments.length > 1, "该切成多段,而不是退回单段兜底");

// 4. 旁注自己排在这一回合**后面**，并且带着 aside 标（展示端据此贴成回合的尾注）。
const [note] = events(items);
assert.equal(note.aside, true, "落在回合中间的旁注应标成 aside");
assert.ok(items.indexOf(note) > items.indexOf(turn), "旁注应排在被它砸中的那一回合后面");

// 5. 旁注后面没有正文时同样不多出气泡：那一组 trace 无人认领会掉进「无正文兜底气泡」。
const trailing = agents(buildConversationItems([{
  session,
  output: ["第一回合说的话。", sentinel({ t: "system", agent: "claude", text: "已预约完成后审查。", at: NOTE_AT })].join("\n"),
  trace: [
    traced("2026-08-29T05:31:00.000Z", { kind: "text", text: "第一回合说的话。" }),
    traced("2026-08-29T05:31:20.000Z", { kind: "tool", name: "exec", detail: "检查布局" }),
  ],
}], [session], []));
assert.equal(trailing.length, 1, "旁注后面没正文时不该多出一颗气泡");
assert.deepEqual(trailing[0].segments.flatMap((s) => s.events).map((e) => e.label), ["exec"]);

// 6. 还在飞的回合不许被旁注按上结束时刻：一按上就当场折叠、还挂出「派生新任务」，
//    而那半截根本不是一条完整回复。
const liveSession = { ...session, endedAt: null, turnStartedAt: SESSION_STARTED };
const live = buildConversationItems([], [liveSession], [
  { kind: "server", id: "e1", event: { taskId: "t1", sessionId: "s1", agentType: "claude", event: { kind: "text", text: "我" } } },
  { kind: "server", id: "e2", event: { taskId: "t1", sessionId: "s1", agentType: "claude", event: { kind: "system", text: "已预约审查：5.5审查。", at: NOTE_AT, aside: true } } },
  { kind: "server", id: "e3", event: { taskId: "t1", sessionId: "s1", agentType: "claude", event: { kind: "text", text: "先看这两张图。" } } },
]);
const [liveTurn] = agents(live);
assert.equal(agents(live).length, 1, "直播里旁注本来就不拆气泡");
assert.equal(liveTurn.endedAt, null, "回合还在飞，旁注不能替它宣布结束");
assert.equal(liveTurn.markdown, "我先看这两张图。");

// 7. 真正的回合起点（系统对 agent 说的「继续（从中断处）」）照旧切：它的时刻**恰好等于**
//    下一组 trace 的 turnStartedAt，跟砸进回合中间的旁注不是一回事。
const RESUMED_AT = "2026-08-29T05:50:00.000Z";
const resumed = agents(buildConversationItems([{
  session,
  output: [
    "第一回合说的话。",
    sentinel({ t: "system", agent: "claude", text: "〔系统〕继续（从中断处）", at: RESUMED_AT }),
    "第二回合说的话。",
  ].join("\n"),
  trace: [
    traced("2026-08-29T05:31:00.000Z", { kind: "text", text: "第一回合说的话。" }),
    traced("2026-08-29T05:31:20.000Z", { kind: "tool", name: "exec", detail: "看一眼" }),
    traced(RESUMED_AT, { kind: "run", model: "claude-opus-5", reasoningEffort: "high" }, RESUMED_AT),
    traced("2026-08-29T05:50:10.000Z", { kind: "text", text: "第二回合说的话。" }, RESUMED_AT),
  ],
}], [session], []));
assert.equal(resumed.length, 2, "回合起点仍然是切点");
assert.equal(resumed[0].markdown, "第一回合说的话。");
assert.equal(resumed[1].markdown, "第二回合说的话。");

// 8. 落在两个回合**之间**的旁注（「第 N 轮验证开始」就是这种：写完才起验证回合）不合并：
//    合了就是把实现者和审查者的发言粘成同一条。
const VERIFY_NOTE_AT = "2026-08-29T05:55:00.000Z";
const VERIFY_TURN_AT = "2026-08-29T05:55:30.000Z";
const verify = agents(buildConversationItems([{
  session,
  output: [
    "实现完了。",
    sentinel({ t: "system", agent: "claude", text: "第 2 轮验证开始：就在这个任务的工作目录里跑。", at: VERIFY_NOTE_AT, aside: true }),
    "第 2 轮结论：verified。",
  ].join("\n"),
  trace: [
    traced("2026-08-29T05:54:00.000Z", { kind: "text", text: "实现完了。" }),
    traced(VERIFY_TURN_AT, { kind: "run", model: "claude-opus-5", reasoningEffort: "high", verifyRound: 2 }, VERIFY_TURN_AT),
    traced("2026-08-29T05:56:00.000Z", { kind: "text", text: "第 2 轮结论：verified。" }, VERIFY_TURN_AT),
  ],
}], [session], []));
assert.equal(verify.length, 2, "验证轮是另一个人在说话，不能并进实现回合");
assert.equal(verify[1].reviewer?.round, 2);

console.log("conversation system-note tests passed");
