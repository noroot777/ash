import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { makeStep } from "@ash/shared/workflow";
import { familyAcceptanceNotices } from "@ash/shared/branch-plan";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-branch-acceptance-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const { db, ensureSchema, dbClient } = await import("../src/db/index.js");
const { tasks, projects } = await import("../src/db/schema.js");
const { createTasks } = await import("../src/task-store.js");
const { taskWorkspace } = await import("../src/task-workspace.js");
const { acceptTask, mountTaskAcceptanceRoutes } = await import("../src/task-accept.js");
const { mountTaskRoutes } = await import("../src/task-routes.js");
const { mountTaskDiffRoutes } = await import("../src/task-diff-routes.js");
const { mountTaskScheduleRoutes } = await import("../src/task-schedule-routes.js");
const { mountProjectRoutes } = await import("../src/project-routes.js");
const { branchDependency, branchDeletionBlock, dependentTasks } = await import("../src/task-branch-plan.js");
const { readBranchPlan, acceptFamily } = await import("../src/task-branch-routes.js");
const { updateTaskBase } = await import("../src/task-base-update.js");
const { claimTurn, releaseTurn } = await import("../src/runs.js");
await ensureSchema();
const api = new Hono();
if (process.argv.includes("--serve")) {
  api.post("/tasks/:id/accept", async c => {
    const result = await acceptTask(c.req.param("id"), "human", { startVerifyRound: async () => ({ round: 1 }) });
    return c.json(result, result.accepted ? 200 : result.httpStatus);
  });
  api.get("/executors", c => c.json([]));
}
mountTaskRoutes(api);
mountTaskAcceptanceRoutes(api);
mountTaskDiffRoutes(api);
mountTaskScheduleRoutes(api);
mountProjectRoutes(api);
let sequence = 0;
const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0];
const commit = (path: string, file: string, value: string) => {
  writeFileSync(join(path, file), value);
  git(path, "add", "--", file);
  git(path, "commit", "-m", file);
  return git(path, "rev-parse", "HEAD");
};
async function setup(strategy: "safe" | "squash" | "tag" = "safe") {
  const key = `case${++sequence}`;
  const repo = join(root, key);
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, "config", "user.name", "Branch Test");
  git(repo, "config", "user.email", "branch@example.test");
  commit(repo, ".gitignore", ".worktrees/\n");
  commit(repo, "shared.txt", "seed\n");
  const at = new Date().toISOString();
  await db.insert(projects).values({ id: key, name: key, repoPath: repo, createdAt: at });
  const accept = makeStep("accept", "accept");
  if (accept.kind === "accept") accept.p = { strategy, clean: "all" };
  const workflow = JSON.stringify({ workspace: "isolated", steps: [makeStep("run", "run"), makeStep("human", "human"), accept] });
  const newTask = async (suffix: string, base: string | null) => {
    const id = `${key}-${suffix}`;
    const [created] = await createTasks([{
      id, projectId: key, title: id, body: "test", mode: "single", status: "done",
      createdAt: at, updatedAt: at, useWorktree: true, worktreeBase: base,
      workflow, workflowAt: "human",
    }]);
    return created;
  };
  const parent = await newTask("parent", "main");
  const parentWs = await taskWorkspace(await row(parent.id), repo);
  const parentCommit = commit(parentWs.path, "parent.txt", "parent feature\n");
  const child = await newTask("child", parentWs.branch);
  // The child's own acceptance uses safe; only the parent strategy varies.
  await db.update(tasks).set({ workflow: null, workflowMode: "free" }).where(eq(tasks.id, child.id));
  const childWs = await taskWorkspace(await row(child.id), repo);
  commit(childWs.path, "child.txt", "child feature\n");
  return { repo, parent, child, parentWs, childWs, parentCommit, newTask };
}

try {
  if (process.argv.includes("--serve")) {
    const s = await setup();
    const grand = await s.newTask("grand", s.childWs.branch);
    await db.update(tasks).set({ workflow: null, workflowMode: "free" }).where(eq(tasks.id, grand.id));
    const grandWs = await taskWorkspace(await row(grand.id), s.repo);
    commit(grandWs.path, "grand.txt", "grandchild\n");
    const squash = await setup("squash");
    await acceptTask(squash.parent.id);
    await setup("squash");
    const missing = await setup();
    git(missing.repo, "branch", "-m", "main", "renamed-main");
    const mid = await setup();
    const workflow = JSON.stringify({ workspace: "isolated", steps: [
      makeStep("run", "run"), makeStep("human", "human"), makeStep("verify", "verify2"),
      makeStep("human", "human2"), makeStep("accept", "accept"),
    ] });
    for (const task of [mid.parent, mid.child]) {
      await db.update(tasks).set({ workflow, workflowMode: "preset", workflowAt: "human", stage: "awaiting_acceptance" })
        .where(eq(tasks.id, task.id));
    }
    const legacy = await setup();
    await db.update(tasks).set({ mergeTargetBranch: null, worktreeStartCommit: null, baseTaskId: null }).where(eq(tasks.id, legacy.child.id));
    await s.newTask("unstarted", "main");
    const unreadable = await s.newTask("badstart", "main");
    await taskWorkspace(await row(unreadable.id), s.repo);
    await db.update(tasks).set({ worktreeStartCommit: "0".repeat(40) }).where(eq(tasks.id, unreadable.id));
    const { serve } = await import("@hono/node-server");
    const backend = serve({ fetch: new Hono().route("/api", api).fetch, hostname: "127.0.0.1", port: 0 });
    if (!backend.listening) await new Promise<void>(resolve => backend.once("listening", resolve));
    const address = backend.address();
    assert.ok(address && typeof address === "object");
    const { createServer } = await import("vite");
    const frontend = await createServer({ root: join(process.cwd(), "web"), logLevel: "error",
      server: { host: "127.0.0.1", port: 0, proxy: { "/api": `http://127.0.0.1:${address.port}` } } });
    await frontend.listen();
    const webAddress = frontend.httpServer!.address();
    assert.ok(webAddress && typeof webAddress === "object");
    console.log(JSON.stringify({ pid: process.pid, root, url: `http://127.0.0.1:${webAddress.port}/scripts/fixtures/branch-acceptance.html?task=${s.parent.id}`, child: s.child.id, squashChild: squash.child.id }));
    await new Promise<void>(resolve => {
      process.once("SIGTERM", resolve); process.once("SIGINT", resolve);
      process.on("message", message => { if (message === "close-fixture") resolve(); });
    });
    await frontend.close();
    await new Promise<void>(resolve => backend.close(() => resolve()));
    if (process.connected) process.disconnect();
  } else {
  {
    const s = await setup();
    const task = await s.newTask("unstarted", "main");
    assert.ok(task.worktreeStartCommit);
    const checkDiff = async (reason: string | null) => {
      for (const endpoint of ["diff", "diff/file?path=shared.txt"]) {
        const response = await api.request(`/tasks/${task.id}/${endpoint}`);
        assert.equal(response.status, 200);
        const result = await response.json();
        assert.equal(result.available, reason === null);
        assert.equal(result.reason ?? null, reason);
        assert.equal(result.error, undefined);
      }
    };
    await checkDiff("source_branch_missing");
    await taskWorkspace(await row(task.id), s.repo);
    await checkDiff(null);
    git(s.repo, "branch", "-m", "main", "renamed-main");
    await checkDiff(null);
    await db.update(tasks).set({ worktreeStartCommit: "0".repeat(40) }).where(eq(tasks.id, task.id));
    await checkDiff("start_commit_unreadable");
    assert.equal((await api.request(`/tasks/${task.id}/diff/file?path=../shared.txt`)).status, 400);
    await db.update(tasks).set({ worktreeStartCommit: null }).where(eq(tasks.id, task.id));
    await checkDiff("target_branch_missing");
    console.log("✓ unstarted and unreadable pinned diff ranges return matching structured results; pinned diffs survive target rename");
  }
  {
    const s = await setup("squash");
    const plan = (await readBranchPlan(s.parent.id))!;
    const entries = [plan.task, ...plan.descendants];
    const notices = familyAcceptanceNotices(entries);
    assert.equal(notices.length, 1);
    assert.match(notices[0], /本次只能先合入父任务/);
    assert.ok(notices[0].includes(s.child.title));
    const accepted = await acceptFamily(s.parent.id, entries, acceptTask);
    assert.equal(accepted.ok, false);
    assert.deepEqual(accepted.completed, [s.parent.id]);
    assert.equal(accepted.stoppedAt, s.child.id);
    assert.equal((await updateTaskBase(s.child.id, git(s.childWs.path, "rev-parse", "HEAD"))).ok, true);
    assert.equal((await acceptTask(s.child.id)).accepted, true);
    console.log("✓ squash family notice predicts the pause, and baseline update permits child acceptance");
  }
  {
    const s = await setup();
    await db.update(tasks).set({ mergeTargetBranch: null, worktreeStartCommit: null, baseTaskId: null }).where(eq(tasks.id, s.child.id));
    const view = (await readBranchPlan(s.parent.id))!;
    assert.deepEqual(view.descendants.map(t => t.taskId), (await dependentTasks(s.repo, s.parent.projectId, s.parent.id)).map(t => t.id));
    assert.equal(view.descendants[0].targetBranch, s.parentWs.branch);
    assert.equal(view.descendants[0].dependency?.taskId, s.parent.id);
    assert.equal(view.descendants[0].dependency?.legacyTarget, true);
    assert.equal(view.descendants[0].startCommit, null);
    assert.equal((await readBranchPlan(s.child.id))!.task.dependency?.legacyTarget, true);
    const family = await acceptFamily(s.parent.id, [view.task, ...view.descendants], acceptTask);
    assert.equal(family.ok, false);
    assert.deepEqual(family.completed, []);
    assert.match(family.error!, /先单独处理并验收子任务/);
    assert.equal(git(s.repo, "rev-parse", s.parentWs.branch!), s.parentCommit);
    const acceptBefore = await acceptTask(s.child.id);
    assert.equal(acceptBefore.accepted, false);
    if (!acceptBefore.accepted) assert.equal(acceptBefore.reason, "target_checked_out");
    const discard = (branch = false) => api.request(`/projects/${s.parent.projectId}/workspaces/discard`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: s.parent.id, worktree: true, branch }),
    });
    assert.equal((await discard(true)).status, 409);
    assert.equal((await api.request(`/tasks/${s.parent.id}?worktree=1&branch=0`, { method: "DELETE" })).status, 409, "record deletion still removes dependency receipts");
    await db.update(tasks).set({ baseUpdateIntent: "pending" }).where(eq(tasks.id, s.parent.id));
    assert.equal((await discard()).status, 409, "directory cleanup preserves pending baseline recovery");
    await db.update(tasks).set({ baseUpdateIntent: null, status: "running" }).where(eq(tasks.id, s.parent.id));
    assert.equal((await discard()).status, 409, "directory cleanup preserves busy protection");
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, s.parent.id));
    const response = await discard();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).worktreeRemoved, true);
    assert.ok(await row(s.parent.id));
    assert.equal(git(s.repo, "rev-parse", s.parentWs.branch!), s.parentCommit);
    assert.equal((await acceptTask(s.child.id)).accepted, true);
    assert.equal((await acceptTask(s.parent.id)).accepted, true);
    assert.equal(git(s.repo, "show", "main:child.txt"), "child feature");
    console.log("✓ legacy child accepts after directory-only cleanup; record/ref, busy and pending-update protections remain");
  }
  {
    const s = await setup();
    const grand = await s.newTask("grand", s.childWs.branch);
    const legacyBranch = s.parentWs.branch!.replace(/^ash\//, "harness/");
    git(s.parentWs.path, "branch", "-m", legacyBranch);
    await db.update(tasks).set({ baseTaskId: null, worktreeStartCommit: null, mergeTargetBranch: null, worktreeBase: `refs/heads/${legacyBranch}` }).where(eq(tasks.id, s.child.id));
    await db.update(tasks).set({ baseTaskId: null, worktreeStartCommit: null, mergeTargetBranch: null, worktreeBase: "main", acceptedTargetBranch: s.childWs.branch, archived: true }).where(eq(tasks.id, grand.id));
    const view = (await readBranchPlan(s.parent.id))!;
    assert.deepEqual(view.descendants.map(t => t.taskId), [s.child.id, grand.id]);
    assert.equal(view.descendants[1].dependency?.taskId, s.child.id);
    assert.ok(view.descendants[1].blocker);
    assert.deepEqual((await dependentTasks(s.repo, s.parent.projectId, s.parent.id)).map(t => t.id), [s.child.id]);
    assert.deepEqual((await dependentTasks(s.repo, s.parent.projectId, s.child.id)).map(t => t.id), [grand.id]);
    console.log("✓ legacy refs/heads and harness branches, accepted target fallback and archived descendants stay visible");
  }
  {
    const s = await setup();
    await db.update(tasks).set({ archived: true, status: "canceled" }).where(eq(tasks.id, s.child.id));
    const response = await api.request(`/tasks/${s.parent.id}`, { method: "DELETE" });
    assert.equal(response.status, 409);
    const { error } = await response.json();
    assert.ok(error.includes(s.child.title));
    assert.match(error, /已归档，可在归档列表中处理/);
    console.log("✓ archived canceled dependency is protected and its archive location is explained");
  }
  {
    const s = await setup();
    const grand = await s.newTask("grand", s.childWs.branch);
    await db.update(tasks).set({ workflow: null, workflowMode: "free" }).where(eq(tasks.id, grand.id));
    const ws = await taskWorkspace(await row(grand.id), s.repo);
    commit(ws.path, "grand.txt", "grandchild\n");
    const view = (await readBranchPlan(s.parent.id))!;
    const entries = [view.task, ...view.descendants];
    const main = git(s.repo, "rev-parse", "main");
    const result = await acceptFamily(s.parent.id, entries.filter(e => e.taskId !== s.child.id), acceptTask);
    assert.equal(result.ok, false);
    assert.deepEqual(result.completed, []);
    assert.equal(result.stoppedAt, grand.id);
    assert.match(result.error!, /未勾选的父任务/);
    assert.equal(git(s.repo, "rev-parse", "main"), main);
    assert.notEqual((await row(s.parent.id)).stage, "accepted");
    const complete = await acceptFamily(s.parent.id, entries, acceptTask);
    assert.equal(complete.ok, true, complete.error);
    assert.deepEqual(complete.completed, [s.parent.id, s.child.id, grand.id]);
    console.log("✓ omitted intermediate ancestor is rejected before any merge; complete selection accepts all three");
  }
  {
    const s = await setup();
    assert.equal((await row(s.child.id)).mergeTargetBranch, "main");
    assert.equal((await row(s.child.id)).worktreeStartCommit, s.parentCommit);
    assert.equal((await row(s.child.id)).baseTaskId, s.parent.id);
    const diff = await (await api.request(`/tasks/${s.child.id}/diff`)).json();
    assert.deepEqual(diff.files.map((f: { path: string }) => f.path), ["child.txt"]);
    const blocked = await acceptTask(s.child.id);
    assert.equal(blocked.accepted, false);
    if (!blocked.accepted) assert.equal(blocked.reason, "base_waiting");
    assert.equal((await row(s.child.id)).acceptedTargetBranch, null, "waiting must not freeze an obsolete target");
    const deletion = await api.request(`/tasks/${s.parent.id}?worktree=1&branch=1&force=1`, { method: "DELETE" });
    assert.equal(deletion.status, 409);
    assert.equal(existsSync(s.parentWs.path), true);
    assert.equal((await acceptTask(s.parent.id)).accepted, true);
    assert.equal(existsSync(s.parentWs.path), false);
    assert.equal((await branchDependency(await row(s.child.id), s.repo))?.state, "ready");
    assert.equal((await api.request(`/tasks/${s.parent.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await acceptTask(s.child.id)).accepted, true);
    assert.equal(git(s.repo, "show", "main:child.txt"), "child feature");
    console.log("✓ parent checkout, deletion protection, parent cleanup and independent child acceptance");
  }
  {
    const s = await setup();
    await acceptTask(s.parent.id);
    const { reopenAcceptedStage } = await import("../src/task-stage.js");
    await reopenAcceptedStage(s.parent.id);
    git(s.repo, "gc", "--prune=now");
    const ws = await taskWorkspace(await row(s.parent.id), s.repo);
    assert.equal(git(ws.path, "show", "HEAD:parent.txt"), "parent feature");
    assert.equal((await row(s.parent.id)).worktreeStartCommit, s.parentCommit);
    commit(ws.path, "followup.txt", "next version\n");
    const diff = await (await api.request(`/tasks/${s.parent.id}/diff`)).json();
    assert.deepEqual(diff.files.map((f: { path: string }) => f.path), ["followup.txt"]);
    assert.equal((await acceptTask(s.parent.id)).accepted, true);
    assert.equal(git(s.repo, "show", "main:followup.txt"), "next version");
    const deleted = await api.request(`/tasks/${s.parent.id}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    assert.equal(git(s.repo, "for-each-ref", "--format=%(refname)", `refs/ash/task-bases/${s.parent.id}`, `refs/ash/accepted-heads/${s.parent.id}`), "");
    console.log("✓ accepted task resumes from its integrated result; deletion removes private lifecycle refs");
  }
  {
    const s = await setup();
    const late = await s.newTask("late", s.parentWs.branch);
    await acceptTask(s.parent.id);
    git(s.repo, "gc", "--prune=now");
    const ws = await taskWorkspace(await row(late.id), s.repo);
    assert.equal(git(ws.path, "rev-parse", "HEAD"), s.parentCommit);
    console.log("✓ unstarted child keeps its pinned start after parent cleanup and gc");
  }
  {
    const s = await setup("squash");
    assert.equal((await acceptTask(s.parent.id)).accepted, true);
    assert.equal((await branchDependency(await row(s.child.id), s.repo))?.state, "needs_update");
    assert.match((await branchDeletionBlock(s.repo, s.parent.id))!, /依赖/);
    const original = git(s.childWs.path, "rev-parse", "HEAD");
    writeFileSync(join(s.childWs.path, "scratch"), "draft");
    assert.equal((await updateTaskBase(s.child.id, original)).ok, false);
    rmSync(join(s.childWs.path, "scratch"));
    const release = claimTurn(s.child.id);
    assert.ok(release);
    assert.equal((await updateTaskBase(s.child.id, original)).ok, false);
    releaseTurn(s.child.id);
    assert.equal((await updateTaskBase(s.child.id, "0".repeat(40))).ok, false);
    const updated = await updateTaskBase(s.child.id, original);
    assert.equal(updated.ok, true, updated.error);
    assert.equal(git(s.childWs.path, "show", "HEAD:parent.txt"), "parent feature");
    assert.equal(git(s.childWs.path, "show", "HEAD:child.txt"), "child feature");
    assert.equal((await branchDependency(await row(s.child.id), s.repo))?.state, "ready");
    assert.equal((await row(s.child.id)).stage, null);
    assert.equal((await acceptTask(s.child.id)).accepted, true);
    console.log("✓ squash baseline update, stale-head/dirty/in-flight guards, preserved code and acceptance");
  }
  {
    const s = await setup("squash");
    git(s.repo, "merge", "--squash", s.parentWs.branch!);
    git(s.repo, "commit", "-m", "parent integrated externally");
    assert.equal((await acceptTask(s.parent.id)).accepted, true);
    assert.equal((await row(s.parent.id)).acceptedBaseCommit, null);
    assert.equal((await row(s.parent.id)).acceptedMergeCommit, git(s.repo, "rev-parse", "main"));
    assert.equal((await branchDependency(await row(s.child.id), s.repo))?.state, "needs_update");
    assert.equal((await updateTaskBase(s.child.id, git(s.childWs.path, "rev-parse", "HEAD"))).ok, true);
    console.log("✓ already-squashed parent records merge evidence even when acceptance does not move target");
  }
  {
    const s = await setup("squash");
    commit(s.parentWs.path, "parent.txt", "parent version two\n");
    git(s.childWs.path, "merge", "--no-edit", s.parentWs.branch!);
    assert.equal((await branchDependency(await row(s.child.id), s.repo))?.state, "waiting");
    assert.equal((await acceptTask(s.parent.id)).accepted, true);
    git(s.repo, "config", "rebase.updateRefs", "true");
    const parentHead = git(s.repo, "rev-parse", s.parentWs.branch!);
    const updated = await updateTaskBase(s.child.id, git(s.childWs.path, "rev-parse", "HEAD"));
    assert.equal(updated.ok, true, updated.error);
    assert.equal(git(s.childWs.path, "show", "HEAD:parent.txt"), "parent version two");
    assert.equal(git(s.childWs.path, "show", "HEAD:child.txt"), "child feature");
    assert.equal(git(s.repo, "rev-parse", s.parentWs.branch!), parentHead);
    assert.equal(git(s.childWs.path, "rev-list", "--count", "main..HEAD"), "1", "inherited parent updates must not be replayed as child work");
    console.log("✓ rebasing a child that pulled newer parent commits preserves only its own delta");
  }
  {
    const s = await setup("squash");
    commit(s.childWs.path, "shared.txt", "child change\n");
    commit(s.parentWs.path, "shared.txt", "parent change\n");
    assert.equal((await acceptTask(s.parent.id)).accepted, true);
    const before = git(s.childWs.path, "rev-parse", "HEAD");
    assert.equal((await updateTaskBase(s.child.id, before)).ok, false);
    assert.equal(git(s.childWs.path, "rev-parse", "HEAD"), before);
    assert.equal(git(s.childWs.path, "status", "--porcelain"), "");
    assert.equal(git(s.repo, "worktree", "list").includes("ash-base-update-"), false);
    console.log("✓ failed rebase preserves child and cleans temporary checkout");
  }
  {
    const s = await setup("tag");
    const main = git(s.repo, "rev-parse", "main");
    assert.equal((await acceptTask(s.parent.id)).accepted, true);
    assert.equal(git(s.repo, "rev-parse", "main"), main);
    assert.equal((await branchDependency(await row(s.child.id), s.repo))?.state, "waiting");
    assert.equal((await updateTaskBase(s.child.id, git(s.childWs.path, "rev-parse", "HEAD"))).ok, false);
    console.log("✓ tag keeps child waiting, cannot pretend parent code was integrated");
  }
  {
    const s = await setup("squash");
    const grandchild = await s.newTask("grand", s.childWs.branch);
    await db.update(tasks).set({ workflow: null, workflowMode: "free" }).where(eq(tasks.id, grandchild.id));
    const grandWs = await taskWorkspace(await row(grandchild.id), s.repo);
    commit(grandWs.path, "grand.txt", "grandchild\n");
    await acceptTask(s.parent.id);
    const { reopenAcceptedStage } = await import("../src/task-stage.js");
    await reopenAcceptedStage(s.parent.id);
    assert.equal((await branchDependency(await row(s.child.id), s.repo))?.state, "needs_update", "parent follow-up retains old merge evidence");
    assert.equal((await updateTaskBase(s.child.id, git(s.childWs.path, "rev-parse", "HEAD"))).ok, true);
    assert.equal((await acceptTask(s.child.id)).accepted, true);
    assert.equal((await branchDependency(await row(grandchild.id), s.repo))?.state, "needs_update");
    assert.equal((await updateTaskBase(grandchild.id, git(grandWs.path, "rev-parse", "HEAD"))).ok, true);
    assert.equal((await acceptTask(grandchild.id)).accepted, true);
    assert.equal(git(s.repo, "show", "main:grand.txt"), "grandchild");
    console.log("✓ parent follow-up preserves receipt; grandchild follows rewritten parent history");
  }
  {
    const s = await setup("squash");
    await acceptTask(s.parent.id);
    await dbClient.execute(`CREATE TRIGGER fail_base_finish BEFORE UPDATE ON tasks WHEN OLD.id='${s.child.id}' AND OLD.base_update_intent IS NOT NULL AND NEW.base_update_intent IS NULL BEGIN SELECT RAISE(ABORT, 'injected base finish failure'); END`);
    const oldHead = git(s.childWs.path, "rev-parse", "HEAD");
    await assert.rejects(() => updateTaskBase(s.child.id, oldHead), /injected base finish failure/);
    const newHead = git(s.childWs.path, "rev-parse", "HEAD");
    assert.notEqual(newHead, oldHead);
    assert.ok((await row(s.child.id)).baseUpdateIntent);
    const blocked = await acceptTask(s.child.id);
    assert.equal(blocked.accepted, false);
    if (!blocked.accepted) assert.equal(blocked.reason, "base_update_pending");
    await dbClient.execute("DROP TRIGGER fail_base_finish");
    assert.equal((await updateTaskBase(s.child.id, newHead)).ok, true);
    assert.equal(git(s.childWs.path, "rev-parse", "HEAD"), newHead, "recovery must not rebase again");
    assert.equal((await row(s.child.id)).baseUpdateIntent, null);
    assert.equal((await acceptTask(s.child.id)).accepted, true);
    console.log("✓ Git-success/DB-failure recovers the durable baseline intent without repeating rebase");
  }
  {
    const s = await setup();
    await db.update(tasks).set({ status: "paused" }).where(eq(tasks.id, s.parent.id));
    const view = (await readBranchPlan(s.parent.id))!;
    assert.equal(view.task.blocker, null, "a preset task at its final human gate can be accepted");
    const expected = [view.task, ...view.descendants].map(t => ({ taskId: t.taskId, fingerprint: t.fingerprint }));
    const result = await acceptFamily(s.parent.id, expected, acceptTask);
    assert.equal(result.ok, true, result.error);
    console.log("✓ family acceptance honors final human gates of preset workflows");
  }
  {
    const s = await setup();
    const view = (await readBranchPlan(s.parent.id))!;
    const expected = [view.task, ...view.descendants].map(t => ({ taskId: t.taskId, fingerprint: t.fingerprint }));
    const result = await acceptFamily(s.parent.id, expected, async id => {
      const accepted = await acceptTask(id);
      if (id === s.parent.id) await db.update(tasks).set({ mergeTargetBranch: "changed-target" }).where(eq(tasks.id, s.child.id));
      return accepted;
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.completed, [s.parent.id]);
    assert.equal(result.stoppedAt, s.child.id);
    assert.notEqual((await row(s.child.id)).stage, "accepted");
    console.log("✓ family acceptance stops when the child's confirmed plan changes during parent acceptance");
  }
  {
    const s = await setup();
    const view = (await readBranchPlan(s.parent.id))!;
    const expected = [view.task, ...view.descendants].map(t => ({ taskId: t.taskId, fingerprint: t.fingerprint }));
    const result = await acceptFamily(s.parent.id, expected, async id => {
      if (id === s.child.id) throw new Error("injected child failure");
      return acceptTask(id);
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.completed, [s.parent.id]);
    assert.equal(result.error, "injected child failure");
    console.log("✓ unexpected child failure preserves the family's partial success result");
  }
  {
    const s = await setup();
    const view = (await readBranchPlan(s.parent.id))!;
    const expected = [view.task, ...view.descendants].map(t => ({ taskId: t.taskId, fingerprint: t.fingerprint }));
    const wrong = await acceptFamily(s.parent.id, [...expected, { taskId: "foreign", fingerprint: "x" }], acceptTask);
    assert.equal(wrong.ok, false);
    assert.deepEqual(wrong.completed, []);
    const result = await acceptFamily(s.parent.id, expected, acceptTask);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.completed, [s.parent.id, s.child.id]);
    assert.equal((await acceptFamily(s.parent.id, expected, acceptTask)).ok, false);
    console.log("✓ unified acceptance order, scope validation and stale confirmation guard");
  }
  {
    const s = await setup("tag");
    const view = (await readBranchPlan(s.parent.id))!;
    const expected = [view.task, ...view.descendants].map(t => ({ taskId: t.taskId, fingerprint: t.fingerprint }));
    const result = await acceptFamily(s.parent.id, expected, acceptTask);
    assert.equal(result.ok, false);
    assert.deepEqual(result.completed, [s.parent.id]);
    assert.equal(result.stoppedAt, s.child.id);
    console.log("✓ partial family result reports accepted parent and blocked child separately");
  }
  }
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
