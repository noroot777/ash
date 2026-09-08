import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-branch-plan-creation-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks } = await import("../src/db/schema.js");
const { mountTaskRoutes } = await import("../src/task-routes.js");
const { createTasks } = await import("../src/task-store.js");
const { taskWorkspace } = await import("../src/task-workspace.js");
const { dispatchWorkers } = await import("../src/team/dispatch.js");
const { acceptTask } = await import("../src/task-accept.js");
await ensureSchema();
const api = new Hono();
mountTaskRoutes(api);
const at = new Date().toISOString();
const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0];
const commit = (repo: string, name: string) => {
  writeFileSync(join(repo, name), name);
  git(repo, "add", "--", name);
  git(repo, "commit", "-m", name);
  return git(repo, "rev-parse", "HEAD");
};
async function repository(id: string, seeded = true) {
  const repo = join(root, id);
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, "config", "user.name", "Branch Test");
  git(repo, "config", "user.email", "branch@example.test");
  if (seeded) commit(repo, "seed.txt");
  await db.insert(projects).values({ id, name: id, repoPath: repo, createdAt: at });
  return repo;
}
async function create(projectId: string, extra: Record<string, unknown> = {}) {
  const response = await api.request("/tasks", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId, title: "创建回归", useWorktree: true, workflowMode: "free", ...extra }) });
  assert.equal(response.status, 201, await response.clone().text());
  return row((await response.json()).id);
}

try {
  {
    const repo = await repository("empty", false);
    const task = await create("empty");
    assert.equal(task.worktreeStartCommit, null);
    assert.equal(existsSync(join(repo, ".worktrees", task.id)), false);
    commit(repo, "initial.txt");
    const ws = await taskWorkspace(task, repo);
    assert.equal(git(ws.path, "rev-parse", "HEAD"), git(repo, "rev-parse", "main"));
    console.log("✓ empty repository creates lazily and starts after the initial commit");
  }
  {
    const repo = await repository("detached");
    const start = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "--detach", start);
    const task = await create("detached");
    assert.equal(task.worktreeStartCommit, start);
    assert.equal(task.mergeTargetBranch, null);
    const ws = await taskWorkspace(task, repo);
    assert.equal(git(ws.path, "rev-parse", "HEAD"), start);
    commit(ws.path, "detached-task.txt");
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, task.id));
    const blocked = await acceptTask(task.id);
    assert.equal(blocked.accepted, false, "unresolved target is deferred to acceptance");
    git(repo, "checkout", "main");
    assert.equal((await acceptTask(task.id)).accepted, true);
    assert.equal(git(repo, "show", "main:detached-task.txt"), "detached-task.txt");
    console.log("✓ detached HEAD pins its commit, can start, and resolves its target at acceptance");
  }
  {
    const repo = await repository("stale");
    const task = await create("stale", { worktreeBase: "gone-branch" });
    const ws = await taskWorkspace(task, repo);
    assert.equal(ws.baseFallback?.requested, "gone-branch");
    assert.equal(ws.baseFallback?.persisted, true);
    assert.equal((await row(task.id)).worktreeBase, "main");
    commit(ws.path, "fallback.txt");
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, task.id));
    assert.equal((await acceptTask(task.id)).accepted, true);
    console.log("✓ stale base keeps the existing runtime fallback and can be accepted");
  }
  {
    const repo = await repository("serial");
    const [lead] = await createTasks([{ id: "serial-lead", projectId: "serial", title: "调度台", body: "", mode: "team", useWorktree: true, status: "idle", createdAt: at, updatedAt: at }]);
    const shared = await taskWorkspace(await row(lead.id), repo);
    const first = commit(shared.path, "lead-1.txt");
    const batch = await dispatchWorkers(lead.id, [{ body: "A", useWorktree: true }, { body: "B", useWorktree: true }], { mode: "serial", run: false });
    for (const task of batch.tasks) assert.equal((await row(task.id)).worktreeStartCommit, null);
    const a = await taskWorkspace(await row(batch.tasks[0].id), repo);
    assert.equal(git(a.path, "rev-parse", "HEAD"), first);
    const second = commit(shared.path, "lead-2.txt");
    const b = await taskWorkspace(await row(batch.tasks[1].id), repo);
    assert.equal(git(b.path, "rev-parse", "HEAD"), second);
    assert.equal(existsSync(join(b.path, "lead-2.txt")), true);
    assert.equal(existsSync(join(a.path, "lead-2.txt")), false);
    commit(shared.path, "lead-3.txt");
    const again = await taskWorkspace(await row(batch.tasks[1].id), repo);
    assert.equal(git(again.path, "rev-parse", "HEAD"), second, "restarting a worker preserves its existing workspace");
    console.log("✓ serial isolated workers branch at their own start and preserve that workspace on retry");
  }
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
