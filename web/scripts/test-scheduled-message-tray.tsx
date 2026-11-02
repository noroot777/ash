import assert from "node:assert/strict";
import { readSource } from "../../scripts/read-source.mjs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ScheduledMessage } from "@ash/shared";
import { annotationBatchPrompt, type AnnotationBatch } from "../../shared/src/page-annotation-batch.ts";
import {
  retainScheduledMessageActionError,
  ScheduledMessageTray,
} from "../src/components/ScheduledMessages.tsx";
import {
  bySendTime,
  scheduledMessageCounts,
  scheduledMessageExitCode,
  scheduledMessageMatches,
  scheduledMessageSource,
  scheduledMessageSummary,
} from "../src/components/scheduledMessagePresentation.ts";
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
  origin: null,
  mode: "queued",
  sendAt,
  status: "pending",
  createdAt: sendAt,
  sentAt: null,
});

const renderTray = (messages: ScheduledMessage[]) => renderToStaticMarkup(<ScheduledMessageTray messages={messages}
  loading={false} error={null} cancelingIds={new Set()} onWithdraw={() => undefined} />);
const samples = Array.from({ length: 3 }, (_, index) => row(`sample-${index}`, `输入-${index}`, `2026-10-24T10:00:0${index}.000Z`));
assert.equal(renderTray([]), "", "空队列不占回复区");
for (const count of [1, 2]) {
  const markup = renderTray(samples.slice(0, count));
  assert.equal((markup.match(/class="scheduled-message-row"/g) ?? []).length, count);
  assert.equal((markup.match(/class="scheduled-message-card/g) ?? []).length, 1, "一两条也统一在同一张卡片中");
  assert.equal((markup.match(/class="scheduled-message-inspect"/g) ?? []).length, count, "每条预览都有完整输入入口");
  assert.match(markup, new RegExp(`展开全部 ${count} 条`));
  assert.doesNotMatch(markup, /scheduled-message-single|另有 [0-] 条/);
}
const folded = renderTray(samples);
assert.equal((folded.match(/class="scheduled-message-card/g) ?? []).length, 1);
assert.equal((folded.match(/class="scheduled-message-row"/g) ?? []).length, 3);
assert.match(folded, /展开全部 3 条/);
assert.doesNotMatch(folded, /另有|scheduled-message-popover/);
assert.match(folded, /输入-2/, "所有用户消息都能不展开直接撤回");
assert.match(renderTray([{ ...samples[0], sessionRole: "reviewer", attachments: ["/tmp/review-notes.txt"] }]), /查看完整输入：输入-0/);
const equalTime = [samples[1], { ...samples[0], id: "z", sendAt: samples[1].sendAt }, { ...samples[0], sendAt: samples[1].sendAt }];
assert.deepEqual(bySendTime(equalTime).map((message) => message.id), ["sample-0", "z", "sample-1"]);
assert.equal(equalTime[0], samples[1], "展示排序不得改动消息原数组");
const monitor = (text: string): ScheduledMessage => ({ ...samples[0], origin: "monitor:test", sessionRole: "reviewer", text });
assert.equal(scheduledMessageSummary(monitor("【哨兵事件】完整行为检查（monitorId=test） review-transfer: EXIT=0\n日志正文")), "完整行为检查");
assert.equal(scheduledMessageSummary(monitor("【哨兵结束】完整行为检查，退出码 1。命令自己跑完了。")), "完整行为检查");
assert.equal(scheduledMessageSummary({ ...samples[0], text: "保留用户写的 (monitorId=test)\n第二行" }), "保留用户写的 (monitorId=test) 第二行");
assert.equal(scheduledMessageExitCode(monitor("REGRESSION_FINISHED exitCode=0 monitor=test")), 0);
assert.equal(scheduledMessageExitCode(monitor("【哨兵事件】检查\nREGRESSION_FINISHED exitCode=1 monitor=test")), 1);
assert.equal(scheduledMessageExitCode(monitor("【哨兵结束】检查（monitorId=test），退出码 -1。异常结束")), -1);
assert.equal(scheduledMessageExitCode(monitor("REGRESSION_FINISHED exitCode=0\nREGRESSION_FINISHED exitCode=1")), 1);
assert.equal(scheduledMessageExitCode(monitor("REGRESSION_FINISHED exitCode=1\n【哨兵结束】检查，退出码 0。已结束")), 1);
assert.equal(scheduledMessageExitCode(monitor("exitCode=1 只是日志里的一段文本")), null);
assert.equal(scheduledMessageExitCode(monitor("【哨兵结束】检查。进程已丢失")), null);
assert.equal(scheduledMessageExitCode({ ...samples[0], text: "REGRESSION_FINISHED exitCode=1" }), null);
assert.equal(scheduledMessageMatches(monitor("【哨兵结束】检查。进程已丢失"), "attention"), false);
const countSamples = [samples[0], { ...samples[1], sessionRole: "reviewer" as const }, monitor("REGRESSION_FINISHED exitCode=1")];
assert.deepEqual(scheduledMessageCounts(countSamples), { all: 3, mine: 1, managed: 1, monitor: 1, system: 0, attention: 1 });
assert.match(renderTray(countSamples), /1 条需留意/);

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
const annotationBatch: AnnotationBatch = {
  id: "batch", taskId: "task", createdAt: 1, gen: "gen", serviceId: "web", evidence: [],
  items: [{ id: "item", number: 1, comment: "把按钮加大", gen: "gen", serviceId: "web", documentId: "document", tool: "element",
    points: [{ x: 1, y: 2 }], element: null,
    context: { route: "/", scroll: { x: 0, y: 0 }, viewport: { width: 1000, height: 700, scale: 1 }, capturedAt: 1 } }],
};
const annotationHtml = renderToStaticMarkup(
  <ScheduledMessageTray messages={[row("annotation", annotationBatchPrompt(annotationBatch), "2026-08-25T10:00:00.000Z")]}
    loading={false} error={null} cancelingIds={new Set()} onWithdraw={() => undefined} />,
);
assert.match(annotationHtml, /页面批注 · 1 条/);
assert.match(annotationHtml, /#1 把按钮加大/);
assert.doesNotMatch(annotationHtml, /preview_page_data|公共组件 vs 单实例/);

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
// 团队那半的回复框在 e5107008 从 TeamView.tsx 拆进了 TeamReplyBox.tsx —— 这里读的是实现
// 所在的那个文件，拆走后没跟过来就等于这几条断言在读一份不存在的 withdraw。
for (const [file, source] of [
  ["ReplyBox.tsx", replySource],
  ["TeamReplyBox.tsx", readSource(new URL("../src/team/TeamReplyBox.tsx", import.meta.url))],
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
// ── 哨兵事件行 ───────────────────────────────────────────────────────────────
// 哨兵推来的事件不是用户打的字。托盘对它只能做两件事：标明来源，给一个「取消这次唤醒」。
// **绝不能给撤回**——撤回承诺「放回输入框、改完再发一次」，而那句话本来就不是用户写的，
// 再发一次等于用户替哨兵冒名说话；引导会话同理（把一条机器事件硬塞进当前回合）。
{
  const monitorRow: ScheduledMessage = {
    ...row("mon", "【哨兵事件】盯三轮\n第 1 轮完成", "2026-08-25T10:00:02.000Z"),
    origin: "monitor:m1",
  };
  const monitorHtml = renderToStaticMarkup(
    <ScheduledMessageTray
      messages={[monitorRow, row("mine", "我自己写的", "2026-08-25T10:00:03.000Z")]}
      loading={false}
      error={null}
      cancelingIds={new Set()}
      steeringIds={new Set()}
      onSteer={() => undefined}
      onWithdraw={() => undefined}
      onCancel={() => undefined}
    />,
  );
  const rows = monitorHtml.split('<div class="scheduled-message-row">');
  const monitorMarkup = rows.find((chunk) => chunk.includes("哨兵事件")) ?? "";
  const mineMarkup = rows.find((chunk) => chunk.includes("我自己写的")) ?? "";
  assert.ok(monitorMarkup, "哨兵事件行应被渲染出来");
  assert.match(monitorMarkup, /<em>哨兵<\/em>/, "哨兵行要标明这条是谁推的");
  assert.match(monitorMarkup, /取消哨兵事件[\s\S]*这一次唤醒/, "哨兵行要给「取消这次唤醒」");
  assert.doesNotMatch(monitorMarkup, /放回输入框/, "哨兵事件不是用户写的，不得提供撤回");
  assert.doesNotMatch(monitorMarkup, /scheduled-message-guide/, "哨兵事件不得出现引导会话入口");
  assert.match(mineMarkup, /放回输入框/, "用户自己那条照旧可以撤回");
  // 队首是哨兵行时，引导入口必须落到用户自己最早的那条上，而不是整个消失。
  assert.match(mineMarkup, /scheduled-message-guide/, "引导入口应落到用户自己最早的那条排队消息上");
}

// ── 带 origin 但不是哨兵的那几种 ────────────────────────────────────────────
// `origin` 早期只有哨兵在写，后来审查结算的修复交接（`review-settlement:<代次>`）、检查点
// 续跑也写它。按 `!!origin` 判哨兵会把一条审查交接标成哨兵，还配上「取消这次唤醒 / 不执行
// 停止哨兵操作」的措辞——用户据此以为「有个哨兵在盯」（2026-10-31 实例：任务 CKjeps4QSRTE
// 的 review-repair-dde14804…）。真哨兵的判据与后端同源（`monitorIdFromOrigin`），认不出来
// 的 origin 一律落到中性的「系统」，而不是沿用哨兵那一套。
{
  const repair: ScheduledMessage = { ...row("repair", "【自由工作流审查未通过 · 第 1 轮】\n请先完整读取 report.md。",
    "2026-10-31T10:00:01.000Z"), origin: "review-settlement:gen-1" };
  const resume: ScheduledMessage = { ...row("resume", "继续：把剩下两处改完", "2026-10-31T10:00:02.000Z"), origin: "checkpoint:resume" };
  const real: ScheduledMessage = { ...row("mon", "【哨兵事件】盯构建（monitorId=m1）\nREGRESSION_FINISHED exitCode=1 monitor=m1",
    "2026-10-31T10:00:00.000Z"), origin: "monitor:m1" };
  assert.deepEqual([real, repair, resume, { ...row("role", "审查答复", "2026-10-31T10:00:03.000Z"), sessionRole: "reviewer" as const },
    row("mine", "我写的", "2026-10-31T10:00:04.000Z")].map(scheduledMessageSource),
  ["monitor", "system", "system", "managed", "mine"], "来源判定:真哨兵 / 认不出的 origin 落中性 / 会话角色 / 用户自己");
  // 「哨兵」筛选器只许命中真哨兵，否则点进去看到的还是那条审查交接。
  assert.equal(scheduledMessageMatches(repair, "monitor"), false, "审查结算不属于哨兵");
  assert.equal(scheduledMessageMatches(resume, "monitor"), false, "检查点续跑不属于哨兵");
  assert.equal(scheduledMessageMatches(real, "monitor"), true, "真哨兵仍归哨兵");
  assert.equal(scheduledMessageMatches(repair, "mine"), false, "系统排入的不是用户自己的消息");
  assert.equal(scheduledMessageMatches(repair, "system"), true);
  assert.deepEqual(scheduledMessageCounts([real, repair, resume]),
    { all: 3, mine: 0, managed: 0, monitor: 1, system: 2, attention: 1 }, "三条里只有一条是哨兵");
  // 退出码是哨兵独有的概念:交接正文里引着的 REGRESSION_FINISHED 不许算成「需留意」。
  const quoted: ScheduledMessage = { ...repair, text: "【审查未通过】\nREGRESSION_FINISHED exitCode=1 monitor=m1" };
  assert.equal(scheduledMessageExitCode(quoted), null, "非哨兵来源不读退出码");
  assert.equal(scheduledMessageMatches(quoted, "attention"), false);
  assert.equal(scheduledMessageExitCode(real), 1, "真哨兵的退出码照旧读得出来");
  // 哨兵格式那几刀也只许用在真哨兵上。
  assert.equal(scheduledMessageSummary({ ...repair, text: "审查未通过（monitorId=m1），退出码 1\n正文" }),
    "审查未通过（monitorId=m1），退出码 1", "非哨兵来源的第一行原样留着");

  const markup = renderToStaticMarkup(<ScheduledMessageTray messages={[real, repair, row("mine", "我写的", "2026-10-31T10:00:04.000Z")]}
    loading={false} error={null} cancelingIds={new Set()} steeringIds={new Set()}
    onSteer={() => undefined} onWithdraw={() => undefined} onCancel={() => undefined} />);
  const chunks = markup.split('<div class="scheduled-message-row">');
  const repairRow = chunks.find((chunk) => chunk.includes("自由工作流审查未通过")) ?? "";
  const monitorRow = chunks.find((chunk) => chunk.includes("盯构建")) ?? "";
  assert.ok(repairRow && monitorRow, "两行都应被渲染出来");
  assert.doesNotMatch(repairRow, /<em>哨兵<\/em>/, "审查结算不得标成哨兵");
  assert.doesNotMatch(repairRow, /取消哨兵事件|停止哨兵/, "审查结算不得套用哨兵的取消措辞");
  assert.doesNotMatch(repairRow, /放回输入框|scheduled-message-guide/, "系统排进来的不是用户打的字，撤回与引导都不给");
  assert.match(repairRow, /<em>系统<\/em>/, "认不出来源时只说「系统」，不冒充哨兵");
  assert.match(repairRow, /scheduled-message-managed[^>]*>由系统排入 · 不可撤回</, "要说清这行为什么没有按钮");
  // 真哨兵那一行一个字都不变。
  assert.match(monitorRow, /<em>哨兵<\/em>/);
  assert.match(monitorRow, /取消哨兵事件[\s\S]*这一次唤醒（仅移除本条输入，不执行停止哨兵操作）/);
  // 头部计数与筛选器按来源分摊:只有真哨兵算进「哨兵 N」。
  assert.match(markup, /我的消息 1 · 哨兵 1 · 系统 1/, "头部按真实来源分摊计数");
  assert.doesNotMatch(markup, /哨兵 2/);
}
// 展开后那排筛选器(含只在有系统输入时才多出来的「系统」)要真浏览器才摆得出来,
// 钉在 test-scheduled-message-tray-dom.mjs 里。

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
console.log("✓ 撤回回填、发送减法、附件丢失防线、审查会话答复只读、哨兵事件只许取消、"
  + "非哨兵 origin 不套哨兵口径、引导按钮位置、错误失效与窄托盘降级均受回归保护");
