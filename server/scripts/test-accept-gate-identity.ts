import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-gate-identity-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
assert.notEqual(process.env.ASH_ALLOW_REAL_AGENT, "1");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const command = (code: string) => `"${process.execPath}" -e ${JSON.stringify(code)}`;
const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
try {
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks, acceptGateRuns } = await import("../src/db/schema.js");
  const { prepareWorktree } = await import("../src/git.js");
  const { acceptTask } = await import("../src/task-accept.js");
  const { acceptGateWouldRun, whenAcceptGateSettled } = await import("../src/accept-gate.js");
  const { acceptGateState } = await import("../src/accept-gate-state.js");
  const { mergeTaskBranch } = await import("../src/git-accept.js");
  await ensureSchema();
  const stamp = new Date().toISOString();
  const runs = async (taskId: string) => db.select().from(acceptGateRuns).where(eq(acceptGateRuns.taskId, taskId));
  const task = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
  const project = async (projectId: string) => (await db.select().from(projects).where(eq(projects.id, projectId)))[0]!;
  async function fixture(name: string, code: string, value = "fixed") {
    const repo = join(root, name);
    execFileSync("git", ["init", "-b", "main", repo]);
    git(repo, "config", "user.name", "Gate Identity Test");
    git(repo, "config", "user.email", "gate@example.test");
    writeFileSync(join(repo, ".gitignore"), ".worktrees/\nnode_modules/\n");
    writeFileSync(join(repo, "seed.txt"), "seed");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "seed");
    const taskId = `identity-${name}`;
    const projectId = `project-${name}`;
    const cwd = (await prepareWorktree(repo, taskId, "main")).path;
    writeFileSync(join(cwd, "value.txt"), value);
    git(cwd, "add", "-A");
    git(cwd, "commit", "-m", "task source");
    await db.insert(projects).values({ id: projectId, name, repoPath: repo, acceptGateCommand: command(code), createdAt: stamp });
    await db.insert(tasks).values({ id: taskId, projectId, title: name, body: "", mode: "single", status: "done",
      stage: "verified", workflowMode: "free", useWorktree: true, worktreeBase: "main", mergeTargetBranch: "main", createdAt: stamp, updatedAt: stamp });
    return { repo, cwd, taskId, projectId };
  }
  async function settled(taskId: string) {
    for (let attempt = 0; attempt < 800; attempt++) {
      const rows = await runs(taskId);
      if (rows.length && rows.every(row => row.status !== "running")) {
        await Promise.all(rows.map(row => whenAcceptGateSettled(row.id)));
        return;
      }
      await sleep(25);
    }
    throw new Error(`gate timed out: ${taskId}`);
  }
  const checksFixed = 'const fs=require("node:fs");const value=fs.readFileSync("value.txt","utf8");console.log("tested:",value);process.exit(value==="fixed"?0:1)';
  {
    const sample = await fixture("dirty", checksFixed, "broken");
    writeFileSync(join(sample.cwd, "value.txt"), "fixed");
    let result = await acceptTask(sample.taskId);
    assert.equal(result.accepted, false);
    if (!result.accepted) assert.equal(result.reason, "accept_gate_source_unavailable");
    assert.equal((await runs(sample.taskId)).length, 0, "uncommitted fixed code never obtains a credential for committed broken code");
    git(sample.cwd, "restore", "value.txt");
    await acceptTask(sample.taskId);
    await settled(sample.taskId);
    const row = (await runs(sample.taskId))[0]!;
    assert.equal(row.status, "failed");
    assert.match(readFileSync(row.logPath, "utf8"), /tested: broken/);
    assert.equal((await task(sample.taskId)).stage, "verified");
  }
  {
    const sample = await fixture("preflight", checksFixed);
    writeFileSync(join(sample.repo, "blocker.txt"), "obvious blocker");
    const refused = await acceptTask(sample.taskId);
    assert.equal(refused.accepted, false);
    if (!refused.accepted) assert.equal(refused.reason, "target_dirty");
    assert.equal((await runs(sample.taskId)).length, 0, "cheap merge blockers precede expensive tests");
  }
  {
    const sample = await fixture("during", 'setTimeout(()=>{' + checksFixed + '},500)');
    await acceptTask(sample.taskId);
    writeFileSync(join(sample.cwd, "value.txt"), "broken");
    await settled(sample.taskId);
    const row = (await runs(sample.taskId))[0]!;
    assert.equal(row.status, "passed");
    assert.equal(row.sourceCommit, git(sample.cwd, "rev-parse", "HEAD"));
    assert.equal(existsSync(row.cwd), false, "the snapshot and all test outputs are removed only after process exit proof");
    assert.match(readFileSync(row.logPath, "utf8"), /tested: fixed/);
    assert.equal((await task(sample.taskId)).stage, "verified", "a pass on the frozen snapshot cannot merge a dirty source checkout");
    assert.equal((await acceptGateState(sample.taskId)).latest?.stale, true);
    assert.equal(await acceptGateWouldRun(await task(sample.taskId), await project(sample.projectId)), false,
      "脏输入会立即拒绝，而不是预测为起跑");
    git(sample.cwd, "restore", "value.txt");
    assert.equal((await acceptGateState(sample.taskId)).latest?.stale, false);
    assert.equal(await acceptGateWouldRun(await task(sample.taskId), await project(sample.projectId)), false);
    assert.equal((await acceptTask(sample.taskId)).accepted, true);
    assert.equal(readFileSync(join(sample.repo, "value.txt"), "utf8"), "fixed");
    assert.equal((await task(sample.taskId)).acceptedSourceCommit, row.sourceCommit);
    assert.equal((await runs(sample.taskId)).length, 1);
  }
  {
    const sample = await fixture("selfedit", 'require("node:fs").writeFileSync("value.txt","fixed");' + checksFixed, "broken");
    await acceptTask(sample.taskId);
    await settled(sample.taskId);
    assert.equal((await runs(sample.taskId))[0]?.failure, "source_changed");
    assert.equal(readFileSync(join(sample.cwd, "value.txt"), "utf8"), "broken");
    assert.equal((await task(sample.taskId)).stage, "verified");
  }
  {
    const sample = await fixture("dependencies", 'setTimeout(()=>{' + checksFixed + '},500)');
    mkdirSync(join(sample.cwd, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(sample.cwd, "node_modules", "dep", "value"), "v1");
    await acceptTask(sample.taskId);
    writeFileSync(join(sample.repo, "blocker.txt"), "late blocker");
    await settled(sample.taskId);
    assert.equal((await acceptGateState(sample.taskId)).latest?.stale, false);
    writeFileSync(join(sample.cwd, "node_modules", "dep", "value"), "v2");
    assert.equal((await acceptGateState(sample.taskId)).latest?.stale, true);
    assert.equal(await acceptGateWouldRun(await task(sample.taskId), await project(sample.projectId)), true);
  }
  {
    const sample = await fixture("pin", checksFixed);
    const tested = git(sample.cwd, "rev-parse", "HEAD");
    const before = git(sample.repo, "rev-parse", "main");
    writeFileSync(join(sample.cwd, "value.txt"), "broken");
    git(sample.cwd, "add", "-A");
    git(sample.cwd, "commit", "-m", "untested newer source");
    const result = await mergeTaskBranch(sample.repo, sample.taskId, "main", "safe", { sourceCommit: tested });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "source_changed");
    assert.equal(git(sample.repo, "rev-parse", "main"), before);
  }
  {
    const repo = join(root, "non-git");
    mkdirSync(repo);
    writeFileSync(join(repo, "input.txt"), "source");
    const taskId = "identity-non-git";
    const projectId = "project-non-git";
    await db.insert(projects).values({ id: projectId, name: "non-git", repoPath: repo,
      acceptGateCommand: command('require("node:fs").writeFileSync("generated.txt","test output")'), createdAt: stamp });
    await db.insert(tasks).values({ id: taskId, projectId, title: "non-git", status: "done", stage: "verified",
      workflowMode: "free", useWorktree: false, createdAt: stamp, updatedAt: stamp });
    await acceptTask(taskId);
    await settled(taskId);
    assert.equal((await task(taskId)).stage, "accepted");
    assert.equal((await runs(taskId))[0]?.sourceCommit, null);
    assert.equal(existsSync(join(repo, "generated.txt")), false);
  }
  console.log("accept-gate-identity: original counterexample, immutable execution, automatic/manual reuse, batch/state freshness, late/early blockers and pinned merge source passed");
} finally { await releaseTmpDb(); await sleep(100); rmSync(root, { recursive: true, force: true }); }
