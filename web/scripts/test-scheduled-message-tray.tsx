import assert from "node:assert/strict";
import { readSource } from "../../scripts/read-source.mjs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ScheduledMessage } from "@navi/shared";
import type { TaskMonitor } from "@navi/shared/monitor";
import type { TrayMonitors } from "../src/components/MonitorTrayRow.tsx";
import { endedMonitorIds } from "../src/monitors/monitorTray.ts";
import { annotationBatchPrompt, type AnnotationBatch } from "../../shared/src/page-annotation-batch.ts";
import {
  retainScheduledMessageActionError,
  ScheduledMessageTray,
} from "../src/components/ScheduledMessages.tsx";
import {
  bySendTime,
  scheduledMessageExitCode,
  scheduledMessageNeedsAttention,
  scheduledMessageSource,
  scheduledMessageSummary,
} from "../src/components/scheduledMessagePresentation.ts";
import {
  attachmentsFromPaths,
  clearSentDraft,
  dropSentAttachments,
  joinDraftText,
  mergeAttachments,
  reuseDraft,
  sentSelections,
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

type TrayExtra = Partial<React.ComponentProps<typeof ScheduledMessageTray>>;
const renderTray = (messages: ScheduledMessage[], extra: TrayExtra = {}) => renderToStaticMarkup(<ScheduledMessageTray messages={messages}
  loading={false} error={null} cancelingIds={new Set()} onWithdraw={() => undefined} {...extra} />);
const renderSteerTray = (messages: ScheduledMessage[], extra: TrayExtra = {}) => renderTray(messages, { onSteer: () => undefined, ...extra });
/** 点开后的那几行;每一段是一条(从它的 data-message-id 起)。 */
const openRows = (markup: string) => markup.split('<div class="scheduled-message-item').slice(1);
const rowOf = (markup: string, text: string) => openRows(markup).find((chunk) => chunk.includes(text)) ?? "";
/** 「排队 N」那一行本身,到点开的列表(或读屏播报)为止。 */
const line = (markup: string) => {
  const start = markup.indexOf('class="scheduled-tray-line"');
  const ends = [markup.indexOf('class="scheduled-tray-list"', start), markup.indexOf("scheduled-message-announcement", start)].filter((at) => at > 0);
  return markup.slice(start, Math.min(...ends));
};
const samples = Array.from({ length: 3 }, (_, index) => row(`sample-${index}`, `输入-${index}`, `2026-10-24T10:00:0${index}.000Z`));
assert.equal(renderTray([]), "", "空队列不占回复区");

// ── 收着:只有一行 ───────────────────────────────────────────────────────────
for (const count of [1, 2, 3]) {
  const markup = renderTray(samples.slice(0, count));
  assert.equal((markup.match(/class="scheduled-tray-line"/g) ?? []).length, 1, "收着时只有一行");
  assert.match(markup, new RegExp(`排队 ${count}<`));
  assert.match(markup, /aria-expanded="false"/);
  assert.equal(openRows(markup).length, 0, "收着时不列出每一条");
  assert.match(line(markup), /查看完整输入：输入-0/, "这一行上带着用户自己最早那条");
  assert.doesNotMatch(line(markup), /输入-1/, "只带最早那一条");
}
const folded = renderSteerTray([{ ...samples[0], steerable: true }, samples[1]]);
assert.doesNotMatch(folded, /scheduled-message-card|展开全部|收起列表|筛选|我的消息|#1|按发送时间和入队顺序处理|需留意</,
  "卡片、来源统计、筛选键、序号、页脚、展开全部都去掉了");
assert.match(line(folded), /scheduled-message-guide[\s\S]*>引导会话</, "最早那条能引导时,引导键就在这一行上");
assert.match(line(folded), /用最早的排队消息“输入-0”引导会话/);
assert.doesNotMatch(line(renderSteerTray(samples)), /scheduled-message-guide/, "服务端没说能引导,这一行上就没有引导键");
assert.doesNotMatch(line(renderTray([{ ...samples[0], steerable: true }])), /scheduled-message-guide/, "团队回复框没有引导");
const machineFirst = renderSteerTray([{ ...samples[0], origin: "monitor:m", text: "【哨兵事件】盯构建" },
  { ...samples[1], sessionRole: "reviewer" }, { ...samples[2], steerable: true }]);
assert.match(line(machineFirst), /查看完整输入：输入-2[\s\S]*引导会话/, "排在前面的是机器输入时,这一行带的仍是用户自己最早那条");
const timedFirst = renderSteerTray([{ ...samples[0], mode: "timed" }, { ...samples[1], steerable: true }]);
assert.match(line(timedFirst), /查看完整输入：输入-1[\s\S]*引导会话/, "定时的不按排队顺序发:那一行带的是下一个就发的那条");
assert.match(line(renderTray([{ ...samples[0], mode: "timed" }])), /查看完整输入：输入-0/, "没有排队的才带定时那条");
const machinesOnly = renderTray([{ ...samples[0], origin: "monitor:m", text: "【哨兵事件】盯构建" }, { ...samples[1], sessionRole: "reviewer" }]);
assert.doesNotMatch(line(machinesOnly), /scheduled-tray-head|查看完整输入/, "没有自己的消息时这一行只说排队几条");
// 收着时最早那条的撤回跟引导会话一样就在这一行上，不用先点开（用户 2026-11-16）。
assert.match(line(folded), /撤回排队中的待发送消息“输入-0”[\s\S]*引导会话/, "撤回在这一行上，排在引导会话前面");
assert.match(line(renderTray(samples)), /scheduled-message-withdraw is-shown[^>]*撤回排队中的待发送消息“输入-0”/, "不能引导时撤回照样在，而且常显");
assert.doesNotMatch(line(machinesOnly), /撤回/, "没有自己的消息时这一行没有撤回");
assert.doesNotMatch(line(renderTray(samples, { defaultExpanded: true })), /撤回/, "点开后撤回回到每一行行尾，这一行不再带");

// ── 还在盯的哨兵并在同一块里（用户 2026-11-16：另占一行显得臃肿）─────────────────────
const watcher = (id: string, description: string, extra: Partial<TaskMonitor> = {}): TaskMonitor => ({
  id, taskId: "task", kind: "ash", nativeId: null, lifetime: "bounded", command: `watch ${id}`, description, cwd: "/repo",
  status: "running", pid: 1, events: 0, exitCode: null, startedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
  startedAtExact: true, expiresAt: new Date(Date.now() + 12 * 60_000).toISOString(), timeoutMs: 900_000,
  endedAt: null, endedReason: null, stopWhen: null, resultHandoffAt: null, resultsAbandonedAt: null, ...extra,
} as TaskMonitor);
const trayMonitors = (live: TaskMonitor[], running = true, ended: ReadonlySet<string> = new Set()): TrayMonitors => ({
  live, ended, running, resumePrompt: null, reviewArmed: false, onOpen: () => undefined, onStop: async () => undefined,
});
const two = [watcher("m1", "等回归跑完"), watcher("m2", "盯构建日志")];
{
  const both = renderSteerTray([{ ...samples[0], steerable: true }], { monitors: trayMonitors(two) });
  assert.equal((both.match(/class="scheduled-tray-line"/g) ?? []).length, 1, "哨兵不另占一行");
  assert.doesNotMatch(both, /monitor-wait-line/, "那条单独的「哨兵在盯」不再出现");
  assert.match(line(both), /aria-label="排队 1，哨兵 2"/, "条数那颗键把两样都数上");
  assert.match(line(both), /scheduled-tray-monitors is-live/, "有会叫醒任务的哨兵在盯：脉冲在动");
  assert.match(line(both), /查看完整输入：输入-0[\s\S]*引导会话/, "有自己的消息时这一行仍带最早那条");
  assert.doesNotMatch(line(both), /等回归跑完/, "有自己的消息时不再挤上哨兵那一句");

  const only = renderTray([], { monitors: trayMonitors(two) });
  assert.match(line(only), /aria-label="哨兵 2"/, "只有哨兵时只数哨兵");
  assert.match(line(only), /等回归跑完 \+1 · 盯了 3 分钟/, "没有自己的消息时这一行说盯的是谁、盯了多久（到分钟）");
  assert.match(renderTray([], { monitors: trayMonitors(two, false) }), /等回归跑完 \+1 · 等了 3 分钟/, "任务停下来等它时说「等了」");
  assert.match(only, /role="status">0 条待发送消息，2 个哨兵在盯</, "读屏播报带上哨兵");
  assert.equal(renderTray([], { monitors: trayMonitors([]) }), "", "什么都没有就不占回复区");

  const builtinOnly = renderTray([], { monitors: trayMonitors([watcher("c1", "内置的那个", { kind: "claude" })]) });
  assert.match(line(builtinOnly), /class="scheduled-tray-monitors"/, "只剩内置 Monitor：脉冲不动（它不会叫醒任务）");

  const opened = renderTray([samples[0]], { monitors: trayMonitors([...two, watcher("c1", "内置的那个", { kind: "claude" })]), defaultExpanded: true });
  const rows = opened.split('<div class="scheduled-message-item').slice(1);
  assert.equal(rows.length, 4, "点开：三个哨兵一行一个，加一条排队消息");
  assert.match(rows[0]!, /data-monitor-id="m1"[\s\S]*>在盯<[\s\S]*>等回归跑完<[\s\S]*盯了 3 分钟 · 最迟 (\d\d\/\d\d )?\d\d:\d\d/, "哨兵在前：谁 · 盯什么 · 盯了多久、最迟几点");
  assert.match(rows[0]!, /在右侧哨兵格里看「等回归跑完」[\s\S]*停掉：哨兵「等回归跑完」/, "行尾两颗键：去哨兵格、停掉");
  assert.match(rows[2]!, />内置<[\s\S]*不会叫醒任务/, "内置的那种说清它不会叫醒任务");
  assert.doesNotMatch(rows[2]!, /停掉/, "内置的停不掉，就不给停的键");
  assert.match(rows[3]!, /data-message-id="sample-0"/, "排队消息在哨兵后面");
  assert.match(renderTray([], { monitors: trayMonitors(two, false), defaultExpanded: true }), />在等<[\s\S]*不等了：哨兵「等回归跑完」/,
    "任务停下来等它时：「在等」、键叫「不等了」");

  // 在盯的和已经结束的一眼分得出（用户 2026-11-16）：在盯 = 呼吸的琥珀点，内置 = 不动的灰点，
  // 已结束、结果还排着的 = 不动的空心方块；还在盯的哨兵送来的一条不画「已结束」。
  assert.match(rows[0]!, /scheduled-monitor-mark is-live" role="img" aria-label="在盯"/, "在盯的那一行：呼吸的点");
  assert.match(rows[2]!, /scheduled-monitor-mark is-builtin/, "内置的那一行：不动的灰点");
  const fromEnded = { ...samples[1], id: "ended", origin: "monitor:gone", text: "【哨兵结束】早就停了（monitorId=gone），退出码 1。" };
  const fromLive = { ...samples[2], id: "alive", origin: "monitor:m1", text: "【哨兵事件】等回归跑完（monitorId=m1）\n一行输出" };
  const mixed = renderTray([fromEnded, fromLive], { monitors: trayMonitors(two, true, new Set(["gone"])), defaultExpanded: true });
  assert.match(rowOf(mixed, "早就停了"), /scheduled-monitor-mark is-ended" role="img" aria-label="已结束"/, "读到它已结束：空心方块");
  assert.doesNotMatch(rowOf(mixed, "一行输出"), /scheduled-monitor-mark/, "哨兵还在盯，它送来的这一条不说「已结束」");
  // 列表还没读到 / 读失败 / 里面找不到这一个：不在「在盯」里不等于停了，什么都不画（第 1 轮审查 F1）
  const unknown = renderTray([fromEnded, fromLive], { monitors: trayMonitors([]), defaultExpanded: true });
  assert.doesNotMatch(unknown, /scheduled-monitor-mark/, "没读到终态就不说「已结束」");
  const finished = { ...watcher("gone", "早就停了"), status: "exited" } as TaskMonitor;
  assert.deepEqual([...endedMonitorIds([two[0]!, finished], true)], ["gone"], "读到的列表里，不在跑的那几个才算结束");
  assert.equal(endedMonitorIds([finished], false).size, 0, "列表还没读成功过：一个都不算结束");
  assert.doesNotMatch(renderTray([fromEnded], { defaultExpanded: true }), /scheduled-monitor-mark/, "不知道哪些在盯（团队回复框）就不画记号");
}
// 要留意的条数:退出码非零的哨兵才算,是琥珀色的字。
const attentionTray = renderTray([samples[0], { ...samples[1], origin: "monitor:a", text: "【哨兵结束】检查，退出码 2。" },
  { ...samples[2], origin: "monitor:b", text: "【哨兵结束】检查，退出码 0。" }, { ...samples[0], id: "c", origin: "monitor:c", text: "REGRESSION_FINISHED exitCode=1" }]);
assert.match(line(attentionTray), /class="scheduled-tray-attention"[^>]*>2 条要留意</);
assert.match(attentionTray, /role="status">4 条待发送消息，2 条需留意</, "读屏播报照旧");
assert.doesNotMatch(renderTray(samples), /scheduled-tray-attention/, "没有要留意的就不写");
assert.match(renderTray(samples), /role="status">3 条待发送消息</);

// ── 点开:每一条一行,谁排进来的 · 摘要 · 什么时候发 · 行尾的键 ─────────────────
const opened = renderTray(samples, { defaultExpanded: true });
assert.equal(openRows(opened).length, 3);
assert.match(opened, /aria-label="排队输入完整列表"/);
assert.doesNotMatch(line(opened), /scheduled-tray-head/, "点开后那一行不再重复带最早那条");
assert.equal((opened.match(/class="scheduled-message-summary" aria-expanded="false"/g) ?? []).length, 3, "每条的摘要都能点开全文");
assert.equal((opened.match(/class="scheduled-message-source">你</g) ?? []).length, 3);
assert.match(renderTray([{ ...samples[0], sessionRole: "reviewer", attachments: ["/tmp/review-notes.txt"] }], { defaultExpanded: true }),
  /aria-expanded="false"[^>]*>输入-0</, "审查答复也有全文入口");
assert.match(renderTray([{ ...samples[0], agent: "codex" }], { defaultExpanded: true }), /scheduled-message-agent">@codex</, "指定了智能体的照旧带上");
assert.match(renderTray([{ ...samples[0], mode: "timed", sendAt: "2026-10-24T10:30:00.000Z" }], { defaultExpanded: true }),
  /scheduled-message-when">\d\d\/\d\d \d\d:\d\d 发</, "定时的写时刻");
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
assert.equal(scheduledMessageNeedsAttention(monitor("【哨兵结束】检查。进程已丢失")), false);
assert.equal(scheduledMessageNeedsAttention(monitor("REGRESSION_FINISHED exitCode=1")), true);
assert.equal(scheduledMessageNeedsAttention(monitor("REGRESSION_FINISHED exitCode=0")), false);
// 哨兵行:退出码非零时「哨兵」琥珀色并写出 exit N;是 0 的不写。
const exitRows = renderTray([monitor("【哨兵结束】失败的检查，退出码 1。"), monitor("【哨兵结束】通过的检查，退出码 0。")],
  { defaultExpanded: true, onCancel: () => undefined });
assert.match(rowOf(exitRows, "失败的检查"), /scheduled-message-source is-attention">哨兵<span class="scheduled-message-exit">exit 1</);
assert.doesNotMatch(rowOf(exitRows, "通过的检查"), /exit 0|is-attention/);

const html = renderSteerTray([
  row("later", "第二条", "2026-08-25T10:00:01.000Z"),
  { ...row("first", "第一条", "2026-08-25T10:00:00.000Z"), steerable: true },
], { defaultExpanded: true, steeringIds: new Set() });
assert.equal((html.match(/>引导会话</g) ?? []).length, 1, "两条 queued 只能显示一个引导动作");
assert.match(html, /用最早的排队消息“第一条”引导会话/, "唯一动作必须指向队首消息");
const [firstRow, secondRow] = openRows(html);
assert.match(firstRow!, /scheduled-message-guide/, "引导动作应放在队首消息行内");
assert.doesNotMatch(secondRow!, /scheduled-message-guide/, "较晚消息行不得重复显示引导动作");
assert.ok(firstRow!.indexOf("scheduled-message-guide") < firstRow!.indexOf("撤回排队中的待发送消息"), "引导动作应位于撤回按钮左侧");
// 托盘上那颗按钮是**撤回**不是丢弃:标签既要点名是哪条,也要自己说清内容会回到输入框。
assert.match(html, /aria-label="撤回排队中的待发送消息“第一条”，内容放回输入框"/, "撤回按钮要点名消息并写明内容会放回输入框");
assert.equal((html.match(/scheduled-message-reveal scheduled-message-withdraw/g) ?? []).length, 2, "每条待发送消息各有一个撤回按钮");
// 引导键带字、一直看得见;撤回是指到才出的图标键。
assert.match(firstRow!, /<span>引导会话<\/span>/);
assert.match(renderSteerTray([{ ...row("first", "第一条", "2026-08-25T10:00:00.000Z"), steerable: true }],
  { defaultExpanded: true, steeringIds: new Set(["first"]) }), /<span>引导中<\/span>/, "引导中的忙碌态照旧");
// 带会话角色的消息（审查链排给 reviewer 会话的答复）不归这个对话框管：撤回回来的正文
// 再发一次只会走普通 /reply，角色就丢了。所以行尾不给键，原来常驻的那两句小字也不再写。
const managedHtml = renderSteerTray([
  { ...row("reviewer", "审查答复", "2026-08-25T10:00:00.000Z"), sessionRole: "reviewer" },
  { ...row("mine", "我写的", "2026-08-25T10:00:01.000Z"), steerable: true },
], { defaultExpanded: true, onCancel: () => undefined });
const [managedRow, mineRow] = openRows(managedHtml);
assert.match(managedRow!, /scheduled-message-source">审查答复</, "取到的应当是审查会话那一行");
assert.doesNotMatch(managedRow!, /<button(?![^>]*scheduled-message-summary)/, "审查会话的答复行尾没有键:这个输入框重发不回它的会话");
assert.doesNotMatch(managedHtml, /由审查链投递|不可撤回/, "那两句说明不再常驻");
assert.match(mineRow!, /scheduled-message-withdraw/, "用户自己那条排队消息仍可撤回");
assert.match(mineRow!, /scheduled-message-guide/, "带角色的消息被跳过后，引导动作要落到最早的那条用户消息上");
// 每条在等什么由服务端按结构给(wait),写在它自己那一行;不按 mode 写死「等待当前一轮结束」。
// 2026-11-13 现场:任务早停了,真正挡着答复的是同队另一条在跑的任务,托盘却说在等这一轮。
const blockedBy = { kind: "queue" as const, blockers: [{ id: "task-b", title: "整理发布说明", running: true }] };
const queueBlocked = renderSteerTray([{ ...row("answer", "我的答复", "2026-11-13T13:25:51.000Z"), wait: blockedBy, steerable: false }],
  { defaultExpanded: true });
assert.match(queueBlocked, /同一队列里「整理发布说明」正在运行，轮到本任务时发送/, "等同队任务时点名那个任务");
assert.doesNotMatch(queueBlocked, /等待当前一轮结束|等本任务这一轮结束/);
assert.doesNotMatch(queueBlocked, /引导会话/, "任务不在跑,点了必被拒的引导键不出现");
const waitingEarlier = renderTray([{ ...row("answer", "我的答复", "2026-11-13T13:25:51.000Z"),
  wait: { kind: "queue", blockers: [{ id: "task-b", title: "整理发布说明", running: false }] } }], { defaultExpanded: true });
assert.match(waitingEarlier, /同一队列里排在前面的「整理发布说明」还没完成/);
const ownTurn = renderSteerTray([{ ...row("next", "下一句", "2026-11-13T13:25:51.000Z"), wait: { kind: "turn" }, steerable: true }],
  { defaultExpanded: true });
assert.match(ownTurn, /等本任务这一轮结束/, "等本任务这一轮是另一种原因");
assert.match(ownTurn, />引导会话</, "本任务在跑、服务端说能引导,才给这颗键");
assert.match(renderTray([{ ...row("paused", "暂停中", "2026-11-13T13:25:51.000Z"), wait: { kind: "groupPaused" } }], { defaultExpanded: true }),
  /分组已暂停，恢复后发送/);
const unknown = renderSteerTray([row("legacy", "旧服务端", "2026-11-13T13:25:51.000Z")], { defaultExpanded: true });
assert.doesNotMatch(unknown, /等待当前一轮结束|等本任务/, "说不出原因就不说");
assert.match(unknown, /class="scheduled-message-when"><\/span>/, "说不出原因也占着那一格,后面的键才对得上列");
assert.doesNotMatch(unknown, /引导会话/, "服务端没下发能不能引导时不给这颗键");
// 抬头那句总的等待说明没有了:每一条写自己的。
const mixedWaits = renderTray([
  { ...row("head", "第一句", "2026-11-13T13:25:51.000Z"), wait: { kind: "turn" } },
  { ...row("same", "第二句", "2026-11-13T13:25:52.000Z"), wait: { kind: "turn" } },
  { ...row("other", "第三句", "2026-11-13T13:25:53.000Z"), wait: { kind: "groupPaused" } },
], { defaultExpanded: true });
assert.equal((mixedWaits.match(/等本任务这一轮结束/g) ?? []).length, 2, "每一条在自己那一行写它在等什么");
assert.match(rowOf(mixedWaits, "第三句"), /scheduled-message-when">分组已暂停，恢复后发送/);
assert.doesNotMatch(line(mixedWaits), /等本任务这一轮结束/, "那一行上不再单独写总的等待说明");

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
const css = readSource(new URL("../src/styles/scheduled-message-tray.css", import.meta.url));
assert.match(css, /@container \(max-width: 480px\) \{[^}]*\}\s*\.scheduled-message-when \{ display: none; \}/, "窄了先让「什么时候发」那一格让位");
assert.match(css, /@container \(max-width: 360px\)[\s\S]*\.scheduled-message-guide > span \{ display: none; \}/, "再窄,引导键降级成纯图标,但键还在");
assert.match(css, /\.scheduled-message-row:focus-within \.scheduled-message-reveal/, "指到才出的键,键盘走到时也要出");
assert.match(css, /@media \(hover: none\) \{ \.scheduled-message-reveal \{ opacity: 1; \} \}/, "触屏没有悬停,指到才出的键一直在");
assert.doesNotMatch(readSource(new URL("../src/styles/reply.css", import.meta.url)), /scheduled-message/, "托盘的样式只在它自己那份文件里");
const replySource = readSource(new URL("../src/task-detail/ReplyBox.tsx", import.meta.url));
// 输入框里只写「回复…」；队尾那颗引导键自己指上去说它做什么。
assert.match(replySource, /: "回复…"/, "回复框占位只写「回复…」，原因只在发不出去时才写进去");
assert.match(
  readSource(new URL("../src/components/ScheduledMessageRow.tsx", import.meta.url)),
  /不等这一轮结束，把这条直接接进正在进行的对话/,
  "队尾的引导键必须自己说清它做什么，用户才发现得了它",
);
// 撤回的回填只能发生在取消成功之后：失败了消息还挂在队列上，再往输入框塞一份就成了两条。
// 团队那半的回复框在 e5107008 从 TeamView.tsx 拆进了 TeamReplyBox.tsx —— 这里读的是实现
// 所在的那个文件，拆走后没跟过来就等于这几条断言在读一份不存在的 withdraw。
// 单飞那半的撤回又抽进了 withdrawDraft.ts 的 withdrawIntoBox（取消、等发送、回填都在那儿，经 `box.` 调），
// ReplyBox 只管把自己那几样交过去——同样读实现所在的那一份。
const withdrawDraftSource = readSource(new URL("../src/task-detail/withdrawDraft.ts", import.meta.url));
assert.match(replySource, /const withdraw = \(message: ScheduledMessage\) => withdrawIntoBox\(message,/, "ReplyBox.tsx 撤回走 withdrawIntoBox");
for (const [file, source, withdraw] of [
  ["ReplyBox.tsx", replySource, withdrawDraftSource.slice(withdrawDraftSource.indexOf("export async function withdrawIntoBox"))],
  ...[readSource(new URL("../src/team/TeamReplyBox.tsx", import.meta.url))]
    .map((team) => ["TeamReplyBox.tsx", team, team.slice(team.indexOf("const withdraw = async"))] as const),
] as const) {
  assert.match(withdraw, /if \(!await (scheduled|box)\.cancel\(message\.id\)\) return;/, `${file} 撤回必须先取消成功再回填`);
  assert.match(withdraw, /await (box\.)?draft\.afterSend\(\);/, `${file} 撤回必须等在途的发送先结算，靠顺序而不是靠猜`);
  // 在途发送登记在草稿库上（一组而不是一个），早退的那次调用顶不掉真正在飞的。
  assert.match(source, /draft\.trackSend\(run\);/, `${file} 发送必须登记到草稿库，撤回和「改了再发」才等得到它`);
  assert.match(withdraw, /joinDraftText\(message\.text, current\)/, `${file} 撤回必须把正文放回草稿`);
  assert.match(withdraw, /attachmentsFromPaths\(message\.attachments\)/, `${file} 撤回必须把附件放回草稿`);
  // 发送结算只认「草稿逐字没变」这一条:任何形式的子串搜索都可能把用户新写的句子
  // 当成旧的那一份删掉(2026-08-27 审查实测「方案」→「新方案细节」)。
  const send = source.slice(source.indexOf("const runSend = async"), source.indexOf("const withdraw = "));
  assert.match(send, /const draftAtSend = \{ text: value, textVersion: draft\.value\.textVersion \};/, `${file} 发送要先留下整份草稿快照（字面 + 版本）`);
  assert.match(send, /clearSentDraft\(current, draftAtSend\)/, `${file} 发送后只在草稿没动过时才清`);
  assert.match(send, /const sentSelection = sentSelections\(uploads\.attachments\);/, `${file} 发送要记下提交的是哪几次选择`);
  assert.match(send, /dropSentAttachments\(current, sentSelection\)/, `${file} 附件按提交时的选择精确摘`);
  assert.doesNotMatch(send, /setValue\(""\)|uploads\.clear\(\)/, `${file} 发送后不得无条件清空草稿`);
  assert.doesNotMatch(send, /indexOf\(sent|lastIndexOf\(sent/, `${file} 不得靠子串搜索去认「发出去的那一段」`);
}

// 清空的判据只有一条：逐字还是发送时那一份。少一个字、多一个字、改一个字都整份留着。
assert.equal(clearSentDraft({ text: "发出去的话" }, { text: "发出去的话" }), "", "草稿没动过就清干净");
assert.equal(clearSentDraft({ text: "撤回来的\n\n发出去的话" }, { text: "发出去的话" }), "撤回来的\n\n发出去的话", "动过就整份留着");
assert.equal(clearSentDraft({ text: "新方案细节" }, { text: "方案" }), "新方案细节", "在途重写的新草稿不得被当成旧文本的容器切开");
assert.equal(clearSentDraft({ text: "  方案\n  细节" }, { text: "方案" }), "  方案\n  细节", "带缩进的 Markdown 草稿必须原样留着");
assert.equal(clearSentDraft({ text: "方案 方案 方案" }, { text: "方案" }), "方案 方案 方案", "重复子串一个都不许删");
assert.equal(clearSentDraft({ text: "方案 " }, { text: "方案" }), "方案 ", "连尾随空格的差异都算动过");
assert.equal(clearSentDraft({ text: "继续", textVersion: 3 }, { text: "继续", textVersion: 3 }), "", "字面和版本都没变才是提交的那一份");
assert.equal(clearSentDraft({ text: "继续", textVersion: 5 }, { text: "继续", textVersion: 3 }), "继续",
  "清掉又放回同一句：字一样、版本换了，迟到的确认不得清掉（「改了再发」第 3 轮审查实测）");
// 旧版本存下的提交没记版本：未知就是未知。草稿也从没换过版本才算那一份，认领过的清不走。
assert.equal(clearSentDraft({ text: "继续" }, { text: "继续" }), "", "旧提交、草稿升级后没动过：照旧清掉");
assert.equal(clearSentDraft({ text: "继续", textVersion: "v-new" }, { text: "继续" }), "继续",
  "旧提交缺版本、草稿已被认领：迟到的确认不得清掉（第 4 轮审查实测）");
{
  const side = readSource(new URL("../src/side-chat/useSideChat.ts", import.meta.url));
  assert.match(side, /textVersion: request\.draftVersion \}/, "侧聊确认按提交时记下的版本清正文");
  assert.doesNotMatch(side, /request\.draftVersion \?\?/, "旧提交缺版本时不得拿草稿此刻的版本去补（第 4 轮审查实测）");
}
assert.deepEqual(
  dropSentAttachments(
    [{ path: "/tmp/late.pdf", name: "late.pdf", kind: "file", url: null },
      { path: "/tmp/sent.pdf", name: "sent.pdf", kind: "file", url: null }],
    [{ path: "/tmp/sent.pdf" }],
  ).map((attachment) => attachment.path),
  ["/tmp/late.pdf"],
  "发送只摘掉自己发出去的附件（直接上传的路径就是唯一标识，不用猜）",
);
// 同一路径又选了一次（撤回、「改了再发」放回）：选择记号不同，在途那次发送结算时摘不走它。
{
  const shot = "data/uploads/abcdefghijkl-shot.png";
  const [sentShot] = attachmentsFromPaths([shot]);
  const sent = sentSelections([sentShot!]);
  const reselected = mergeAttachments(attachmentsFromPaths([shot]), [sentShot!]);
  assert.equal(reselected.length, 1, "又选一次不会变成两份");
  assert.notEqual(reselected[0]!.selection, sentShot!.selection, "又选一次换上新的选择记号");
  assert.deepEqual(dropSentAttachments(reselected, sent).map((attachment) => attachment.path), [shot],
    "旧发送结算时不得摘掉途中又选进来的同一张图（「改了再发」第 2 轮审查实测）");
  assert.deepEqual(dropSentAttachments([sentShot!], sent), [], "没再选过的那份照常摘掉");
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), sent, "提交的选择能原样落进本地存储（侧聊迟到确认靠它）");
}
assert.notEqual(
  attachmentsFromPaths(["/tmp/a.pdf"])[0]!.selection,
  attachmentsFromPaths(["/tmp/a.pdf"])[0]!.selection,
  "每次还原都是一次新的选择",
);

// 「改了再发」的合并：判连点认「同一条 + 放回后草稿没动过（正文版本、附件数组都没换）」，不看
// 草稿里有没有这几个字；每次放回（含连点）都是认领：正文换新版本、附件换新选择记号。
{
  const input = { source: "m1", text: "继续" };
  const restore = () => attachmentsFromPaths(["/tmp/a.pdf"]);
  const first = reuseDraft(input, restore(), { text: "不要继续", textVersion: 1, attachments: [] }, null, 2);
  assert.equal(first.text, "继续\n\n不要继续", "草稿碰巧含着这几个字也照样放回（第 1 轮审查实测）");
  assert.deepEqual(first.attachments.map((attachment) => attachment.path), ["/tmp/a.pdf"]);
  assert.equal(first.textVersion, 2, "放回换上新的正文版本");
  const settled = { text: first.text, textVersion: first.textVersion, attachments: first.attachments };
  const again = reuseDraft(input, restore(), settled, first.mark, 3);
  assert.equal(again.text, first.text, "放回后一点没动就是连点，正文不再接一遍");
  assert.equal(again.textVersion, 3, "连点也是认领，正文换版本");
  assert.notEqual(again.attachments[0]!.selection, first.attachments[0]!.selection, "连点也换附件选择记号");
  assert.equal(reuseDraft({ ...input, source: "m2" }, restore(), settled, first.mark, 3).text,
    "继续\n\n继续\n\n不要继续", "换一条就不是连点");
  assert.equal(reuseDraft(input, restore(), { text: "", textVersion: 9, attachments: [] }, first.mark, 10).text, "继续",
    "草稿被发送清掉之后再点，照样放回");
  assert.equal(reuseDraft(input, restore(), { ...settled, textVersion: 7 }, first.mark, 8).text, "继续\n\n继续\n\n不要继续",
    "正文动过（版本换了）就不算连点");
  assert.equal(reuseDraft(input, restore(), { ...settled, attachments: [...settled.attachments] }, first.mark, 8).text,
    first.text, "确认到达后附件被重读成一份新数组，选择没变就还是连点（第 4 轮审查实测）");
  assert.equal(reuseDraft(input, restore(), { ...settled, attachments: [] }, first.mark, 8).text,
    "继续\n\n继续\n\n不要继续", "附件动过（删了一张）就不算连点");
  // 纯函数：同一组输入重放（StrictMode 重放 updater）得到同一个结果。
  const restored = restore();
  assert.deepEqual(reuseDraft(input, restored, settled, first.mark, 4), reuseDraft(input, restored, settled, first.mark, 4),
    "同一组输入重放结果一致（第 3 轮审查：开发模式重放 updater 曾叠出两份正文）");
  // 迟到确认：放回之后正文版本换了，旧提交的确认清不走它，附件同理。
  const submitted = { text: "继续", textVersion: 2 };
  const reclaimed = reuseDraft(input, restore(), { text: "", textVersion: 6, attachments: [] }, first.mark, 7);
  assert.equal(clearSentDraft(reclaimed, submitted), "继续", "迟到的确认不得清掉刚放回的同一句正文");
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
      messages={[monitorRow, { ...row("mine", "我自己写的", "2026-08-25T10:00:03.000Z"), steerable: true }]}
      loading={false}
      error={null}
      cancelingIds={new Set()}
      steeringIds={new Set()}
      onSteer={() => undefined}
      onWithdraw={() => undefined}
      onCancel={() => undefined}
      defaultExpanded
    />,
  );
  const rows = openRows(monitorHtml);
  const monitorMarkup = rows.find((chunk) => chunk.includes("哨兵事件")) ?? "";
  const mineMarkup = rows.find((chunk) => chunk.includes("我自己写的")) ?? "";
  assert.ok(monitorMarkup, "哨兵事件行应被渲染出来");
  assert.match(monitorMarkup, /scheduled-message-source">哨兵</, "哨兵行要标明这条是谁推的");
  assert.match(monitorMarkup, /取消哨兵事件[\s\S]*这一次唤醒/, "哨兵行要给「取消这次唤醒」");
  assert.doesNotMatch(monitorMarkup, /放回输入框/, "哨兵事件不是用户写的，不得提供撤回");
  assert.doesNotMatch(monitorMarkup, /scheduled-message-guide/, "哨兵事件不得出现引导会话入口");
  assert.match(mineMarkup, /放回输入框/, "用户自己那条照旧可以撤回");
  // 队首是哨兵行时，引导入口必须落到用户自己最早的那条上，而不是整个消失。
  assert.match(mineMarkup, /scheduled-message-guide/, "引导入口应落到用户自己最早的那条排队消息上");
  assert.match(monitorMarkup, /scheduled-message-reveal scheduled-message-cancel/, "取消这次唤醒是指到才出的叉");
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
  assert.deepEqual([real, repair, resume].map(scheduledMessageNeedsAttention), [true, false, false], "三条里只有哨兵那条算要留意");
  // 退出码是哨兵独有的概念:交接正文里引着的 REGRESSION_FINISHED 不许算成「需留意」。
  const quoted: ScheduledMessage = { ...repair, text: "【审查未通过】\nREGRESSION_FINISHED exitCode=1 monitor=m1" };
  assert.equal(scheduledMessageExitCode(quoted), null, "非哨兵来源不读退出码");
  assert.equal(scheduledMessageNeedsAttention(quoted), false);
  assert.equal(scheduledMessageExitCode(real), 1, "真哨兵的退出码照旧读得出来");
  // 哨兵格式那几刀也只许用在真哨兵上。
  assert.equal(scheduledMessageSummary({ ...repair, text: "审查未通过（monitorId=m1），退出码 1\n正文" }),
    "审查未通过（monitorId=m1），退出码 1", "非哨兵来源的第一行原样留着");

  const markup = renderToStaticMarkup(<ScheduledMessageTray messages={[real, repair, row("mine", "我写的", "2026-10-31T10:00:04.000Z")]}
    loading={false} error={null} cancelingIds={new Set()} steeringIds={new Set()}
    onSteer={() => undefined} onWithdraw={() => undefined} onCancel={() => undefined} defaultExpanded />);
  const chunks = openRows(markup);
  const repairRow = chunks.find((chunk) => chunk.includes("自由工作流审查未通过")) ?? "";
  const monitorRow = chunks.find((chunk) => chunk.includes("盯构建")) ?? "";
  assert.ok(repairRow && monitorRow, "两行都应被渲染出来");
  assert.doesNotMatch(repairRow, /哨兵/, "审查结算行一个哨兵字样都不许有");
  assert.doesNotMatch(repairRow, /取消哨兵事件|停止哨兵/, "审查结算不得套用哨兵的取消措辞");
  assert.doesNotMatch(repairRow, /放回输入框|scheduled-message-guide/, "系统排进来的不是用户打的字，撤回与引导都不给");
  assert.match(repairRow, /scheduled-message-source">系统</, "认不出来源时只说「系统」，不冒充哨兵");
  assert.doesNotMatch(repairRow, /<button(?![^>]*scheduled-message-summary)/, "系统排进来的行尾没有键");
  // 真哨兵那一行照旧。
  assert.match(monitorRow, /scheduled-message-source is-attention">哨兵/);
  assert.match(monitorRow, /取消哨兵事件[\s\S]*这一次唤醒（仅移除本条输入，不执行停止哨兵操作）/);
  // 要留意的只数真哨兵:审查交接正文里引着的退出码不算。
  assert.match(line(markup), />1 条要留意</);
}

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
// 「某某名下已全部停下」那一格：给了 onOpenTask 就是一颗键，点过去打开那一条；没给只是一句话。
{
  const held = { ...row("held", "停着时排的", "2026-10-24T10:00:00.000Z"),
    wait: { kind: "dispatchHeld", by: { id: "H", title: "派活的那条" } } } as ScheduledMessage;
  const opened: string[] = [];
  const markup = renderTray([held], { defaultExpanded: true, onOpenTask: (taskId) => opened.push(taskId) });
  assert.match(rowOf(markup, "停着时排的"), /<button type="button" class="scheduled-message-when is-link" aria-label="「派活的那条」名下已全部停下，接着跑后发送：打开「派活的那条」">/,
    "被谁停下那一格点得过去");
  assert.doesNotMatch(rowOf(renderTray([held], { defaultExpanded: true }), "停着时排的"), /is-link/, "没给去处就不是键");
}
console.log("✓ 撤回回填、发送减法、附件丢失防线、审查会话答复只读、哨兵事件只许取消、"
  + "非哨兵 origin 不套哨兵口径、引导按钮位置、错误失效、窄托盘降级与「名下已全部停下」可点均受回归保护");
