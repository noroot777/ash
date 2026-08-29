// 系统旁注落在回合中间时，trace 该怎么分给两颗气泡。
//
// 病症（用户 2026-08-29 报的 1qsWWVsvfIvT）：agent 刚吐出一个「我」字，「已预约完成后
// 审查」这条旁注就落了盘。.md 在 sentinel 处把正文切成两段 agent，trace 却没跟着切 ——
// 于是那颗只有一个字的气泡领走了整组 trace（236 次工具、7 张附件），真正写了 2700 字
// 报告的那一段一个事件都没有，既没有执行过程也折不起来。
//
// 另一半是对齐：trace 把相邻 delta 并成一条、时间戳取最后一个 delta，所以那条正文事件
// 是「我先看这两张图。」——跨了旁注。逐字相等的闸会因为多出来的一个「我」把整条回合打回
// 单段。全库 1881 段里有 172 段是这种一方包含另一方的关系。
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
const traced = (at, event) => ({ at, turnStartedAt: SESSION_STARTED, event });
const agents = (items) => items.filter((item) => item.kind === "agent");

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

const items = agents(buildConversationItems([{ session, output, trace }], [session], []));
assert.equal(items.length, 2, "旁注前后各一颗气泡");

const [head, body] = items;
// 1. 事件归写正文的那一段，不是那颗只有一个字的气泡。
assert.deepEqual(head.segments.flatMap((s) => s.events).map((e) => e.label), [], "「我」那颗气泡不该领走整组工具");
assert.deepEqual(body.segments.flatMap((s) => s.events).map((e) => e.label), ["Read", "Edit"]);
assert.deepEqual(body.segments.flatMap((s) => s.attachments), ["shot.png"]);

// 2. 对齐：trace 那条正文多出来的「我」已经由上一颗气泡显示过，这一段不该再重一遍。
assert.equal(head.segments.map((s) => s.markdown).join(""), "我");
const bodyText = body.segments.map((s) => s.markdown).join("");
assert.equal(bodyText, body.markdown.trim(), "分段拼回去必须恰好等于 .md 正文,一个字不丢不重");
assert.doesNotMatch(bodyText, /^我/, "「我」被重复渲染了一遍");

// 3. 对齐成功才有交错结构可切；否则整条回合退回单段，折叠无从下手。
assert.ok(body.segments.length > 1, "该切成多段,而不是退回单段兜底");

// 4. 旁注后面没有正文时不能切：那一组 trace 会没人认领、凭空多出一颗兜底气泡，
//    而直播那边旁注根本不拆气泡（appendAgent 会跨旁注回捞当前回合），刷新前后就不一样了。
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

console.log("conversation system-note tests passed");
