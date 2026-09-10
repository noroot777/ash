import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Task } from "@ash/shared";
import type { QuestionRecord } from "@ash/shared/questions";
import { QuestionCard } from "../src/task-detail/QuestionCard.tsx";
import { ConversationFeed } from "../src/task-detail/ConversationFeed.tsx";
import { TeamFeed } from "../src/team/TeamFeed.tsx";
import type { ConversationItem } from "../src/task-detail/conversationModel.ts";

const task = { id: "question-card", title: "问答卡", mode: "single", status: "paused", question: "两个细节", questionItems: [
  { question: "放在哪里？", options: ["会话里", "侧栏里"] },
  { question: "保留什么？", options: ["只留答案", "保留问题"] },
] } as Task;
const record: QuestionRecord = {
  id: "record", answeredAt: "2026-09-10T01:00:00Z", question: task.question, questionItems: task.questionItems,
  answers: ["会话里", ""], answer: "1. 会话里\n2. （未答）", reply: "【答复】\n1. 会话里\n2. （未答）",
};
const answer: ConversationItem = { kind: "user", id: "answer", at: record.answeredAt, text: record.reply, attachments: [], bySystem: true, isAnswer: true };
const render = (items: ConversationItem[], history = [record]) => renderToStaticMarkup(
  <ConversationFeed task={task} items={items} questionHistory={history} sessions={[]} loading={false} error={null} />,
);
const count = (text: string, needle: string) => text.split(needle).length - 1;
const current = renderToStaticMarkup(<QuestionCard task={task} onAnswer={async () => undefined} />);
assert.match(current, /aria-label="答复：放在哪里？"/);
assert.equal(count(current, 'aria-pressed="false"'), 4);
assert.match(current, /<button type="button" disabled="">[^]*发送答复/);
assert.match(current, /已答 0\/2 项/);
const recorded = render([answer]);
assert.equal(count(recorded, 'class="task-question-record"'), 1, "会话与数据库里的同一份答复只显示一张卡");
assert.match(recorded, /<details class="task-question-record">/);
assert.doesNotMatch(recorded, /<details class="task-question-record" open/);
assert.match(recorded, /查看问答/);
assert.match(recorded, /放在哪里？/);
assert.match(recorded, /侧栏里/);
assert.match(recorded, /已部分答复/);
assert.match(recorded, /未答复/);
assert.doesNotMatch(recorded, /你之前的提问|请据此/);
assert.equal(count(recorded, "会话里"), 2, "答案和当时的选项各保留一处");
assert.equal(count(render([]), 'class="task-question-record"'), 1, "已保存但续跑尚未写入会话时，历史仍可查看");

const repeated = { ...record, id: "record-2", answeredAt: "2026-09-10T02:00:00Z", question: "第二次确认" };
const repeatedHtml = renderToStaticMarkup(<ConversationFeed task={task} items={[answer, { ...answer, id: "answer-2", at: repeated.answeredAt }]}
  questionHistory={[record, repeated]} sessions={[]} loading={false} error={null} />);
assert.equal(count(repeatedHtml, 'class="task-question-record"'), 2);
assert.match(repeatedHtml, /第二次确认/);
const delayedHtml = renderToStaticMarkup(<ConversationFeed task={task} items={[
  { ...answer, at: "2026-09-10T03:00:00Z" }, { ...answer, id: "answer-2", at: "2026-09-10T03:01:00Z" },
]} questionHistory={[record, repeated]} sessions={[]} loading={false} error={null} />);
assert.equal(count(delayedHtml, 'class="task-question-record-title">两个细节'), 1, "排队延迟送达的同文答复仍要对应各自的问题");
assert.equal(count(delayedHtml, 'class="task-question-record-title">第二次确认'), 1);

const oldText = "【答复】你之前的提问:「以前的问题？」\n\n以前的答案\n\n请据此继续完成任务。";
const legacyAnswer = { ...answer, text: oldText };
const oldHtml = render([legacyAnswer], []);
assert.match(oldHtml, /以前的问题？/);
assert.match(oldHtml, /以前的答案/);
assert.doesNotMatch(oldHtml, /请据此继续完成任务/);
const team = renderToStaticMarkup(<TeamFeed task={{ ...task, mode: "team" }} rows={[{ kind: "conv", key: "old", item: legacyAnswer }]}
  workers={[]} onOpenWorker={() => undefined} onAskLead={() => undefined} delegatingIds={new Set()} indicatorForTask={() => null} />);
assert.match(team, /class="task-question-record"/);
assert.match(team, /以前的问题？/);
assert.doesNotMatch(team, /你之前的提问/);
console.log("question card: accessible inputs, collapsed durable cards, duplicate suppression and legacy/team rendering passed");
