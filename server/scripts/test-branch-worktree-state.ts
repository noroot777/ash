import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { makeStep } from "@ash/shared/workflow";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-branch-worktree-state-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();
const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks } = await import("../src/db/schema.js");
const { createTasks } = await import("../src/task-store.js");
const { taskWorkspace } = await import("../src/task-workspace.js");
const { acceptTask, mountTaskAcceptanceRoutes } = await import("../src/task-accept.js");
const { readBranchPlan } = await import("../src/task-branch-routes.js");
const { discardTaskWorkspace } = await import("../src/workspace-cleanup.js");
await ensureSchema();
const api = new Hono();
mountTaskAcceptanceRoutes(api);
const commit = (path: string, name: string) => {
  writeFileSync(join(path, name), name);
  git(path, "add", "--", name);
  git(path, "commit", "-m", name);
  return git(path, "rev-parse", "HEAD");
};
let sequence = 0;
async function setup() {
  const id = `state${++sequence}`;
  const repo = join(root, id);
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, "config", "user.name", "Worktree State Test");
  git(repo, "config", "user.email", "state@example.test");
  commit(repo, "seed.txt");
  const at = new Date().toISOString();
  await db.insert(projects).values({ id, name: id, repoPath: repo, createdAt: at });
  const create = async (suffix: string, base: string, strategy: "safe" | "squash" = "safe") => {
    const accept = makeStep("accept", "accept");
    if (accept.kind === "accept") accept.p = { strategy, clean: "all" };
    const [task] = await createTasks([{
      id: `${suffix}-${id}`, projectId: id, title: suffix, body: "test", status: "done", mode: "single",
      useWorktree: true, worktreeBase: base, createdAt: at, updatedAt: at, workflowMode: "preset",
      workflow: JSON.stringify({ workspace: "isolated", steps: [makeStep("run", "run"), makeStep("human", "human"), accept] }),
      workflowAt: "human",
    }]);
    const workspace = await taskWorkspace(task, repo);
    const head = commit(workspace.path, `${suffix}.txt`);
    return { task, ...workspace, head };
  };
  const parent = await create("parent", "main");
  const child = await create("child", parent.branch!);
  await db.update(tasks).set({ mergeTargetBranch: parent.branch }).where(eq(tasks.id, child.task.id));
  return { id, repo, parent, child, create };
}
const accept = (id: string) => acceptTask(id, "human", { startVerifyRound: async () => ({ round: 1 }) });

try {
  for (const mode of ["missing-link", "moved-project"] as const) {
    const s = await setup();
    const unrelated = await s.create("unrelated", "main");
    writeFileSync(join(s.parent.path, "PARENT_WIP.txt"), "keep parent WIP");
    let repo = s.repo;
    let parentPath = s.parent.path;
    if (mode === "missing-link") rmSync(join(parentPath, ".git"));
    else {
      repo = `${s.repo}-renamed`;
      renameSync(s.repo, repo);
      parentPath = join(repo, ".worktrees", s.parent.task.id);
      await db.update(projects).set({ repoPath: repo }).where(eq(projects.id, s.id));
    }
    const registration = git(repo, "worktree", "list", "--porcelain", "-z");
    assert.match(registration, /prunable/);
    const view = (await readBranchPlan(s.child.task.id))!.task;
    assert.match(view.blocker!, /目标分支.*仍在工作区/);
    assert.ok(view.blocker!.includes(parentPath) || view.blocker!.includes(readFileSync(join(repo, ".git", "worktrees", s.parent.task.id, "gitdir"), "utf8").trim().replace(/\/.git$/, "")));
    const childResult = await accept(s.child.task.id);
    assert.equal(childResult.accepted, false);
    assert.equal(git(repo, "rev-parse", s.parent.branch!), s.parent.head);
    const release = await api.request(`/tasks/${s.parent.task.id}/release-workspace`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ fingerprint: (await readBranchPlan(s.parent.task.id))!.task.fingerprint }),
    });
    assert.equal(release.status, 409);
    assert.equal(git(repo, "worktree", "list", "--porcelain", "-z"), registration);
    assert.equal(readFileSync(join(parentPath, "PARENT_WIP.txt"), "utf8"), "keep parent WIP");
    if (mode === "missing-link") {
      assert.equal((await accept(unrelated.task.id)).accepted, true);
      assert.ok(git(repo, "worktree", "list", "--porcelain", "-z").includes(`branch refs/heads/${s.parent.branch}\0prunable`));
      const own = await accept(s.parent.task.id);
      assert.equal(own.accepted, false);
      if (own.accepted) throw new Error("unreadable workspace was accepted");
      assert.equal(own.reason, "worktree_remove_failed");
      assert.match(own.error, /无法确认工作区.*目录及文件已保留/);
      assert.equal(readFileSync(join(parentPath, "PARENT_WIP.txt"), "utf8"), "keep parent WIP");
    }
    console.log(`✓ ${mode}: child blocked, release refused, target and WIP preserved`);
  }
  for (const strategy of ["safe", "squash"] as const) {
    const s = await setup();
    const unrelated = await s.create("unrelated", "main", strategy);
    const gone = await s.create("gone", "main");
    writeFileSync(join(s.parent.path, "WIP.txt"), "keep WIP");
    rmSync(join(s.parent.path, ".git"));
    rmSync(gone.path, { recursive: true });
    commit(s.repo, "diverged.txt");
    git(s.repo, "checkout", "-b", "parking");
    const before = git(s.repo, "worktree", "list", "--porcelain", "-z");
    assert.equal((await accept(unrelated.task.id)).accepted, true);
    const after = git(s.repo, "worktree", "list", "--porcelain", "-z");
    for (const branch of [s.parent.branch, gone.branch]) {
      const record = before.split("\0\0").find(part => part.includes(`branch refs/heads/${branch}\0`));
      assert.ok(record && after.includes(record), "unrelated broken and missing registrations remain unchanged");
    }
    assert.equal(readFileSync(join(s.parent.path, "WIP.txt"), "utf8"), "keep WIP");
    console.log(`✓ ${strategy} temporary merge and cleanup preserve unrelated registrations`);
  }
  for (const releaseFirst of [false, true]) {
    const s = await setup();
    const unrelated = await s.create("unrelated", "main");
    writeFileSync(join(unrelated.path, "WIP.txt"), "keep unrelated WIP");
    rmSync(join(unrelated.path, ".git"));
    git(s.repo, "worktree", "lock", s.parent.path);
    rmSync(s.parent.path, { recursive: true });
    assert.match((await readBranchPlan(s.child.task.id))!.task.blocker!, /目标分支.*仍在工作区/);
    assert.equal((await accept(s.child.task.id)).accepted, false, "locked missing registration remains occupied");
    git(s.repo, "worktree", "unlock", s.parent.path);
    assert.equal((await readBranchPlan(s.child.task.id))!.task.blocker, null);
    if (releaseFirst) {
      const response = await api.request(`/tasks/${s.parent.task.id}/release-workspace`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ fingerprint: (await readBranchPlan(s.parent.task.id))!.task.fingerprint }),
      });
      assert.equal(response.status, 200);
    }
    assert.equal((await accept(s.child.task.id)).accepted, true, "first acceptance succeeds after unlocking a missing directory");
    const registry = git(s.repo, "worktree", "list", "--porcelain", "-z");
    assert.ok(!registry.includes(`branch refs/heads/${s.parent.branch}\0`));
    assert.ok(registry.includes(`branch refs/heads/${unrelated.branch}\0prunable`));
    assert.equal(readFileSync(join(unrelated.path, "WIP.txt"), "utf8"), "keep unrelated WIP");
    console.log(`✓ missing target (${releaseFirst ? "explicit release" : "direct acceptance"}): scoped cleanup preserves unrelated broken checkout and respects locks`);
  }
  {
    const s = await setup();
    writeFileSync(join(s.parent.path, "WIP.txt"), "keep orphan WIP");
    rmSync(join(s.parent.path, ".git"));
    rmSync(join(s.repo, ".git", "worktrees", s.parent.task.id), { recursive: true });
    const result = await accept(s.parent.task.id);
    assert.equal(result.accepted, false, "registration loss cannot bypass cleanup protection");
    const discarded = await discardTaskWorkspace(s.repo, s.parent.task.id, { worktree: true, branch: false });
    assert.equal(discarded.worktreeRemoved, false);
    assert.match(discarded.worktreeError!, /无法确认工作区/);
    assert.equal(readFileSync(join(s.parent.path, "WIP.txt"), "utf8"), "keep orphan WIP");
    assert.ok(existsSync(s.parent.path));
    console.log("✓ unregistered orphan: acceptance and ordinary deletion preserve files and report unreadable state");
  }
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
