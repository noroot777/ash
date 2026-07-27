import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const root = mkdtempSync(join(tmpdir(), "harness-task-workspace-"));
const repo = join(root, "repo");
process.env.HARNESS_DB = join(root, "harness.db");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

try {
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.name", "Harness Test");
  git(repo, "config", "user.email", "harness@example.test");
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  git(repo, "add", "seed.txt");
  git(repo, "commit", "-m", "seed");

  const [{ db, ensureSchema }, { tasks }, { taskWorkspace }] = await Promise.all([
    import("../src/db/index.js"),
    import("../src/db/schema.js"),
    import("../src/task-workspace.js"),
  ]);
  await ensureSchema();

  const ts = new Date().toISOString();
  const common = {
    projectId: "project",
    groupId: null,
    title: "workspace test",
    body: "",
    status: "backlog",
    priority: "none",
    labels: "[]",
    dependsOn: "[]",
    resumeDependsOn: "[]",
    agentType: "claude",
    autoTitle: false,
    createdAt: ts,
    updatedAt: ts,
  };
  await db.insert(tasks).values([
    {
      ...common,
      id: "lead-task-1234",
      parentId: null,
      mode: "team",
      useWorktree: true,
      worktreeBase: "main",
    },
    {
      ...common,
      id: "shared-worker-1",
      parentId: "lead-task-1234",
      mode: "single",
      useWorktree: false,
      worktreeBase: null,
    },
    {
      ...common,
      id: "isolated-worker-1",
      parentId: "lead-task-1234",
      mode: "single",
      useWorktree: true,
      worktreeBase: null,
    },
  ]);

  const load = async (id: string) =>
    (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;

  const lead = await load("lead-task-1234");
  const leadWorkspace = await taskWorkspace(lead, repo);
  assert.equal(leadWorkspace.path, join(repo, ".worktrees", lead.id));
  assert.equal(leadWorkspace.isWorktree, true);

  writeFileSync(join(leadWorkspace.path, "team.txt"), "shared team state\n");
  git(leadWorkspace.path, "add", "team.txt");
  git(leadWorkspace.path, "commit", "-m", "team state");

  const sharedWorkspace = await taskWorkspace(await load("shared-worker-1"), repo);
  assert.equal(sharedWorkspace.path, leadWorkspace.path);
  assert.equal(sharedWorkspace.branch, leadWorkspace.branch);

  const isolated = await load("isolated-worker-1");
  const isolatedWorkspace = await taskWorkspace(isolated, repo);
  assert.equal(isolatedWorkspace.path, join(repo, ".worktrees", isolated.id));
  assert.equal(isolatedWorkspace.isWorktree, true);
  assert.equal(existsSync(join(isolatedWorkspace.path, "team.txt")), true);
  assert.equal(git(isolatedWorkspace.path, "rev-parse", "HEAD"), git(leadWorkspace.path, "rev-parse", "HEAD"));
  assert.notEqual(git(repo, "rev-parse", "HEAD"), git(leadWorkspace.path, "rev-parse", "HEAD"));

  console.log("✓ team lead and default worker share one worktree");
  console.log("✓ explicitly isolated worker branches from the shared team branch");
} finally {
  rmSync(root, { recursive: true, force: true });
}
