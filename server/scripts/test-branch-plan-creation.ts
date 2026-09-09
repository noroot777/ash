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
const { acceptTask, mountTaskAcceptanceRoutes } = await import("../src/task-accept.js");
const { branchDependency, baseRef } = await import("../src/task-branch-plan.js");
const { readBranchPlan } = await import("../src/task-branch-routes.js");
await ensureSchema();
const api = new Hono();
mountTaskRoutes(api);
mountTaskAcceptanceRoutes(api);
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
async function changeTarget(id: string, branch: string, fingerprint?: string) {
  return api.request(`/tasks/${id}/merge-target`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ branch, fingerprint: fingerprint ?? (await readBranchPlan(id))!.task.fingerprint }) });
}

try {
  {
    const repo = await repository("retarget");
    git(repo, "branch", "feature-x");
    const task = await create("retarget", { worktreeBase: "feature-x" });
    const ws = await taskWorkspace(task, repo);
    const source = commit(ws.path, "retarget.txt");
    const start = task.worktreeStartCommit;
    git(repo, "branch", "-D", "feature-x");
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, task.id));
    assert.match((await readBranchPlan(task.id))!.task.blocker!, /feature-x 不存在/);
    const failed = await acceptTask(task.id);
    assert.equal(failed.accepted, false);
    if (!failed.accepted) assert.equal(failed.reason, "target_branch_missing");
    assert.equal((await row(task.id)).acceptedTargetBranch, "feature-x");
    assert.equal((await changeTarget(task.id, "main", "stale")).status, 409);
    assert.equal((await changeTarget(task.id, "missing-target")).status, 400);
    assert.equal((await changeTarget(task.id, ws.branch!)).status, 400);
    for (const state of [{ status: "running" }, { status: "done", baseUpdateIntent: "pending" }, { baseUpdateIntent: null, archived: true }, { archived: false, stage: "merged" }]) {
      await db.update(tasks).set(state).where(eq(tasks.id, task.id));
      assert.equal((await changeTarget(task.id, "main")).status, 409);
    }
    await db.update(tasks).set({ stage: null }).where(eq(tasks.id, task.id));
    assert.equal((await changeTarget(task.id, "main")).status, 200);
    const changed = await row(task.id);
    assert.equal(changed.mergeTargetBranch, "main");
    assert.equal(changed.acceptedTargetBranch, null);
    assert.equal(changed.worktreeStartCommit, start);
    assert.equal(git(repo, "rev-parse", baseRef(task.id)), start);
    assert.equal(git(ws.path, "rev-parse", "HEAD"), source);
    assert.equal((await acceptTask(task.id)).accepted, true);
    assert.equal((await changeTarget(task.id, "main")).status, 409);
    console.log("✓ deleted target can be reset and accepted without changing source/start; stale, busy, pending, archived and merged changes rejected");
  }
  {
    const repo = await repository("detached-family");
    git(repo, "checkout", "--detach", "HEAD");
    const parent = await create("detached-family");
    const pws = await taskWorkspace(parent, repo);
    commit(pws.path, "parent-feature.txt");
    const child = await create("detached-family", { worktreeBase: pws.branch });
    const cws = await taskWorkspace(child, repo);
    commit(cws.path, "child-feature.txt");
    for (const task of [parent, child]) await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, task.id));
    assert.equal(child.baseTaskId, parent.id);
    assert.equal(child.mergeTargetBranch, null);
    assert.equal((await readBranchPlan(child.id))!.task.targetBranch, null, "parent branch is never substituted for unresolved final target");
    assert.equal((await branchDependency(await row(child.id), repo))?.state, "unknown");
    const blocked = await acceptTask(child.id);
    assert.equal(blocked.accepted, false);
    if (!blocked.accepted) assert.equal(blocked.reason, "base_unknown");
    assert.equal((await row(child.id)).acceptedTargetBranch, null);
    assert.equal((await changeTarget(parent.id, "main")).status, 200);
    assert.equal((await changeTarget(child.id, "main")).status, 200);
    assert.equal((await branchDependency(await row(child.id), repo))?.state, "waiting");
    assert.equal((await acceptTask(parent.id)).accepted, true);
    assert.equal((await branchDependency(await row(child.id), repo))?.state, "ready");
    assert.equal((await api.request(`/tasks/${parent.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await acceptTask(child.id)).accepted, true);
    assert.equal(git(repo, "show", "main:child-feature.txt"), "child-feature.txt");
    console.log("✓ detached derived task blocks safely, target selection restores dependency checks and parent cleanup");
  }
  {
    await repository("invalid-target");
    const response = await api.request("/tasks", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "invalid-target", title: "typo", useWorktree: true, mergeTargetBranch: "typo-branch" }) });
    assert.equal(response.status, 400);
    assert.match(response.headers.get("content-type")!, /application\/json/);
    assert.match((await response.json()).error, /typo-branch 不存在/);
    assert.equal((await db.select().from(tasks).where(eq(tasks.projectId, "invalid-target"))).length, 0);
    console.log("✓ explicit nonexistent merge target is rejected as actionable JSON before creating a task");
  }
  {
    const repo = await repository("recover-pinned");
    const task = await create("recover-pinned");
    const ws = await taskWorkspace(task, repo);
    const head = commit(ws.path, "preserved.txt");
    await db.update(tasks).set({ worktreeStartCommit: "f".repeat(40) }).where(eq(tasks.id, task.id));
    assert.equal((await taskWorkspace(await row(task.id), repo)).path, ws.path, "existing checkout is reusable without reading old start");
    git(repo, "worktree", "remove", ws.path);
    const restored = await taskWorkspace(await row(task.id), repo);
    assert.equal(git(restored.path, "rev-parse", "HEAD"), head);
    assert.equal(existsSync(join(restored.path, "preserved.txt")), true);
    git(repo, "worktree", "remove", restored.path);
    git(repo, "branch", "-D", restored.branch!);
    await assert.rejects(async () => taskWorkspace(await row(task.id), repo), /记录的开工提交不可读/);
    console.log("✓ unreadable pinned start permits reuse/restore but cannot rebuild from a different commit");
  }
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
    const explicit = await create("stale", { worktreeBase: "gone-again", mergeTargetBranch: "refs/heads/main" });
    const explicitWs = await taskWorkspace(explicit, repo);
    commit(explicitWs.path, "explicit-target.txt");
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, explicit.id));
    assert.equal((await acceptTask(explicit.id)).accepted, true, "lazy starts still normalize explicit refs/heads targets");
    console.log("✓ stale base keeps the existing runtime fallback and can be accepted");
  }
  {
    // repoPath 是带 `~` 存进库的（normalizeRepoPathForStorage 有意保留），验收链路上每个
    // 拿它跑 git 的地方都必须自己展开：漏一个，`git -C '~/x'` 直接 fatal，catch 一吞就
    // 变成「目标本地分支 main 不存在」，整个项目的任务都验收不了。
    const home = join(root, "tilde-home");
    const repo = join(home, "repo");
    execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
    git(repo, "config", "user.name", "Branch Test");
    git(repo, "config", "user.email", "branch@example.test");
    commit(repo, "seed.txt");
    await db.insert(projects).values({ id: "tilde", name: "tilde", repoPath: "~/repo", createdAt: at });
    const realHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const task = await create("tilde");
      const ws = await taskWorkspace(task, "~/repo");
      commit(ws.path, "tilde.txt");
      await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, task.id));
      const plan = (await readBranchPlan(task.id))!.task;
      assert.equal(plan.targetBranch, "main");
      assert.equal(plan.blocker, null, "带 ~ 的仓库路径不能被读成「目标分支不存在」");
      assert.equal((await acceptTask(task.id)).accepted, true);
      assert.equal(git(repo, "show", "main:tilde.txt"), "tilde.txt");
    } finally {
      if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    }
    console.log("✓ repoPath stored with ~ resolves for the branch plan and merges on acceptance");
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
