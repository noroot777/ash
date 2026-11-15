// 讨论的读取侧纯逻辑那一半（free-workflow/discussionModel.ts、task-detail/conversationDiscussionRows.ts）。
// 浏览器那一半在 test-discussion-dom.mjs。
//
// 盯的是此刻气泡上写的话说的是不是实情：一段都没交卷时说「各自在写」、在说时写刚说完那段、谈拢没谈拢如实写、
// 断了写断在哪；会话里一场讨论折成一行、配哪一场只认时间线那几句带的讨论身份（开始那句读不到时后一场不顶上来）、
// 交给主执行器写合稿的那句系统话不出现。
import assert from "node:assert/strict";
import {
  discussionBubbleText, discussionNowText, discussionPair, discussionSegmentHead, discussionStatusLabel, discussionWaiting,
} from "../src/free-workflow/discussionModel.ts";
import { conversationDiscussionRows } from "../src/task-detail/conversationDiscussionRows.ts";

const at = (minute) => `2026-11-15T10:${String(minute).padStart(2, "0")}:00.000Z`;
const participants = [
  { agentType: "codex", executorId: null, model: null, reasoningEffort: null, host: false },
  { agentType: "claude", executorId: null, model: null, reasoningEffort: null, host: true },
];
const turn = (seq, speaker, status, summary = null, agreed = null) => ({
  seq, speaker, status, summary, statement: status === "done" ? `${summary}——展开说。` : "", agreed,
  startedAt: at(seq), endedAt: status === "speaking" ? null : at(seq + 1),
});
const discussion = (patch) => ({
  id: "d1", status: "running", topic: "幽灵回合锁走哪条路？", rounds: 2, participants, attachments: [], turns: [],
  outcome: null, note: null, startedAt: at(0), finishedAt: null, ...patch,
});

// —— 气泡此刻写什么 ——
assert.equal(discussionPair(discussion({})), "claude 和 codex", "这条任务的执行器在前");
assert.equal(discussionPair(discussion({ participants: [...participants, { ...participants[0], agentType: "gemini" }] })),
  "claude、codex 和 gemini", "三方");
const blind = discussion({ turns: [turn(1, "codex", "speaking")] });
assert.deepEqual(discussionBubbleText(blind), { lead: null, text: "各自在写第一段，互相看不到" }, "一段都还没交卷");
assert.equal(discussionNowText(blind), "codex 在说第 1 / 4 段", "2 轮两方 = 4 段");
const live = discussion({ turns: [turn(1, "codex", "done", "让收尾每一步自己带时限"), turn(2, "claude", "speaking")] });
assert.deepEqual(discussionBubbleText(live), { lead: "codex", text: "让收尾每一步自己带时限" }, "谁 + 刚说完那段的一句话");
assert.equal(discussionNowText(live), "claude 在说第 2 / 4 段");
const between = discussion({ turns: [turn(1, "codex", "done", "a"), turn(2, "claude", "done", "b")] });
assert.deepEqual(discussionWaiting(between), { seq: 3, who: "codex" }, "两段之间那一下：下一段照轮着来的人写");
assert.equal(discussionWaiting(live), null);
const three = [turn(1, "codex", "done", "a"), turn(2, "claude", "done", "b"), turn(3, "codex", "done", "c", true)];
const synthesizing = discussion({ status: "synthesizing", outcome: "agreed", turns: three });
assert.equal(discussionBubbleText(synthesizing).text, "claude 和 codex 谈了 3 段 · 谈拢了");
assert.equal(discussionNowText(synthesizing), "claude 在写合稿", "说完了：小灰字写在写合稿");
const agreed = discussion({ status: "finished", outcome: "agreed", turns: three, finishedAt: at(9) });
assert.equal(discussionBubbleText(agreed).text, "claude 和 codex 谈了 3 段 · 谈拢了");
assert.equal(discussionStatusLabel(agreed), "谈拢了");
const rounds = discussion({ status: "finished", outcome: "rounds", turns: three, finishedAt: at(9) });
assert.equal(discussionBubbleText(rounds).text, "claude 和 codex 谈了 3 段 · 没谈拢", "没谈拢如实写");
assert.equal(discussionStatusLabel(rounds), "没谈拢");
const noSynthesis = discussion({ status: "finished", outcome: "agreed", turns: three, note: "合稿没写完（被停下或异常结束）" });
assert.match(discussionBubbleText(noSynthesis).text, /合稿没写完$/);
const stopped = discussion({
  status: "failed", note: "claude 第 2 段被停下或异常结束",
  turns: [turn(1, "codex", "done", "a"), turn(2, "claude", "error")],
});
assert.deepEqual(discussionBubbleText(stopped), { lead: null, text: "讨论中止：claude 第 2 段被停下或异常结束，前 1 段都在" },
  "断在哪、为什么写的是服务端落的那一句（刷新读的就是它）");
assert.equal(discussionStatusLabel(stopped), "中止");
assert.equal(discussionSegmentHead(live, 1), "写的时候没看对方的", "第一轮写明各写各的");
assert.equal(discussionSegmentHead(live, 3), null);

// —— 会话里一场折成一行 ——
const event = (id, text, minute, notice) => ({ kind: "event", id, text: `〔系统〕${text}`, at: at(minute), variant: "note", notice });
const mark = (discussionId, phase) => ({ kind: "discussion", discussionId, phase });
const agent = (id, text, minute) => ({ kind: "agent", id, text, at: at(minute), segments: [] });
const user = (id, text, minute, extra = {}) => ({ kind: "user", id, text, attachments: [], at: at(minute), ...extra });
const rows = [
  user("u0", "先改一版", 0),
  event("e1", "开始讨论：claude 和 codex，2 轮。", 1, mark("d1", "start")),
  event("e2", "讨论第 1/4 段：轮到 codex。", 1, mark("d1", "segment")),
  user("p1", "【讨论】用户在这条任务里叫了 codex…", 1, { bySystem: true }),
  agent("a1", "本段已交卷。", 2),
  event("e3", "讨论第 2/4 段：轮到 claude。", 3, mark("d1", "segment")),
  agent("a2", "第 2 段交了。", 4),
  event("e4", "讨论结束：claude 和 codex 谈了 2 段，没谈拢。", 5, mark("d1", "end")),
  user("p2", "【讨论说完了 · 写合稿】claude、codex 谈了 2 段", 5, { bySystem: true }),
  agent("a3", "合稿：先修泄漏，再给收尾加时限。", 6),
  event("e5", "开始讨论：claude 和 codex，1 轮。", 7, mark("d2", "start")),
  event("e6", "讨论已中止：codex 第 1 段说完没有交卷。可以再发起一次。", 8, mark("d2", "aborted")),
].map((item) => ({ kind: "item", item }));
const second = discussion({ id: "d2", status: "failed", startedAt: at(7), note: "codex 第 1 段说完没有交卷" });
const folded = conversationDiscussionRows(rows, { discussions: [second, discussion({ id: "d1", status: "finished", outcome: "rounds" })] });
assert.deepEqual(folded.map((row) => row.kind === "item" ? row.item.id : row.id),
  ["u0", "discussion-lane:d1", "a3", "discussion-lane:d2"],
  "一场一行；合稿是之后照常回的那一段，不折进来；交给它写合稿的那句系统话不出现");
assert.equal(folded[1].discussion.id, "d1", "按开始那句带的讨论身份配");
assert.equal(folded[3].discussion.id, "d2");
assert.ok(!folded[1].items.some((item) => item.id === "e2" || item.id === "e3"), "段间流水不留（配到记录时）");
// d1 开始那句没读出来（会话文件缺了一份 / 时间线没写进去）：后面的 d2 不能顶上去，d1 剩下那几句原样留着。
const lost = conversationDiscussionRows(rows.filter((row) => row.item.id !== "e1"),
  { discussions: [discussion({ id: "d1", status: "finished", outcome: "rounds" }), second] });
const lanes = lost.filter((row) => row.kind === "discussion-lane");
assert.deepEqual(lanes.map((row) => row.discussion?.id), ["d2"], "只有 d2 成了一颗气泡，配的就是 d2");
assert.ok(["e2", "e3", "e4"].every((id) => lost.some((row) => row.kind === "item" && row.item.id === id)), "d1 那几句原样摆着");
// 记录里没有这一场（快照还没到）：一颗没配上记录的气泡，原文兜底，不拿别的场顶替。
const missing = conversationDiscussionRows(rows, { discussions: [second] });
assert.equal(missing[1].discussion, null, "d1 不在快照里就不配，哪怕只剩 d2");
assert.equal(missing[3].discussion?.id, "d2");
// 老样子的一句（没带讨论身份的回执）不认成讨论。
const plain = conversationDiscussionRows([{ kind: "item", item: event("p9", "开始讨论：claude 和 codex，2 轮。", 1) }],
  { discussions: [discussion({})] });
assert.deepEqual(plain.map((row) => row.kind), ["item"], "没带讨论身份的那句只是一句普通回执");
const unmatched = conversationDiscussionRows(rows, { discussions: null });
assert.ok(unmatched[1].items.some((item) => item.id === "e2"), "配不到记录：原始行原样留着兜底");
const interrupted = conversationDiscussionRows([
  { kind: "item", item: event("x1", "开始讨论：claude 和 codex，2 轮。", 1, mark("dx", "start")) },
  { kind: "item", item: user("u9", "我插一句", 2) },
], { discussions: [] });
assert.deepEqual(interrupted.map((row) => row.kind), ["discussion-lane", "item"], "真人插话就收口，不把后面全吞进去");

console.log("discussion test passed");
