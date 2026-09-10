import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Task } from "@ash/shared";
import type { QuestionRecord } from "@ash/shared/questions";
import { QuestionCard } from "../src/task-detail/QuestionCard.tsx";
import { ConversationFeed } from "../src/task-detail/ConversationFeed.tsx";
import { TeamFeed } from "../src/team/TeamFeed.tsx";
import type { ConversationItem } from "../src/task-detail/conversationModel.ts";
import { longAnswer, longLegacyReply, longQuestion } from "./fixtures/question-card-long-answer.ts";
import { legacyQuestionRecord } from "@ash/shared/questions";

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
assert.match(current, /留空项会标记为未答/);
assert.doesNotMatch(current, /可稍后补充/);
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
assert.equal(count(recorded, "会话里"), 3, "摘要、答案和当时的选项各保留一处");
const summaries = (html: string) => [...html.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].map((match) => match[1]!);
assert.match(summaries(recorded)[0]!, /你的答复/);
assert.match(summaries(recorded)[0]!, /1\. 会话里/);
assert.doesNotMatch(summaries(recorded)[0]!, /两个细节|放在哪里|侧栏里/);
assert.equal(count(render([]), 'class="task-question-record"'), 1, "已保存但续跑尚未写入会话时，历史仍可查看");

const repeated = { ...record, id: "record-2", answeredAt: "2026-09-10T02:00:00Z", question: "第二次确认" };
const repeatedHtml = renderToStaticMarkup(<ConversationFeed task={task} items={[answer, { ...answer, id: "answer-2", at: repeated.answeredAt }]}
  questionHistory={[record, repeated]} sessions={[]} loading={false} error={null} />);
assert.equal(count(repeatedHtml, 'class="task-question-record"'), 2);
assert.match(repeatedHtml, /第二次确认/);
const delayedHtml = renderToStaticMarkup(<ConversationFeed task={task} items={[
  { ...answer, at: "2026-09-10T03:00:00Z" }, { ...answer, id: "answer-2", at: "2026-09-10T03:01:00Z" },
]} questionHistory={[record, repeated]} sessions={[]} loading={false} error={null} />);
assert.equal(count(delayedHtml, '<p>两个细节</p>'), 1, "排队延迟送达的同文答复仍要对应各自的问题");
assert.equal(count(delayedHtml, '<p>第二次确认</p>'), 1);

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
const teamHistory = renderToStaticMarkup(<TeamFeed task={{ ...task, mode: "team", questionHistory: [record] }} rows={[]}
  workers={[]} onOpenWorker={() => undefined} onAskLead={() => undefined} delegatingIds={new Set()} indicatorForTask={() => null} />);
assert.equal(count(teamHistory, 'class="task-question-record"'), 1, "团队流直接展示调用方已经持有的历史");
assert.match(teamHistory, /放在哪里？/);
const longRecord = legacyQuestionRecord(longLegacyReply, "screenshot");
assert.equal(longRecord?.question, longQuestion, "嵌套引号和空行不能截断旧题干");
assert.equal(longRecord?.answer, longAnswer, "没有系统尾句的旧答复也可恢复真实答案");
const crlfRecord = legacyQuestionRecord(`${longLegacyReply}\n\n请据此继续完成任务。\n`.replace(/\n/g, "\r\n"), "crlf");
assert.equal(crlfRecord?.question, longQuestion);
assert.equal(crlfRecord?.answer, longAnswer);
const longHtml = render([{ ...legacyAnswer, isAnswer: undefined, bySystem: false, text: longLegacyReply }], []);
assert.equal(count(longHtml, 'class="task-question-record"'), 1, "旧消息没有 isAnswer 标记也显示已答卡");
assert.equal(count(longHtml, 'class="task-user-bubble"'), 0);
assert.match(summaries(longHtml)[0]!, /你的答复/);
assert.match(summaries(longHtml)[0]!, /A\n顺便/);
assert.doesNotMatch(summaries(longHtml)[0]!, /跨站那个问题|三个选项|你之前的提问/);
assert.match(longHtml, /跨站那个问题/);
assert.match(longHtml, /还是在 ash 上预览别的项目/);
console.log("question card: accessible inputs, collapsed durable cards, duplicate suppression and legacy/team rendering passed");
