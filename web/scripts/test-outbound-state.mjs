import assert from "node:assert/strict";
import {
  applyRemoteStates,
  handedOut,
  peersOf,
  remoteStateMap,
} from "../src/workspace/outboundStateModel.ts";
import { spreadCounts } from "../src/workspace/useSidebarSpread.ts";
import { inTaskMode } from "../src/lib/taskAttention.ts";

const TASKS = { kind: "tasks" };

function task(id, extra = {}) {
  return {
    id,
    projectId: "p1",
    mode: "single",
    status: "backlog",
    stage: null,
    question: null,
    pinnedAt: null,
    starredAt: null,
    parentId: null,
    archived: false,
    title: `任务 ${id}`,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...extra,
  };
}

const outMarker = { direction: "out", pending: false, peerUrl: "http://peer:4317", peerName: "mac-mini", peerTaskId: "gone" };
// 接力出去的行在本机是历史存档：导出前先停了任务，所以本机这一行冻在 canceled 上。
const archived = task("gone", { status: "canceled", handoff: outMarker });
const local = task("here", { status: "running" });
const rows = [archived, local];

// 谁算「已经交出去了」：确认送达的才算，pending(送达未知)那种本机还硬拦着，状态归本机自己说。
assert.equal(handedOut(archived), true);
assert.equal(handedOut(local), false);
assert.equal(handedOut(task("x", { handoff: { ...outMarker, pending: true } })), false);
assert.equal(handedOut(task("y", { handoff: { direction: "in", peerUrl: "http://peer:4317", peerTaskId: "y" } })), false);

// 第一轮：持有机答了，那一行按对端的真状态算 —— 状态、标题都以持有机为准。
const live = remoteStateMap([{
  taskId: "gone", status: "running", stage: null, question: null,
  title: "对端给它改的名", updatedAt: "2026-08-02T00:00:00.000Z",
}]);
const merged = applyRemoteStates(rows, live);
assert.equal(merged[0].status, "running");
assert.equal(merged[0].title, "对端给它改的名");
assert.equal(merged[1], local, "没接力出去的行原样返回，别白白换掉引用");
assert.equal(inTaskMode(merged[0]), true, "它在持有机上跑着，就是「还没落地的活」");
assert.equal(spreadCounts(merged, TASKS).all, 2);
assert.equal(spreadCounts(merged, TASKS).run, 2);

// 第二轮：持有机联系不上（rows 空 + offline）。**这一轮的状态必须整份重建，不能叠加**——
// 否则上一轮那个 running 会一直留着，列表、顶栏计数、筛选全跟着说谎，而屏幕上同时还
// 写着「联系不上 mac-mini」。问不到就是没有实时状态：回落到本机冻住的那一行。
const gone = remoteStateMap([]);
assert.equal(gone.size, 0, "每轮整份重建：这一轮没回来的行不许从上一轮继承状态");
const afterOffline = applyRemoteStates(rows, gone);
assert.equal(afterOffline[0], archived, "没有实时状态就回落到本机那一行（canceled）");
assert.equal(inTaskMode(afterOffline[0]), false, "冻住的存档不该继续算「还没落地」");
const counts = spreadCounts(afterOffline, TASKS);
assert.equal(counts.all, 1, "顶栏计数要跟着掉回来");
assert.equal(counts.run, 1);

// 同一条路径也覆盖「对端逐个鉴权时读不到这一行」（任务被移回/删掉，服务端静默跳过它）：
// 那一行同样不在 rows 里，同样退回本机状态，而别的行照常更新。
const partial = applyRemoteStates(
  [archived, task("other", { status: "canceled", handoff: { ...outMarker, peerTaskId: "other" } })],
  remoteStateMap([{
    taskId: "other", status: "running", stage: null, question: null,
    title: "另一条还在", updatedAt: "2026-08-02T00:00:00.000Z",
  }]),
);
assert.equal(partial[0], archived, "这一轮没回来的那条退回本机状态");
assert.equal(partial[1].status, "running", "同一轮里回来的那条照常更新");

// 一台都问不着时（本机接口自己就没应答），仍要报得出联系不上谁 —— 名字取接力时冻进
// 标记里的那个，同一台机器只报一次。
const offline = peersOf(
  [archived, task("z", { handoff: { ...outMarker, peerTaskId: "z" } }), local],
  new Error("fetch failed"),
);
assert.deepEqual(offline, [{ url: "http://peer:4317", name: "mac-mini", reason: "fetch failed" }]);
assert.deepEqual(peersOf([local], new Error("x")), [], "没有出站行就没有谁联系不上");

console.log("outbound state tests passed");
