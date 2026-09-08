import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { makeStep } from "@ash/shared/workflow";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-base-recovery-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks } = await import("../src/db/schema.js");
const { createTasks } = await import("../src/task-store.js");
const { taskWorkspace } = await import("../src/task-workspace.js");
const { acceptTask, mountTaskAcceptanceRoutes } = await import("../src/task-accept.js");
const { mountTaskRoutes } = await import("../src/task-routes.js");
const { mountProjectRoutes } = await import("../src/project-routes.js");
const { updateTaskBase } = await import("../src/task-base-update.js");
const { baseRef, branchDependency } = await import("../src/task-branch-plan.js");
const { readBranchPlan } = await import("../src/task-branch-routes.js");
const { claimTurn, releaseTurn } = await import("../src/runs.js");
await ensureSchema();
const api = new Hono();
mountTaskRoutes(api); mountTaskAcceptanceRoutes(api); mountProjectRoutes(api);
const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0];
const post = (path: string, body: unknown) => api.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const commit = (repo: string, file: string, content: string) => {
  writeFileSync(join(repo, file), content); git(repo, "add", file); git(repo, "commit", "-m", file);
  return git(repo, "rev-parse", "HEAD");
};
let sequence = 0;
async function setup() {
  const id = `recover${++sequence}`;
  const repo = join(root, id);
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, "config", "user.name", "Recovery Test"); git(repo, "config", "user.email", "recovery@example.test");
  commit(repo, ".gitignore", ".worktrees/\n");
  const at = new Date().toISOString();
  await db.insert(projects).values({ id, name: id, repoPath: repo, createdAt: at });
  const create = async (suffix: string, base: string, strategy: "safe" | "squash") => {
    const accept = makeStep("accept", "accept");
    if (accept.kind === "accept") accept.p = { strategy, clean: "all" };
    const [task] = await createTasks([{ id: `${suffix}-${id}`, projectId: id, title: suffix, body: "test", status: "done",
      useWorktree: true, worktreeBase: base, createdAt: at, updatedAt: at, workflowAt: "human",
      workflow: JSON.stringify({ workspace: "isolated", steps: [makeStep("run", "run"), makeStep("human", "human"), accept] }) }]);
    const ws = await taskWorkspace(task, repo);
    commit(ws.path, `${suffix}.txt`, suffix);
    return { task, ...ws };
  };
  const parent = await create("parent", "main", "squash");
  const child = await create("child", parent.branch!, "safe");
  return { id, repo, parent, child };
}

try {
  for (const mode of ["missing-worktree", "head-advanced"] as const) {
    const s = await setup();
    assert.equal((await acceptTask(s.parent.task.id)).accepted, true);
    const original = await row(s.child.task.id);
    const oldHead = git(s.repo, "rev-parse", s.child.branch!);
    await dbClient.execute(`CREATE TRIGGER interrupt_base BEFORE UPDATE ON tasks WHEN OLD.id='${s.child.task.id}' AND OLD.base_update_intent IS NOT NULL AND NEW.base_update_intent IS NULL BEGIN SELECT RAISE(ABORT, 'interrupted base update'); END`);
    await assert.rejects(() => updateTaskBase(s.child.task.id, oldHead), /interrupted base update/);
    await dbClient.execute("DROP TRIGGER interrupt_base");
    const intent = JSON.parse((await row(s.child.task.id)).baseUpdateIntent!);
    if (mode === "missing-worktree") rmSync(s.child.path, { recursive: true });
    else commit(s.child.path, "after-crash.txt", "new work after crash");
    const current = git(s.repo, "rev-parse", s.child.branch!);
    const retry = await post(`/tasks/${s.child.task.id}/update-base`, { sourceCommit: current });
    assert.equal(retry.status, 409);
    assert.match((await retry.json()).error, /工作区已变化|子分支已被其它操作修改/);
    const deletion = await api.request(`/tasks/${s.child.task.id}`, { method: "DELETE" });
    assert.equal(deletion.status, 409);
    assert.equal((await deletion.json()).reason, "base_update_pending");
    const discard = await post(`/projects/${s.id}/workspaces/discard`, { taskId: s.child.task.id });
    assert.equal(discard.status, 409);
    assert.equal((await discard.json()).reason, "base_update_pending");
    const before = await (await api.request(`/tasks/${s.child.task.id}/base-update-recovery`)).json();
    assert.equal(before.oldCommit, oldHead);
    assert.equal(before.preparedCommit, intent.rebased);
    const cancel = (fingerprint: string) => post(`/tasks/${s.child.task.id}/abandon-base-update`, { fingerprint });
    for (const changed of [{ status: "running" as const }, { status: "done" as const, archived: true }]) {
      await db.update(tasks).set(changed).where(eq(tasks.id, s.child.task.id));
      assert.equal((await cancel(before.fingerprint)).status, 409);
      assert.ok((await row(s.child.task.id)).baseUpdateIntent);
    }
    await db.update(tasks).set({ status: "done", archived: false }).where(eq(tasks.id, s.child.task.id));
    assert.equal(claimTurn(s.child.task.id), true);
    assert.equal((await cancel(before.fingerprint)).status, 409);
    releaseTurn(s.child.task.id);
    if (mode === "head-advanced") {
      commit(s.child.path, "newer.txt", "newer committed work");
      assert.equal((await cancel(before.fingerprint)).status, 409, "stale confirmation cannot discard a changed intent/branch view");
      writeFileSync(join(s.child.path, "WIP.txt"), "uncommitted work");
    }
    const view = await (await api.request(`/tasks/${s.child.task.id}/base-update-recovery`)).json();
    const currentHead = git(s.repo, "rev-parse", s.child.branch!);
    const result = await cancel(view.fingerprint);
    assert.equal(result.status, 200, JSON.stringify(await result.json()));
    assert.equal((await row(s.child.task.id)).baseUpdateIntent, null);
    assert.equal((await row(s.child.task.id)).worktreeStartCommit, original.worktreeStartCommit);
    assert.equal(git(s.repo, "rev-parse", baseRef(s.child.task.id)), original.worktreeStartCommit);
    assert.equal(git(s.repo, "rev-parse", s.child.branch!), currentHead);
    assert.equal(git(s.repo, "rev-parse", intent.backup), oldHead);
    for (const backup of view.backups) assert.equal(git(s.repo, "rev-parse", backup.ref), backup.commit);
    if (mode === "head-advanced") assert.equal(readFileSync(join(s.child.path, "WIP.txt"), "utf8"), "uncommitted work");
    else assert.equal(existsSync(s.child.path), false);
    assert.equal((await readBranchPlan(s.child.task.id))!.task.baseUpdatePending, false);
    const plan = (await readBranchPlan(s.child.task.id))!.task;
    assert.equal((await post(`/tasks/${s.child.task.id}/merge-target`, { branch: s.parent.branch, fingerprint: plan.fingerprint })).status, 200);
    assert.equal((await api.request(`/tasks/${s.child.task.id}`, { method: "DELETE" })).status, 200, "ordinary deletion is available after explicit abandonment");
    console.log(`✓ ${mode}: real interrupted update can be abandoned; current work, start and recovery commits preserved; stale/busy/archived guards and exits work`);
  }
  {
    const s = await setup();
    await db.update(tasks).set({ mergeTargetBranch: s.parent.branch }).where(eq(tasks.id, s.child.task.id));
    const occupied = await acceptTask(s.child.task.id);
    assert.equal(occupied.accepted, false);
    if (!occupied.accepted) {
      assert.equal(occupied.reason, "target_checked_out");
      assert.match(occupied.error, /占用者是任务/);
      assert.doesNotMatch(occupied.error, /。；/);
    }
    await db.update(tasks).set({ mergeTargetBranch: "main" }).where(eq(tasks.id, s.child.task.id));
    await db.delete(tasks).where(eq(tasks.id, s.parent.task.id));
    const child = await row(s.child.task.id);
    const dep = await branchDependency(child, s.repo);
    assert.equal(dep?.state, "unknown");
    assert.match(dep!.message, /重设合入目标.*已包含继承提交/);
    assert.doesNotMatch(dep!.message, /核对并更新子分支/);
    const rejected = await updateTaskBase(child.id, git(s.repo, "rev-parse", s.child.branch!));
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error, dep!.message);
    git(s.repo, "branch", "imported-parent", s.parent.branch!);
    const plan = (await readBranchPlan(child.id))!.task;
    assert.equal((await post(`/tasks/${child.id}/merge-target`, { branch: "imported-parent", fingerprint: plan.fingerprint })).status, 200);
    assert.equal((await branchDependency(await row(child.id), s.repo))?.state, "ready");
    assert.equal((await acceptTask(child.id)).accepted, true);
    console.log("✓ missing parent record: suggested retargeting is executable and leads to successful acceptance");
  }
} finally {
  await releaseTmpDb(); rmSync(root, { recursive: true, force: true });
}
