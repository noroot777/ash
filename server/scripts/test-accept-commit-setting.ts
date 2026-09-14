// 「验收合并后提交代码」这一档的回归用例：项目设置的默认值、单次验收的覆盖、以及
// 「不提交」自带的那些代价（目标分支必须检出且干净、分支不许删、下一次验收会被脏工作区
// 拦下）。从 test-accept-merge.ts 拆出来的——那套验的是「怎么合」，这套验的是「合完要
// 不要替你提交」，两者正交。
//
// 每个用例自带一个临时仓库，checkout 和 ref 更新一律出不了临时目录。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { makeStep } from "@ash/shared/workflow";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-accept-commit-test-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
// 兜底清理挂在建好舞台的下一行：早退路径也不许在 TEMP 里留下目录（见 test-accept-merge.ts）。
process.on("exit", () => { try { rmSync(root, { recursive: true, force: true }); } catch {} });
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function hasRef(repo: string, branch: string): boolean {
  try {
    git(repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`);
    return true;
  } catch {
    return false;
  }
}

function makeRepo(name: string): string {
  const repo = join(root, name);
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.name", "Ash Accept Test");
  git(repo, "config", "user.email", "accept@example.test");
  writeFileSync(join(repo, ".gitignore"), ".worktrees/\n");
  writeFileSync(join(repo, "shared.txt"), "seed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "seed");
  return repo;
}

try {
  const { prepareWorktree, worktreeBranchName } = await import("../src/git.js");
  const { mergeTaskBranch } = await import("../src/git-accept.js");
  const { cleanupAcceptedTask } = await import("../src/git-accept-cleanup.js");
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks } = await import("../src/db/schema.js");
  const { acceptTask } = await import("../src/task-accept.js");
  const { createTasks } = await import("../src/task-store.js");
  const { taskWorkspace } = await import("../src/task-workspace.js");
  const { readBranchPlan, acceptFamily } = await import("../src/task-branch-routes.js");
  await ensureSchema();

  // 1. 「合并后不提交」：改动进目标分支的工作区，目标分支的 ref 一个字节都不动。
  {
    const repo = makeRepo("no-commit");
    const taskId = "acceptnc0015";
    const ws = await prepareWorktree(repo, taskId, "main");
    writeFileSync(join(ws.path, "pending.txt"), "not committed yet\n");
    git(ws.path, "add", "-A");
    git(ws.path, "commit", "-m", "task pending");
    const before = git(repo, "rev-parse", "main");

    // 目标分支正检出在项目目录、工作区干净 → 合进工作区并暂存，不提交。
    const merged = await mergeTaskBranch(repo, taskId, "main", "safe", { commit: false });
    assert.equal(merged.ok, true);
    if (!merged.ok) throw new Error(merged.message);
    assert.equal(merged.method, "no_commit");
    assert.equal(git(repo, "rev-parse", "main"), before, "不提交这一档绝不能动目标分支的 ref");
    assert.equal(merged.beforeCommit, merged.afterCommit, "ref 没动，前后当然相等");
    assert.equal(readFileSync(join(repo, "pending.txt"), "utf8"), "not committed yet\n", "改动要真的落在工作区里");
    assert.equal(git(repo, "diff", "--cached", "--name-only"), "pending.txt", "而且是暂存好的");

    // 分支必须留着：改动还没提交，它是那份产物在版本库里唯一的副本。
    const cleanup = await cleanupAcceptedTask(repo, taskId, "main", { worktree: true, branch: false });
    assert.equal(cleanup.ok, true);
    if (!cleanup.ok) throw new Error(cleanup.message);
    assert.equal(cleanup.branchDeleted, false);
    assert.equal(hasRef(repo, worktreeBranchName(taskId)), true);

    // 重试（上一轮已经合过、停在 merged）不许再合一遍：工作区里躺着的正是上次的产物，
    // 再合只会被自己判成 target_dirty，任务永远出不来。
    const retry = await mergeTaskBranch(repo, taskId, "main", "safe", { commit: false, retryOfMerged: true });
    assert.equal(retry.ok, true);
    if (!retry.ok) throw new Error(retry.message);
    assert.equal(retry.method, "no_commit");
    assert.equal(git(repo, "rev-parse", "main"), before);
  }

  // 2. 「合并后不提交」但目标分支没检出在项目目录：一个字节都不动，并说清为什么。
  //      临时 worktree 跑完就删，合进去的改动会跟着丢 —— 那是「看上去验收通过、产物却
  //      不见了」，比不合危险得多。
  {
    const repo = makeRepo("no-commit-not-checked-out");
    const taskId = "acceptnk0016";
    const ws = await prepareWorktree(repo, taskId, "main");
    writeFileSync(join(ws.path, "nowhere.txt"), "nowhere\n");
    git(ws.path, "add", "-A");
    git(ws.path, "commit", "-m", "task nowhere");
    git(repo, "checkout", "-b", "parking");
    const before = git(repo, "rev-parse", "main");

    const merged = await mergeTaskBranch(repo, taskId, "main", "safe", { commit: false });
    assert.equal(merged.ok, false);
    if (merged.ok) throw new Error("目标分支没检出时不该合");
    assert.equal(merged.reason, "target_not_checked_out");
    assert.match(merged.message, /合并后不提交/);
    assert.equal(git(repo, "rev-parse", "main"), before);
    assert.equal(existsSync(join(repo, "nowhere.txt")), false, "项目目录里不许留下半份产物");

    // 工作区脏时同样只报告：那个工作区正是改动要落脚的地方。
    git(repo, "checkout", "main");
    writeFileSync(join(repo, "shared.txt"), "local edit\n");
    const dirty = await mergeTaskBranch(repo, taskId, "main", "safe", { commit: false });
    assert.equal(dirty.ok, false);
    if (dirty.ok) throw new Error("脏工作区不该合");
    assert.equal(dirty.reason, "target_dirty");
    assert.deepEqual(dirty.dirtyFiles, ["shared.txt"]);
    assert.equal(git(repo, "rev-parse", "main"), before);
  }

  // 3. 端到端走 acceptTask：项目设置「验收合并后提交代码」关掉 → 不落提交；
  //      单次验收显式传 commit:true → 这一次照样落提交（项目设置不变）。
  {
    const repo = makeRepo("accept-commit-setting");
    const createdAt = new Date().toISOString();
    const projectId = "accept-commit-project";
    await db.insert(projects).values({ id: projectId, name: "accept-commit", repoPath: repo, acceptCommit: false, createdAt });
    const seedTask = async (taskId: string, file: string) => {
      const ws = await prepareWorktree(repo, taskId, "main");
      writeFileSync(join(ws.path, file), `${file}\n`);
      git(ws.path, "add", "-A");
      git(ws.path, "commit", "-m", `task ${file}`);
      await db.insert(tasks).values({
        id: taskId, projectId, title: file, body: "", mode: "single", status: "done", stage: "verified",
        labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "claude",
        useWorktree: true, worktreeBase: "main", mergeTargetBranch: "main",
        autoTitle: false, createdAt, updatedAt: createdAt,
      });
      return ws;
    };

    const pendingId = "acceptps0017";
    await seedTask(pendingId, "pending.txt");
    const before = git(repo, "rev-parse", "main");
    const kept = await acceptTask(pendingId);
    assert.equal(kept.accepted, true);
    if (!kept.accepted) throw new Error(kept.error);
    assert.equal(kept.merge, "no_commit", "项目设置说不提交，就不许落提交");
    assert.equal(kept.branchDeleted, false, "没提交的改动只剩分支这一份副本，分支必须留着");
    assert.equal(git(repo, "rev-parse", "main"), before, "目标分支的 ref 一动不动");
    assert.equal(git(repo, "diff", "--cached", "--name-only"), "pending.txt");
    const keptRow = (await db.select().from(tasks).where(eq(tasks.id, pendingId))).at(0)!;
    assert.equal(keptRow.stage, "accepted");
    assert.equal(keptRow.acceptedMergeCommit, null, "没有合并提交就写 null，不许拿目标分支原来的头冒充");

    // 工作区留着未提交的合并 → 下一次验收会被如实拦下（这正是这一档的代价，不能瞒着）。
    const blockedId = "acceptbl0018";
    await seedTask(blockedId, "blocked.txt");
    const blocked = await acceptTask(blockedId);
    assert.equal(blocked.accepted, false);
    if (blocked.accepted) throw new Error("上一次的改动还没提交，工作区是脏的，不该继续合");
    assert.equal(blocked.reason, "target_dirty");

    // 用户自己提交掉之后，单次覆盖 commit:true 照样能落提交。
    git(repo, "commit", "-m", "user commits the pending merge");
    const committed = await acceptTask(blockedId, "human", { commit: true });
    assert.equal(committed.accepted, true);
    if (!committed.accepted) throw new Error(committed.error);
    assert.notEqual(committed.merge, "no_commit", "这一次显式要求提交，就得真的提交");
    assert.notEqual(git(repo, "rev-parse", "main"), before);
    assert.equal(git(repo, "status", "--porcelain"), "", "落了提交就不该留下脏工作区");
    assert.equal(
      (await db.select().from(projects).where(eq(projects.id, projectId))).at(0)!.acceptCommit,
      false,
      "单次覆盖只管这一次，绝不回写项目设置",
    );
  }

  // 4. 统一验收（父任务 + 子任务一串）也认「本次」这一勾，判据是**生效值**而不是项目设置。
  {
    const repo = makeRepo("accept-commit-family");
    const projectId = "accept-commit-family-project";
    const createdAt = new Date().toISOString();
    await db.insert(projects).values({ id: projectId, name: "family", repoPath: repo, acceptCommit: false, createdAt });
    const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
    const newTask = async (id: string, base: string) => {
      const [created] = await createTasks([{
        id, projectId, title: id, body: "test", mode: "single", status: "done",
        createdAt, updatedAt: createdAt, useWorktree: true, worktreeBase: base, workflowMode: "free",
      }]);
      return created;
    };
    const parentId = "acceptfp0019";
    const childId = "acceptfc0020";
    await newTask(parentId, "main");
    const parentWs = await taskWorkspace(await row(parentId), repo);
    writeFileSync(join(parentWs.path, "parent.txt"), "parent\n");
    git(parentWs.path, "add", "-A");
    git(parentWs.path, "commit", "-m", "parent");
    await newTask(childId, parentWs.branch!);
    const childWs = await taskWorkspace(await row(childId), repo);
    writeFileSync(join(childWs.path, "child.txt"), "child\n");
    git(childWs.path, "add", "-A");
    git(childWs.path, "commit", "-m", "child");

    const view = (await readBranchPlan(parentId))!;
    const expected = [view.task, ...view.descendants].map(t => ({ taskId: t.taskId, fingerprint: t.fingerprint }));
    const before = git(repo, "rev-parse", "main");
    // 不提交那一档改动留在目标分支工作区里，串到第二个任务必被自己的前一位判成脏工作区
    // —— 所以按下去之前就整批拦住，一个都不合。
    const blocked = await acceptFamily(parentId, expected, acceptTask);
    assert.equal(blocked.ok, false);
    assert.deepEqual(blocked.completed, []);
    assert.equal(blocked.stoppedAt, childId);
    assert.match(blocked.error!, /一次只能合一个任务/);
    assert.equal(git(repo, "rev-parse", "main"), before, "拦住就是一个字节都没动");

    // 本次显式勾上「合并后提交代码」→ 项目设置不再说了算，整串照常合完。
    const committed = await acceptFamily(parentId, expected, acceptTask, true);
    assert.equal(committed.ok, true, committed.error);
    assert.deepEqual(committed.completed, [parentId, childId]);
    assert.notEqual(git(repo, "rev-parse", "main"), before);
    assert.equal(
      (await db.select().from(projects).where(eq(projects.id, projectId))).at(0)!.acceptCommit,
      false,
      "单次覆盖只管这一次，绝不回写项目设置",
    );
  }

  // 5. 反过来：项目默认提交，这一次单独选「不提交」——只合一个任务时照做，ref 一动不动。
  {
    const repo = makeRepo("accept-commit-family-opt-out");
    const projectId = "accept-commit-family-opt-out-project";
    const createdAt = new Date().toISOString();
    await db.insert(projects).values({ id: projectId, name: "family-opt-out", repoPath: repo, createdAt });
    const taskId = "acceptfo0021";
    const [created] = await createTasks([{
      id: taskId, projectId, title: taskId, body: "test", mode: "single", status: "done",
      createdAt, updatedAt: createdAt, useWorktree: true, worktreeBase: "main", workflowMode: "free",
    }]);
    const ws = await taskWorkspace(created, repo);
    writeFileSync(join(ws.path, "solo.txt"), "solo\n");
    git(ws.path, "add", "-A");
    git(ws.path, "commit", "-m", "solo");

    const view = (await readBranchPlan(taskId))!;
    const before = git(repo, "rev-parse", "main");
    const kept = await acceptFamily(taskId, [{ taskId: view.task.taskId, fingerprint: view.task.fingerprint }], acceptTask, false);
    assert.equal(kept.ok, true, kept.error);
    assert.equal(git(repo, "rev-parse", "main"), before, "不提交这一档绝不动目标分支的 ref");
    assert.equal(git(repo, "diff", "--cached", "--name-only"), "solo.txt", "改动合进工作区并暂存");
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!.acceptedMergeCommit, null);
  }

  // 6. 「一次只能合一个」数的是**真会合进目标工作区**的那些：「只打标签不合并」不产生
  //    提交、也不碰目标工作区，把它算进去就会拦下「一个真合并 + 一个 tag 子任务」这种
  //    明明做得了的组合（第 2 轮审查 P1）。
  {
    const repo = makeRepo("accept-commit-family-tag");
    const projectId = "accept-commit-family-tag-project";
    const createdAt = new Date().toISOString();
    await db.insert(projects).values({ id: projectId, name: "family-tag", repoPath: repo, createdAt });
    const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
    const tagStep = makeStep("accept", "accept");
    if (tagStep.kind === "accept") tagStep.p = { strategy: "tag", clean: "all" };
    const tagWorkflow = JSON.stringify({ workspace: "isolated", steps: [makeStep("run", "run"), makeStep("human", "human"), tagStep] });
    const parentId = "accepttp0022";
    const childId = "accepttc0023";
    await createTasks([{
      id: parentId, projectId, title: parentId, body: "test", mode: "single", status: "done",
      createdAt, updatedAt: createdAt, useWorktree: true, worktreeBase: "main", workflowMode: "free",
    }]);
    const parentWs = await taskWorkspace(await row(parentId), repo);
    writeFileSync(join(parentWs.path, "tagparent.txt"), "parent\n");
    git(parentWs.path, "add", "-A");
    git(parentWs.path, "commit", "-m", "tag parent");
    await createTasks([{
      id: childId, projectId, title: childId, body: "test", mode: "single", status: "done",
      createdAt, updatedAt: createdAt, useWorktree: true, worktreeBase: parentWs.branch!,
      workflow: tagWorkflow, workflowAt: "human",
    }]);
    const childWs = await taskWorkspace(await row(childId), repo);
    writeFileSync(join(childWs.path, "tagchild.txt"), "child\n");
    git(childWs.path, "add", "-A");
    git(childWs.path, "commit", "-m", "tag child");

    const view = (await readBranchPlan(parentId))!;
    assert.equal(view.descendants[0]?.strategy, "tag", "子任务这一档应当是「只打标签不合并」");
    const expected = [view.task, ...view.descendants].map(t => ({ taskId: t.taskId, fingerprint: t.fingerprint }));
    const before = git(repo, "rev-parse", "main");
    const result = await acceptFamily(parentId, expected, acceptTask, false);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.completed, [parentId, childId]);
    assert.equal(git(repo, "rev-parse", "main"), before, "父任务这一档不提交，main 的 ref 不动");
    assert.equal(git(repo, "diff", "--cached", "--name-only"), "tagparent.txt");
    assert.equal((await row(childId)).stage, "accepted");
    assert.match(git(repo, "tag", "--list"), /ash-accepted\//, "tag 那一档照常打标签");
  }

  console.log("accept commit setting: 合并后不提交 / 目标分支前提 / 项目默认与单次覆盖 / 统一验收本次覆盖 全部通过");
} finally {
  // 删舞台前先松开库文件,否则 Windows 上必然 EBUSY(理由见 tmp-db.ts 的 releaseTmpDb)。
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
