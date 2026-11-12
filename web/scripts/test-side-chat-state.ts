import assert from "node:assert/strict";
import { sideChatBody, sideChatTitle, splitSideChatBody, type ChatMessage, type ChatSnapshot } from "@ash/shared/chat";
import { mergeSideSnapshot } from "../src/side-chat/useSideChat.ts";

const room = { id: "room", parentTaskId: "parent", kind: "side" as const, projectId: "p", name: "侧聊", members: [], createdAt: "2026-09-11" };
const message: ChatMessage = { id: "m", roomId: room.id, role: "agent", memberId: null, author: "助手", body: "方案 B", mentions: [], status: "done", taskId: null, createdAt: "2026-09-11T00:00:00Z", forward: { messageId: "side-m", taskId: "parent", text: "选择方案 B", status: "sent" } };
const previous: ChatSnapshot = { room, messages: [message], tasks: [] };
assert.equal(mergeSideSnapshot(previous, { ...previous, messages: [{ ...message, status: "running", body: "" }] }).messages[0]!.status, "done");
assert.equal(mergeSideSnapshot(previous, { ...previous, messages: [{ ...message, forward: { ...message.forward!, status: "queued" } }] }).messages[0]!.forward?.status, "sent");
const revoked = { ...previous, messages: [{ ...message, forward: { ...message.forward!, status: "canceled" as const } }] };
assert.equal(mergeSideSnapshot(revoked, { ...previous, messages: [{ ...message, forward: { ...message.forward!, status: "queued" } }] }).messages[0]!.forward?.status, "queued",
  "撤回过的可以再发一次：新的「排着」要显示出来");
assert.equal(mergeSideSnapshot(previous, { ...previous, messages: [] }).messages.length, 1, "迟到的快照不丢失已收到消息");
assert.equal(mergeSideSnapshot(previous, { room: { ...room, id: "other", parentTaskId: "other-task" }, messages: [], tasks: [] }).messages.length, 0, "不同侧聊不合并历史");
const stopped = { ...previous, messages: [{ ...message, status: "stopped" as const, forward: undefined }] };
assert.equal(mergeSideSnapshot(stopped, { ...previous, messages: [{ ...message, status: "running" }] }).messages[0]!.status, "stopped");
// 带着主会话选文发出去的那条：拆得回「那一段」和「你问的那句」；一场的名字是第一句话问的那句。
const quoted = sideChatBody("这段为什么要重试？后面还有一句。", "第一行\n第二行");
assert.deepEqual(splitSideChatBody(quoted), { quote: "第一行\n第二行", question: "这段为什么要重试？后面还有一句。" });
assert.deepEqual(splitSideChatBody("直接问"), { quote: null, question: "直接问" });
assert.equal(sideChatTitle(quoted), "这段为什么要重试？", "名字取到第一个句末标点");
assert.equal(sideChatTitle(`看看这张图\n\n[用户附带的文件 1 个]\n- /tmp/a.png`), "看看这张图", "附件块不进名字");
assert.equal(sideChatTitle("长".repeat(60)), `${"长".repeat(40)}…`);
console.log("✓ 侧聊 HTTP/SSE 乱序不回退回复或回执，不串会话；选文正文拆得回来，一场以第一句话为名");
