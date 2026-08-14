import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

const root = mkdtempSync(join(tmpdir(), "harness-task-derivation-"));
process.env.HARNESS_DB = join(root, "harness.db");

const [{ db, ensureSchema }, schema, { mountTaskRoutes }] = await Promise.all([
  import("../src/db/index.js"),
  import("../src/db/schema.js"),
  import("../src/task-routes.js"),
]);
const { projects, tasks } = schema;

await ensureSchema();
const at = new Date().toISOString();
const taskRow = (overrides: Record<string, unknown>) => ({
  id: "base-task",
  projectId: "project",
  groupId: null,
  parentId: null,
  title: "base",
  body: "",
  mode: "single",
  status: "done",
  stage: null,
  reviewOf: null,
  reviewRound: null,
  reviewRequested: false,
  labels: "[]",
  dependsOn: "[]",
  resumeDependsOn: "[]",
  agentType: "claude",
  executorId: null,
  autoTitle: false,
  duet: null,
  team: null,
  scheduleId: null,
  createdAt: at,
  updatedAt: at,
  useWorktree: false,
  worktreeBase: null,
  originTaskId: null,
  ...overrides,
});

try {
  await db.insert(projects).values({
    id: "project",
    name: "derivation policy",
    repoPath: root,
    apiKeys: null,
    createdAt: at,
  });
  await db.insert(tasks).values([
    taskRow({ id: "base-task", title: "base" }),
    taskRow({ id: "lead", title: "lead", mode: "team", originTaskId: "base-task" }),
    taskRow({ id: "worker", title: "worker", parentId: "lead" }),
    taskRow({ id: "reviewer", title: "reviewer", reviewOf: "base-task" }),
  ]);

  const api = new Hono();
  mountTaskRoutes(api);
  const createDerived = (input: Record<string, unknown>) => api.request("/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "project", title: "nested", ...input }),
  });

  let response = await createDerived({ mode: "team", originTaskId: "worker" });
  assert.equal(response.status, 409, "worker must not derive a team task");
  assert.match((await response.json() as { error: string }).error, /不能再创建团队\/讨论任务/);

  response = await createDerived({ mode: "duet", originTaskId: "reviewer" });
  assert.equal(response.status, 409, "reviewer without parentId must not derive a duet task");

  response = await createDerived({ mode: "team", parentId: "worker" });
  assert.equal(response.status, 409, "direct nested team creation must also be rejected");

  response = await createDerived({ mode: "duet", originTaskId: "base-task", useWorktree: false });
  assert.equal(response.status, 201, "ordinary top-level tasks may still derive duets");

  response = await createDerived({ mode: "duet", originTaskId: "lead", useWorktree: false });
  assert.equal(response.status, 201, "top-level duet/team iteration chains must stay supported");

  console.log("task derivation policy tests passed");
} finally {
  rmSync(root, { recursive: true, force: true });
}
