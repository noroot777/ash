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
    {
      ...common,
      id: "review-shared-1",
      parentId: "lead-task-1234",
      mode: "single",
      reviewOf: "shared-worker-1",
      reviewRound: 1,
      useWorktree: false,
      worktreeBase: null,
    },
    {
      ...common,
      id: "review-isolated-1",
      parentId: "lead-task-1234",
      mode: "single",
      reviewOf: "isolated-worker-1",
      reviewRound: 1,
      useWorktree: false,
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

  const sharedReviewWorkspace = await taskWorkspace(await load("review-shared-1"), repo);
  assert.equal(sharedReviewWorkspace.path, sharedWorkspace.path);
  assert.equal(sharedReviewWorkspace.branch, sharedWorkspace.branch);

  const isolatedReviewWorkspace = await taskWorkspace(await load("review-isolated-1"), repo);
  assert.equal(isolatedReviewWorkspace.path, isolatedWorkspace.path);
  assert.equal(isolatedReviewWorkspace.branch, isolatedWorkspace.branch);

  // ── 登记的 base 分支已经没了 → 降级要**落回任务行** ─────────────────────────
  // 只在 worktree 创建处降级、库里仍留着那个已删的名字的话，这一轮是起来了，用户下一步
  // 看 diff 会得到 target_branch_missing、验收被「目标本地分支不存在」挡回 —— 等于把
  // 「起不来」换成了「起得来但交不掉」。所以连带验收目标一起钉住。
  {
    git(repo, "branch", "feat/gone-base");
    await db.insert(tasks).values([{
      ...common, id: "basegone-task", parentId: null, mode: "single",
      useWorktree: true, worktreeBase: "feat/gone-base",
    }]);
    git(repo, "branch", "-D", "feat/gone-base"); // 验收合并之后目标分支被删

    const ws = await taskWorkspace(await load("basegone-task"), repo);
    assert.equal(ws.baseFallback?.requested, "feat/gone-base", "要说清原本想用哪个 base");
    assert.equal(ws.baseFallback?.used, "main", "退回仓库当前分支");
    assert.equal(ws.baseFallback?.persisted, true, "落库了才敢对用户说 diff/验收跟着走");
    assert.equal((await load("basegone-task")).worktreeBase, "main", "任务登记的基线必须跟着改");

    const { resolveTaskMergeTarget } = await import("../src/git.js");
    const { taskBranchDiff } = await import("../src/git-diff.js");
    const reloaded = await load("basegone-task");
    assert.equal(await resolveTaskMergeTarget(repo, reloaded.worktreeBase), "main", "验收目标要解析得出来");
    writeFileSync(join(ws.path, "after.txt"), "after fallback\n");
    git(ws.path, "add", "-A");
    git(ws.path, "commit", "-m", "work after fallback");
    const diff = await taskBranchDiff(repo, reloaded.id, reloaded.worktreeBase);
    assert.equal(diff.available, true, `降级后 diff 必须能出来，实际 ${JSON.stringify(diff)}`);
  }

  // ── 没登记过基线的任务不该被写上一个 ────────────────────────────────────────
  // 团队执行者默认就是这样：它传给 prepareWorktree 的是**领队的**分支，不是自己的登记
  // 值；跟着降级写库等于凭空给它按上一个显式基线，往后 diff/验收都会照着它走。
  {
    const before = await load("isolated-worker-1");
    assert.equal(before.worktreeBase, null, "前提：这个执行者本来没有登记基线");
    await taskWorkspace(before, repo);
    assert.equal((await load("isolated-worker-1")).worktreeBase, null, "没登记过基线就不该被写上一个");
  }

  console.log("✓ team lead and default worker share one worktree");
  console.log("✓ explicitly isolated worker branches from the shared team branch");
  console.log("✓ reviewers reuse the exact shared or isolated workspace under review");
  console.log("✓ deleted base falls back to the repo branch AND persists it for diff/accept");
} finally {
  rmSync(root, { recursive: true, force: true });
}
