// 一条消息从发出到这一回合收口是同一个身份（docs/ui-ux-audit 08 工程前提）：直播里的号、客户端的
// 号、落盘那一套号各不相同，React 的 key 不能跟着换，否则收口那一刻整条回复卸掉重建。
// 跑:npm -w web run test:conversation-keys
import assert from "node:assert/strict";
import { conversationKeys } from "../src/task-detail/conversationKeys.ts";

const user = (id, text) => ({ kind: "user", id, text, attachments: [], at: "x" });
const agent = (id, at, over = {}) => ({ kind: "agent", id, sessionId: "s1", at, segments: [], markdown: "", ...over });

const live = conversationKeys([user("client-1", "改一下右边"), agent("live:s1:1", "2026-11-12T00:00:00.000Z")]);
const persisted = conversationKeys([user("persisted:user:s1:0", "改一下右边"), agent("persisted:agent:s1:1", "2026-11-12T00:00:00.000Z")]);
assert.deepEqual([...live.values()], [...persisted.values()], "直播 → 落盘，key 不变");

const twice = conversationKeys([user("a", "继续"), user("b", "继续"), agent("c", "t"), agent("d", "t")]);
assert.equal(new Set(twice.values()).size, 4, "同样的话、同一回合的两截各有各的 key");
assert.notEqual(
  conversationKeys([agent("e", "t", { reviewer: { round: 2 } })]).get("e"),
  conversationKeys([agent("e", "t")]).get("e"),
  "同一条会话上换成审查者说话算换人",
);
console.log("conversation keys ok");
