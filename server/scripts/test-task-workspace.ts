import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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

  // ── 谁跟谁共用同一个工作目录 ────────────────────────────────────────────────
  // 上面刚证明领队、跟随执行者、它俩的审查任务解析到**同一个路径**。SCM 面板要按这个
  // 事实上锁：只锁自己那个 task id，兄弟执行者正写着文件，用户在这一位的面板上无 force
  // 就能把它的成果丢掉（第 4 轮审查在页面上真实复现）。所以把分组关系单独钉一遍。
  {
    const { workspaceParticipants } = await import("../src/task-workspace.js");
    const ids = async (id: string) => (await workspaceParticipants(await load(id))).map((p) => p.id).sort();

    await db.insert(tasks).values([
      { ...common, id: "in-place-a", parentId: null, mode: "single", useWorktree: false },
      { ...common, id: "in-place-b", parentId: null, mode: "single", useWorktree: false },
      // 归档 = 冻结，它起不来 → 不该把别人的写操作也一起挡住
      { ...common, id: "in-place-archived", parentId: null, mode: "single", useWorktree: false,
        archived: true, archivedAt: ts },
    ]);

    const teamShared = ["lead-task-1234", "review-shared-1", "shared-worker-1"];
    assert.deepEqual(await ids("shared-worker-1"), teamShared, "跟随执行者要连同领队和审查任务一起算");
    assert.deepEqual(await ids("lead-task-1234"), teamShared, "领队看到的是同一组");
    assert.deepEqual(await ids("review-shared-1"), teamShared, "审查任务跟到被审任务所在的目录");
    // 显式独立的执行者是另一个目录：别把整个团队都算进来，那会把无关任务一起冻住。
    assert.deepEqual(await ids("isolated-worker-1"), ["isolated-worker-1", "review-isolated-1"]);

    // 就地干活的那批共用项目主仓，是同一类共用，不是特例。
    assert.deepEqual(await ids("in-place-a"), ["in-place-a", "in-place-b"]);
    // 归档任务自己仍然在自己名单里（锁要覆盖到自己），但不出现在别人的名单里。
    assert.deepEqual(await ids("in-place-archived"), ["in-place-a", "in-place-b", "in-place-archived"].sort());

    await db.delete(tasks).where(eq(tasks.id, "in-place-a"));
    await db.delete(tasks).where(eq(tasks.id, "in-place-b"));
    await db.delete(tasks).where(eq(tasks.id, "in-place-archived"));
  }

  // ── 同一个仓库登记成两个项目 ────────────────────────────────────────────────
  // `POST /api/projects` 不去重也不拒绝重复路径，把同一个仓库加两遍是正常用法。两边的
  // 就地任务落在**同一个物理目录**里：按 projectId 圈候选，对面那个正在跑的任务在这边
  // 完全不可见，面板不显示在飞横幅，无 force 的 discard 直接把它的成果丢掉（第 1 轮审查
  // 用公共 API 复现）。所以候选按归一后的仓库路径圈，跨项目。
  {
    const { projects } = await import("../src/db/schema.js");
    const { workspaceParticipants } = await import("../src/task-workspace.js");
    const ids = async (id: string) => (await workspaceParticipants(await load(id))).map((p) => p.id).sort();
    const otherRepo = join(root, "other-repo");

    await db.insert(projects).values([
      { id: "proj-a", name: "同一个仓库 A", repoPath: repo, apiKeys: null, workflowId: null, createdAt: ts },
      // 末尾斜杠 + `~` 之外的写法差异由 repoKey 归一：存成两种写法仍是同一个仓库。
      { id: "proj-b", name: "同一个仓库 B", repoPath: `${repo}/`, apiKeys: null, workflowId: null, createdAt: ts },
      { id: "proj-c", name: "另一个仓库", repoPath: otherRepo, apiKeys: null, workflowId: null, createdAt: ts },
    ]);

    await db.insert(tasks).values([
      { ...common, id: "xproj-a", projectId: "proj-a", parentId: null, mode: "single", useWorktree: false },
      { ...common, id: "xproj-b", projectId: "proj-b", parentId: null, mode: "single", useWorktree: false },
      { ...common, id: "xproj-c", projectId: "proj-c", parentId: null, mode: "single", useWorktree: false },
      // 独立 worktree 的那档不受影响：目录是 `<repo>/.worktrees/<id>`，task id 全局唯一。
      { ...common, id: "xproj-b-wt", projectId: "proj-b", parentId: null, mode: "single", useWorktree: true },
    ]);

    assert.deepEqual(await ids("xproj-a"), ["xproj-a", "xproj-b"], "同一个仓库的两个项目，就地任务共用主仓");
    assert.deepEqual(await ids("xproj-b"), ["xproj-a", "xproj-b"], "反过来也要看得见");
    assert.deepEqual(await ids("xproj-c"), ["xproj-c"], "别的仓库不能被顺带圈进来");
    assert.deepEqual(await ids("xproj-b-wt"), ["xproj-b-wt"], "独立 worktree 仍是自己一个目录");

    // 去尾斜杠只挡得住最表面那一种写法：`repo/.`、`repo/sub/..` 和一条软链都是
    // `POST /api/projects` 收得下的合法路径，指的还是同一个 `.git`（第 2 轮审查用公共
    // API 复现：别名项目里正在跑的任务完全不在候选里，无 force 的丢弃直接穿透）。
    // 故意用字符串拼而不是 `join`：`join` 自己会把 `.` / `..` 消掉，那样测的就不是 repoKey。
    {
      const link = join(root, "repo-alias-link");
      symlinkSync(repo, link, "dir");
      // 相对路径同理，而且它不是理论上的写法：`POST /api/projects` 原样收，真正干活的
      // `git -C` 按 server 进程的 cwd 解释它——落的就是同一个物理目录（第 1 轮审查用
      // 隔离实例复现：相对路径项目里在跑的任务完全不可见，无 force 的丢弃直接穿透）。
      for (const alias of [`${repo}/.`, `${repo}/sub/..`, link, `${link}/./`, relative(process.cwd(), repo)]) {
        await db.update(projects).set({ repoPath: alias }).where(eq(projects.id, "proj-b"));
        assert.deepEqual(await ids("xproj-a"), ["xproj-a", "xproj-b"], `别名写法 ${alias} 仍是同一个仓库`);
      }
      await db.update(projects).set({ repoPath: `${repo}/` }).where(eq(projects.id, "proj-b"));
    }

    for (const id of ["xproj-a", "xproj-b", "xproj-c", "xproj-b-wt"]) {
      await db.delete(tasks).where(eq(tasks.id, id));
    }
    for (const id of ["proj-a", "proj-b", "proj-c"]) {
      await db.delete(projects).where(eq(projects.id, id));
    }
  }

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
    assert.equal(ws.baseFallback?.workspaceRebuilt, true, "这一档确实新建了工作目录");
    assert.equal(ws.baseFallback?.builtFromRequested, false, "名字整个没了，只能退回仓库当前分支起");
    assert.equal(ws.baseFallback?.persisted, true, "落库了才敢对用户说 diff/验收跟着走");
    {
      // 三态措辞之一：名字整个没了 → 目录退回仓库当前分支新建。
      const { WORKSPACE_BASE_FALLBACK_MARKER } = await import("../src/run-prompts.js");
      const note = WORKSPACE_BASE_FALLBACK_MARKER(
        ws.baseFallback!.requested, ws.baseFallback!.used, ws.baseFallback!, true,
      );
      assert.match(note, /改按仓库当前 main 新建/, "要说清这次的目录是从仓库当前分支起的");
    }
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
    assert.equal(again.baseFallback?.workspaceRebuilt, false, "复用路径什么都没重建，别说成重建了");
    assert.equal(again.baseFallback?.builtFromRequested, false, "更不是从那个已删的名字建的");
    assert.equal(again.baseFallback?.persisted, true, "复用路径同样要把降级落回任务行");
    assert.equal((await load("keptwt-task")).worktreeBase, "main", "库里不能继续留着已删的名字");
    {
      // 三态措辞之二：目录压根没动 → 只说基线换了目标，别提任何「重建」。
      const { WORKSPACE_BASE_FALLBACK_MARKER } = await import("../src/run-prompts.js");
      const note = WORKSPACE_BASE_FALLBACK_MARKER(
        again.baseFallback!.requested, again.baseFallback!.used, again.baseFallback!, true,
      );
      assert.match(note, /沿用原有的工作目录/, "目录原样留着就该这么说");
      assert.doesNotMatch(note, /新建/, "什么都没建，别让用户以为改动被挪走了");
    }

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
    assert.equal(fallback?.workspaceRebuilt, false, "这条路径连工作目录都没碰");
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
    assert.equal(restored.baseFallback?.workspaceRebuilt, false, "恢复回来的目录跟 base 无关，别说成新建的");
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
    assert.equal(ws.baseFallback?.workspaceRebuilt, true, "这一轮确实新建了工作目录");
    assert.equal(ws.baseFallback?.builtFromRequested, true, "而且是从那个仍解析得出的名字建的，不是退回仓库当前分支");

    // 这两条 marker 在同一个回合里紧挨着落进时间线（orchestrator.continueTask：旧 cwd 没了
    // → 建新目录 → 先写 RESET 再写 FALLBACK）。曾经用一个布尔同时表示「新建了目录」和
    // 「按 used 新建的」，于是这一档先说「已重建为空目录」又说「沿用原有的工作目录」，
    // 用户刷新后判断不出这轮到底发生了什么（审查实测）。所以直接钉措辞，光改字段名不算修好。
    const { WORKSPACE_BASE_FALLBACK_MARKER, WORKSPACE_RESET_MARKER } = await import("../src/run-prompts.js");
    const note = WORKSPACE_BASE_FALLBACK_MARKER(
      ws.baseFallback!.requested, ws.baseFallback!.used, ws.baseFallback!, !!ws.baseFallback?.persisted,
    );
    assert.match(WORKSPACE_RESET_MARKER, /重建/, "前提：同回合的另一条说的是「目录已重建」");
    assert.doesNotMatch(note, /沿用原有的工作目录/, "同一回合刚说完已重建，不能紧接着说沿用原目录");
    assert.match(note, /feat\/same-name（tag 或提交）新建/, "要说清新目录是从那个仍解析得出的名字起的");
    assert.match(note, /基线也已一并更新为 main/, "同时说清验收目标已经改到哪");

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
  console.log("✓ 三种工作目录去向各自的措辞对得上，同回合的两条 marker 不互相打架");
} finally {
  rmSync(root, { recursive: true, force: true });
}
