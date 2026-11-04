import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ScheduledMessage, TaskListItem } from "@ash/shared";
import { ScheduledMessageTray } from "../src/components/ScheduledMessageTray.tsx";
import { sendAfterOptions, sendAfterState } from "../src/lib/sendAfter.ts";

// 「等某任务完成后发送」的前端口径(与服务端 pending-after.ts 同源:只有完成算数):
// - 候选:同项目、未归档、不是自己;已完成的置灰沉底,失败/取消的可选但说清「重跑完成后才发」;
// - 托盘:说出在等谁;等不到了(失败/取消/删除/归档)标出来并给「直接发送」,等得到时不给。

const t = (id: string, overrides: Partial<TaskListItem> = {}) => ({
  id, title: id, projectId: "p1", parentId: null, archived: false, mode: "single",
  groupId: null, queueId: null, queuePosition: null, status: "backlog", ...overrides,
}) as TaskListItem;

const tasks = [
  t("me", { status: "done" }),
  t("done", { status: "done" }),
  t("failed", { status: "failed" }),
  t("running", { status: "running", groupId: "g1" }),
  t("other-project", { projectId: "p2" }),
  t("archived", { archived: true }),
  t("worker", { parentId: "team", status: "paused" }),
  t("lead", { mode: "team", status: "idle" as never }),
];
const options = sendAfterOptions({ tasks, groups: [{ id: "g1", name: "前端" } as never], projectId: "p1", taskId: "me" });
assert.deepEqual(options.map((option) => option.value), ["running", "worker", "failed", "done"],
  "还会完成的在前、失败的其次、已完成的沉底;别的项目、归档的、自己、团队调度台都不列");
assert.equal(options.find((option) => option.value === "done")?.disabled, true, "已完成的没什么可等");
assert.equal(options.find((option) => option.value === "failed")?.disabled, false);
assert.match(options.find((option) => option.value === "failed")!.detail!, /重跑完成后才发/);
assert.equal(options.find((option) => option.value === "running")?.group, "前端");

assert.deepEqual(sendAfterState(undefined), { label: "前置任务已删除", stuck: true });
assert.deepEqual(sendAfterState(t("x", { status: "running" })), { label: "等「x」完成", stuck: false });
assert.equal(sendAfterState(t("x", { status: "canceled" })).stuck, true);
assert.equal(sendAfterState(t("x", { status: "paused", archived: true })).stuck, true);
assert.equal(sendAfterState(t("x", { status: "done" })).stuck, false);
assert.deepEqual(sendAfterState(t("x", { mode: "team", status: "idle" as never })), { label: "「x」是团队调度台，等不到完成", stuck: true },
  "存量的等调度台:说清等不到,给直接发送");
// 服务端锁存了完成时刻 = 等到了:前置随后被删、重跑、失败都不改口。
for (const task of [undefined, t("x", { status: "running" }), t("x", { status: "failed" })]) {
  assert.deepEqual(sendAfterState(task, "2026-11-04T09:00:00Z").stuck, false);
  assert.match(sendAfterState(task, "2026-11-04T09:00:00Z").label, /已完成/);
}

const message = (id: string, afterTaskId: string, afterDoneAt: string | null = null): ScheduledMessage => ({ id, taskId: "me",
  text: id, attachments: [], agent: null, executorId: null, model: null, reasoningEffort: null, origin: null, sessionRole: null,
  mode: "after", afterTaskId, afterDoneAt, status: "pending", createdAt: "2026-11-04T00:00:00Z", sendAt: "2026-11-04T00:00:00Z", sentAt: null });
const tray = (messages: ScheduledMessage[]) => renderToStaticMarkup(<ScheduledMessageTray messages={messages} loading={false}
  error={null} cancelingIds={new Set()} onWithdraw={() => {}} onCancel={() => {}} tasks={tasks} onSendNow={() => {}} />);

const waiting = tray([message("waiting", "running")]);
assert.match(waiting, /等「running」完成/);
assert.match(waiting, /等前置任务完成后发送/, "托盘抬头按条件说,不说「等待当前一轮结束」");
assert.doesNotMatch(waiting, /scheduled-message-send-now|is-stuck/, "等得到时不给「直接发送」");
assert.match(waiting, /scheduled-message-withdraw/, "照常可撤回");

const stuck = tray([message("stuck", "failed")]);
assert.match(stuck, /「failed」失败/);
assert.match(stuck, /is-stuck/);
assert.match(stuck, /scheduled-message-send-now/);
assert.match(tray([message("gone", "deleted")]), /前置任务已删除[\s\S]*scheduled-message-send-now/);
const released = tray([message("latched", "failed", "2026-11-04T09:00:00Z")]);
assert.match(released, /「failed」已完成/, "锁存过的不因前置后来失败而改口");
assert.doesNotMatch(released, /scheduled-message-send-now|is-stuck/);

console.log("test-send-after ok");
