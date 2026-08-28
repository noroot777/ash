import assert from "node:assert/strict";
import { readSource } from "../../scripts/read-source.mjs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ScheduledMessage } from "@ash/shared";
import {
  retainScheduledMessageActionError,
  ScheduledMessageTray,
} from "../src/components/ScheduledMessages.tsx";
import {
  attachmentsFromPaths,
  clearSentDraft,
  dropSentAttachments,
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
  sessionRole: null,
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
// 带会话角色的消息（审查链排给 reviewer 会话的答复）不归这个对话框管：撤回回来的正文
// 再发一次只会走普通 /reply，角色就丢了。所以两个入口都不给它，只如实标出来。
const managedHtml = renderToStaticMarkup(
  <ScheduledMessageTray
    messages={[
      { ...row("reviewer", "审查答复", "2026-08-25T10:00:00.000Z"), sessionRole: "reviewer" },
      row("mine", "我写的", "2026-08-25T10:00:01.000Z"),
    ]}
    loading={false}
    error={null}
    cancelingIds={new Set()}
    steeringIds={new Set()}
    onSteer={() => undefined}
    onWithdraw={() => undefined}
  />,
);
const managedStart = managedHtml.indexOf('<div class="scheduled-message-row">');
const mineStart = managedHtml.indexOf('<div class="scheduled-message-row">', managedStart + 1);
assert.ok(managedStart >= 0 && mineStart > managedStart, "两条消息应各占一行");
const managedRow = managedHtml.slice(managedStart, mineStart);
assert.match(managedRow, /审查答复/, "取到的应当是审查会话那一行");
assert.doesNotMatch(managedRow, /scheduled-message-withdraw/, "审查会话的答复不得挂撤回按钮：这个输入框重发不回它的会话");
assert.doesNotMatch(managedRow, /scheduled-message-guide/, "审查会话的答复也不得被选作托盘引导目标");
assert.match(managedRow, /scheduled-message-managed[^>]*>审查会话的答复 · 由审查链投递</, "要如实标出这条由谁投递");
assert.equal((managedHtml.match(/scheduled-message-withdraw/g) ?? []).length, 1, "用户自己那条排队消息仍可撤回");
assert.match(
  managedHtml.slice(mineStart),
  /scheduled-message-guide/,
  "带角色的消息被跳过后，引导动作要落到最早的那条用户消息上",
);

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
const source = readSource(new URL("../src/components/ScheduledMessages.tsx", import.meta.url));
const reloadSource = source.slice(source.indexOf("const reload"), source.indexOf("useEffect", source.indexOf("const reload")));
assert.match(source, /const \[actionError, setActionError\]/, "动作错误必须与加载错误分开保存");
assert.match(reloadSource, /retainScheduledMessageActionError/, "reload 必须按消息是否仍在队列决定错误存活");
const css = readSource(new URL("../src/styles/reply.css", import.meta.url));
assert.match(css, /@container \(max-width: 520px\)[\s\S]*scheduled-message-guide[\s\S]*display: none/, "窄托盘必须把引导按钮降级成纯图标");
const replySource = readSource(new URL("../src/task-detail/ReplyBox.tsx", import.meta.url));
assert.match(
  replySource,
  /command \? "任务进行中；发送即排队，队尾可点“引导会话”/,
  "普通顶层任务即使支持派生命令，运行中提示也必须让用户发现队尾引导动作",
);
// 撤回的回填只能发生在取消成功之后：失败了消息还挂在队列上，再往输入框塞一份就成了两条。
for (const [file, source] of [
  ["ReplyBox.tsx", replySource],
  ["TeamView.tsx", readSource(new URL("../src/team/TeamView.tsx", import.meta.url))],
] as const) {
  const withdraw = source.slice(source.indexOf("const withdraw = async"));
  assert.match(withdraw, /if \(!await scheduled\.cancel\(message\.id\)\) return;/, `${file} 撤回必须先取消成功再回填`);
  assert.match(withdraw, /await inFlightSend\.current;/, `${file} 撤回必须等在途的发送先结算，靠顺序而不是靠猜`);
  assert.match(withdraw, /joinDraftText\(message\.text, current\)/, `${file} 撤回必须把正文放回草稿`);
  assert.match(withdraw, /attachmentsFromPaths\(message\.attachments\)/, `${file} 撤回必须把附件放回草稿`);
  // 发送结算只认「草稿逐字没变」这一条:任何形式的子串搜索都可能把用户新写的句子
  // 当成旧的那一份删掉(2026-08-27 审查实测「方案」→「新方案细节」)。
  const send = source.slice(source.indexOf("const runSend = async"), source.indexOf("const withdraw = async"));
  assert.match(send, /const draftAtSend = value;/, `${file} 发送要先留下整份草稿快照`);
  assert.match(send, /clearSentDraft\(current, draftAtSend\)/, `${file} 发送后只在草稿没动过时才清`);
  assert.match(send, /dropSentAttachments\(current, sentPaths\)/, `${file} 附件按路径精确摘`);
  assert.doesNotMatch(send, /setValue\(""\)|uploads\.clear\(\)/, `${file} 发送后不得无条件清空草稿`);
  assert.doesNotMatch(send, /indexOf\(sent|lastIndexOf\(sent/, `${file} 不得靠子串搜索去认「发出去的那一段」`);
}

// 清空的判据只有一条：逐字还是发送时那一份。少一个字、多一个字、改一个字都整份留着。
assert.equal(clearSentDraft("发出去的话", "发出去的话"), "", "草稿没动过就清干净");
assert.equal(clearSentDraft("撤回来的\n\n发出去的话", "发出去的话"), "撤回来的\n\n发出去的话", "动过就整份留着");
assert.equal(clearSentDraft("新方案细节", "方案"), "新方案细节", "在途重写的新草稿不得被当成旧文本的容器切开");
assert.equal(clearSentDraft("  方案\n  细节", "方案"), "  方案\n  细节", "带缩进的 Markdown 草稿必须原样留着");
assert.equal(clearSentDraft("方案 方案 方案", "方案"), "方案 方案 方案", "重复子串一个都不许删");
assert.equal(clearSentDraft("方案 ", "方案"), "方案 ", "连尾随空格的差异都算动过");
assert.deepEqual(
  dropSentAttachments(
    [{ path: "/tmp/late.pdf", name: "late.pdf", kind: "file", url: null },
      { path: "/tmp/sent.pdf", name: "sent.pdf", kind: "file", url: null }],
    ["/tmp/sent.pdf"],
  ).map((attachment) => attachment.path),
  ["/tmp/late.pdf"],
  "发送只摘掉自己发出去的附件（路径是唯一标识，不用猜）",
);

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
// 手机端那一屏没有附件通道：撤回承诺「内容原样回到输入框」，对带附件的消息做不到，
// 就一次都不做——只提示去网页端，绝不能从这个入口发出取消请求。真要扔掉走独立的丢弃。
const mobileSource = readSource(new URL("../../mobile/src/components/PendingMessageTray.tsx", import.meta.url));
const slice = (from: string, to: string) => {
  const start = mobileSource.indexOf(from);
  assert.notEqual(start, -1, `手机端托盘应存在 ${from}`);
  const end = mobileSource.indexOf(to, start);
  assert.notEqual(end, -1, `${from} 之后应存在 ${to}`);
  return mobileSource.slice(start, end);
};
const mobileWithdraw = slice("const withdraw = async", "const discard =");
const attachmentBranch = mobileWithdraw.slice(
  mobileWithdraw.indexOf("if (message.attachments.length)"),
  mobileWithdraw.indexOf("if (!await cancelPending(message)) return;"),
);
assert.match(attachmentBranch, /Alert\.alert\(/, "带附件时必须先告诉用户去哪撤回");
assert.doesNotMatch(attachmentBranch, /cancelPending/, "撤回入口不得对带附件的消息发出取消请求");
assert.match(mobileWithdraw, /if \(!await cancelPending\(message\)\) return;[\s\S]*onRestoreText\(/, "无附件的消息取消成功后才回填正文");
// 丢弃是另一颗按钮、另一套措辞：明说不留内容，且必须经确认才真删。
const mobileDiscard = slice("const discard =", "return (");
assert.match(mobileDiscard, /Alert\.alert\([\s\S]*style: "destructive"[\s\S]*cancelPending\(message\)/, "丢弃必须经明确确认才调用取消端点");
assert.match(mobileDiscard, /不保留/, "丢弃的措辞必须写明内容不保留");
assert.match(mobileSource, /accessibilityLabel="丢弃这条待发送消息，内容不保留"/, "托盘上要有独立的丢弃入口");
// 手机端同样不许把审查会话的答复交给这两颗按钮:撤回回不去那个会话,丢弃直接卡住审查链。
const mobileRow = mobileSource.slice(mobileSource.indexOf("m.sessionRole ?"), mobileSource.indexOf("accessibilityLabel=\"丢弃"));
assert.match(mobileRow, /m\.sessionRole \? \([\s\S]*审查会话 · 自动投递[\s\S]*\) : \(/, "带角色的消息只标出来");
assert.ok(
  mobileRow.indexOf("审查会话 · 自动投递") < mobileRow.indexOf("void withdraw(m)"),
  "撤回与丢弃必须落在 sessionRole 为空的那个分支里",
);
console.log("✓ 撤回回填、发送减法、附件丢失防线、审查会话答复只读、引导按钮位置、错误失效与窄托盘降级均受回归保护");
