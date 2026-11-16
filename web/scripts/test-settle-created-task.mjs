import assert from "node:assert/strict";
import { settleCreatedTask } from "../src/composer/settleCreatedTask.ts";

// settleCreatedTask 草稿归属裁决的回归(第 9、10 轮审查;新建框第 2、3 轮审查):
// - 结果**一律凭这次提交的身份**动草稿:成功清空、没送达挂上待重发都交给 settleSubmission(戳 + 面板已卸载时的
//   对象引用),不在这里看挂载状态猜归属、也不读字段比较(第 10 轮:逐字段比较漏掉附件);
// - 不认就不清、不挂,ownsComposer=false,上层不收面板;面板挂着、草稿却已清空另写(新建框第 3 轮)也一样;
// - 随手记回链永远交提交时捕获的 noteIds;queue 分支成员快照交 onTasksSynced。
//
// 下面的 settleSubmission 照 DraftStore 的判据模拟一份草稿库:store.current 是此刻的草稿。

const baseArgs = (overrides) => {
  const calls = { settled: [], resetLabels: 0, created: [], synced: [], notices: [] };
  const submittedDraft = { text: "提交时的正文", attachments: [], pendingUploads: [], noteIds: ["n1"], submission: "tok-1" };
  const store = { current: submittedDraft };
  return {
    calls,
    store,
    submittedDraft,
    args: {
      task: { id: "task-1", updatedAt: "2026-10-08T07:00:00.000Z" },
      launchMode: "create",
      scheduleAt: "",
      scheduleCron: "",
      submitted: { token: "tok-1", draft: submittedDraft, noteIds: ["n1"] },
      panelMounted: () => true,
      draft: {
        settleSubmission: (token, outcome, unchangedSince) => {
          calls.settled.push({ token, outcome, unchangedSince });
          const current = store.current;
          if (current.submission !== token || (unchangedSince && current !== unchangedSince)) return false;
          store.current = outcome === "clear" ? null : { ...current, created: outcome.created };
          return true;
        },
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
// 清空后写了另一件事：戳没了，对象也换了。
const rewritten = { text: "清空后新写的", attachments: [], pendingUploads: [], noteIds: [], submission: null };

// 面板还挂着、草稿还是这一份:正常收尾,清草稿、ownsComposer=true。
{
  const { args, calls, store } = baseArgs({});
  await settleCreatedTask(args);
  assert.deepEqual(calls.settled.map((item) => [item.token, item.outcome, item.unchangedSince]), [["tok-1", "clear", undefined]],
    "挂着时只凭戳认,不要求一字未动(发送途中改的还是这一件)");
  assert.equal(store.current, null, "清掉了");
  assert.equal(calls.resetLabels, 1);
  assert.deepEqual(calls.created[0].noteIds, ["n1"]);
  assert.equal(calls.created[0].ownsComposer, true);
  assert.deepEqual(calls.notices, ["任务已创建"]);
}

// 面板还挂着,但等结果期间清空草稿另写了一件事:成功也不清它、不收面板,只如实说一声(新建框第 3 轮审查)。
{
  const { args, calls, store } = baseArgs({});
  store.current = rewritten;
  await settleCreatedTask(args);
  assert.equal(store.current, rewritten, "新写的一个字都不动");
  assert.equal(calls.resetLabels, 0);
  assert.equal(calls.created[0].ownsComposer, false, "上层据此不收面板");
  assert.deepEqual(calls.notices, ["任务已创建；那份草稿已经换了，后来写的内容原样留着"]);
}

// 面板已卸载:把提交时刻的草稿对象交过去做引用判等;没动过就清,ownsComposer 仍是 false(面板已经不是它的)。
{
  const { args, calls, store, submittedDraft } = baseArgs({ panelMounted: () => false });
  await settleCreatedTask(args);
  assert.equal(calls.settled[0].unchangedSince, submittedDraft, "必须交提交那一刻的草稿对象引用");
  assert.equal(store.current, null);
  assert.equal(calls.resetLabels, 0);
  assert.equal(calls.created[0].ownsComposer, false, "上层据此不收别人的面板");
}

// 面板已卸载、新面板在同一份草稿上补了附件(戳还在、对象换了):不清。
{
  const { args, store, submittedDraft } = baseArgs({ panelMounted: () => false });
  const edited = { ...submittedDraft, attachments: [{ path: "/tmp/a.png" }] };
  store.current = edited;
  await settleCreatedTask(args);
  assert.equal(store.current, edited, "任何字段变化都让旧提交失去清空资格");
}

// queue 分支:task 换成入队快照,成员整批交 onTasksSynced;卸载裁决同样生效。
{
  const { args, calls, submittedDraft } = baseArgs({ launchMode: "queue", panelMounted: () => false });
  await settleCreatedTask(args);
  assert.equal(calls.created[0].task.queueId, "q1", "onCreated 拿到的是入队后的快照");
  assert.deepEqual(calls.synced, [[{ id: "t-prev" }]]);
  assert.deepEqual(calls.notices, ["已排在「前驱」之后"]);
  assert.equal(calls.settled[0].unchangedSince, submittedDraft);
}

// 框里 `@` 了人、第一回合没被接下:这次提交没办成——不清草稿、不回写 onCreated(面板不收),把已建好的任务
// 连同原因挂进这次提交的草稿,下一次只对它重发。面板卸载了也一样(草稿库还在)。
for (const mounted of [true, false]) {
  const { args, calls, store } = baseArgs({
    launchMode: "run",
    panelMounted: () => mounted,
    opening: { start: async () => { throw new Error("暂时不可用"); }, started: "任务已创建，第一句交给 codex 答", what: "给 codex 的这一句" },
  });
  assert.equal(await settleCreatedTask(args), false, "第一回合没送达就不算办成");
  assert.deepEqual(calls.settled.map((item) => item.outcome), [{ created: { task: args.task, error: "暂时不可用" } }],
    "已建好的任务连同原因挂上,不清草稿");
  assert.deepEqual(store.current.created, { task: args.task, error: "暂时不可用" });
  assert.equal(calls.created.length, 0, "不回写 onCreated(不收面板、不跳走)");
  assert.match(calls.notices[0], /给 codex 的这一句没发出去：暂时不可用。再按一次只重发这一下，不会再建一条/);
}

// 等结果期间那份草稿被清空、换成了别的事:这条任务不接管新草稿,也不回写、不清,只如实说它留在待办里。
{
  const { args, calls, store } = baseArgs({
    launchMode: "run",
    task: { id: "task-1", title: "上一件事", updatedAt: "2026-10-08T07:00:00.000Z" },
    opening: { start: async () => { throw new Error("暂时不可用"); }, started: "", what: "给 codex 的这一句" },
  });
  store.current = rewritten;
  assert.equal(await settleCreatedTask(args), false);
  assert.equal(store.current, rewritten, "新草稿上不挂、不清");
  assert.equal(calls.created.length, 0);
  assert.deepEqual(calls.notices, ["任务「上一件事」已创建，但给 codex 的这一句没发出去：暂时不可用。那份草稿已经换了，这条任务留在待办里"]);
}

// 第一回合接下了:照常收尾,返回办成。
{
  const started = [];
  const { args, calls, store } = baseArgs({
    launchMode: "run",
    opening: { start: async (task) => { started.push(task.id); }, started: "任务已创建，和 codex 的讨论开始了", what: "这场讨论" },
  });
  assert.equal(await settleCreatedTask(args), true);
  assert.deepEqual(started, ["task-1"]);
  assert.equal(store.current, null);
  assert.equal(calls.created.length, 1);
  assert.deepEqual(calls.notices, ["任务已创建，和 codex 的讨论开始了"]);
}

console.log("settle-created-task: all assertions passed");
