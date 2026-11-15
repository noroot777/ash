// 派出的任务来问 / 失败的判据（task-detail/dispatched/dispatchSignals.ts、task-detail/feedAsides.ts）：
// 气泡的状态与头一句、回复框那一格轮到谁、按时刻插进会话的哪一处。浏览器那一半在
// test-dispatch-signals-dom.mjs。
// 跑：npm -w web run test:dispatch-signals
import assert from "node:assert/strict";
import { askingOrder, dispatchFeed, dispatchedSignature, headSentence } from "../src/task-detail/dispatched/dispatchSignals.ts";
import { interleaveAsides } from "../src/task-detail/feedAsides.ts";

const at = (minutes) => new Date(Date.parse("2026-11-15T10:00:00.000Z") + minutes * 60_000).toISOString();
const task = (id, extra = {}) => ({
  id, projectId: "p1", parentId: null, title: id, mode: "single", status: "paused", stage: null, question: null,
  archived: false, dispatchedBy: "lead", createdAt: at(0), updatedAt: at(0), executorLabel: "claude@x", ...extra,
});
const question = (seq, taskId, minute, extra = {}) => ({ seq, taskId, kind: "question", at: at(minute), question: `${taskId} 的问题。后半句`, answered: false, ...extra });

// —— 头一句：截到第一个句末，markdown 记号去掉，代码块不进来，太长截断。
assert.equal(headSentence("先改哪一块？前端还是服务端。"), "先改哪一块？");
assert.equal(headSentence("**两件事**要你定。\n\n第一件……"), "两件事要你定。");
assert.equal(headSentence("这一站没过：\n```\nerror TS2304\n```\n怎么办？"), "这一站没过：");
assert.equal(headSentence("Use v2. Then migrate."), "Use v2.");
assert.equal(headSentence("1.5 版本还要不要"), "1.5 版本还要不要", "小数点不算句末");
assert.equal(headSentence("长".repeat(200)).length, 120);
assert.equal(headSentence(null), "");

// —— 气泡状态：还在等 = 它最近那一问、此刻还挂着；答过 / 不再等；失败带原因，没原因有一句兜底。
{
  const tasks = [task("kid-a", { question: "kid-a 的第二问" }), task("kid-b"), task("kid-c")];
  const signals = [
    question(1, "kid-a", 1, { answered: true, answer: { id: "r1", question: "q", answer: "要", reply: "【答复】\n要", answeredAt: at(2) } }),
    question(2, "kid-b", 3),
    question(3, "kid-a", 4, { question: "kid-a 的第二问" }),
    { seq: 4, taskId: "kid-c", kind: "failed", at: at(5), reason: "模型上游连不上（503）。点重试会接着跑。" },
    { seq: 5, taskId: "kid-c", kind: "failed", at: at(6), reason: null },
    question(6, "gone", 7),
  ];
  const { bubbles, answers } = dispatchFeed(signals, tasks);
  assert.deepEqual(bubbles.map((bubble) => [bubble.taskId, bubble.state]), [
    ["kid-a", "answered"], ["kid-b", "closed"], ["kid-a", "waiting"], ["kid-c", "failed"], ["kid-c", "failed"], ["gone", "closed"],
  ], "只有最近那一问、此刻还挂着的才是在等");
  assert.equal(bubbles[3].text, "模型上游连不上（503）。");
  assert.equal(bubbles[4].text, "这一轮异常结束", "失败说不出原因时的那一句");
  assert.equal(bubbles[5].title, "派出的任务", "列表里找不到那条（看不见、还没读到）时不写空标题");
  assert.equal(bubbles[0].executor, "claude@x");
  assert.deepEqual(answers.map((answer) => [answer.taskId, answer.at]), [["kid-a", at(2)]], "在这里答的那一题按答复的时刻排");
}

// —— 回复框那一格：自己在问先答自己；派出的按提问先后（不按派出的先后），记录没到用任务改动时刻。
{
  const host = task("lead", { dispatchedBy: null });
  const early = task("kid-early", { createdAt: at(1), question: "q", updatedAt: at(30) });
  const late = task("kid-late", { createdAt: at(2), question: "q", updatedAt: at(9) });
  const quiet = task("kid-quiet", { createdAt: at(3) });
  const archived = task("kid-archived", { question: "q", archived: true });
  const signals = [question(1, "kid-late", 5), question(2, "kid-early", 8)];
  const ids = (rows) => rows.map((row) => row.id);
  assert.deepEqual(ids(askingOrder(host, [early, late, quiet, archived], signals)), ["kid-late", "kid-early"], "按提问先后");
  assert.deepEqual(ids(askingOrder(host, [early, late], [])), ["kid-late", "kid-early"], "记录还没读到：按任务最后改动的时刻");
  assert.deepEqual(ids(askingOrder({ ...host, question: "自己的" }, [early, late], signals)), ["lead", "kid-late", "kid-early"], "自己在问先答自己");
  assert.deepEqual(ids(askingOrder(host, [quiet], signals)), [], "没人在问");
  // 同一毫秒里一起来（一批派出去的同时问）：时刻分不出先后，按记录的序号 —— 后派出的那条先问的，它先上。
  const sameMs = [question(7, "kid-late", 40), question(8, "kid-early", 40)];
  assert.deepEqual(ids(askingOrder(host, [early, late], sameMs)), ["kid-late", "kid-early"], "同一时刻按记录序号，不按派出的先后");
  assert.deepEqual(ids(askingOrder(host, [late, early], [question(9, "kid-early", 40), question(10, "kid-late", 40)])), ["kid-early", "kid-late"]);
  assert.notEqual(dispatchedSignature([late]), dispatchedSignature([{ ...late, question: null }]), "撤下一问也要重读");
  assert.notEqual(dispatchedSignature([quiet]), dispatchedSignature([{ ...quiet, status: "failed" }]), "失败了也要重读");
}

// —— 按时刻插进会话：插在第一条比它晚的行前面，比所有行都晚的在最后；说不出时刻的行不参与比较。
{
  const rows = [{ id: "r0", at: at(0) }, { id: "r?", at: null }, { id: "r10", at: at(10) }, { id: "r20", at: at(20) }];
  const asides = [{ key: "a25", at: at(25) }, { key: "a5", at: at(5) }, { key: "a10", at: at(10) }];
  const order = interleaveAsides(rows, asides, (row) => row.at).map((entry) => entry.row?.id ?? entry.aside.key);
  assert.deepEqual(order, ["r0", "r?", "a5", "r10", "a10", "r20", "a25"]);
  assert.deepEqual(interleaveAsides(rows, [], (row) => row.at).map((entry) => entry.row.id), ["r0", "r?", "r10", "r20"]);
}

console.log("✓ 派出的任务来问 / 失败：头一句、气泡状态、答题卡先后、按时刻插进会话");
