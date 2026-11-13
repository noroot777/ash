// 已经收口的回合不跟着别人的事件重渲（docs/ui-ux-audit 08 工程前提），但它**自己**变了必须重画：
// 重读回来的同一回合，工具详情、附件、配对的那份拷贝换了而条数不变时，旧版只比条数就漏了
// （第 1 轮审查）。记录里那几轮审查晚到的身份、报告同理（第 2 轮审查）。
// 跑:npm -w web run test:settled-turn-memo
import assert from "node:assert/strict";
import { sameSettledTurn } from "../src/task-detail/ConversationFeed.tsx";

const turn = (patch = {}) => ({
  kind: "agent", id: "a1", markdown: "改好了。", label: "claude", at: "2026-11-12T10:00:00.000Z", endedAt: "2026-11-12T10:05:00.000Z",
  segments: [{ id: "s0", markdown: "改好了。", awaiting: false, attachments: ["shot.png"], attachmentSources: [{ path: "a/shot.png", source: "shot.png", ref: 0 }],
    events: [{ kind: "tool", label: "Read", detail: '{"file_path":"a.ts"}' }] }],
  sources: [{ sessionId: "s", index: 0, fingerprint: "f1" }],
  usage: { input: 10, output: 5 },
  ...patch,
});
const props = (item) => ({ item, taskId: "t", taskActive: false, hideTime: false });
const segment = (patch) => [{ ...turn().segments[0], ...patch }];

assert.equal(sameSettledTurn(props(turn()), props(turn())), true, "内容一样的新对象不重画");
assert.equal(sameSettledTurn(props(turn()), props(turn({ segments: segment({ events: [{ kind: "tool", label: "Read", detail: '{"file_path":"b.ts"}' }] }) }))), false, "工具详情换了要重画");
assert.equal(sameSettledTurn(props(turn()), props(turn({ segments: segment({ attachments: ["other.png"] }) }))), false, "附件换了要重画");
assert.equal(sameSettledTurn(props(turn()), props(turn({ segments: segment({ attachmentSources: [{ path: "b/shot.png", source: "shot.png", ref: 0 }] }) }))), false, "配对的拷贝换了要重画");
assert.equal(sameSettledTurn(props(turn()), props(turn({ sources: [{ sessionId: "s", index: 0, fingerprint: "f2" }] }))), false, "来源换了要重画");
assert.equal(sameSettledTurn(props(turn()), props(turn({ usage: { input: 10, output: 6 } }))), false, "用量换了要重画");
assert.equal(sameSettledTurn(props(turn({ endedAt: null })), { ...props(turn({ endedAt: null })), taskActive: true }), false, "还在说的回合跟着变");

// 记在这一回合上的记录：条数、最后一条都没变，里面那一轮审查晚到一步补上了哪一场、报告、附言，
// 照样要重画——不然记录里那一条点了还拿着旧的那一轮，去不了审查格、也没有报告入口（第 2 轮审查）。
const lane = (patch = {}) => ({
  kind: "review-lane", id: "l1", source: "free", round: 1, totalRounds: null, title: "第 1 轮审查",
  items: [{ kind: "event", id: "l1:end", text: "自由工作流第 1 轮审查通过", variant: "note", tone: "neutral" }],
  reviewerLabel: "5.5审查", reviewerModel: null, reviewerEffort: null, note: null, startedAt: null, endedAt: "2026-11-12T10:30:00.000Z",
  conclusion: "verified", verdict: "passed", complete: true, reportAvailable: false, report: null, runId: null, defaultCollapsed: true, findings: null,
  ...patch,
});
const receipts = (lanePatch, viewPatch = {}) => [
  { id: "l1:end", view: { tier: "milestone", tone: "ok", topic: "review", text: "第 1 轮审查通过", detail: null, dispute: false, ...viewPatch }, lane: lane(lanePatch) },
  { id: "e2", view: { tier: "alert", tone: "bad", topic: "review", text: "第 2 轮验证没能开始", detail: null, dispute: false } },
];
const withReceipts = (list) => ({ ...props(turn()), receipts: list });
assert.equal(sameSettledTurn(withReceipts(receipts()), withReceipts(receipts())), true, "记录内容一样的新对象不重画");
assert.equal(sameSettledTurn(withReceipts(receipts()), withReceipts(receipts({ runId: "run-a" }))), false, "补上了是哪一场要重画");
assert.equal(
  sameSettledTurn(withReceipts(receipts()), withReceipts(receipts({ reportAvailable: true, report: { kind: "free", runId: "run-a", round: 1 } }))),
  false,
  "补上了报告要重画",
);
assert.equal(sameSettledTurn(withReceipts(receipts()), withReceipts(receipts({ note: "重点看并发" }))), false, "补上了附言要重画");
assert.equal(sameSettledTurn(withReceipts(receipts()), withReceipts(receipts({}, { text: "第 1 轮审查通过（重审）" }))), false, "记录里那一句的字变了要重画");
console.log("settled turn memo ok: 收口的回合内容不变不重画，工具详情 / 附件 / 拷贝 / 来源 / 用量 / 记录里的审查换了都重画");
