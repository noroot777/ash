import assert from "node:assert/strict";
import { buildTaskTree, orderedTopLevelTasks, previewTasksByAge } from "../src/workspace/taskTreeModel.ts";

function task(id, mode, {
  pinnedAt = null,
  status = "done",
  stage = null,
  createdAt = "2026-08-01T00:00:00.000Z",
  updatedAt = createdAt,
} = {}) {
  return {
    id,
    mode,
    pinnedAt,
    status,
    stage,
    createdAt,
    updatedAt,
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

const byLastUpdate = buildTaskTree([
  task("created-later", "single", {
    createdAt: "2026-08-11T10:00:00.000Z",
    updatedAt: "2026-08-11T10:00:00.000Z",
  }),
  task("updated-later", "single", {
    createdAt: "2026-08-10T10:00:00.000Z",
    updatedAt: "2026-08-11T11:00:00.000Z",
  }),
]);
assert.deepEqual(byLastUpdate[0].tasks.map((row) => row.id), ["updated-later", "created-later"]);

const onlyPinned = buildTaskTree([
  task("only-collab", "team", { pinnedAt: 300 }),
], { unifiedPinned: true });
assert.deepEqual(onlyPinned.map((section) => section.key), ["pinned"]);

const now = Date.parse("2026-08-11T12:00:00.000Z");
const byAge = previewTasksByAge([
  task("old", "single", { updatedAt: "2026-08-10T11:59:59.999Z" }),
  task("recent", "single", { updatedAt: "2026-08-11T11:00:00.000Z" }),
  task("boundary", "single", { updatedAt: "2026-08-10T12:00:00.000Z" }),
], now);
assert.deepEqual(byAge.visible.map((row) => row.id), ["recent", "boundary"]);
assert.deepEqual(byAge.hidden.map((row) => row.id), ["old"]);

const allOld = previewTasksByAge([
  task("older", "single", { updatedAt: "2026-08-08T12:00:00.000Z" }),
  task("latest", "single", { updatedAt: "2026-08-10T11:00:00.000Z" }),
  task("oldest", "single", { updatedAt: "2026-08-07T12:00:00.000Z" }),
], now);
assert.deepEqual(allOld.visible.map((row) => row.id), ["latest"]);
assert.deepEqual(allOld.hidden.map((row) => row.id), ["older", "oldest"]);

console.log("task tree grouping tests passed");
