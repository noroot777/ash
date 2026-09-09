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
const { projects, tasks, taskBranchReceipts } = await import("../src/db/schema.js");
const { createTasks } = await import("../src/task-store.js");
const { taskWorkspace } = await import("../src/task-workspace.js");
const { acceptTask, mountTaskAcceptanceRoutes } = await import("../src/task-accept.js");
const { mountTaskRoutes } = await import("../src/task-routes.js");
const { mountProjectRoutes } = await import("../src/project-routes.js");
const { mountTaskDiffRoutes } = await import("../src/task-diff-routes.js");
const { updateTaskBase } = await import("../src/task-base-update.js");
const { baseRef, branchDependency } = await import("../src/task-branch-plan.js");
const { readBranchPlan } = await import("../src/task-branch-routes.js");
const { claimTurn, releaseTurn } = await import("../src/runs.js");
await ensureSchema();
const api = new Hono();
mountTaskRoutes(api); mountTaskAcceptanceRoutes(api); mountProjectRoutes(api); mountTaskDiffRoutes(api);
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
  for (const mode of ["before-reset", "prepared", "missing-worktree", "head-advanced", "missing-start", "unreadable-start"] as const) {
    const s = await setup();
    assert.equal((await acceptTask(s.parent.task.id)).accepted, true);
    commit(s.repo, "unrelated-main.txt", "another task's change");
    const original = await row(s.child.task.id);
    const oldHead = git(s.repo, "rev-parse", s.child.branch!);
    await dbClient.execute(`CREATE TRIGGER interrupt_base BEFORE UPDATE ON tasks WHEN OLD.id='${s.child.task.id}' AND OLD.base_update_intent IS NOT NULL AND NEW.base_update_intent IS NULL BEGIN SELECT RAISE(ABORT, 'interrupted base update'); END`);
    await assert.rejects(() => updateTaskBase(s.child.task.id, oldHead), /interrupted base update/);
    await dbClient.execute("DROP TRIGGER interrupt_base");
    const intent = JSON.parse((await row(s.child.task.id)).baseUpdateIntent!);
    assert.equal((await db.select().from(taskBranchReceipts).where(eq(taskBranchReceipts.taskId, s.child.task.id))).length, 0,
      "the receipt and start metadata roll back together when completion is interrupted");
    if (mode === "missing-worktree") rmSync(s.child.path, { recursive: true });
    if (mode === "head-advanced") commit(s.child.path, "after-crash.txt", "new work after crash");
    if (mode === "before-reset") git(s.child.path, "reset", "--hard", oldHead);
    if (mode === "missing-start" || mode === "unreadable-start") {
      await db.update(tasks).set({ worktreeStartCommit: mode === "missing-start" ? null : "a".repeat(40) }).where(eq(tasks.id, s.child.task.id));
    }
    const current = git(s.repo, "rev-parse", s.child.branch!);
    if (mode === "missing-worktree" || mode === "head-advanced") {
      const retry = await post(`/tasks/${s.child.task.id}/update-base`, { sourceCommit: current });
      assert.equal(retry.status, 409);
      assert.match((await retry.json()).error, /工作区已变化|子分支已被其它操作修改/);
    }
    if (mode !== "before-reset" && !mode.endsWith("start")) {
      const brokenDiff = await (await api.request(`/tasks/${s.child.task.id}/diff`)).json();
      assert.ok(brokenDiff.files.some((f: { path: string }) => f.path === "unrelated-main.txt"), "reproduce the review's mixed diff before recovery");
    }
    const deletion = await api.request(`/tasks/${s.child.task.id}`, { method: "DELETE" });
    assert.equal(deletion.status, 409);
    assert.equal((await deletion.json()).reason, "base_update_pending");
    const discard = await post(`/projects/${s.id}/workspaces/discard`, { taskId: s.child.task.id });
    assert.equal(discard.status, 409);
    assert.equal((await discard.json()).reason, "base_update_pending");
    const before = await (await api.request(`/tasks/${s.child.task.id}/base-update-recovery`)).json();
    assert.equal(before.oldCommit, oldHead);
    assert.equal(before.preparedCommit, intent.rebased);
    const cancel = (fingerprint: string, resolution = mode === "before-reset" ? "abandon" : "complete") => post(`/tasks/${s.child.task.id}/abandon-base-update`, { fingerprint, resolution });
    if (mode === "before-reset") {
      for (const missing of [null, "a".repeat(40)]) {
        await db.update(tasks).set({ worktreeStartCommit: missing }).where(eq(tasks.id, s.child.task.id));
        const blocked = await (await api.request(`/tasks/${s.child.task.id}/base-update-recovery`)).json();
        assert.equal(blocked.resolution, "manual");
        assert.ok(blocked.manual, "uncertain start must offer a reviewable manual exit");
        assert.equal((await cancel(blocked.fingerprint)).status, 409);
        assert.ok((await row(s.child.task.id)).baseUpdateIntent);
        assert.equal(git(s.repo, "rev-parse", baseRef(s.child.task.id)), intent.target);
      }
      await db.update(tasks).set({ worktreeStartCommit: original.worktreeStartCommit }).where(eq(tasks.id, s.child.task.id));
    }
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
    const expectedStart = mode === "before-reset" ? original.worktreeStartCommit : intent.target;
    assert.equal(view.resolution, mode === "before-reset" ? "abandon" : "complete");
    assert.equal(view.resolvedStartCommit, expectedStart);
    assert.equal((await cancel(view.fingerprint, view.resolution === "complete" ? "abandon" : "complete")).status, 409);
    assert.equal((await post(`/tasks/${s.child.task.id}/abandon-base-update`, { fingerprint: view.fingerprint })).status, 400,
      "old clients cannot silently authorize a different recovery action");
    const currentHead = git(s.repo, "rev-parse", s.child.branch!);
    const result = await cancel(view.fingerprint);
    assert.equal(result.status, 200, JSON.stringify(await result.json()));
    assert.equal((await row(s.child.task.id)).baseUpdateIntent, null);
    assert.equal((await row(s.child.task.id)).worktreeStartCommit, expectedStart);
    assert.equal(git(s.repo, "rev-parse", baseRef(s.child.task.id)), expectedStart);
    assert.equal(git(s.repo, "rev-parse", s.child.branch!), currentHead);
    git(s.repo, "merge-base", "--is-ancestor", expectedStart!, currentHead);
    const diff = await (await api.request(`/tasks/${s.child.task.id}/diff`)).json();
    assert.equal(diff.available, true);
    assert.equal(diff.mergeBase, expectedStart);
    assert.deepEqual(diff.files.map((f: { path: string }) => f.path).sort(),
      mode === "head-advanced" ? ["after-crash.txt", "child.txt", "newer.txt"] : ["child.txt"]);
    const receipts = await db.select().from(taskBranchReceipts).where(eq(taskBranchReceipts.taskId, s.child.task.id));
    assert.equal(receipts.length, mode === "before-reset" ? 0 : 1);
    if (receipts.length) {
      assert.equal(receipts[0].sourceCommit, oldHead);
      assert.equal(receipts[0].mergeCommit, intent.rebased);
      assert.equal(receipts[0].targetBranch, "main");
    }
    assert.equal(git(s.repo, "rev-parse", intent.backup), oldHead);
    for (const backup of view.backups) assert.equal(git(s.repo, "rev-parse", backup.ref), backup.commit);
    if (mode === "head-advanced") assert.equal(readFileSync(join(s.child.path, "WIP.txt"), "utf8"), "uncommitted work");
    else assert.equal(existsSync(s.child.path), mode !== "missing-worktree");
    assert.equal((await readBranchPlan(s.child.task.id))!.task.baseUpdatePending, false);
    if (mode === "prepared") {
      assert.equal((await acceptTask(s.child.task.id)).accepted, true);
      const acceptedDiff = await (await api.request(`/tasks/${s.child.task.id}/diff`)).json();
      assert.deepEqual(acceptedDiff.files.map((f: { path: string }) => f.path), ["child.txt"]);
      assert.equal(readFileSync(join(s.repo, "unrelated-main.txt"), "utf8"), "another task's change");
    } else {
      const plan = (await readBranchPlan(s.child.task.id))!.task;
      assert.equal((await post(`/tasks/${s.child.task.id}/merge-target`, { branch: s.parent.branch, fingerprint: plan.fingerprint })).status, 200);
    }
    assert.equal((await api.request(`/tasks/${s.child.task.id}`, { method: "DELETE" })).status, 200, "ordinary deletion is available after explicit abandonment");
    console.log(`✓ ${mode}: recovery preserves current work, reconciles start/ref/receipt and exposes only task files in the diff; guards and exits work`);
  }
  for (const mode of ["amended", "reset-target", "reset-unrelated", "broken-json", "broken-shape", "legacy-gc", "missing-branch"] as const) {
    const s = await setup();
    assert.equal((await acceptTask(s.parent.task.id)).accepted, true);
    commit(s.repo, "unrelated-main.txt", "another task's change");
    const oldHead = git(s.repo, "rev-parse", s.child.branch!);
    await dbClient.execute(`CREATE TRIGGER interrupt_manual BEFORE UPDATE ON tasks WHEN OLD.id='${s.child.task.id}' AND OLD.base_update_intent IS NOT NULL AND NEW.base_update_intent IS NULL BEGIN SELECT RAISE(ABORT, 'interrupted manual fixture'); END`);
    await assert.rejects(() => updateTaskBase(s.child.task.id, oldHead), /interrupted manual fixture/);
    await dbClient.execute("DROP TRIGGER interrupt_manual");
    const intent = JSON.parse((await row(s.child.task.id)).baseUpdateIntent!);
    const preparedRef = `refs/ash/base-update-backups/${s.child.task.id}/prepared-${intent.rebased}`;
    assert.equal(git(s.repo, "rev-parse", preparedRef), intent.rebased, "prepared result is pinned before durable intent is written");
    if (["amended", "legacy-gc"].includes(mode)) {
      writeFileSync(join(s.child.path, "child.txt"), "amended work after interruption");
      git(s.child.path, "add", "child.txt"); git(s.child.path, "commit", "--amend", "-m", "amended child");
    }
    if (mode === "reset-target") git(s.child.path, "reset", "--hard", intent.target);
    if (mode === "reset-unrelated") {
      const rootCommit = git(s.child.path, "commit-tree", "HEAD^{tree}", "-m", "rewritten unrelated history");
      git(s.child.path, "reset", "--hard", rootCommit);
    }
    if (["broken-json", "broken-shape", "missing-branch"].includes(mode)) {
      await db.update(tasks).set({ baseUpdateIntent: mode === "broken-shape" ? '{"head":42}' : "{not json" }).where(eq(tasks.id, s.child.task.id));
      const retry = await post(`/tasks/${s.child.task.id}/update-base`, { sourceCommit: intent.rebased });
      assert.equal(retry.status, 409);
      assert.match((await retry.json()).error, /记录损坏.*手动解除挂起/);
    }
    if (mode === "legacy-gc") git(s.repo, "update-ref", "-d", preparedRef);
    if (mode === "missing-branch") {
      git(s.repo, "worktree", "remove", "--force", s.child.path); git(s.repo, "branch", "-D", s.child.branch!);
      await db.update(tasks).set({ worktreeStartCommit: null }).where(eq(tasks.id, s.child.task.id));
      git(s.repo, "update-ref", "-d", baseRef(s.child.task.id));
    }
    git(s.repo, "reflog", "expire", "--expire=now", "--all"); git(s.repo, "gc", "--prune=now");
    assert.equal(git(s.repo, "rev-parse", `${intent.backup}^{commit}`), oldHead);
    if (mode === "legacy-gc") assert.throws(() => git(s.repo, "cat-file", "-e", intent.rebased));
    else assert.equal(git(s.repo, "rev-parse", `${preparedRef}^{commit}`), intent.rebased, "prepared result survives history rewrite and GC");
    const read = async () => (await api.request(`/tasks/${s.child.task.id}/base-update-recovery`)).json();
    let view = await read();
    assert.equal(view.resolution, "manual", mode);
    assert.ok(view.existingBackups.length, "corrupt intents still expose real repository backups");
    for (const backup of view.existingBackups) assert.equal(git(s.repo, "rev-parse", `${backup.ref}^{commit}`), backup.commit);
    const recover = (fingerprint: string, acknowledged = true) => post(`/tasks/${s.child.task.id}/abandon-base-update`, { fingerprint, resolution: "manual", acknowledged });
    assert.equal((await recover(view.fingerprint, false)).status, 409, "manual recovery needs explicit scope acknowledgement");
    if (mode === "amended") {
      commit(s.child.path, "after-preview.txt", "new work after preview");
      assert.equal((await recover(view.fingerprint)).status, 409);
      view = await read();
    }
    const head = mode === "missing-branch" ? null : git(s.repo, "rev-parse", s.child.branch!);
    if (head) writeFileSync(join(s.child.path, "WIP.txt"), "keep uncommitted work");
    if (mode === "reset-unrelated") assert.match(view.manual.basis, /已有代码全部保留.*不再计入/);
    assert.equal((await recover(view.fingerprint)).status, 200, mode);
    assert.equal((await row(s.child.task.id)).baseUpdateIntent, null);
    assert.equal((await row(s.child.task.id)).worktreeStartCommit, view.resolvedStartCommit);
    assert.equal((await db.select().from(taskBranchReceipts).where(eq(taskBranchReceipts.taskId, s.child.task.id))).length, 0, "manual escape does not invent completion receipts");
    if (head) {
      assert.equal(git(s.repo, "rev-parse", s.child.branch!), head);
      assert.equal(git(s.repo, "rev-parse", baseRef(s.child.task.id)), view.resolvedStartCommit);
      git(s.repo, "merge-base", "--is-ancestor", view.resolvedStartCommit, head);
      assert.equal(readFileSync(join(s.child.path, "WIP.txt"), "utf8"), "keep uncommitted work");
      const diff = await (await api.request(`/tasks/${s.child.task.id}/diff`)).json();
      assert.deepEqual(diff.files.map((f: { path: string }) => f.path), view.manual.files);
      assert.ok(view.backups.some((b: { commit: string }) => b.commit === head), "current rewritten HEAD is also backed up");
      if (["amended", "legacy-gc", "broken-json", "broken-shape"].includes(mode)) assert.ok(!diff.files.some((f: { path: string }) => f.path === "unrelated-main.txt"));
    }
    for (const backup of view.backups) assert.equal(git(s.repo, "rev-parse", `${backup.ref}^{commit}`), backup.commit);
    const plan = (await readBranchPlan(s.child.task.id))!.task;
    assert.equal((await post(`/tasks/${s.child.task.id}/merge-target`, { branch: "main", fingerprint: plan.fingerprint })).status, 200);
    assert.equal((await api.request(`/tasks/${s.child.task.id}`, { method: "DELETE" })).status, 200, "manual escape restores a real deletion exit");
    if (head) assert.equal(readFileSync(join(s.child.path, "WIP.txt"), "utf8"), "keep uncommitted work");
    console.log(`✓ ${mode}: reviewable manual recovery unlocks target/deletion, preserves current work and real backups, and never invents a receipt`);
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
