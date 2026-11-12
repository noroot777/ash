// 已经收口的回合不跟着别人的事件重渲（docs/ui-ux-audit 08 工程前提），但它**自己**变了必须重画：
// 重读回来的同一回合，工具详情、附件、配对的那份拷贝换了而条数不变时，旧版只比条数就漏了
// （第 1 轮审查）。
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
console.log("settled turn memo ok: 收口的回合内容不变不重画，工具详情 / 附件 / 拷贝 / 来源 / 用量换了都重画");
