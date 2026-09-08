import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mock } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-branch-plan-scale-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks } = await import("../src/db/schema.js");
const { branchOwner, branchDeletionBlock } = await import("../src/task-branch-plan.js");
const { mountBranchPlanRoutes } = await import("../src/task-branch-routes.js");
await ensureSchema();
const api = new Hono();
mountBranchPlanRoutes(api, async () => { throw new Error("read-only fixture"); });
const at = new Date().toISOString();
const row = (id: string, extra: Partial<typeof tasks.$inferInsert> = {}) => ({
  id, projectId: "project", title: id, body: "", useWorktree: true, worktreeBase: "main",
  workflowMode: "free", status: "done", createdAt: at, updatedAt: at, ...extra,
});
let gitCalls = 0;
const realExecFile = childProcess.execFile;
mock.method(childProcess, "execFile", (...args: Parameters<typeof realExecFile>) => {
  if (args[0] === "git") gitCalls++;
  return realExecFile(...args);
});
syncBuiltinESMExports();

async function measurePlan(id: string) {
  const before = gitCalls;
  const start = performance.now();
  const response = await api.request(`/tasks/${id}/branch-plan`);
  assert.equal(response.status, 200);
  const plan = await response.json();
  const result = { task: id, ms: Math.round(performance.now() - start), gitCalls: gitCalls - before };
  console.log(JSON.stringify(result));
  return { ...result, plan };
}

try {
  git("init", "-b", "main");
  git("config", "user.name", "Branch Scale Test");
  git("config", "user.email", "branch-scale@example.test");
  git("commit", "--allow-empty", "-m", "initial");
  await db.insert(projects).values({ id: "project", name: "Scale", repoPath: root, createdAt: at });
  await db.insert(projects).values({ id: "other", name: "Other", repoPath: root, createdAt: at });
  await db.insert(tasks).values([
    row("old-main-task"),
    row("old-done-task", { stage: "accepted", acceptedTargetBranch: "main" }),
    row("new-main-task", { mergeTargetBranch: "main" }),
    row("parent-owner", { archived: true }),
    row("child-legacy", { worktreeBase: "refs/heads/ash/parent-o" }),
    row("no-wt-owner", { useWorktree: false }),
  ]);
  for (const id of ["old-main", "new-main", "parent-o", "child-le", "no-wt-ow"]) git("branch", `ash/${id}`);
  const small = new Map<string, number>();
  for (const id of ["old-main-task", "old-done-task", "new-main-task", "child-legacy"]) {
    small.set(id, (await measurePlan(id)).gitCalls);
  }
  for (let batch = 0; batch < 10; batch++) {
    await db.insert(tasks).values(Array.from({ length: 100 }, (_, index) => row(`bulk${String(batch * 100 + index).padStart(4, "0")}-old`, {
      archived: index % 2 === 0, stage: "accepted", acceptedTargetBranch: "main",
    })));
  }
  console.log("1,000 unrelated legacy worktree tasks added (all target main)");
  for (let repeat = 0; repeat < 3; repeat++) {
    for (const id of small.keys()) {
      const result = await measurePlan(id);
      assert.equal(result.gitCalls, small.get(id), "unrelated task count must not increase Git subprocess count");
      assert.equal(result.plan.task.dependency?.taskId ?? null, id === "child-legacy" ? "parent-owner" : null);
    }
  }
  const before = gitCalls;
  for (const branch of ["main", "refs/heads/main", "feature/topic", "ash/unknown", "ash/parent-owner", "ash/parent-o/nested"]) {
    assert.equal(await branchOwner(root, "project", branch), undefined);
  }
  assert.equal(gitCalls, before, "ordinary branches and unmatched IDs need no Git calls");
  assert.equal(await branchOwner(root, "other", "ash/parent-o"), undefined);
  assert.equal(await branchOwner(root, "project", "ash/no-wt-ow"), undefined);
  assert.equal((await branchOwner(root, "project", " refs/heads/ash/parent-o "))?.id, "parent-owner");
  assert.match((await branchDeletionBlock(root, "parent-owner"))!, /child-legacy/);
  git("branch", "harness/parent-o");
  assert.equal(await branchOwner(root, "project", "harness/parent-o"), undefined, "ash branch wins when both namespaces exist");
  git("branch", "-D", "ash/parent-o");
  assert.equal((await branchOwner(root, "project", "refs/heads/harness/parent-o"))?.id, "parent-owner");
  await db.update(tasks).set({ worktreeBase: "harness/parent-o" }).where(eq(tasks.id, "child-legacy"));
  assert.equal((await measurePlan("child-legacy")).plan.task.dependency?.taskId, "parent-owner");
  assert.match((await branchDeletionBlock(root, "parent-owner"))!, /child-legacy/);
  git("branch", "-D", "harness/parent-o");
  assert.equal((await branchOwner(root, "project", "ash/parent-o"))?.id, "parent-owner", "missing branches retain existing ash ownership fallback");
  assert.equal(await branchOwner(root, "project", "harness/parent-o"), undefined);
  await db.insert(tasks).values(row("a_%", { archived: true }));
  git("branch", "ash/a_%");
  assert.equal((await branchOwner(root, "project", "ash/a_%"))?.id, "a_%", "short IDs and SQL wildcard characters match literally");
  const fingerprint = (await measurePlan("old-main-task")).plan.task.fingerprint;
  git("commit", "--allow-empty", "-m", "advance main");
  assert.notEqual((await measurePlan("old-main-task")).plan.task.fingerprint, fingerprint, "target advancement must be visible immediately");
  console.log("✓ bounded Git calls at 1,006 tasks; legacy/archived ownership, namespace precedence, literal IDs and fresh fingerprints");
} finally {
  mock.restoreAll();
  syncBuiltinESMExports();
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
