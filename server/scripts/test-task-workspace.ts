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

  const [{ db, ensureSchema }, { tasks }, { refreshTaskBase, taskWorkspace }] = await Promise.all([
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

  // ── worktree 没被清掉、base 后来被删 ────────────────────────────────────────
  // 上面那档走的是「目录不在了，重新建」。真实现场更常见的是目录好端端地留着（验收清理
  // 策略保留 worktree、清理失败、或用户自己留着），只有 base 分支没了：复用路径要是不查
  // 一遍，这一轮跑得好好的，用户到 diff / 验收那头才撞上 target_branch_missing。
  {
    git(repo, "branch", "feat/gone-while-worktree-stays");
    await db.insert(tasks).values([{
      ...common, id: "keptwt-task", parentId: null, mode: "single",
      useWorktree: true, worktreeBase: "feat/gone-while-worktree-stays",
    }]);
    const first = await taskWorkspace(await load("keptwt-task"), repo);
    assert.equal(first.baseFallback, undefined, "前提：这一步 base 还在，不该报降级");

    git(repo, "branch", "-D", "feat/gone-while-worktree-stays");
    const again = await taskWorkspace(await load("keptwt-task"), repo);
    assert.equal(again.path, first.path, "前提：worktree 还在，这次走的是复用");
    assert.equal(again.baseFallback?.requested, "feat/gone-while-worktree-stays");
    assert.equal(again.baseFallback?.rebuilt, false, "复用路径什么都没重建，别说成重建了");
    assert.equal(again.baseFallback?.persisted, true, "复用路径同样要把降级落回任务行");
    assert.equal((await load("keptwt-task")).worktreeBase, "main", "库里不能继续留着已删的名字");

    const { taskBranchDiff } = await import("../src/git-diff.js");
    writeFileSync(join(again.path, "kept.txt"), "worktree kept\n");
    git(again.path, "add", "-A");
    git(again.path, "commit", "-m", "work in kept worktree");
    const reloaded = await load("keptwt-task");
    const diff = await taskBranchDiff(repo, reloaded.id, reloaded.worktreeBase);
    assert.equal(diff.available, true, `复用路径降级后 diff 也必须能出来，实际 ${JSON.stringify(diff)}`);
  }

  // ── 续聊压根不重新解析工作目录，也得查一遍 ──────────────────────────────────
  // orchestrator 的续聊只在 cwd 消失时才调 taskWorkspace。目录还在的那条路上没人查 base，
  // 「起得来但交不掉」就会原样留着 —— 所以那条路直接调 refreshTaskBase。
  {
    git(repo, "branch", "feat/gone-during-chat");
    await db.update(tasks).set({ worktreeBase: "feat/gone-during-chat" }).where(eq(tasks.id, "keptwt-task"));
    git(repo, "branch", "-D", "feat/gone-during-chat");

    const fallback = await refreshTaskBase(await load("keptwt-task"), repo);
    assert.equal(fallback?.requested, "feat/gone-during-chat", "要说清原本想用哪个 base");
    assert.equal(fallback?.rebuilt, false, "这条路径连工作目录都没碰");
    assert.equal(fallback?.persisted, true, "续聊路径同样要落库");
    assert.equal((await load("keptwt-task")).worktreeBase, "main");

    assert.equal(
      await refreshTaskBase(await load("keptwt-task"), repo), undefined,
      "基线本来就解析得出来时不该报降级，更不该反复改它",
    );
  }

  // ── 恢复档（目录没了、任务分支还在）同样别说成「按 base 重建」 ────────────────
  // 这一档是拿任务分支把工作原样接回来，跟 base 是谁毫无关系；措辞里说成「改按 X 重建」
  // 会让用户以为自己的改动被挪到了另一个基线上。
  {
    git(repo, "branch", "feat/gone-before-restore");
    await db.update(tasks).set({ worktreeBase: "feat/gone-before-restore" }).where(eq(tasks.id, "keptwt-task"));
    git(repo, "branch", "-D", "feat/gone-before-restore");
    rmSync(join(repo, ".worktrees", "keptwt-task"), { recursive: true, force: true });

    const restored = await taskWorkspace(await load("keptwt-task"), repo);
    assert.equal(existsSync(join(restored.path, "kept.txt")), true, "前提：分支还在，工作被接回来了");
    assert.equal(restored.fresh, false, "前提：这是恢复，不是建空壳");
    assert.equal(restored.baseFallback?.rebuilt, false, "恢复回来的目录跟 base 无关，别说成按它重建");
    assert.equal(restored.baseFallback?.persisted, true, "但登记的验收目标照样得修回来");
  }

  // ── 同名 tag 遮住「分支已删」这件事 ─────────────────────────────────────────
  // 判据要是「这个名字还解析得出一个提交吗」，仓库里留着一个同名 tag 就足以把分支被删整个
  // 遮掉：worktree 从 tag 起得来，diff / 验收查的却是 refs/heads/<name>，继续 target_branch_
  // missing —— 「起得来但交不掉」原样复活（审查实测）。所以过期判据必须跟下游一致，问的是
  // 本地分支还在不在；而「拿什么建目录」是另一个判据，tag 解析得出来就照它建。
  {
    const seedSha = git(repo, "rev-parse", "HEAD");
    git(repo, "branch", "feat/same-name");
    await db.insert(tasks).values([{
      ...common, id: "tagmask-task", parentId: null, mode: "single",
      useWorktree: true, worktreeBase: "feat/same-name",
    }]);
    writeFileSync(join(repo, "moved-on.txt"), "main moved on\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "main moves on");
    git(repo, "branch", "-D", "feat/same-name");
    git(repo, "tag", "feat/same-name", seedSha); // 同名 tag：rev-parse 照样成功

    const ws = await taskWorkspace(await load("tagmask-task"), repo);
    assert.equal(ws.baseFallback?.requested, "feat/same-name", "分支没了就是没了，别被同名 tag 骗过去");
    assert.equal(ws.baseFallback?.persisted, true, "验收目标必须修回一个真的本地分支");
    assert.equal((await load("tagmask-task")).worktreeBase, "main");
    assert.equal(git(ws.path, "rev-parse", "HEAD"), seedSha, "目录仍按仍解析得出的 tag 建，不白扔用户选的起点");
    assert.equal(ws.baseFallback?.rebuilt, false, "既然是从 tag 建的，就别说成「按仓库当前分支重建」");

    const { taskBranchDiff } = await import("../src/git-diff.js");
    writeFileSync(join(ws.path, "masked.txt"), "work on tag base\n");
    git(ws.path, "add", "-A");
    git(ws.path, "commit", "-m", "work on tag base");
    const reloaded = await load("tagmask-task");
    const diff = await taskBranchDiff(repo, reloaded.id, reloaded.worktreeBase);
    assert.equal(diff.available, true, `同名 tag 场景下 diff 也必须能出来，实际 ${JSON.stringify(diff)}`);
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
  console.log("✓ a kept worktree (and a plain follow-up turn) still notice a deleted base");
  console.log("✓ reuse/restore report the fallback without claiming a rebuild");
} finally {
  rmSync(root, { recursive: true, force: true });
}
