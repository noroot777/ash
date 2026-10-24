import assert from "node:assert/strict";
import { mergeFetchedTasks, upsertTask } from "../src/lib/useTasks.ts";
import { mergeCreatedTask, mergeTaskSnapshot } from "../src/workspace/createdTaskMerge.ts";
import { mergeTaskSnapshotFields } from "../src/lib/taskSnapshot.ts";

const base = { id: "task", projectId: "project", title: "same", updatedAt: "2026-10-24T00:00:00Z",
  backgroundRevision: 0, acceptGateRunning: false, monitorRunning: false };
const mergers = [mergeFetchedTasks, (current, incoming) => upsertTask(current, incoming[0]),
  (current, incoming) => mergeCreatedTask(current, incoming[0]),
  (current, incoming) => mergeTaskSnapshot(current, incoming[0])];

for (const field of ["acceptGateRunning", "monitorRunning"]) {
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
const both = { ...base, acceptGateRunning: true, monitorRunning: true, backgroundRevision: 3 };
assert.deepEqual(mergeTaskSnapshotFields(both, base), both);
assert.equal(mergeTaskSnapshot([], both).length, 0);
assert.deepEqual(mergeCreatedTask([], both), [both]);
assert.equal(mergeTaskSnapshotFields({ ...base, title: "local" }, base, true).title, "local");
assert.equal(mergeTaskSnapshotFields({ ...base, title: "local" }, base).title, "same");
console.log("task background sync: every snapshot entrance preserves independently versioned facts");
