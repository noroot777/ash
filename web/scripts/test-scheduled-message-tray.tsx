import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ScheduledMessage } from "@ash/shared";
import {
  retainScheduledMessageActionError,
  ScheduledMessageTray,
} from "../src/components/ScheduledMessages.tsx";
import {
  attachmentsFromPaths,
  joinDraftText,
  mergeAttachments,
} from "../src/task-detail/withdrawDraft.ts";

const row = (id: string, text: string, sendAt: string): ScheduledMessage => ({
  id,
  taskId: "task",
  text,
  attachments: [],
  agent: null,
  executorId: null,
  model: null,
  reasoningEffort: null,
  mode: "queued",
  sendAt,
  status: "pending",
  createdAt: sendAt,
  sentAt: null,
});

const html = renderToStaticMarkup(
  <ScheduledMessageTray
    messages={[
      row("later", "第二条", "2026-08-25T10:00:01.000Z"),
      row("first", "第一条", "2026-08-25T10:00:00.000Z"),
    ]}
    loading={false}
    error={null}
    cancelingIds={new Set()}
    steeringIds={new Set()}
    onSteer={() => undefined}
    onWithdraw={() => undefined}
  />,
);

assert.equal((html.match(/>引导会话</g) ?? []).length, 1, "两条 queued 只能显示一个托盘级引导动作");
assert.match(html, /用最早的排队消息“第一条”引导会话/, "唯一动作必须指向队首消息");
const firstRowStart = html.indexOf('<div class="scheduled-message-row">');
const firstRowEnd = html.indexOf("</div>", firstRowStart);
const firstRow = html.slice(firstRowStart, firstRowEnd);
const secondRow = html.slice(html.indexOf('<div class="scheduled-message-row">', firstRowEnd));
assert.match(firstRow, /scheduled-message-guide/, "引导动作应放在队首消息行内");
assert.doesNotMatch(secondRow, /scheduled-message-guide/, "较晚消息行不得重复显示引导动作");
assert.ok(
  firstRow.indexOf("scheduled-message-guide") < firstRow.indexOf("撤回排队中的待发送消息"),
  "引导动作应位于撤回按钮左侧",
);
// 托盘上那颗按钮是**撤回**不是丢弃:标签既要点名是哪条,也要自己说清内容会回到输入框。
assert.match(html, /aria-label="撤回排队中的待发送消息“第一条”，内容放回输入框"/, "撤回按钮要点名消息并写明内容会放回输入框");
assert.equal((html.match(/scheduled-message-withdraw/g) ?? []).length, 2, "每条待发送消息各有一个撤回按钮");
const actionError = { messageId: "first", message: "消息继续排队" };
assert.deepEqual(
  retainScheduledMessageActionError(actionError, [row("first", "第一条", "2026-08-25T10:00:00.000Z")]),
  actionError,
  "对应消息仍在排队时应保留动作错误",
);
assert.equal(
  retainScheduledMessageActionError(actionError, [row("later", "第二条", "2026-08-25T10:00:01.000Z")]),
  null,
  "对应消息离队后必须清掉陈旧动作错误",
);
const source = readFileSync(new URL("../src/components/ScheduledMessages.tsx", import.meta.url), "utf8");
const reloadSource = source.slice(source.indexOf("const reload"), source.indexOf("useEffect", source.indexOf("const reload")));
assert.match(source, /const \[actionError, setActionError\]/, "动作错误必须与加载错误分开保存");
assert.match(reloadSource, /retainScheduledMessageActionError/, "reload 必须按消息是否仍在队列决定错误存活");
const css = readFileSync(new URL("../src/styles/reply.css", import.meta.url), "utf8");
assert.match(css, /@container \(max-width: 520px\)[\s\S]*scheduled-message-guide[\s\S]*display: none/, "窄托盘必须把引导按钮降级成纯图标");
const replySource = readFileSync(new URL("../src/task-detail/ReplyBox.tsx", import.meta.url), "utf8");
assert.match(
  replySource,
  /command \? "任务进行中；发送即排队，队尾可点“引导会话”/,
  "普通顶层任务即使支持派生命令，运行中提示也必须让用户发现队尾引导动作",
);
// 撤回的回填只能发生在取消成功之后：失败了消息还挂在队列上，再往输入框塞一份就成了两条。
for (const [file, source] of [
  ["ReplyBox.tsx", replySource],
  ["TeamView.tsx", readFileSync(new URL("../src/team/TeamView.tsx", import.meta.url), "utf8")],
] as const) {
  const withdraw = source.slice(source.indexOf("const withdraw = async"));
  assert.match(withdraw, /if \(!await scheduled\.cancel\(message\.id\)\) return;/, `${file} 撤回必须先取消成功再回填`);
  assert.match(withdraw, /joinDraftText\(message\.text, current\)/, `${file} 撤回必须把正文放回草稿`);
  assert.match(withdraw, /attachmentsFromPaths\(message\.attachments\)/, `${file} 撤回必须把附件放回草稿`);
}

// 回填的合并语义:撤回的内容排在已有草稿前面,同一路径的附件不重复。
assert.equal(joinDraftText("撤回的话", ""), "撤回的话", "草稿为空时直接用撤回的正文");
assert.equal(joinDraftText("", "草稿"), "草稿", "空正文不得清掉已有草稿");
assert.equal(joinDraftText("撤回的话", "草稿"), "撤回的话\n\n草稿", "两边都有内容时撤回的排前面并空行隔开");
const restored = attachmentsFromPaths([" data/uploads/abcdefghijkl-shot.png ", "/tmp/report.pdf", "data/uploads/abcdefghijkl-shot.png"]);
assert.deepEqual(
  restored.map((attachment) => [attachment.path, attachment.name, attachment.kind, attachment.url]),
  [
    ["data/uploads/abcdefghijkl-shot.png", "shot.png", "image", "/api/uploads/abcdefghijkl-shot.png"],
    ["/tmp/report.pdf", "report.pdf", "file", null],
  ],
  "附件按路径还原:图片可预览、库外路径只当文件、重复路径去重",
);
assert.deepEqual(
  mergeAttachments(restored, [{ path: "/tmp/report.pdf", name: "report.pdf", kind: "file", url: null, size: 12 }])
    .map((attachment) => attachment.path),
  ["data/uploads/abcdefghijkl-shot.png", "/tmp/report.pdf"],
  "已经在草稿里的附件不得因撤回变成两份",
);
// 手机端那一屏没有附件通道:带附件的消息必须先问过用户才允许取消,否则撤回 = 附件永久丢失。
const mobileSource = readFileSync(new URL("../../mobile/src/app/task/[id].tsx", import.meta.url), "utf8");
const mobileWithdraw = mobileSource.slice(
  mobileSource.indexOf("const withdrawScheduled"),
  mobileSource.indexOf("const meta =", mobileSource.indexOf("const withdrawScheduled")),
);
assert.match(mobileWithdraw, /if \(message\.attachments\.length\) \{[\s\S]*Alert\.alert\(/, "手机端撤回带附件的消息前必须先把后果问清楚");
assert.ok(
  mobileWithdraw.indexOf("Alert.alert(") < mobileWithdraw.indexOf("if (!await cancelPending(message)) return;"),
  "手机端确认必须挡在取消端点前面",
);
console.log("✓ 撤回回填、附件丢失防线、引导按钮位置、错误失效与窄托盘降级均受回归保护");
