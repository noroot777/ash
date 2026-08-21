import assert from "node:assert/strict";
import {
  normalizedWorkspaceUrl,
  pushTaskHistoryEntry,
  selectedTaskProjectId,
  taskSelectionUrl,
} from "../src/workspace/workspaceHistory.ts";

assert.equal(
  taskSelectionUrl({ id: "task / 四", projectId: "project & one" }, "/"),
  "/?project=project+%26+one&task=task+%2F+%E5%9B%9B",
);

assert.equal(
  normalizedWorkspaceUrl("/tasks/task%20%2F%20%E5%9B%9B", "", "#reply"),
  "/?task=task+%2F+%E5%9B%9B#reply",
  "legacy handoff links must retain the task id when the SPA normalizes the path",
);
assert.equal(
  normalizedWorkspaceUrl("/tasks/task-2", "?project=stale", ""),
  "/?project=stale&task=task-2",
);
assert.equal(normalizedWorkspaceUrl("/tasks/bad%ZZ", "", ""), "/?task=bad%25ZZ");
assert.equal(normalizedWorkspaceUrl("/", "?project=p1", ""), null);

assert.equal(
  selectedTaskProjectId([
    { id: "task-1", projectId: "project-1" },
    { id: "task-2", projectId: "project-2" },
  ], "task-2"),
  "project-2",
  "a task-only deep link must switch the workspace to that task's project",
);
assert.equal(selectedTaskProjectId([], "missing"), null);

const entries = ["/?project=project-1"];
const location = { pathname: "/", search: "?project=project-1" };
const browser = {
  location,
  history: {
    pushState(_state, _unused, url) {
      const parsed = new URL(String(url), "http://ash.test");
      location.pathname = parsed.pathname;
      location.search = parsed.search;
      entries.push(`${location.pathname}${location.search}`);
    },
  },
};

for (const id of ["a", "b", "c", "d"]) {
  assert.equal(pushTaskHistoryEntry({ id, projectId: "project-1" }, browser), true);
}

assert.deepEqual(entries, [
  "/?project=project-1",
  "/?project=project-1&task=a",
  "/?project=project-1&task=b",
  "/?project=project-1&task=c",
  "/?project=project-1&task=d",
]);
assert.equal(
  pushTaskHistoryEntry({ id: "d", projectId: "project-1" }, browser),
  false,
  "reselecting the current task must not add a duplicate history entry",
);

console.log("workspace task history tests passed");
