import assert from "node:assert/strict";
import type { ChatMessage, ChatSnapshot } from "@ash/shared/chat";
import { mergeSideSnapshot } from "../src/side-chat/useSideChat.ts";

const room = { id: "room", parentTaskId: "parent", kind: "side" as const, projectId: "p", name: "侧聊", members: [], createdAt: "2026-09-11" };
const message: ChatMessage = { id: "m", roomId: room.id, role: "agent", memberId: null, author: "助手", body: "方案 B", mentions: [], status: "done", taskId: null, createdAt: "2026-09-11T00:00:00Z", forward: { messageId: "side-m", taskId: "parent", text: "选择方案 B", status: "sent" } };
const previous: ChatSnapshot = { room, messages: [message], tasks: [] };
assert.equal(mergeSideSnapshot(previous, { ...previous, messages: [{ ...message, status: "running", body: "" }] }).messages[0]!.status, "done");
assert.equal(mergeSideSnapshot(previous, { ...previous, messages: [{ ...message, forward: { ...message.forward!, status: "queued" } }] }).messages[0]!.forward?.status, "sent");
assert.equal(mergeSideSnapshot(previous, { ...previous, messages: [] }).messages.length, 1, "迟到的快照不丢失已收到消息");
assert.equal(mergeSideSnapshot(previous, { room: { ...room, id: "other", parentTaskId: "other-task" }, messages: [], tasks: [] }).messages.length, 0, "不同侧聊不合并历史");
const stopped = { ...previous, messages: [{ ...message, status: "stopped" as const, forward: undefined }] };
assert.equal(mergeSideSnapshot(stopped, { ...previous, messages: [{ ...message, status: "running" }] }).messages[0]!.status, "stopped");
console.log("✓ 侧聊 HTTP/SSE 乱序不回退回复或回执，不串会话");
