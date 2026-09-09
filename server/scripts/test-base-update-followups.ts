import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { makeStep } from "@ash/shared/workflow";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-base-followups-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
const { tasks, projects, taskBranchReceipts } = await import("../src/db/schema.js");
const { createTasks } = await import("../src/task-store.js");
const { taskWorkspace } = await import("../src/task-workspace.js");
const { acceptTask } = await import("../src/task-accept.js");
const { updateTaskBase } = await import("../src/task-base-update.js");
const { readBaseUpdateRecovery, abandonTaskBaseUpdate } = await import("../src/task-base-recovery.js");
const { baseRef, baseUpdateBackupPrefix, branchDependency } = await import("../src/task-branch-plan.js");
const { readBaseUpdateBackups, retainBaseUpdateBackups } = await import("../src/task-base-backups.js");
const { taskBranchDiff } = await import("../src/git-diff.js");
await ensureSchema();
const git = (repo: string, ...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0];
const commit = (repo: string, file: string, content: string) => {
  writeFileSync(join(repo, file), content); git(repo, "add", file); git(repo, "commit", "-m", file);
  return git(repo, "rev-parse", "HEAD");
};
let sequence = 0;
async function setup(parentStrategy: "safe" | "squash" = "squash") {
  const id = `chain${++sequence}`;
  const repo = join(root, id);
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, "config", "user.name", "Followup Test"); git(repo, "config", "user.email", "followup@example.test");
  commit(repo, ".gitignore", ".worktrees/\n");
  const at = new Date().toISOString();
  await db.insert(projects).values({ id, name: id, repoPath: repo, createdAt: at });
  const create = async (name: string, base: string, strategy: "safe" | "squash" | "tag" = "safe") => {
    const accept = makeStep("accept", "accept");
    if (accept.kind === "accept") accept.p = { strategy, clean: "all" };
    const [task] = await createTasks([{ id: `${name}-${id}`, projectId: id, title: name, body: "test", status: "done",
      useWorktree: true, worktreeBase: base, createdAt: at, updatedAt: at, workflowAt: "human",
      workflow: JSON.stringify({ workspace: "isolated", steps: [makeStep("run", "run"), makeStep("human", "human"), accept] }) }]);
    const ws = await taskWorkspace(task, repo);
    commit(ws.path, `${name}.txt`, name);
    return { ...ws, task };
  };
  const parent = await create("parent", "main", parentStrategy);
  const middle = await create("middle", parent.branch!);
  const grand = await create("grand", middle.branch!);
  return { repo, parent, middle, grand, create };
}
async function interrupted(s: Awaited<ReturnType<typeof setup>>) {
  const id = s.middle.task.id;
  await dbClient.execute(`CREATE TRIGGER interrupt_followup BEFORE UPDATE ON tasks WHEN OLD.id='${id}' AND OLD.base_update_intent IS NOT NULL AND NEW.base_update_intent IS NULL BEGIN SELECT RAISE(ABORT, 'followup interruption'); END`);
  await assert.rejects(() => updateTaskBase(id, git(s.repo, "rev-parse", s.middle.branch!)), /followup interruption/);
  await dbClient.execute("DROP TRIGGER interrupt_followup");
}

try {
  for (const mode of ["manual", "broken", "complete", "plain", "tag"] as const) {
    const s = await setup(mode === "plain" || mode === "tag" ? "safe" : "squash");
    const inherited = (await row(s.grand.task.id)).worktreeStartCommit!;
    if (mode === "complete") commit(s.middle.path, "middle-extra.txt", "inherited old source beyond the grandchild start");
    assert.equal((await acceptTask(s.parent.task.id)).accepted, true);
    const prefix = baseUpdateBackupPrefix(s.middle.task.id);
    const neighbour = `${baseUpdateBackupPrefix(`${s.middle.task.id}-other`)}keep`;
    git(s.repo, "update-ref", neighbour, inherited);
    if (mode === "manual") for (let index = 0; index < 24; index++) git(s.repo, "update-ref", `${prefix}old-${index}`, inherited);
    if (!["plain", "tag"].includes(mode)) {
      await interrupted(s);
      if (mode === "manual") assert.equal((await readBaseUpdateBackups(s.repo, s.middle.task.id)).length, 26, "pending settlement keeps previous backups");
    }
    if (mode !== "complete") {
      writeFileSync(join(s.middle.path, "middle.txt"), "amended middle");
      git(s.middle.path, "add", "middle.txt"); git(s.middle.path, "commit", "--amend", "-m", "amended middle");
    }
    if (mode === "broken") await db.update(tasks).set({ baseUpdateIntent: "{broken" }).where(eq(tasks.id, s.middle.task.id));
    if (mode === "manual" || mode === "broken" || mode === "complete") {
      const view = (await readBaseUpdateRecovery(s.middle.task.id))!;
      assert.equal(view.resolution, mode === "complete" ? "complete" : "manual");
      assert.equal((await abandonTaskBaseUpdate(s.middle.task.id, view.fingerprint, mode === "complete" ? "complete" : "manual", true)).ok, true);
      const receipts = await db.select().from(taskBranchReceipts).where(eq(taskBranchReceipts.taskId, s.middle.task.id));
      assert.equal(receipts.length, mode === "complete" ? 1 : 0, "manual recovery does not invent a completion receipt");
      assert.ok((await readBaseUpdateBackups(s.repo, s.middle.task.id)).length <= 5, "successful settlement retains only current recovery refs");
    }
    assert.equal((await branchDependency(await row(s.grand.task.id), s.repo))?.state, "waiting", "middle must really merge before the grandchild can replace its baseline");
    const beforeMerge = git(s.repo, "rev-parse", "main");
    if (mode === "tag") {
      const workflow = JSON.parse((await row(s.middle.task.id)).workflow!);
      workflow.steps.find((step: { kind: string }) => step.kind === "accept").p.strategy = "tag";
      await db.update(tasks).set({ workflow: JSON.stringify(workflow) }).where(eq(tasks.id, s.middle.task.id));
    }
    assert.equal((await acceptTask(s.middle.task.id)).accepted, true);
    if (mode === "tag") {
      assert.equal((await branchDependency(await row(s.grand.task.id), s.repo))?.state, "waiting");
      assert.equal((await updateTaskBase(s.grand.task.id, git(s.repo, "rev-parse", s.grand.branch!))).ok, false);
      console.log("✓ tag-only rewritten parent cannot authorize replacing the grandchild baseline");
      continue;
    }
    if (mode === "complete") {
      const current = (await row(s.middle.task.id)).acceptedSourceCommit!;
      const latest = `${prefix}latest-current`;
      git(s.repo, "update-ref", latest, current);
      assert.equal(await retainBaseUpdateBackups(s.repo, s.middle.task.id, [latest]), "");
      const refs = await readBaseUpdateBackups(s.repo, s.middle.task.id);
      assert.equal(refs.length, 2, "keep latest plus the one old source still needed by the grandchild receipt");
      const savedStage = (await row(s.middle.task.id)).stage;
      await db.update(tasks).set({ stage: null, acceptedSourceCommit: null, acceptedMergeCommit: null }).where(eq(tasks.id, s.middle.task.id));
      git(s.repo, "reflog", "expire", "--expire=now", "--all"); git(s.repo, "gc", "--prune=now");
      assert.equal((await branchDependency(await row(s.grand.task.id), s.repo))?.state, "needs_update", "pruning must preserve historical receipt evidence even after the parent reopens");
      await db.update(tasks).set({ stage: savedStage, acceptedSourceCommit: current, acceptedMergeCommit: git(s.repo, "rev-parse", "main") }).where(eq(tasks.id, s.middle.task.id));
    }
    const dependency = await branchDependency(await row(s.grand.task.id), s.repo);
    assert.equal(dependency?.state, "needs_update", mode);
    if (mode !== "complete") assert.match(dependency!.message, /当前版本已合入.*继承的旧提交/);
    if (mode === "manual") {
      const source = (await row(s.middle.task.id)).acceptedSourceCommit!;
      const unrelated = git(s.repo, "commit-tree", `${source}^{tree}`, "-m", "unrelated history");
      assert.equal((await branchDependency({ ...await row(s.grand.task.id), worktreeStartCommit: unrelated }, s.repo))?.state, "waiting", "unrelated history is not evidence of an amended inherited baseline");
      const newer = git(s.repo, "commit-tree", `${source}^{tree}`, "-p", source, "-m", "unaccepted parent followup");
      git(s.repo, "update-ref", `refs/heads/${s.middle.branch}`, newer, source);
      assert.equal((await branchDependency(await row(s.grand.task.id), s.repo))?.state, "waiting", "new parent work must not be replaced by its older accepted result");
      git(s.repo, "update-ref", `refs/heads/${s.middle.branch}`, source, newer);
      assert.equal((await branchDependency({ ...await row(s.grand.task.id), worktreeStartCommit: newer }, s.repo))?.state, "waiting", "inherited followup beyond the accepted source still needs a real merge");
    }
    const accepted = git(s.repo, "rev-parse", "main");
    git(s.repo, "update-ref", "refs/heads/main", beforeMerge, accepted);
    assert.equal((await branchDependency(await row(s.grand.task.id), s.repo))?.state, "waiting", "unreachable merge evidence does not authorize replacement");
    git(s.repo, "update-ref", "refs/heads/main", accepted, beforeMerge);
    const blocked = await acceptTask(s.grand.task.id);
    assert.equal(blocked.accepted, false);
    if (!blocked.accepted) assert.equal(blocked.reason, "base_needs_update");
    git(s.repo, "reflog", "expire", "--expire=now", "--all"); git(s.repo, "gc", "--prune=now");
    assert.equal(git(s.repo, "rev-parse", `${baseRef(s.grand.task.id)}^{commit}`), inherited);
    const oldGrand = git(s.repo, "rev-parse", s.grand.branch!);
    assert.equal((await updateTaskBase(s.grand.task.id, oldGrand)).ok, true);
    assert.equal((await branchDependency(await row(s.grand.task.id), s.repo))?.state, "ready");
    const diff = await taskBranchDiff(s.repo, s.grand.task.id, "main", undefined, (await row(s.grand.task.id)).worktreeStartCommit);
    assert.deepEqual(diff.files.map(file => file.path), ["grand.txt"]);
    assert.equal((await acceptTask(s.grand.task.id)).accepted, true);
    assert.equal(readFileSync(join(s.repo, "middle.txt"), "utf8"), mode === "complete" ? "middle" : "amended middle");
    assert.equal(readFileSync(join(s.repo, "grand.txt"), "utf8"), "grand");
    assert.equal(git(s.repo, "rev-parse", neighbour), inherited);
    console.log(`✓ ${mode}: accepted rewritten middle → explicit grandchild baseline update → own delta only → acceptance`);
  }
  {
    const s = await setup();
    await acceptTask(s.parent.task.id); await interrupted(s);
    git(s.repo, "worktree", "remove", "--force", s.middle.path); git(s.repo, "branch", "-D", s.middle.branch!);
    const view = (await readBaseUpdateRecovery(s.middle.task.id))!;
    assert.equal(view.resolution, "abandon");
    const result = await abandonTaskBaseUpdate(s.middle.task.id, view.fingerprint, "abandon");
    assert.equal(result.ok, true); assert.match(result.message!, /任务分支已不存在/);
    assert.doesNotMatch(result.message!, /当前分支.*已保留|工作区文件.*已保留/);
    console.log("✓ missing branch recovery reports that no branch or workspace was recreated");
  }
  {
    const s = await setup();
    const base = git(s.repo, "rev-parse", s.middle.branch!);
    const blob = git(s.repo, "rev-parse", `${base}:middle.txt`);
    const entries = Array.from({ length: 70000 }, (_, i) => `100644 blob ${blob}\tf${String(i).padStart(5, "0")}-${"x".repeat(240)}\0`).join("");
    const tree = execFileSync("git", ["-C", s.repo, "mktree", "-z"], { input: entries, encoding: "utf8" }).trim();
    const huge = git(s.repo, "commit-tree", tree, "-p", base, "-m", "large recovery fixture");
    git(s.repo, "update-ref", `refs/heads/${s.middle.branch}`, huge, base);
    await db.update(tasks).set({ baseUpdateIntent: "{broken" }).where(eq(tasks.id, s.middle.task.id));
    const view = (await readBaseUpdateRecovery(s.middle.task.id))!;
    assert.equal(view.resolution, "manual", "file lists over the old 16 MB numstat limit remain recoverable");
    assert.equal(view.manual!.files.length, 1000); assert.ok(view.manual!.fileCount >= 70000);
    assert.ok(view.manual!.truncated); assert.ok(view.manual!.files.join("\n").length < 300000);
    assert.equal((await abandonTaskBaseUpdate(s.middle.task.id, view.fingerprint, "manual", true)).ok, true);
    assert.equal(git(s.repo, "rev-parse", s.middle.branch!), huge);
    assert.equal((await row(s.middle.task.id)).baseUpdateIntent, null);
    console.log(`✓ ${view.manual!.fileCount} changed paths (>16 MB listing): bounded preview, complete count and explicit recovery succeed`);
  }
} finally {
  await releaseTmpDb(); rmSync(root, { recursive: true, force: true });
}
