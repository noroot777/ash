import assert from "node:assert/strict";
import { settleCreatedTask } from "../src/composer/settleCreatedTask.ts";

// settleCreatedTask 草稿归属裁决的回归(第 9、10 轮审查):
// - 面板还挂着:无条件收尾(resetLabels + clear),ownsComposer=true;
// - 面板已卸载:走 clearIfUnchanged,把**提交那一刻的草稿对象**原样交给 Store 做
//   引用判等——不在这里读字段比较(第 10 轮:逐字段比较漏掉附件,被真实复现打回);
// - 随手记回链永远交提交时捕获的 noteIds;queue 分支成员快照交 onTasksSynced。

const baseArgs = (overrides) => {
  const calls = { clear: 0, clearIfUnchanged: [], resetLabels: 0, created: [], synced: [], notices: [] };
  const submittedDraft = { text: "提交时的正文", attachments: [], pendingUploads: [], noteIds: ["n1"] };
  return {
    calls,
    submittedDraft,
    args: {
      task: { id: "task-1", updatedAt: "2026-10-08T07:00:00.000Z" },
      launchMode: "create",
      scheduleAt: "",
      scheduleCron: "",
      submitted: { draft: submittedDraft, noteIds: ["n1"] },
      panelMounted: () => true,
      draft: {
        clear: () => { calls.clear += 1; },
        clearIfUnchanged: (snapshot) => { calls.clearIfUnchanged.push(snapshot); },
      },
      resetLabels: () => { calls.resetLabels += 1; },
      enqueue: async (task) => ({ task: { ...task, queueId: "q1" }, members: [{ id: "t-prev" }], message: "已排在「前驱」之后" }),
      onCreated: (task, noteIds, ownsComposer) => { calls.created.push({ task, noteIds, ownsComposer }); },
      onTasksSynced: (tasks) => { calls.synced.push(tasks); },
      notify: (message) => { calls.notices.push(message); },
      ...overrides,
    },
  };
};

// 面板还挂着:正常收尾,清草稿、ownsComposer=true。
{
  const { args, calls } = baseArgs({});
  await settleCreatedTask(args);
  assert.equal(calls.clear, 1);
  assert.equal(calls.resetLabels, 1);
  assert.deepEqual(calls.clearIfUnchanged, [], "面板挂着时不走条件清空");
  assert.deepEqual(calls.created[0].noteIds, ["n1"]);
  assert.equal(calls.created[0].ownsComposer, true);
  assert.deepEqual(calls.notices, ["任务已创建"]);
}

// 面板已卸载:不无条件清,把提交时刻的草稿对象交给 clearIfUnchanged 做引用判等。
{
  const { args, calls, submittedDraft } = baseArgs({ panelMounted: () => false });
  await settleCreatedTask(args);
  assert.equal(calls.clear, 0, "卸载后不得无条件清草稿");
  assert.equal(calls.resetLabels, 0);
  assert.equal(calls.clearIfUnchanged.length, 1);
  assert.equal(calls.clearIfUnchanged[0], submittedDraft, "必须交提交那一刻的草稿对象引用");
  assert.equal(calls.created[0].ownsComposer, false, "上层据此不收别人的面板");
}

// queue 分支:task 换成入队快照,成员整批交 onTasksSynced;卸载裁决同样生效。
{
  const { args, calls, submittedDraft } = baseArgs({ launchMode: "queue", panelMounted: () => false });
  await settleCreatedTask(args);
  assert.equal(calls.created[0].task.queueId, "q1", "onCreated 拿到的是入队后的快照");
  assert.deepEqual(calls.synced, [[{ id: "t-prev" }]]);
  assert.deepEqual(calls.notices, ["已排在「前驱」之后"]);
  assert.equal(calls.clear, 0);
  assert.equal(calls.clearIfUnchanged[0], submittedDraft);
}

// 框里 `@` 了人、第一回合没被接下:这次提交没办成——不清草稿、不回写 onCreated(面板不收),把已建好的任务
// 连同原因交给 onOpeningFailed 记进草稿,下一次只对它重发。面板卸载了也一样(草稿库还在)。
for (const mounted of [true, false]) {
  const failed = [];
  const { args, calls } = baseArgs({
    launchMode: "run",
    panelMounted: () => mounted,
    opening: { start: async () => { throw new Error("暂时不可用"); }, started: "任务已创建，第一句交给 codex 答", what: "给 codex 的这一句" },
    onOpeningFailed: (task, error) => { failed.push({ task, error }); return true; },
  });
  assert.equal(await settleCreatedTask(args), false, "第一回合没送达就不算办成");
  assert.equal(calls.clear, 0, "不清草稿");
  assert.deepEqual(calls.clearIfUnchanged, [], "卸载了也不清");
  assert.equal(calls.created.length, 0, "不回写 onCreated(不收面板、不跳走)");
  assert.deepEqual(failed, [{ task: args.task, error: "暂时不可用" }], "已建好的任务连同原因记下来");
  assert.match(calls.notices[0], /给 codex 的这一句没发出去：暂时不可用。再按一次只重发这一下，不会再建一条/);
}

// 等结果期间那份草稿被清空、换成了别的事(onOpeningFailed 回 false):这条任务不接管新草稿,也不回写、不清,
// 只如实说它留在待办里。
{
  const { args, calls } = baseArgs({
    launchMode: "run",
    task: { id: "task-1", title: "上一件事", updatedAt: "2026-10-08T07:00:00.000Z" },
    opening: { start: async () => { throw new Error("暂时不可用"); }, started: "", what: "给 codex 的这一句" },
    onOpeningFailed: () => false,
  });
  assert.equal(await settleCreatedTask(args), false);
  assert.equal(calls.clear, 0, "不清新草稿");
  assert.deepEqual(calls.clearIfUnchanged, []);
  assert.equal(calls.created.length, 0);
  assert.deepEqual(calls.notices, ["任务「上一件事」已创建，但给 codex 的这一句没发出去：暂时不可用。那份草稿已经换了，这条任务留在待办里"]);
}

// 第一回合接下了:照常收尾,返回办成。
{
  const started = [];
  const { args, calls } = baseArgs({
    launchMode: "run",
    opening: { start: async (task) => { started.push(task.id); }, started: "任务已创建，和 codex 的讨论开始了", what: "这场讨论" },
    onOpeningFailed: () => assert.fail("接下了就不该记失败"),
  });
  assert.equal(await settleCreatedTask(args), true);
  assert.deepEqual(started, ["task-1"]);
  assert.equal(calls.clear, 1);
  assert.equal(calls.created.length, 1);
  assert.deepEqual(calls.notices, ["任务已创建，和 codex 的讨论开始了"]);
}

console.log("settle-created-task: all assertions passed");
