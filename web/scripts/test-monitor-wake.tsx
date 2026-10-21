import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session, Task } from "@ash/shared";
import { mergeMonitorEventText } from "@ash/shared/monitor";
import { ConversationFeed } from "../src/task-detail/ConversationFeed.tsx";
import { buildConversationItems, type ConversationItem } from "../src/task-detail/conversationModel.ts";
import { monitorWakeInput, monitorWakePreview, monitorWakeReplyIds } from "../src/task-detail/monitorWakeModel.ts";
import { SystemAuthoredMessage } from "../src/task-detail/SystemNotice.tsx";
import { TeamFeed } from "../src/team/TeamFeed.tsx";

const at = "2026-10-21T04:24:00.000Z";
const output = "【哨兵事件】全量回归（补完第六处闸之后）（monitorId=monitor-new）\nRan 3471 tests in 719.547s\nOK (skipped=1)\nSWEEP_EXIT=0\n全文在 /tmp/kb-sweep5.log";
const ended = "【哨兵结束】全量回归（清静机器上的提交前那一遍）（monitorId=monitor-old），退出码 0。命令自己跑完了";
const user = (text: string, extra: Partial<Extract<ConversationItem, { kind: "user" }>> = {}): Extract<ConversationItem, { kind: "user" }> => ({
  kind: "user", id: "input", text, at, bySystem: true, attachments: [], ...extra,
});
const agent = (id = "reply"): Extract<ConversationItem, { kind: "agent" }> => ({
  kind: "agent", id, sessionId: "session", label: "claude@nodemach", at,
  endedAt: "2026-10-21T04:25:27.000Z", markdown: "核对收到的回归结果，再完成收尾。",
  segments: [{ id: `${id}:body`, markdown: "核对收到的回归结果，再完成收尾。", events: [], attachments: [] }],
});
const notice: Extract<ConversationItem, { kind: "event" }> = {
  kind: "event", id: "record", text: "哨兵结束：全量回归，退出码 0。命令自己跑完了", at, aside: true, variant: "note",
};

assert.equal(monitorWakeInput(notice), null);
assert.equal(monitorWakeInput(user(output, { bySystem: false })), null);
assert.equal(monitorWakeInput(user(output, { isAnswer: true })), null);
assert.equal(monitorWakeInput(user("【哨兵已起】全量回归")), null);
assert.equal(monitorWakeInput(user("普通指令里引用\n" + output)), null);
assert.equal(monitorWakeInput(user("【自由工作流审查未通过 · 第 1 轮】\n请按报告修复。")), null);

const parsed = monitorWakeInput(user(output))!;
assert.equal(parsed.events.length, 1);
assert.deepEqual(parsed.events[0], {
  kind: "output", source: "全量回归（补完第六处闸之后）", monitorId: "monitor-new",
  body: "Ran 3471 tests in 719.547s\nOK (skipped=1)\nSWEEP_EXIT=0\n全文在 /tmp/kb-sweep5.log",
});
assert.match(parsed.reason, /新输出/);
assert.doesNotMatch(parsed.reason, /通过|成功|失败/);
assert.equal(parsed.source, "全量回归（补完第六处闸之后）");
assert.equal(parsed.hasCheckpoint, false);

const endInput = monitorWakeInput(user(ended))!;
assert.equal(endInput.events[0].kind, "ended");
assert.equal(endInput.events[0].source, "全量回归（清静机器上的提交前那一遍）");
assert.equal(endInput.events[0].body, "退出码 0。命令自己跑完了");
assert.doesNotMatch(endInput.reason, /成功|通过|旧哨兵/);
assert.match(monitorWakeInput(user(ended.replace("退出码 0", "退出码 1")))!.events[0].body, /退出码 1/);

const legacy = monitorWakeInput(user("【哨兵事件 · 回归 (monitorId=legacy)】\nOK"))!;
assert.equal(legacy.source, "回归");
assert.equal(legacy.events[0].monitorId, "legacy");
assert.equal(legacy.events[0].body, "OK");
assert.equal(monitorWakeInput(user("【哨兵事件】\nwaiting"))!.events[0].source, "未标注名称的哨兵");

const combined = mergeMonitorEventText(output, ended);
const batch = monitorWakeInput(user(combined))!;
assert.deepEqual(batch.events.map((event) => event.kind), ["output", "ended"]);
assert.equal(batch.source, "全量回归（清静机器上的提交前那一遍） 等 2 个哨兵");
assert.match(batch.reason, /2 条哨兵消息.*一次输入/);
const sameSourceBatch = monitorWakeInput(user(mergeMonitorEventText(output, output)))!;
assert.equal(sameSourceBatch.events.length, 2);
assert.equal(sameSourceBatch.source, parsed.source, "同一哨兵的多条事件不应被算作多个来源");

const checkpoint = combined + "\n\n【你当初留下的续跑交代】核对结果再收尾。\n" + output;
assert.equal(monitorWakeInput(user(checkpoint))!.events.length, 2);
assert.equal(monitorWakeInput(user(checkpoint))!.hasCheckpoint, true);
assert.doesNotMatch(monitorWakeInput(user(checkpoint))!.events.at(-1)!.body, /续跑交代/);

const truncated = mergeMonitorEventText(Array.from({ length: 500 }, () => output).join("\n\n"), ended);
const truncatedInput = monitorWakeInput(user(truncated))!;
assert.equal(truncatedInput.historyTruncated, true);
assert.equal(truncatedInput.events.at(-1)!.body, "退出码 0。命令自己跑完了");
assert.match(truncatedInput.reason, /至少/);
assert.equal(monitorWakePreview("first\nsecond\nthird\nfourth"), "first\nsecond\nthird\n…");
assert.equal(monitorWakePreview("x".repeat(900)).length, 421);
assert.equal(monitorWakePreview("first\r\nsecond"), "first\nsecond");

const reply = agent();
assert.deepEqual([...monitorWakeReplyIds([user(output), notice, reply, agent("later")])], ["reply"]);
assert.deepEqual([...monitorWakeReplyIds([user(output), user("手动继续", { bySystem: false }), reply])], []);
assert.deepEqual([...monitorWakeReplyIds([user(output), user("【其他系统指令】继续"), reply])], []);
assert.deepEqual([...monitorWakeReplyIds([user(output), { ...notice, variant: "boundary" }, reply])], []);
assert.deepEqual([...monitorWakeReplyIds([user(output), { ...notice, verify: true }, reply])], []);
assert.deepEqual([...monitorWakeReplyIds([notice, reply])], []);
assert.deepEqual([...monitorWakeReplyIds([user(output), { ...reply, at: "2026-10-21T04:23:00.000Z" }])], ["reply"], "直播复用会话的起点可能早于输入，关联依据是输入后的第一轮回复");

const task = { id: "monitor-wake", title: "回归结果唤起会话", body: "", status: "done", mode: "single" } as unknown as Task;
const renderTask = (items: ConversationItem[]) => renderToStaticMarkup(
  <ConversationFeed task={task} items={items} sessions={[]} loading={false} error={null} />,
);
const renderTeam = (items: ConversationItem[]) => renderToStaticMarkup(
  <TeamFeed task={{ ...task, mode: "team" }} rows={items.map((item) => ({ kind: "conv", key: item.id, item }))}
    workers={[]} onOpenWorker={() => undefined} onAskLead={() => undefined} delegatingIds={new Set()} indicatorForTask={() => null} />,
);
const count = (text: string, token: string) => text.split(token).length - 1;

for (const render of [renderTask, renderTeam]) {
  const html = render([notice, user(combined), reply]);
  assert.equal(count(html, 'class="monitor-wake-input '), 1);
  assert.equal(count(html, 'class="monitor-wake-reply"'), 1);
  assert.match(html, /ash<\/b>.*自动输入/s);
  assert.match(html, /2 条消息 → 1 次输入/);
  assert.match(html, /复制完整自动输入/);
  assert.match(html, /<details class="monitor-wake-raw"><summary>/);
  assert.ok(html.includes(combined), "完整输入原样保留，不丢监控 ID、换行或事件");
  assert.match(html, /system-event-(?:digest|row)/, "普通记录仍走原来的旁注组件");
  assert.doesNotMatch(html, /已送达 Agent|任务成功/);
  assert.equal(count(render([notice, reply]), 'class="monitor-wake-input '), 0);
  assert.equal(count(render([user(output)]), 'class="monitor-wake-reply"'), 0);
  assert.equal(count(render([user(output, { bySystem: false }), reply]), 'class="monitor-wake-reply"'), 0);
  const endHtml = render([user(ended), reply]);
  assert.match(endHtml, /命令结束 ≠ 任务完成/);
  assert.match(endHtml, /退出码 0。命令自己跑完了/);
  const checkpointHtml = render([user(checkpoint), reply]);
  assert.match(checkpointHtml, /含续跑交代/);
  assert.ok(checkpointHtml.includes(checkpoint));
  const truncatedHtml = render([user(truncated), reply]);
  assert.match(truncatedHtml, /至少 \d+ 条消息/);
  assert.match(truncatedHtml, /另有 \d+ 条较早消息/);
  assert.ok(truncatedHtml.includes(truncated));
  const hostile = render([user(output + '\n<img src=x onerror="alert(1)">')]);
  assert.doesNotMatch(hostile, /<img src=x/);
  assert.match(hostile, /&lt;img/);
}

const conflict = renderToStaticMarkup(<SystemAuthoredMessage item={user("【验收未通过 · 需要你解冲突】\n合并发生冲突。") } />);
assert.match(conflict, /system-action-note is-conflict/);
assert.doesNotMatch(conflict, /monitor-wake-input/);

const reviewerWake = renderTask([
  { ...notice, text: "第 1 轮验证开始：就在这个任务的工作目录里跑。", verify: true },
  user(output),
  { ...reply, reviewer: { round: 1 } },
]);
assert.ok(reviewerWake.includes('class="verify-lane"'));
assert.equal(count(reviewerWake, 'class="monitor-wake-input '), 1, "审查卡内的真实哨兵输入也使用新样式");
assert.equal(count(reviewerWake, 'class="monitor-wake-reply"'), 1);

const session = {
  id: "session", taskId: task.id, agentType: "claude", role: "single", executor: "claude@nodemach",
  startedAt: "2026-10-21T04:18:00.000Z", endedAt: "2026-10-21T04:25:27.000Z",
} as unknown as Session;
const sentinel = (text: string) => `\n\x1e${JSON.stringify({ t: "user", text, at, by: "system" })}\n`;
const persisted = buildConversationItems([{ session, output: "等待全量回归。" + sentinel(combined) + "收到回归结果。", trace: [] }], [session], []);
const live = buildConversationItems([], [{ ...session, endedAt: null }], [
  { kind: "user", id: "wake-live", text: combined, attachments: [], at, bySystem: true },
  { kind: "server", id: "text", event: { type: "agent.event", taskId: task.id, sessionId: session.id, agentType: "claude", event: { kind: "text", text: "收到回归结果。" } } },
] as never);
for (const items of [persisted, live]) {
  assert.equal(items.filter((item) => monitorWakeInput(item)).length, 1);
  assert.equal(monitorWakeReplyIds(items).size, 1, "直播和刷新后都应识别同一轮自动输入与回复");
  assert.match(renderTask(items), /monitor-wake-reply/);
}

console.log("monitor wake: parsing, merged/truncated events, checkpoints, attribution, task/team rendering and live/reload passed");
