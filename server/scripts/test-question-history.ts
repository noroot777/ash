import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { formatQuestionAnswers, questionKey, legacyQuestionRecord, toggleQuestionOption } from "@ash/shared/questions";
import { releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-question-history-"));
process.env.ASH_DB = join(stage, "ash.db");
const { db, ensureSchema } = await import("../src/db/index.js");
const { tasks } = await import("../src/db/schema.js");
const { prepareQuestionRecord, claimQuestionAnswer } = await import("../src/task-question-record.js");
const { enrichTasks, toTaskListItem } = await import("../src/task-store.js");
const { answerTask } = await import("../src/task-answer.js");
const { setTaskQuestion } = await import("../src/task-question.js");
const app = new Hono();
app.post("/tasks/:id/answer", (c) => answerTask(c, c.req.param("id")));
const answerRequest = (id: string, body: unknown) => app.request(`/tasks/${id}/answer`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const readTask = async () => (await db.select().from(tasks).where(eq(tasks.id, "q1")))[0]!;
const source = {
  question: "确认两项配置",
  questionItems: [
    { question: "记录放哪里？", options: ["保留在会话里", "额外加一个入口"] },
    { question: "发送什么内容？", options: ["只发送答案", "保留完整问题"] },
  ],
};
try {
  await ensureSchema();
  await ensureSchema();
  await db.insert(tasks).values({ id: "q1", projectId: "p1", title: "问答记录", mode: "single", status: "paused", createdAt: "2026-09-10T01:00:00.000Z", updatedAt: "2026-09-10T01:00:00.000Z" });
  await setTaskQuestion({ taskId: "q1", question: source.question, items: source.questionItems });
  const task = await readTask();
  const input = { questionKey: questionKey(source), answers: ["保留在会话里", ""] };
  const record = prepareQuestionRecord(task, "ignored client formatting", input);
  assert.equal(record.reply, "【答复】\n1. 保留在会话里\n2. （未答）");
  assert.equal(record.reply.includes(source.question), false);
  assert.deepEqual(record.questionItems, source.questionItems);
  assert.deepEqual(record.answers, input.answers);

  assert.equal((await answerRequest("missing", { answer: "ok" })).status, 404);
  assert.equal((await answerRequest("q1", { answer: 12 })).status, 400);
  assert.equal((await answerRequest("q1", { answers: ["", "  "] })).status, 400);
  assert.equal((await answerRequest("q1", { answers: ["one"] })).status, 400);
  assert.equal((await answerRequest("q1", { answers: [null, "two"] })).status, 400);
  assert.equal((await answerRequest("q1", { answer: "stale", questionKey: "old" })).status, 409);
  assert.equal((await readTask()).question, source.question);
  await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, "q1"));
  assert.equal((await answerRequest("q1", { answer: "too early" })).status, 409);
  assert.equal(await claimQuestionAnswer(task, record), false, "状态变化后不能清空旧问题");
  await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, "q1"));

  const concurrent = await Promise.all([claimQuestionAnswer(task, record), claimQuestionAnswer(task, { ...record, id: "duplicate" })]);
  assert.equal(concurrent.filter(Boolean).length, 1, "并发答复只落一次历史");
  let saved = await readTask();
  assert.equal(saved.question, null);
  assert.equal(saved.questionOptions, null);
  assert.equal(saved.questionItems, null);
  assert.deepEqual(JSON.parse(saved.questionHistory!), [record]);
  assert.equal((await answerRequest("q1", { answer: "again" })).status, 409);

  const independent = new DatabaseSync(process.env.ASH_DB!);
  try {
    assert.deepEqual(JSON.parse(independent.prepare("SELECT question_history FROM tasks WHERE id='q1'").get()!.question_history as string), [record], "独立连接仍可读到完整问答");
  } finally { independent.close(); }
  const full = (await enrichTasks([saved]))[0]!;
  assert.deepEqual(full.questionHistory, [record]);
  assert.equal("questionHistory" in toTaskListItem(full), false, "列表不携带整段历史");

  await setTaskQuestion({ taskId: "q1", question: "第二轮问题", options: ["甲", "乙"] });
  const second = await readTask();
  const secondRecord = prepareQuestionRecord(second, "甲", {});
  assert.equal(secondRecord.reply, "【答复】\n甲", "旧客户端和 MCP 仍可发送自由文本");
  await setTaskQuestion({ taskId: "q1", question: "问题已经换了", options: ["甲", "乙"] });
  assert.equal(await claimQuestionAnswer(second, secondRecord), false, "新问题不能被旧快照答复清空");
  const current = await readTask();
  const finalRecord = prepareQuestionRecord(current, "乙", {});
  assert.equal(await claimQuestionAnswer(current, finalRecord), true);
  saved = await readTask();
  assert.deepEqual(JSON.parse(saved.questionHistory!), [record, finalRecord]);

  assert.equal(formatQuestionAnswers(["  简短答案  "]), "简短答案");
  assert.equal(toggleQuestionOption("补充说明", "甲\n乙"), "补充说明\n甲\n乙");
  assert.equal(toggleQuestionOption("补充说明\n甲\n乙", "甲\n乙"), "补充说明");
  const legacy = legacyQuestionRecord("【答复】你之前的提问:「选择哪种方案？」\n\n方案 A\n\n请据此继续完成任务。", "old");
  assert.equal(legacy?.question, "选择哪种方案？");
  assert.deepEqual(legacy?.answers, ["方案 A"]);
  const multi = legacyQuestionRecord("【答复】你之前的提问:「两件事」\n\n【1】第一个问题\n答：第一行\n第二行\n\n【2】第二个问题\n答：(未答)\n\n请据此接着安排。", "old-multi");
  assert.deepEqual(multi?.answers, ["第一行\n第二行", ""]);
  assert.deepEqual(multi?.questionItems, [{ question: "第一个问题" }, { question: "第二个问题" }]);
  assert.equal(legacyQuestionRecord("普通回复", "none"), null);
  console.log("question history: durable snapshots, concise replies, stale/concurrent guards and legacy recovery passed");
} finally {
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
