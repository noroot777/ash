import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-auto-commit-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks, sessions } = await import("../src/db/schema.js");
  const { createTasks } = await import("../src/task-store.js");
  const { taskWorkspace } = await import("../src/task-workspace.js");
  const { autoCommitAcceptanceWorkspace } = await import("../src/accept-workspace-commit.js");
  const { acceptTask } = await import("../src/task-accept.js");
  const { mountProjectRoutes } = await import("../src/project-routes.js");
  const { mountScmRoutes } = await import("../src/scm-routes.js");
  const { sessionTranscriptPath } = await import("../src/transcript.js");
  const { Hono } = await import("hono");
  await ensureSchema();
  const app = new Hono();
  mountProjectRoutes(app);
  mountScmRoutes(app);
  const setup = async (suffix: string, isolated = true) => {
    const repo = join(root, suffix);
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    git(repo, "config", "user.name", "Acceptance Test");
    git(repo, "config", "user.email", "acceptance@example.test");
    writeFileSync(join(repo, ".gitignore"), ".worktrees/\n");
    writeFileSync(join(repo, "tracked.txt"), "seed\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "seed");
    const projectId = `project-${suffix}`;
    const taskId = `autocmt-${suffix}`;
    const at = new Date().toISOString();
    await db.insert(projects).values({ id: projectId, name: suffix, repoPath: repo, createdAt: at });
    await createTasks([{ id: taskId, projectId, title: `改动 ${suffix}`, status: "done", mode: "single", body: "test",
      useWorktree: isolated, worktreeBase: "main", workflowMode: "free", createdAt: at, updatedAt: at }]);
    const row = async () => (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
    const workspace = await taskWorkspace(await row(), repo);
    writeFileSync(join(workspace.path, "tracked.txt"), "changed\n");
    writeFileSync(join(workspace.path, "untracked.txt"), "new\n");
    return { repo, projectId, taskId, workspace, row };
  };
  const manualCommit = (taskId: string) => app.request(`/tasks/${taskId}/scm/acceptance-commit`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ message: "chore: manual task commit", stagePaths: ["tracked.txt", "untracked.txt"] }) });
  for (const detached of [false, true]) {
    const value = await setup(`shared-${detached}`, false);
    if (detached) git(value.repo, "checkout", "--detach", "-q");
    writeFileSync(join(value.repo, "USER-SCRATCH.md"), "private draft\n");
    const sessionId = `session-${value.taskId}`;
    await db.insert(sessions).values({ id: sessionId, taskId: value.taskId, role: "executor", agentType: "codex",
      executor: "test", cwd: value.repo, startedAt: new Date().toISOString() });
    await db.update(projects).set({ acceptAutoCommit: true }).where(eq(projects.id, value.projectId));
    const before = git(value.repo, "rev-parse", "HEAD");
    const dirty = git(value.repo, "status", "--porcelain");
    const overview = await (await app.request(`/tasks/${value.taskId}/scm`)).json();
    assert.match(overview.acceptanceCommitBlock, /共用项目目录/);
    assert.equal(await autoCommitAcceptanceWorkspace(await value.row(), true), null);
    assert.equal((await manualCommit(value.taskId)).status, 409);
    const result = await acceptTask(value.taskId);
    assert.equal(result.accepted, true, JSON.stringify(result));
    assert.equal(git(value.repo, "rev-parse", "HEAD"), before);
    assert.equal(git(value.repo, "status", "--porcelain"), dirty);
    assert.match(readFileSync(sessionTranscriptPath(value.taskId, sessionId), "utf8"), /已跳过自动提交/);
  }
  {
    const value = await setup("manual-route");
    const before = git(value.repo, "rev-parse", "HEAD");
    const overview = await (await app.request(`/tasks/${value.taskId}/scm`)).json();
    assert.equal(overview.acceptanceCommitBlock, null);
    const response = await manualCommit(value.taskId);
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
    assert.equal(git(value.workspace.path, "status", "--porcelain"), "");
    assert.equal(git(value.repo, "rev-parse", "HEAD"), before);
  }
  {
    const value = await setup("manual");
    const before = git(value.workspace.path, "rev-parse", "HEAD");
    assert.equal(await autoCommitAcceptanceWorkspace(await value.row(), false), null);
    assert.equal(git(value.workspace.path, "rev-parse", "HEAD"), before);
    assert.ok(git(value.workspace.path, "status", "--porcelain"));
    assert.equal(await autoCommitAcceptanceWorkspace(await value.row(), true), null);
    assert.notEqual(git(value.workspace.path, "rev-parse", "HEAD"), before);
    assert.equal(git(value.workspace.path, "status", "--porcelain"), "");
    assert.equal(git(value.repo, "rev-parse", "main"), before);
    assert.equal(await autoCommitAcceptanceWorkspace(await value.row(), true), null);
  }
  {
    const value = await setup("running");
    await db.update(tasks).set({ status: "running" }).where(eq(tasks.id, value.taskId));
    const before = git(value.workspace.path, "rev-parse", "HEAD");
    const result = await autoCommitAcceptanceWorkspace(await value.row(), true);
    assert.equal(result?.reason, "auto_commit_failed");
    assert.match(result!.error, /运行|不能自动提交/);
    assert.equal(git(value.workspace.path, "rev-parse", "HEAD"), before);
  }
  {
    const value = await setup("archived");
    await db.update(tasks).set({ archived: true }).where(eq(tasks.id, value.taskId));
    const result = await autoCommitAcceptanceWorkspace(await value.row(), true);
    assert.equal(result?.reason, "auto_commit_failed");
    assert.match(result!.error, /归档/);
  }
  {
    const value = await setup("wrong-branch");
    git(value.workspace.path, "checkout", "-qb", "unexpected");
    const before = git(value.workspace.path, "rev-parse", "HEAD");
    const result = await autoCommitAcceptanceWorkspace(await value.row(), true);
    assert.equal(result?.reason, "auto_commit_failed");
    assert.match(result!.error, /任务分支/);
    assert.equal((await manualCommit(value.taskId)).status, 409);
    assert.equal(git(value.workspace.path, "rev-parse", "HEAD"), before);
  }
  {
    const value = await setup("foreign");
    const foreign = await setup("foreign-target");
    await db.insert(sessions).values({ id: "foreign-session", taskId: value.taskId, role: "executor", agentType: "codex",
      executor: "test", cwd: foreign.workspace.path, startedAt: new Date().toISOString() });
    const before = git(foreign.workspace.path, "rev-parse", "HEAD");
    const result = await autoCommitAcceptanceWorkspace(await value.row(), true);
    assert.equal(result?.reason, "auto_commit_failed");
    assert.match(result!.error, /不属于项目仓库/);
    assert.equal((await manualCommit(value.taskId)).status, 409);
    assert.equal(git(foreign.workspace.path, "rev-parse", "HEAD"), before);
  }
  {
    const value = await setup("endtoend");
    const initial = (await db.select().from(projects).where(eq(projects.id, value.projectId))).at(0)!;
    assert.equal(initial.acceptAutoCommit, false);
    const patch = (body: unknown) => app.request(`/projects/${value.projectId}`, { method: "PATCH",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await patch({ acceptAutoCommit: "true" })).status, 400);
    const saved = await patch({ acceptAutoCommit: true });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).acceptAutoCommit, true);
    const result = await acceptTask(value.taskId);
    assert.equal(result.accepted, true, JSON.stringify(result));
    assert.equal(readFileSync(join(value.repo, "tracked.txt"), "utf8"), "changed\n");
    assert.equal(readFileSync(join(value.repo, "untracked.txt"), "utf8"), "new\n");
    assert.equal(git(value.repo, "status", "--porcelain"), "");
    assert.equal((await value.row()).stage, "accepted");
  }
  console.log("accept auto commit: shared/detached workspaces unchanged, common manual/auto ownership guards, default off, persistence and real acceptance passed");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
