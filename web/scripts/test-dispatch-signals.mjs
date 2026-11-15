// 派出的任务失败的判据（task-detail/dispatched/dispatchSignals.ts、task-detail/feedAsides.ts）：
// 气泡的头一句与先后、什么时候去重读、按时刻插进会话的哪一处。浏览器那一半在
// test-dispatch-signals-dom.mjs。
// 跑：npm -w web run test:dispatch-signals
import assert from "node:assert/strict";
import { dispatchBubbles, dispatchedSignature, headSentence } from "../src/task-detail/dispatched/dispatchSignals.ts";
import { interleaveAsides } from "../src/task-detail/feedAsides.ts";

const at = (minutes) => new Date(Date.parse("2026-11-15T10:00:00.000Z") + minutes * 60_000).toISOString();
const task = (id, extra = {}) => ({
  id, projectId: "p1", parentId: null, title: id, mode: "single", status: "paused", stage: null, question: null,
  archived: false, dispatchedBy: "lead", createdAt: at(0), updatedAt: at(0), executorLabel: "claude@x", ...extra,
});
const failed = (seq, taskId, minute, reason) => ({ seq, taskId, kind: "failed", at: at(minute), reason });

// —— 头一句：截到第一个句末，markdown 记号去掉，代码块不进来，太长截断。
assert.equal(headSentence("先改哪一块？前端还是服务端。"), "先改哪一块？");
assert.equal(headSentence("**两件事**要你定。\n\n第一件……"), "两件事要你定。");
assert.equal(headSentence("这一站没过：\n```\nerror TS2304\n```\n怎么办？"), "这一站没过：");
assert.equal(headSentence("Use v2. Then migrate."), "Use v2.");
assert.equal(headSentence("1.5 版本还要不要"), "1.5 版本还要不要", "小数点不算句末");
assert.equal(headSentence("长".repeat(200)).length, 120);
assert.equal(headSentence(null), "");

// —— 失败气泡：原因的头一句，没原因有一句兜底，找不到那条任务不写空标题；先后按 (那一刻, 序号)。
{
  const bubbles = dispatchBubbles([
    failed(3, "kid-c", 6, null),
    failed(2, "kid-c", 5, "模型上游连不上（503）。点重试会接着跑。"),
    failed(9, "gone", 5, "后补录的同一刻"),
    failed(4, "kid-a", 5, "同一刻、序号小的在前"),
  ], [task("kid-a"), task("kid-c")]);
  assert.deepEqual(bubbles.map((bubble) => [bubble.taskId, bubble.text]), [
    ["kid-c", "模型上游连不上（503）。"],
    ["kid-a", "同一刻、序号小的在前"],
    ["gone", "后补录的同一刻"],
    ["kid-c", "这一轮异常结束"],
  ], "按那一刻排，同一刻再比序号；说不出原因有一句兜底");
  assert.equal(bubbles[2].title, "派出的任务", "列表里找不到那条（看不见、还没读到）时不写空标题");
  assert.equal(bubbles[0].executor, "claude@x");
  assert.equal(bubbles[0].key, "dispatch:2");
}

// —— 什么时候去重读：名下那几条状态变了（失败了、重试了）；只是来问、答了不用（不画提问）。
{
  const kid = task("kid");
  assert.notEqual(dispatchedSignature([kid]), dispatchedSignature([{ ...kid, status: "failed" }]), "失败了要重读");
  assert.equal(dispatchedSignature([kid]), dispatchedSignature([{ ...kid, question: "又问了" }]), "来问不重读");
}

// —— 按时刻插进会话：插在第一条比它晚的行前面，比所有行都晚的在最后；说不出时刻的行不参与比较。
{
  const rows = [{ id: "r0", at: at(0) }, { id: "r?", at: null }, { id: "r10", at: at(10) }, { id: "r20", at: at(20) }];
  const asides = [{ key: "a25", at: at(25) }, { key: "a5", at: at(5) }, { key: "a10", at: at(10) }];
  const order = interleaveAsides(rows, asides, (row) => row.at).map((entry) => entry.row?.id ?? entry.aside.key);
  assert.deepEqual(order, ["r0", "r?", "a5", "r10", "a10", "r20", "a25"]);
  assert.deepEqual(interleaveAsides(rows, [], (row) => row.at).map((entry) => entry.row.id), ["r0", "r?", "r10", "r20"]);
}

console.log("✓ 派出的任务失败：头一句、气泡先后、何时重读、按时刻插进会话");
