import assert from "node:assert/strict";
import type { Task, Session } from "@ash/shared";
import { buildConversationItems } from "../src/task-detail/conversationModel.ts";
import { canForkReply, forkTaskBody, forkBodyProblem, forkContextBytes, snapshotConversationFork } from "../src/task-detail/conversationFork.ts";

const task = { id: "source", title: "来源任务", body: "原始需求", mode: "single" } as Task;
const session = {
  id: "s1", taskId: task.id, role: "single", agentType: "codex",
  startedAt: "2026-09-10T01:00:00Z", endedAt: "2026-09-10T01:05:00Z",
  cliSessionId: "DO_NOT_RESUME", transcriptPath: "/later/full-transcript.md",
} as Session;
const marker = (t: string, text: string, at: string) => `\x1e${JSON.stringify({ t, text, at })}\n`;
const output = "第一条答复\n" + marker("agentEnd", "", "2026-09-10T01:01:00Z")
  + marker("user", "此前的追问", "2026-09-10T01:02:00Z")
  + "选中的答复\n" + marker("agentEnd", "", "2026-09-10T01:03:00Z")
  + marker("user", "不应带入的后续追问", "2026-09-10T01:04:00Z")
  + "不应带入的后续答复\n";
const items = buildConversationItems([{ session, output }], [session], []);
const replies = items.filter((item) => item.kind === "agent");
const target = replies[1]!;
target.segments[0]!.attachments.push("/tmp/earlier.png");
target.segments[0]!.events.push({ kind: "tool", label: "Read", detail: "earlier-file.ts" });
replies[2]!.segments[0]!.attachments.push("/tmp/later.png");
const seed = snapshotConversationFork(task, items, target.id);
assert.equal(seed.fork.messageCount, 3);
assert.deepEqual(seed.fork.attachmentPaths, ["/tmp/earlier.png"]);
const body = forkTaskBody(seed.fork, "接下来研究方案 B");
for (const expected of ["原始需求", "第一条答复", "此前的追问", "选中的答复", "earlier-file.ts", "接下来研究方案 B"]) {
  assert.ok(body.includes(expected), expected);
}
for (const excluded of ["不应带入", "later.png", "DO_NOT_RESUME", "full-transcript.md"]) assert.ok(!body.includes(excluded), excluded);
target.markdown += "此后新增";
task.body += "此后修改正文";
assert.ok(!seed.fork.context.includes("此后"));
const first = snapshotConversationFork(task, items, replies[0]!.id);
assert.ok(!first.fork.context.includes("此前的追问"));
assert.throws(() => snapshotConversationFork(task, items, "missing"));
assert.throws(() => snapshotConversationFork(task, [{ ...target, session: { ...session, taskId: "other-task" } }], target.id));
assert.equal(canForkReply({ ...target, endedAt: null }), false);
assert.equal(canForkReply({ ...target, markdown: "" }), false);
assert.throws(() => snapshotConversationFork(task, [{ ...target, endedAt: null }], target.id));

// 审查轮的发言不是派生落点：它是搭在任务上的旁路回合，给的是结论不是新需求。三种审查
// 身份（就地验证轮带轮号、自由派审不带轮号）共用 `reviewer` 这一个标，所以都挡得住。
for (const reviewer of [{ round: 6 }, { round: null }]) {
  assert.equal(canForkReply({ ...target, reviewer }), false, `审查者发言不给派生入口（round=${reviewer.round}）`);
  assert.throws(() => snapshotConversationFork(task, [{ ...target, reviewer }], target.id), /审查轮/);
}
// 同一条回复摘掉审查身份就恢复可派生 —— 别把普通实现回合一起误伤。
assert.ok(canForkReply({ ...target, reviewer: undefined }));

// 引导打断的半截不给派生：真人的话直接投进正在跑的会话（原生引导不结束回合，所以没有
// agentEnd），.md 却已经被那条 sentinel 切成两段。上半截白得一个「结束时刻」，看着像说完
// 的一条回复 —— 派生带走的是截至它的整份上下文，拿半截当落点就是把没说完的话当结论。
const steerSession = { ...session, id: "s2", endedAt: "2026-09-16T08:36:00Z" } as Session;
const steered = buildConversationItems([{
  session: steerSession,
  output: "官方能力边界已确认，我接着核对本地这一段\n"
    + marker("user", "我的意思是在 ash 的输入框里 / 怎么没有 image-gen 这个 skill", "2026-09-16T08:24:50.564Z")
    + "明白了：你问的是斜杠菜单\n" + marker("agentEnd", "", "2026-09-16T08:27:09.253Z")
    + marker("user", "可以，加上吧", "2026-09-16T08:30:15.783Z")
    + "已加上。\n" + marker("agentEnd", "", "2026-09-16T08:35:53.943Z"),
}], [steerSession], []);
const steeredReplies = steered.filter((item) => item.kind === "agent");
assert.equal(steeredReplies.length, 3);
assert.equal(steeredReplies[0]!.interrupted, true, "被引导打断的半截要认出来");
assert.equal(canForkReply(steeredReplies[0]!), false, "半截回复不给派生入口");
assert.throws(() => snapshotConversationFork(task, steered, steeredReplies[0]!.id), /引导打断/);
// 自己收过口（agentEnd）的那两轮照常可派生 —— 后面同样跟着真人发言，不能一起误伤。
assert.equal(steeredReplies[1]!.interrupted, false, "落过 agentEnd 的一轮是自己说完的");
assert.ok(canForkReply(steeredReplies[1]!));
assert.ok(canForkReply(steeredReplies[2]!));
assert.ok(snapshotConversationFork(task, steered, steeredReplies[1]!.id).fork.context.includes("明白了"));
const longReply = { ...target, markdown: "长文本".repeat(50_000) };
assert.ok(snapshotConversationFork(task, [longReply], target.id).fork.context.includes(longReply.markdown));
const oversized = snapshotConversationFork(task, [longReply], target.id).fork;
assert.match(forkBodyProblem(oversized, "继续")!, /128 KiB/);
assert.throws(() => forkTaskBody(oversized, "继续"), /超过/);
assert.equal(forkBodyProblem(seed.fork, "继续"), null);
assert.equal(forkTaskBody(undefined, " 普通新任务 "), "普通新任务");
const countEncoding = TextEncoder.prototype.encode;
let encodedCharacters = 0;
TextEncoder.prototype.encode = function (value = "") { encodedCharacters += value.length; return countEncoding.call(this, value); };
try {
  const repeated = { ...seed.fork, context: "超长历史".repeat(150000) };
  for (let index = 0; index < 100; index++) {
    assert.ok(forkBodyProblem(repeated, `继续 ${index}`));
    assert.equal(forkContextBytes(repeated), 1800000);
  }
  assert.ok(encodedCharacters < repeated.context.length * 2, "连续输入不反复编码整份超长历史");
  repeated.context = "已换成短背景";
  assert.equal(forkContextBytes(repeated), countEncoding.call(new TextEncoder(), repeated.context).length);
  assert.equal(forkBodyProblem(repeated, "继续"), null);
} finally { TextEncoder.prototype.encode = countEncoding; }
console.log("conversation fork boundaries, immutable history, attachments, fresh context: passed");
