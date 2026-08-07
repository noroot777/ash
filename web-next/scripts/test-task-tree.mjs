import assert from "node:assert/strict";
import { buildTaskTree, orderedTopLevelTasks } from "../src/workspace/taskTreeModel.ts";

function task(id, mode, { pinnedAt = null, status = "done", stage = null, createdAt = "2026-08-01T00:00:00.000Z" } = {}) {
  return {
    id,
    mode,
    pinnedAt,
    status,
    stage,
    createdAt,
    priority: "none",
    parentId: null,
    archived: false,
  };
}

const mixed = [
  task("collab-pinned", "team", { pinnedAt: 100 }),
  task("single-pinned", "single", { pinnedAt: 200 }),
  task("collab-normal", "duet"),
  task("single-normal", "single"),
];

const unified = buildTaskTree(mixed, { unifiedPinned: true });
assert.deepEqual(unified.map((section) => section.key), ["pinned", "collab", "single"]);
assert.deepEqual(unified[0].tasks.map((row) => row.id), ["single-pinned", "collab-pinned"]);
assert.deepEqual(unified[1].tasks.map((row) => row.id), ["collab-normal"]);
assert.deepEqual(unified[2].tasks.map((row) => row.id), ["single-normal"]);
assert.equal(new Set(unified.flatMap((section) => section.tasks.map((row) => row.id))).size, mixed.length);
assert.deepEqual(orderedTopLevelTasks(mixed, { unifiedPinned: true }).map((row) => row.id), [
  "single-pinned",
  "collab-pinned",
  "collab-normal",
  "single-normal",
]);

const original = buildTaskTree(mixed);
assert.deepEqual(original.map((section) => section.key), ["collab", "single"]);
assert.deepEqual(original[0].tasks.map((row) => row.id), ["collab-pinned", "collab-normal"]);
assert.deepEqual(original[1].tasks.map((row) => row.id), ["single-pinned", "single-normal"]);

const withoutPinned = buildTaskTree([
  task("collab-normal", "team"),
  task("single-normal", "single"),
], { unifiedPinned: true });
assert.deepEqual(withoutPinned.map((section) => section.key), ["collab", "single"]);

const onlyPinned = buildTaskTree([
  task("only-collab", "team", { pinnedAt: 300 }),
], { unifiedPinned: true });
assert.deepEqual(onlyPinned.map((section) => section.key), ["pinned"]);

console.log("task tree grouping tests passed");
