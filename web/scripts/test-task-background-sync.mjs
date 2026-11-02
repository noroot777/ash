import assert from "node:assert/strict";
import { mergeFetchedTasks, upsertTask } from "../src/lib/useTasks.ts";
import { mergeCreatedTask, mergeTaskSnapshot } from "../src/workspace/createdTaskMerge.ts";
import { mergeTaskSnapshotFields } from "../src/lib/taskSnapshot.ts";

// 独立计版的那几格要**一个不缺**地摆进夹具:`mergeTaskSnapshotFields` 是整份拷过去的
// (缺的那格会带着 undefined 落进结果),夹具漏一格就只能靠 deepEqual 报「多了个
// upstreamStalled: undefined」—— 2026 年加停滞看门狗那一刀就是这么把它搞红的,而那句话
// 说不出「这一格到底该不该跟着版本号走」。答案是该:它跟另外两格同一个版本号。
const base = { id: "task", projectId: "project", title: "same", updatedAt: "2026-10-24T00:00:00Z",
  backgroundRevision: 0, acceptGateRunning: false, monitorRunning: false, upstreamStalled: false };
const mergers = [mergeFetchedTasks, (current, incoming) => upsertTask(current, incoming[0]),
  (current, incoming) => mergeCreatedTask(current, incoming[0]),
  (current, incoming) => mergeTaskSnapshot(current, incoming[0])];

for (const field of ["acceptGateRunning", "monitorRunning", "upstreamStalled"]) {
  const started = { ...base, [field]: true, backgroundRevision: 1 };
  const ended = { ...base, backgroundRevision: 2 };
  for (const merge of mergers) {
    assert.deepEqual(merge([started], [base])[0], started);
    assert.deepEqual(merge([base], [started])[0], started);
    assert.deepEqual(merge([ended], [started])[0], ended);
    assert.deepEqual(merge([started], [ended])[0], ended);
    const newerMetadata = { ...base, title: "newer metadata", updatedAt: "2026-10-24T00:01:00Z" };
    const result = merge([started], [newerMetadata])[0];
    assert.equal(result.title, newerMetadata.title);
    assert.equal(result[field], true);
    assert.equal(result.backgroundRevision, 1);
    const laterBackground = merge([newerMetadata], [started])[0];
    assert.equal(laterBackground.title, newerMetadata.title);
    assert.equal(laterBackground[field], true);
    assert.equal(laterBackground.backgroundRevision, 1);
    const legacy = { ...newerMetadata, backgroundRevision: undefined };
    assert.equal(merge([started], [legacy])[0][field], true);
    assert.equal(merge([legacy], [started])[0][field], true);
    assert.deepEqual(merge([started], [started])[0], started);
  }
}
const both = { ...base, acceptGateRunning: true, monitorRunning: true, upstreamStalled: true, backgroundRevision: 3 };
assert.deepEqual(mergeTaskSnapshotFields(both, base), both);
assert.equal(mergeTaskSnapshot([], both).length, 0);
assert.deepEqual(mergeCreatedTask([], both), [both]);
assert.equal(mergeTaskSnapshotFields({ ...base, title: "local" }, base, true).title, "local");
assert.equal(mergeTaskSnapshotFields({ ...base, title: "local" }, base).title, "same");
console.log("task background sync: every snapshot entrance preserves independently versioned facts");
