import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Task } from "@ash/shared";
import type { QuestionRecord } from "@ash/shared/questions";
import { QuestionCard } from "../src/task-detail/QuestionCard.tsx";
import { QuestionDock, useQuestionTakeover } from "../src/task-detail/QuestionSlot.tsx";
import { isUnshownNotice, questionsOnScreen } from "../src/task-detail/timelineNoticeCopy.ts";
import { syncComposerSendKey } from "../src/lib/sendKey.ts";
import { ConversationFeed } from "../src/task-detail/ConversationFeed.tsx";
import { TeamFeed } from "../src/team/TeamFeed.tsx";
import type { ConversationItem } from "../src/task-detail/conversationModel.ts";
import { longAnswer, longLegacyReply, longQuestion } from "./fixtures/question-card-long-answer.ts";
import { formatQuestionAnswers, joinQuestionAnswer, legacyQuestionRecord, questionOptionSelected, settleNoteQuestion } from "@ash/shared/questions";

const task = { id: "question-card", title: "问答卡", body: "问答卡的原始需求", mode: "single", status: "paused", question: "两个细节", questionItems: [
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
const card = (props: Partial<Task> = {}, collapsed = false) => renderToStaticMarkup(
  <QuestionCard task={{ ...task, ...props } as Task} onAnswer={async () => undefined} collapsed={collapsed} onCollapsedChange={() => undefined} />,
);
const current = card();
// 答题卡一次只出一题：后面几题连同它们的选项都不该提前渲染出来。
assert.match(current, /aria-label="答复：放在哪里？"/);
assert.doesNotMatch(current, /aria-label="答复：保留什么？"/);
assert.doesNotMatch(current, /只留答案/);
assert.equal(count(current, 'aria-pressed="false"'), 2);
// 全卡只有一处能打字、一颗发送键；没有卡头（问号图标、「需要你的答复」）。
assert.equal(count(current, "<textarea"), 1, "全卡只有一处输入");
assert.equal(count(current, 'class="question-card-send"'), 1, "全卡只有一颗发送键");
assert.doesNotMatch(current, /需要你的答复|task-question-heading|上一题/);
// 卡里不套框：选项行首那一格写数字，最后一格是下一个数字（按它光标落进去）。
assert.match(current, /<span class="question-card-key" aria-hidden="true">1<\/span><span>会话里<\/span>/);
assert.match(current, /<div class="question-card-note"><span class="question-card-key" aria-hidden="true">3<\/span><textarea/);
assert.match(current, /placeholder="自己写，或者补一句…"/);
// 多题：题号在题目旁边，当前题标着；第一题还没答、什么都没答时那颗键点不动、写的是「下一题」。
assert.match(current, /<nav class="question-card-steps" aria-label="题目进度"/);
assert.match(current, /aria-current="step"[^>]*aria-label="第 1 题（未答）"/);
assert.match(current, /aria-label="第 2 题（未答）"/);
assert.match(current, /<button type="button" class="question-card-send" disabled=""[^>]*>下一题<\/button>/);
// 共同背景在题目上面（灰色小字那一段），题目照常按 markdown 渲染。
assert.match(current, /class="question-card-context"[^]*两个细节[^]*class="question-card-title"[^]*放在哪里？/);
// 单题没有题号，那颗键就是「发送答复」。
const single = card({ questionItems: undefined, questionOptions: ["甲", "乙"] });
assert.doesNotMatch(single, /question-card-steps|question-card-context/);
assert.match(single, /class="question-card-send" disabled=""[^>]*>发送答复<\/button>/);
assert.doesNotMatch(single, /下一题/);
// 没有选项：最后一行就是「写下你的答案…」，行首没有数字格。
const open = card({ questionItems: undefined, questionOptions: undefined });
assert.match(open, /placeholder="写下你的答案…"/);
assert.doesNotMatch(open, /question-card-key|role="group"/);
// 提问的那一轮还没结束：选项点不动，最后一行写着什么时候能答。
const settling = card({ status: "running" });
assert.equal(count(settling, 'aria-pressed="false" disabled=""') + count(settling, 'disabled="" aria-pressed="false"'), 2, "那一轮没结束时选项点不动");
assert.match(settling, /<textarea[^>]*disabled=""[^>]*placeholder="这一轮结束后即可答复"/);
// 团队调度台是常驻会话，忙着也接得住：照常能答。
assert.doesNotMatch(card({ status: "running", mode: "team" }), /这一轮结束后即可答复/);
// 收起：只剩题目一行（一颗展开键），没有输入、没有发送键。
const folded = card({}, true);
assert.match(folded, /<button type="button" class="question-card-peek" aria-expanded="false"><span>放在哪里？<\/span>/);
assert.doesNotMatch(folded, /<textarea|question-card-send|role="group"/);
// 发送键那句提示跟着「输入框发送键」那一档走（设置 → 默认规则 → 输入框），不是写死的。
// 还没读到设置时念的是 ⌘/Ctrl ——那正是此刻真正在生效的规矩（裸回车换行），见 sendKey.ts。
assert.match(single, /⌘ \/ Ctrl \+ Enter 发送/, "设置还没到货时，提示该念此刻真正生效的那一档");
const renderSingle = () => card({ questionItems: undefined, questionOptions: ["甲", "乙"] });
syncComposerSendKey("enter");
const singleEnter = renderSingle();
assert.match(singleEnter, /Enter 发送/);
assert.doesNotMatch(singleEnter, /⌘ \/ Ctrl \+ Enter 发送/);
syncComposerSendKey("mod-enter");
assert.match(renderSingle(), /⌘ \/ Ctrl \+ Enter 发送/);
syncComposerSendKey("enter");

// 卡在回复框那一格：有问题在等时宿主拿到 covering，平常那个框（草稿都在）hidden；没有问题、或宿主没有答复的路时不接管。
function Host({ task: hosted, answerable = true }: { task: Task; answerable?: boolean }) {
  const takeover = useQuestionTakeover(answerable ? hosted : null);
  return <>
    {answerable && <QuestionDock takeover={takeover} onAnswer={async () => undefined} />}
    <div className="task-reply-box" hidden={takeover.covering || undefined}><textarea aria-label="回复任务" /></div>
  </>;
}
const slotted = renderToStaticMarkup(<Host task={task} />);
assert.match(slotted, /<div class="question-dock"><section class="question-card"/);
assert.match(slotted, /<div class="task-reply-box" hidden="">/, "卡展开时不出现平常的回复框");
const idle = renderToStaticMarkup(<Host task={{ ...task, question: null, questionItems: null } as Task} />);
assert.doesNotMatch(idle, /question-card|hidden/);
assert.match(idle, /<div class="task-reply-box"><textarea/);
assert.doesNotMatch(renderToStaticMarkup(<Host task={task} answerable={false} />), /question-card|hidden/, "没有答复的路就不接管");

// 勾了就是选了：答复 = 勾了的那几项（按选项顺序一项一行）+ 补充的话；跟已答气泡认选项的口径兼容。
const options = ["会话里", "侧栏里\n两行的选项", "都要"];
const joined = joinQuestionAnswer(options, new Set([2, 1]), "  再补一句 ");
assert.equal(joined, "侧栏里\n两行的选项\n都要\n再补一句");
assert.equal(questionOptionSelected(joined, "侧栏里\n两行的选项"), true);
assert.equal(questionOptionSelected(joined, "都要"), true);
assert.equal(questionOptionSelected(joined, "会话里"), false);
assert.equal(joinQuestionAnswer(options, new Set(), "  "), "", "什么都没答就是空的（记成未答）");
assert.equal(formatQuestionAnswers([joinQuestionAnswer(options, new Set([0]), ""), ""]), "1. 会话里\n2. （未答）");

// 问题只出现一次：提问那一轮的结算说明（带着问题全文），在那道题另有一处看得见时（答题卡上、答过的气泡里）不画；
// 被撤下而没回答的旧题没有别处可看，照画。
const settle = (text: string): ConversationItem => ({ kind: "event", id: `note:${text.slice(0, 6)}`, text, at: "2026-09-10T00:59:00Z", tone: "notice", variant: "note" });
const turn = { kind: "agent", id: "turn", sessionId: "session", label: "codex", agentType: "codex", at: "2026-09-10T00:58:00Z",
  endedAt: "2026-09-10T00:59:00Z", markdown: "先问两件事", segments: [{ id: "turn:body", markdown: "先问两件事", events: [], attachments: [] }] } as unknown as ConversationItem;
const asked = "独一无二的「问题」全文";
const answeredRecord: QuestionRecord = { ...record, id: "asked", question: asked, questionItems: undefined };
for (const note of [`本回合以提问暂停,等待答复:「${asked}」`, `续聊回合以提问结束,等待答复:「${asked}」(任务状态仍为「已完成」)`]) {
  assert.equal(settleNoteQuestion(note), asked, "引号套引号也认得出整道题");
  assert.equal(settleNoteQuestion(`〔系统〕${note}`), asked);
  const pending = questionsOnScreen({ question: asked }, []);
  const answered = questionsOnScreen({ question: null }, [answeredRecord]);
  const superseded = questionsOnScreen({ question: null }, [{ ...answeredRecord, question: "另一道" }]);
  assert.equal(isUnshownNotice(note, pending), true, "在等的那道题在答题卡上");
  assert.equal(isUnshownNotice(note, answered), true, "答过的那道题跟着答案留在气泡里");
  assert.equal(isUnshownNotice(note, superseded), false, "撤下没答的旧题照画");
  assert.equal(isUnshownNotice(note), false, "不知道界面上有什么就照画");
  assert.equal(isUnshownNotice(note, questionsOnScreen({ question: null }, [{ ...answeredRecord, deleted: true }])), false, "删掉的答复不算看得见");
  const html = renderToStaticMarkup(<ConversationFeed task={{ ...task, question: asked, questionItems: undefined } as Task}
    items={[turn, settle(note)]} questionHistory={[]} sessions={[]} loading={false} error={null} />);
  assert.doesNotMatch(html, /独一无二/, `会话里不再抄一遍问题：${note.slice(0, 12)}`);
  assert.match(html, /先问两件事/);
  const team = (question: string | null) => renderToStaticMarkup(<TeamFeed task={{ ...task, mode: "team", question, questionItems: undefined, questionHistory: [] } as Task}
    rows={[{ kind: "conv", key: "note", item: settle(note) }]}
    workers={[]} onOpenWorker={() => undefined} onAskLead={() => undefined} delegatingIds={new Set()} indicatorForTask={() => null} />);
  assert.doesNotMatch(team(asked), /独一无二/, "团队页同样不画");
  assert.match(team(null), /独一无二/, "团队页撤下没答的旧题照画");
}
assert.equal(settleNoteQuestion("本回合没有交卷,记为未完成"), null, "别的结算说明照旧");
const recorded = render([answer]);
const recordClass = 'class="task-message task-message--user task-question-record"';
assert.equal(count(recorded, recordClass), 1, "会话与数据库里的同一份答复只显示一个气泡");
// 答过的提问就是你的一个气泡：问题引在答案上面，当时的选项点那句引文才摊开。
assert.match(recorded, /<div class="task-user-bubble task-question-bubble"><header><b>你<\/b><small>已部分答复<\/small>/);
assert.match(recorded, /class="task-question-quote"[^>]*aria-expanded="false"[\s\S]*?>两个细节</, "多题时共同引言先引一句");
assert.match(recorded, /class="task-question-quote-number">1<\/span><span class="task-question-quote-text">放在哪里？<\/span><\/button><p>会话里<\/p>/, "第 1 题：问题引在答案上面");
assert.match(recorded, /<span class="task-question-quote-text">保留什么？<\/span><\/button><p class="is-empty">未答复<\/p>/, "留空的题写「未答复」");
assert.doesNotMatch(recorded, /侧栏里/, "当时的选项平时不摊开");
assert.doesNotMatch(recorded, /你之前的提问|请据此|查看问答|<details/);
assert.equal(count(recorded, "会话里"), 1, "答案只写一处");
const quoteOrder = (html: string) => [...html.matchAll(/task-question-quote-text">([\s\S]*?)<\/span>/g)].map((match) => match[1]!);
assert.deepEqual(quoteOrder(recorded), ["两个细节", "放在哪里？", "保留什么？"]);
assert.equal(count(render([]), recordClass), 1, "已保存但续跑尚未写入会话时，历史仍可查看");

const repeated = { ...record, id: "record-2", answeredAt: "2026-09-10T02:00:00Z", question: "第二次确认" };
const repeatedHtml = renderToStaticMarkup(<ConversationFeed task={task} items={[answer, { ...answer, id: "answer-2", at: repeated.answeredAt }]}
  questionHistory={[record, repeated]} sessions={[]} loading={false} error={null} />);
assert.equal(count(repeatedHtml, recordClass), 2);
assert.match(repeatedHtml, /第二次确认/);
const delayedHtml = renderToStaticMarkup(<ConversationFeed task={task} items={[
  { ...answer, at: "2026-09-10T03:00:00Z" }, { ...answer, id: "answer-2", at: "2026-09-10T03:01:00Z" },
]} questionHistory={[record, repeated]} sessions={[]} loading={false} error={null} />);
assert.equal(count(delayedHtml, 'task-question-quote-text">两个细节<'), 1, "排队延迟送达的同文答复仍要对应各自的问题");
assert.equal(count(delayedHtml, 'task-question-quote-text">第二次确认<'), 1);

const oldText = "【答复】你之前的提问:「以前的问题？」\n\n以前的答案\n\n请据此继续完成任务。";
const legacyAnswer = { ...answer, text: oldText };
const oldHtml = render([legacyAnswer], []);
assert.match(oldHtml, /以前的问题？/);
assert.match(oldHtml, /以前的答案/);
assert.doesNotMatch(oldHtml, /请据此继续完成任务/);
const team = renderToStaticMarkup(<TeamFeed task={{ ...task, mode: "team" }} rows={[{ kind: "conv", key: "old", item: legacyAnswer }]}
  workers={[]} onOpenWorker={() => undefined} onAskLead={() => undefined} delegatingIds={new Set()} indicatorForTask={() => null} />);
assert.match(team, /task-question-record"/);
assert.match(team, /以前的问题？/);
assert.doesNotMatch(team, /你之前的提问/);
const teamHistory = renderToStaticMarkup(<TeamFeed task={{ ...task, mode: "team", questionHistory: [record] }} rows={[]}
  workers={[]} onOpenWorker={() => undefined} onAskLead={() => undefined} delegatingIds={new Set()} indicatorForTask={() => null} />);
assert.equal(count(teamHistory, recordClass), 1, "团队流直接展示调用方已经持有的历史");
assert.match(teamHistory, /放在哪里？/);
const longRecord = legacyQuestionRecord(longLegacyReply, "screenshot");
assert.equal(longRecord?.question, longQuestion, "嵌套引号和空行不能截断旧题干");
assert.equal(longRecord?.answer, longAnswer, "没有系统尾句的旧答复也可恢复真实答案");
const crlfRecord = legacyQuestionRecord(`${longLegacyReply}\n\n请据此继续完成任务。\n`.replace(/\n/g, "\r\n"), "crlf");
assert.equal(crlfRecord?.question, longQuestion);
assert.equal(crlfRecord?.answer, longAnswer);
const longHtml = render([{ ...legacyAnswer, isAnswer: undefined, bySystem: false, text: longLegacyReply }], []);
assert.equal(count(longHtml, recordClass), 1, "旧消息没有 isAnswer 标记也显示已答的气泡");
assert.equal(count(longHtml, 'class="task-user-bubble"'), 0, "不另画一个普通气泡");
assert.match(longHtml, /<\/button><p>A\n顺便/, "答案原样在引文下面");
assert.doesNotMatch(longHtml, /你之前的提问/);
assert.match(longHtml, /task-question-quote-text">[^<]*跨站那个问题/, "旧题干引在答案上面");
assert.match(longHtml, /还是在 ash 上预览别的项目/);
console.log("question card: one input + one send key, slot hides the reply box, picks join into compatible answers, settle note hidden only while the question shows elsewhere, collapsed/settling/no-option states, duplicate suppression and legacy/team rendering passed");
