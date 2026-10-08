// 创建完成回写合并策略(createdTaskMerge)的回归。单独成文件:它和数据层回归
// 没有共享夹具,而 test-data-layer.mjs 已贴着单文件 700 行上限(第 4 轮审查)。
import assert from "node:assert/strict";
import { mergeCreatedTask } from "../src/workspace/createdTaskMerge.ts";

// 按服务端在队列变更时 bump 的 updatedAt 比先后。
// ① 本地行更新(SSE 已送达移出等更晚更新),在途旧快照不得覆盖(第 2 轮审查);
// ② 本地行只收到过创建事件,更新的入队快照(现在直接来自插入/建队响应)必须覆盖
//    (第 3、4 轮审查:入队事件断流时任务错显「独立任务」);
// ③ 同刻保留本地 enriched 行;④ 无行时占位插入,新行在最前。
const sseRemovedRow = { id: "t1", queueId: null, queuePosition: null, updatedAt: "2026-10-08T03:00:02.000Z" };
const staleEnqueuedSnapshot = { id: "t1", queueId: "q1", queuePosition: 1, updatedAt: "2026-10-08T03:00:01.000Z" };
assert.deepEqual(mergeCreatedTask([sseRemovedRow], staleEnqueuedSnapshot), [sseRemovedRow], "更晚的 SSE 更新不能被在途旧快照覆盖");

const createdOnlyRow = { id: "t1", queueId: null, queuePosition: null, updatedAt: "2026-10-08T03:00:00.000Z" };
const freshEnqueuedSnapshot = { id: "t1", queueId: "q1", queuePosition: 1, updatedAt: "2026-10-08T03:00:01.000Z" };
assert.deepEqual(
  mergeCreatedTask([createdOnlyRow], freshEnqueuedSnapshot),
  [freshEnqueuedSnapshot],
  "只收到创建事件的旧行不能挡掉入队响应带回的新快照",
);
assert.deepEqual(
  mergeCreatedTask([{ ...createdOnlyRow, updatedAt: freshEnqueuedSnapshot.updatedAt }], freshEnqueuedSnapshot),
  [{ ...createdOnlyRow, updatedAt: freshEnqueuedSnapshot.updatedAt }],
  "同刻保留本地 enriched 行",
);
assert.deepEqual(mergeCreatedTask([], createdOnlyRow), [createdOnlyRow], "SSE 没到时用快照占位插入");
assert.deepEqual(
  mergeCreatedTask([{ id: "t0", updatedAt: "2026-10-08T03:00:00.000Z" }], { id: "t1", updatedAt: "2026-10-08T03:00:00.000Z" }).map((row) => row.id),
  ["t1", "t0"],
  "新行插在最前",
);

// ⑤ 入队响应带回**全体成员**快照(含前驱)时,整批 reduce 过同一条合并路径
//   (第 5 轮审查:只同步新成员会让前驱在列表里保持入队前状态——没有队列徽标、
//    计数错位,不刷新再接同一前驱还会重复建队撞 409)。每份快照仍各自按
//    updatedAt 裁决:批里混着过期快照时,只有更新的那些生效。
const stalePredecessorRow = { id: "t-prev", queueId: null, queuePosition: null, updatedAt: "2026-10-08T03:00:00.000Z" };
const unrelatedRow = { id: "t-other", queueId: null, queuePosition: null, updatedAt: "2026-10-08T03:00:00.000Z" };
const memberSnapshots = [
  { id: "t-prev", queueId: "q1", queuePosition: 0, updatedAt: "2026-10-08T03:00:01.000Z" },
  { id: "t-new", queueId: "q1", queuePosition: 1, updatedAt: "2026-10-08T03:00:01.000Z" },
];
assert.deepEqual(
  memberSnapshots.reduce(mergeCreatedTask, [stalePredecessorRow, unrelatedRow]),
  [memberSnapshots[1], memberSnapshots[0], unrelatedRow],
  "全体成员快照整批合并:前驱被更新快照覆盖,缺行的新成员占位插入,无关行不动",
);
const laterMovedPredecessor = { id: "t-prev", queueId: null, queuePosition: null, updatedAt: "2026-10-08T03:00:02.000Z" };
assert.deepEqual(
  memberSnapshots.reduce(mergeCreatedTask, [laterMovedPredecessor]),
  [memberSnapshots[1], laterMovedPredecessor],
  "批量合并仍按 updatedAt 逐份裁决:前驱已有更晚的 SSE 更新(移出)时不被在途快照盖回",
);

console.log("创建回写合并策略回归验证通过");
