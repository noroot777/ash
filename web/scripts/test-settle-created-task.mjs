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

// 「创建并等前置」:建好后要求运行;前置没齐时服务端回「在等」,提示是「已建好、等谁站稳后自动开始」,
// 不是「启动失败」;前置都齐了却开不了工时如实说原因;都站稳了就当场起跑。
{
  const realFetch = globalThis.fetch;
  const runWith = async (body, waitingFor = () => ["前置A", "前置B"]) => {
    const requests = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), method: init?.method });
      return new Response(JSON.stringify(body), { status: 202, headers: { "content-type": "application/json" } });
    };
    try {
      const { args, calls } = baseArgs({ launchMode: "prerequisites", waitingFor });
      await settleCreatedTask(args);
      return { calls, requests };
    } finally {
      globalThis.fetch = realFetch;
    }
  };
  let { calls, requests } = await runWith({ started: false, waiting: true, blocked: false, reason: "在等前置：「前置A」在跑" });
  assert.deepEqual(requests, [{ url: "/api/tasks/task-1/run", method: "POST" }], "建好之后要求运行");
  assert.deepEqual(calls.notices, ["任务已建好，等「前置A」「前置B」站稳后自动开始"]);
  assert.doesNotMatch(calls.notices[0], /失败/, "在等前置不是启动失败");
  assert.equal(calls.clear, 1, "建好了草稿照常丢");
  ({ calls } = await runWith({ started: false, waiting: true, blocked: true, reason: "「前置A」和「前置B」的改动合不到一起" }));
  assert.deepEqual(calls.notices, ["任务已建好，前置都站稳了，但还开不了工：「前置A」和「前置B」的改动合不到一起"]);
  ({ calls } = await runWith({ started: true }));
  assert.deepEqual(calls.notices, ["任务已创建并启动"], "前置都站稳了：当场起跑");
}

console.log("settle-created-task: all assertions passed");
