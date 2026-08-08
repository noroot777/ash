import assert from "node:assert/strict";
import { filterNotes, NOTE_CONVERSION_FILTERS } from "../src/overlays/notesFilter.ts";

const note = (id, body, taskCount = 0) => ({
  id,
  projectId: "project",
  body,
  attachments: [],
  taskLinks: Array.from({ length: taskCount }, (_, index) => ({ taskId: `task-${id}-${index}` })),
  createdAt: 1,
  updatedAt: 1,
});

const rows = [note("plain", "待整理的灵感"), note("task", "已经安排发布", 2)];

assert.deepEqual(NOTE_CONVERSION_FILTERS.map((item) => item.value), ["all", "converted", "unconverted"]);
assert.deepEqual(filterNotes(rows, "", "all").map((item) => item.id), ["plain", "task"]);
assert.deepEqual(filterNotes(rows, "", "converted").map((item) => item.id), ["task"]);
assert.deepEqual(filterNotes(rows, "", "unconverted").map((item) => item.id), ["plain"]);
assert.deepEqual(filterNotes(rows, "发布", "converted").map((item) => item.id), ["task"]);
assert.deepEqual(filterNotes(rows, "灵感", "converted"), []);
assert.deepEqual(filterNotes(rows, "新正文", "unconverted", { id: "plain", body: "新正文" }).map((item) => item.id), ["plain"]);

console.log("notes conversion filter tests passed");
