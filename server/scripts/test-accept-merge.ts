// Deterministic acceptance merge regression suite. Every case owns a temporary
// repository; no checkout or ref update can escape into the harness repo.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "harness-accept-merge-test-"));
process.env.HARNESS_DB = join(root, "harness.db");
// RUNS_DIR 指到临时目录,顺带把 guardAgentSpawn 打开:用例 13 那一轮**不会真起 CLI**,每一次
// spawn 都被拦成 failedChild(executors/spawn.ts),回合照开照结算,只是没有真进程。
// 原来这里还摆着一份没后缀的 `#!/bin/sh` 假 claude、PATH 用 `:` 拼 —— 两条都只在 Unix 成立
// (Windows 用 `;` 分隔、查找只认 PATHEXT 后缀、内核不认 shebang),而且不管哪个平台它都从没
// 被执行过:死代码,还让人误以为这一轮验的是 CLI 启动。真正验的是「有没有真发起这一轮」。
process.env.HARNESS_RUNS_DIR = join(root, "runs");
// 舞台的兜底清理挂在**建好它的下一行**,而不是靠尾部那个 finally。下面这条 fail-closed 断言
// 就在 try 之前:它一响(HARNESS_ALLOW_REAL_AGENT=1 时正是要它响),脚本当场掀桌,尾部清理
// 一行都执行不到,TEMP 里就躺下一个 harness-accept-merge-test-*。exit 钩子对**每条**早退
// 路径都成立,成功路径那次 rmSync 照旧(它还得先 releaseTmpDb),这里只管兜底。
process.on("exit", () => { try { rmSync(root, { recursive: true, force: true }); } catch {} });
assert.ok(
  process.env.HARNESS_ALLOW_REAL_AGENT !== "1",
  "用例 13 靠 guardAgentSpawn 拦住真 CLI;拦截器一失效,测试就会拿用户的真额度跑 agent",
);
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
  git(repo, "config", "user.name", "Harness Accept Test");
  git(repo, "config", "user.email", "accept@example.test");
  writeFileSync(join(repo, ".gitignore"), ".worktrees/\n");
  writeFileSync(join(repo, "shared.txt"), "seed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "seed");
  return repo;
}

try {
  const { prepareWorktree, worktreeBranchName } = await import("../src/git.js");
  const {
    acceptTagName,
    cleanupAcceptedTask,
    cleanupPlanFor,
    mergeTaskBranch,
    withTemporaryCleanupOutcome,
  } = await import("../src/git-accept.js");
  const { taskBranchDiff } = await import("../src/git-diff.js");
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, sessions, tasks } = await import("../src/db/schema.js");
  const { sessionTranscriptPath } = await import("../src/transcript.js");
  const { beginAccepting, endAccepting } = await import("../src/acceptance-lock.js");
  const { flushConflictHandoff, handOffConflict } = await import("../src/accept-conflict.js");
  const { acceptTask } = await import("../src/task-accept.js");
  await ensureSchema();

  // 1. Pure ref-only fast-forward, followed by worktree + `branch -d` cleanup.
  {
    const repo = makeRepo("fast-forward");
    const taskId = "acceptff0001";
    const ws = await prepareWorktree(repo, taskId, "main");
    writeFileSync(join(ws.path, "ff.txt"), "fast forward\n");
    git(ws.path, "add", "-A");
    git(ws.path, "commit", "-m", "task ff");
    git(repo, "checkout", "-b", "parking"); // release main without touching task branch

    const before = await taskBranchDiff(repo, taskId, "main");
    assert.equal(before.available, true);
    assert.deepEqual(before.files.map((file) => file.path), ["ff.txt"]);
    assert.match(before.diff, /fast forward/);
    const capped = await taskBranchDiff(repo, taskId, "main", 16);
    assert.equal(capped.truncated, true);
    assert.ok(Buffer.byteLength(capped.diff) <= 16);

    const merged = await mergeTaskBranch(repo, taskId, "main");
    assert.equal(merged.ok, true);
    if (!merged.ok) throw new Error(merged.message);
    assert.equal(merged.method, "fast_forward");
    assert.equal(git(repo, "rev-parse", "main"), git(repo, "rev-parse", worktreeBranchName(taskId)));

    const cleanup = await cleanupAcceptedTask(repo, taskId, "main");
    assert.equal(cleanup.ok, true);
    if (!cleanup.ok) throw new Error(cleanup.message);
    assert.equal(cleanup.worktreeRemoved, true);
    assert.equal(cleanup.branchDeleted, true);
    assert.equal(existsSync(ws.path), false);
    assert.equal(hasRef(repo, worktreeBranchName(taskId)), false);
  }

  // 2. Diverged histories: merge in a temporary target worktree with --no-ff.
  {
    const repo = makeRepo("no-fast-forward");
    const taskId = "acceptnf0002";
    const ws = await prepareWorktree(repo, taskId, "main");
    writeFileSync(join(ws.path, "source.txt"), "source side\n");
    git(ws.path, "add", "-A");
    git(ws.path, "commit", "-m", "source side");
    writeFileSync(join(repo, "target.txt"), "target side\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "target side");
    git(repo, "checkout", "-b", "parking");

    const merged = await mergeTaskBranch(repo, taskId, "main");
    assert.equal(merged.ok, true);
    if (!merged.ok) throw new Error(merged.message);
    assert.equal(merged.method, "merge_commit");
    assert.equal(git(repo, "rev-list", "--parents", "-n", "1", "main").split(" ").length, 3);
    assert.equal(git(repo, "show", "main:source.txt"), "source side");
    assert.equal(git(repo, "show", "main:target.txt"), "target side");
  }

  // 3. Conflict: collect files, abort, remove the temporary worktree, preserve refs.
  {
    const repo = makeRepo("conflict");
    const taskId = "acceptcf0003";
    const ws = await prepareWorktree(repo, taskId, "main");
    writeFileSync(join(ws.path, "shared.txt"), "source version\n");
    git(ws.path, "add", "-A");
    git(ws.path, "commit", "-m", "source conflict");
    writeFileSync(join(repo, "shared.txt"), "target version\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "target conflict");
    const targetBefore = git(repo, "rev-parse", "main");
    git(repo, "checkout", "-b", "parking");

    const merged = await mergeTaskBranch(repo, taskId, "main");
    assert.equal(merged.ok, false);
    if (merged.ok) throw new Error("conflict unexpectedly merged");
    assert.equal(merged.reason, "merge_conflict");
    assert.deepEqual(merged.conflictFiles, ["shared.txt"]);
    assert.equal(git(repo, "rev-parse", "main"), targetBefore, "target ref must remain unchanged");
    assert.equal(hasRef(repo, worktreeBranchName(taskId)), true);
    assert.equal(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 2);
  }

  // 4. Source is already an ancestor of target: skip merge and clean directly.
  {
    const repo = makeRepo("already-merged");
    const taskId = "acceptam0004";
    const ws = await prepareWorktree(repo, taskId, "main");
    writeFileSync(join(ws.path, "already.txt"), "merged earlier\n");
    git(ws.path, "add", "-A");
    git(ws.path, "commit", "-m", "already merged work");
    git(repo, "worktree", "remove", "--force", ws.path);
    const branchOnlyDiff = await taskBranchDiff(repo, taskId, "main");
    assert.equal(branchOnlyDiff.available, true, "worktree 目录没了但分支还在时仍应能出 diff");
    assert.deepEqual(branchOnlyDiff.files.map((file) => file.path), ["already.txt"]);
    git(repo, "checkout", "-b", "parking");
    git(repo, "branch", "-f", "main", worktreeBranchName(taskId));

    const merged = await mergeTaskBranch(repo, taskId, "main");
    assert.equal(merged.ok, true);
    if (!merged.ok) throw new Error(merged.message);
    assert.equal(merged.method, "already_merged");
    const cleanup = await cleanupAcceptedTask(repo, taskId, "main");
    assert.equal(cleanup.ok, true);
    assert.equal(existsSync(ws.path), false);
    assert.equal(hasRef(repo, worktreeBranchName(taskId)), false);
  }

  // 5. Target is checked out in the project directory and dirty: report only.
  {
    const repo = makeRepo("dirty-target");
    const taskId = "acceptdt0005";
    const ws = await prepareWorktree(repo, taskId, "main");
    writeFileSync(join(ws.path, "task.txt"), "task output\n");
    git(ws.path, "add", "-A");
    git(ws.path, "commit", "-m", "task output");
    const targetBefore = git(repo, "rev-parse", "main");
    writeFileSync(join(repo, "shared.txt"), "local dirty change\n");

    const merged = await mergeTaskBranch(repo, taskId, "main");
    assert.equal(merged.ok, false);
    if (merged.ok) throw new Error("dirty target unexpectedly merged");
    assert.equal(merged.reason, "target_dirty");
    assert.deepEqual(merged.dirtyFiles, ["shared.txt"]);
    assert.equal(git(repo, "rev-parse", "main"), targetBefore);
    assert.equal(existsSync(ws.path), true);
    assert.equal(hasRef(repo, worktreeBranchName(taskId)), true);
  }

  // 6. A failed temporary-worktree cleanup is a warning, not a merge failure.
  {
    const worktreePath = "/tmp/harness-accept-test-cleanup/worktree";
    const merged = withTemporaryCleanupOutcome({
      ok: true,
      sourceBranch: "harness/cleanup",
      targetBranch: "main",
      method: "merge_commit",
    }, "permission denied", worktreePath);
    assert.equal(merged.ok, true, "清理失败不能掩盖已经成功的合并");
    if (!merged.ok) throw new Error(merged.message);
    assert.equal(merged.warnings?.[0]?.reason, "temporary_cleanup_failed");
    assert.equal(merged.warnings?.[0]?.worktreePath, worktreePath);
    assert.match(merged.warnings?.[0]?.message ?? "", /合并结果已保留/);
    assert.match(merged.warnings?.[0]?.message ?? "", /git worktree prune/);
  }

  // 7. An idle team lead cannot accept while shared-worktree workers are active.
  {
    const repo = makeRepo("team-in-flight");
    const createdAt = new Date().toISOString();
    const leadId = "teamlead0007";
    await db.insert(projects).values({ id: "team-project", name: "team", repoPath: repo, createdAt });
    const common = {
      projectId: "team-project",
      body: "",
      labels: "[]",
      dependsOn: "[]",
      resumeDependsOn: "[]",
      createdAt,
      updatedAt: createdAt,
    };
    await db.insert(tasks).values([
      { ...common, id: leadId, title: "team lead", mode: "team", status: "idle", useWorktree: true, worktreeBase: "main" },
      { ...common, id: "shared-running", parentId: leadId, title: "shared running", mode: "single", status: "running", useWorktree: false },
      { ...common, id: "shared-queued", parentId: leadId, title: "shared queued", mode: "single", status: "queued", useWorktree: false },
      { ...common, id: "isolated-running", parentId: leadId, title: "isolated running", mode: "single", status: "running", useWorktree: true },
    ]);

    const accepted = await acceptTask(leadId);
    assert.equal(accepted.accepted, false);
    if (accepted.accepted) throw new Error("team accept unexpectedly succeeded");
    assert.equal(accepted.httpStatus, 409);
    assert.equal(accepted.reason, "shared_team_workers_in_flight");
    assert.equal(accepted.status, "idle", "调度台自身 idle，应由共享执行者而不是自身状态阻挡");
    assert.equal(accepted.phase, "initial");
    assert.deepEqual(
      accepted.inFlightTasks
        ?.map((task) => ({ id: task.id, status: task.status, role: task.role }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      [
        { id: "shared-queued", status: "queued", role: "shared_worker" },
        { id: "shared-running", status: "running", role: "shared_worker" },
      ],
    );
  }

  // 8. Shared workers reject direct acceptance; team acceptance links all shared stages.
  {
    const repo = makeRepo("team-linked-acceptance");
    const createdAt = new Date().toISOString();
    const projectId = "team-linked-project";
    const leadId = "teamlead0008";
    const sharedId = "shared-done";
    const sharedAcceptedId = "shared-accepted";
    const isolatedId = "isolated-done";
    await db.insert(projects).values({ id: projectId, name: "team linked", repoPath: repo, createdAt });
    const common = {
      projectId,
      body: "",
      labels: "[]",
      dependsOn: "[]",
      resumeDependsOn: "[]",
      createdAt,
      updatedAt: createdAt,
    };
    await db.insert(tasks).values([
      { ...common, id: leadId, title: "team lead", mode: "team", status: "idle", useWorktree: false },
      { ...common, id: sharedId, parentId: leadId, title: "shared done", mode: "single", status: "done", stage: "verified", useWorktree: false },
      { ...common, id: sharedAcceptedId, parentId: leadId, title: "shared accepted", mode: "single", status: "done", stage: "accepted", useWorktree: false },
      { ...common, id: isolatedId, parentId: leadId, title: "isolated done", mode: "single", status: "done", stage: "awaiting_acceptance", useWorktree: true },
    ]);

    const workerAcceptance = await acceptTask(sharedId);
    assert.equal(workerAcceptance.accepted, false);
    if (workerAcceptance.accepted) throw new Error("shared worker accept unexpectedly succeeded");
    assert.equal(workerAcceptance.httpStatus, 409);
    assert.equal(workerAcceptance.reason, "shared_worker_acceptance_not_applicable");
    assert.equal(workerAcceptance.error, "执行者不需人工验收，请对团队整体验收");

    const teamAcceptance = await acceptTask(leadId);
    assert.equal(teamAcceptance.accepted, true);
    if (!teamAcceptance.accepted) throw new Error(teamAcceptance.error);
    assert.equal(teamAcceptance.kind, "in_place");
    assert.equal(teamAcceptance.sharedWorkersAccepted, 1, "已 accepted 的共享执行者应跳过，不重复发阶段事件");

    const linked = await db.select().from(tasks);
    const stageOf = (id: string) => linked.find((task) => task.id === id)?.stage;
    assert.equal(stageOf(leadId), "accepted");
    assert.equal(stageOf(sharedId), "accepted");
    assert.equal(stageOf(sharedAcceptedId), "accepted");
    assert.equal(stageOf(isolatedId), "awaiting_acceptance", "独立 worktree 执行者仍由自身验收");
  }

  // 9. 线上写「squash 合并」：目标分支上只多出一个提交，任务分支照旧留着。
  {
    const repo = makeRepo("squash");
    const taskId = "acceptsq0009";
    const ws = await prepareWorktree(repo, taskId, "main");
    for (const n of ["one", "two"]) {
      writeFileSync(join(ws.path, `${n}.txt`), `${n}\n`);
      git(ws.path, "add", "-A");
      git(ws.path, "commit", "-m", `task ${n}`);
    }
    const before = git(repo, "rev-parse", "main");
    git(repo, "checkout", "-b", "parking");

    const merged = await mergeTaskBranch(repo, taskId, "main", "squash");
    assert.equal(merged.ok, true);
    if (!merged.ok) throw new Error(merged.message);
    assert.equal(merged.method, "squash");
    assert.equal(
      git(repo, "rev-list", "--count", `${before}..main`), "1",
      "两个提交压成一个",
    );
    assert.equal(
      git(repo, "show", "--name-only", "--format=", "main").split("\n").sort().join(","),
      "one.txt,two.txt",
      "两次改动都进去了",
    );
    assert.notEqual(git(repo, "rev-parse", "main"), git(repo, "rev-parse", worktreeBranchName(taskId)));

    // squash 之后 git 不认为任务分支已合并，所以自动清理**不去删分支**（绝不用 -D）。
    const cleanup = await cleanupAcceptedTask(repo, taskId, "main", { worktree: true, branch: false });
    assert.equal(cleanup.ok, true);
    if (!cleanup.ok) throw new Error(cleanup.message);
    assert.equal(cleanup.worktreeRemoved, true);
    assert.equal(cleanup.branchDeleted, false);
    assert.equal(existsSync(ws.path), false);
    assert.equal(hasRef(repo, worktreeBranchName(taskId)), true, "分支保留，用户想删自己删");
  }

  // 10. 线上写「只打标签，不合并」：目标分支一个字节都不动。
  {
    const repo = makeRepo("tag-only");
    const taskId = "accepttg0010";
    const ws = await prepareWorktree(repo, taskId, "main");
    writeFileSync(join(ws.path, "tagged.txt"), "tagged\n");
    git(ws.path, "add", "-A");
    git(ws.path, "commit", "-m", "task tagged");
    const before = git(repo, "rev-parse", "main");

    const merged = await mergeTaskBranch(repo, taskId, "main", "tag");
    assert.equal(merged.ok, true);
    if (!merged.ok) throw new Error(merged.message);
    assert.equal(merged.method, "tagged");
    assert.equal(merged.tag, acceptTagName(taskId));
    assert.equal(git(repo, "rev-parse", "main"), before, "目标分支没动");
    assert.equal(
      git(repo, "rev-parse", `${acceptTagName(taskId)}^{commit}`),
      git(repo, "rev-parse", worktreeBranchName(taskId)),
      "标签打在任务分支的头上",
    );

    // 再验一次是幂等的（同一个提交上重复打标签不算错）
    const again = await mergeTaskBranch(repo, taskId, "main", "tag");
    assert.equal(again.ok, true, "标签已经指向这个提交了，再点一次验收不该报错");

    // 但标签若已经指向**别的**提交，就绝不覆盖：那多半是别人的东西，
    // 覆盖掉之后原来指的提交可能再也找不回来。宁可停下来说清楚，让人自己处置。
    const tagged = git(repo, "rev-parse", `${acceptTagName(taskId)}^{commit}`);
    writeFileSync(join(ws.path, "more.txt"), "more\n");
    git(ws.path, "add", "-A");
    git(ws.path, "commit", "-m", "task moved on");
    const clash = await mergeTaskBranch(repo, taskId, "main", "tag");
    assert.equal(clash.ok, false, "标签指着别的提交时不许悄悄挪走它");
    if (!clash.ok) {
      assert.match(clash.message, /已经存在/, "并且把「为什么没做」说清楚");
      assert.equal(clash.reason, "merge_failed");
    }
    assert.equal(
      git(repo, "rev-parse", `${acceptTagName(taskId)}^{commit}`),
      tagged,
      "标签原样没动",
    );
  }

  // 11. 清理档位：「只删 worktree，分支留着」与「都留着」。
  {
    assert.deepEqual(cleanupPlanFor("all"), { worktree: true, branch: true });
    assert.deepEqual(cleanupPlanFor("worktree"), { worktree: true, branch: false });
    assert.deepEqual(cleanupPlanFor("none"), { worktree: false, branch: false });

    const repo = makeRepo("keep-branch");
    const taskId = "acceptkb0011";
    const ws = await prepareWorktree(repo, taskId, "main");
    writeFileSync(join(ws.path, "keep.txt"), "keep\n");
    git(ws.path, "add", "-A");
    git(ws.path, "commit", "-m", "task keep");
    git(repo, "checkout", "-b", "parking");
    const merged = await mergeTaskBranch(repo, taskId, "main");
    assert.equal(merged.ok, true);

    const kept = await cleanupAcceptedTask(repo, taskId, "main", cleanupPlanFor("none"));
    assert.equal(kept.ok, true);
    if (!kept.ok) throw new Error(kept.message);
    assert.equal(kept.worktreeRemoved, false);
    assert.equal(kept.branchDeleted, false);
    assert.equal(existsSync(ws.path), true, "「都留着」就真的一个都不删");

    const halfway = await cleanupAcceptedTask(repo, taskId, "main", cleanupPlanFor("worktree"));
    assert.equal(halfway.ok, true);
    if (!halfway.ok) throw new Error(halfway.message);
    assert.equal(halfway.worktreeRemoved, true);
    assert.equal(halfway.branchDeleted, false);
    assert.equal(existsSync(ws.path), false);
    assert.equal(hasRef(repo, worktreeBranchName(taskId)), true, "已合并也照样按线上写的留着分支");
  }

  // 12. 清理被脏工作区拦下时，报错要指名道姓说是哪几个文件。
  //     git 只回一句 "contains modified or untracked files"，而这障碍不会自己消失：不说
  //     文件名，用户每重试一次都撞同一堵墙、还是同一句看不出所以然的话（实测事故：一个
  //     忘了删的 _v3_fixed.ts 让验收连着卡了三次，时间线里也只有 git 那句原话）。
  {
    const repo = makeRepo("dirty-worktree");
    const taskId = "acceptdw0012";
    const ws = await prepareWorktree(repo, taskId, "main");
    writeFileSync(join(ws.path, "done.txt"), "done\n");
    git(ws.path, "add", "-A");
    git(ws.path, "commit", "-m", "task done");
    git(repo, "checkout", "-b", "parking");
    assert.equal((await mergeTaskBranch(repo, taskId, "main")).ok, true);

    // 一个未跟踪、一个已跟踪但改过——两种都该被点名。
    writeFileSync(join(ws.path, "scratch-draft.ts"), "// 忘了删的草稿\n");
    writeFileSync(join(ws.path, "done.txt"), "done\nlocal edit\n");

    const blocked = await cleanupAcceptedTask(repo, taskId, "main");
    assert.equal(blocked.ok, false, "工作区脏就该拦住，不替用户拍板扔东西");
    if (blocked.ok) throw new Error("脏工作区竟然被清理了");
    assert.equal(blocked.reason, "worktree_remove_failed");
    assert.deepEqual(blocked.dirtyFiles, ["done.txt", "scratch-draft.ts"], "结构化字段给全量");
    for (const file of ["done.txt", "scratch-draft.ts"]) {
      assert.ok(blocked.message.includes(file), `报错原文要点名 ${file}，光转述 git 那句不算`);
    }
    assert.equal(existsSync(ws.path), true, "拦下之后工作区原样还在");

    // 收拾掉挡路的，再点一次验收就该一路走完——脱困办法确实管用。
    rmSync(join(ws.path, "scratch-draft.ts"));
    git(ws.path, "checkout", "--", "done.txt");
    const retried = await cleanupAcceptedTask(repo, taskId, "main");
    assert.equal(retried.ok, true, "障碍清掉后重试要能过");
    assert.equal(existsSync(ws.path), false);
  }

  // 13. 撞冲突要**真的**把任务叫醒 —— 时间线写了「已叫醒」，就必须有一轮真的起来。
  //     回归的是 2026-08-14 那个现场：唤醒发在验收锁**里面**，continueTask 一进门查
  //     isAcceptingTask 就静默退避返回 false，而调用处是 `void` 掉的，退避连个响都没有：
  //     任务纹丝不动，用户对着「已叫醒该任务去解冲突」干等了一早上。
  {
    const repo = makeRepo("conflict-handoff");
    const taskId = "acceptch0013";
    const createdAt = new Date().toISOString();
    const ws = await prepareWorktree(repo, taskId, "main");
    writeFileSync(join(ws.path, "shared.txt"), "source version\n");
    git(ws.path, "add", "-A");
    git(ws.path, "commit", "-m", "source conflict");
    writeFileSync(join(repo, "shared.txt"), "target version\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "target conflict");
    git(repo, "checkout", "-b", "parking"); // 让 main 不被占用，冲突才是唯一的拦路点

    await db.insert(projects).values({ id: "handoff-project", name: "handoff", repoPath: repo, createdAt });
    await db.insert(tasks).values({
      id: taskId,
      projectId: "handoff-project",
      title: "conflict handoff",
      body: "",
      mode: "single",
      status: "done",
      stage: "verified",
      labels: "[]",
      dependsOn: "[]",
      resumeDependsOn: "[]",
      agentType: "claude",
      useWorktree: true,
      worktreeBase: "main",
      autoTitle: false,
      createdAt,
      updatedAt: createdAt,
    });
    // 时间线只写得进**已有会话**（没跑过的任务没有落点），交接说明要能落盘就得先有这一行。
    const seededSession = "handoffsess13";
    await db.insert(sessions).values({
      id: seededSession,
      taskId,
      role: "single",
      agentType: "claude",
      executor: "claude",
      cwd: ws.path,
      worktreePath: ws.path,
      branch: worktreeBranchName(taskId),
      startedAt: createdAt,
      turnStartedAt: createdAt,
      endedAt: createdAt,
      activeMs: 0,
    });

    const result = await acceptTask(taskId);
    assert.equal(result.accepted, false);
    if (result.accepted) throw new Error("conflict unexpectedly accepted");
    assert.equal(result.reason, "merge_conflict");
    assert.equal(result.conflictHandoff?.notified, true, "撞冲突要交接给任务自己解");

    // 「起了一轮」的硬证据：多出一行会话。轮询而不是等固定时长——唤醒是异步发出的。
    const turnStarted = async () =>
      (await db.select().from(sessions).where(eq(sessions.taskId, taskId))).length > 1;
    for (let i = 0; i < 100 && !(await turnStarted()); i++) {
      await new Promise((done) => setTimeout(done, 50));
    }
    assert.equal(await turnStarted(), true, "时间线说「已叫醒」，就必须真有一轮跑起来");
    const timeline = readFileSync(sessionTranscriptPath(taskId, seededSession), "utf8");
    assert.match(timeline, /冲突交接：/, "交接说明要留在时间线上（刷新后仍看得见）");
    assert.equal(timeline.includes("冲突交接失败"), false, "真叫醒了就不该同时写着失败");
  }

  // 14. 交接**投递不出去**时必须留字。老代码是 `void continueTask(...)`：验收互斥让它
  //     返回 false（不是抛错），`.catch` 接不到，于是「已叫醒」写在时间线上、任务却一动
  //     没动。这里把锁按住不放，逼出那条投递失败路径：可以叫不醒，但不许没声音。
  {
    const taskId = "acceptcs0014";
    const createdAt = new Date().toISOString();
    const seededSession = "handoffsess14";
    await db.insert(tasks).values({
      id: taskId,
      projectId: "handoff-project",
      title: "conflict handoff silent",
      body: "",
      mode: "single",
      status: "done",
      labels: "[]",
      dependsOn: "[]",
      resumeDependsOn: "[]",
      agentType: "claude",
      useWorktree: true,
      autoTitle: false,
      createdAt,
      updatedAt: createdAt,
    });
    await db.insert(sessions).values({
      id: seededSession,
      taskId,
      role: "single",
      agentType: "claude",
      executor: "claude",
      cwd: root,
      startedAt: createdAt,
      turnStartedAt: createdAt,
      endedAt: createdAt,
      activeMs: 0,
    });

    assert.equal(beginAccepting(taskId), true);
    try {
      const handoff = await handOffConflict({ id: taskId, title: "conflict handoff silent" }, {
        reason: "merge_conflict",
        sourceBranch: `harness/${taskId}`,
        targetBranch: "main",
        conflictFiles: ["shared.txt"],
      });
      assert.equal(handoff?.notified, true);
      flushConflictHandoff(taskId);
      const transcript = sessionTranscriptPath(taskId, seededSession);
      const reported = () =>
        existsSync(transcript) && readFileSync(transcript, "utf8").includes("冲突交接失败");
      for (let i = 0; i < 100 && !reported(); i++) {
        await new Promise((done) => setTimeout(done, 50));
      }
      assert.equal(reported(), true, "叫不醒就得说，绝不能只留下一句「已叫醒」");
    } finally {
      endAccepting(taskId);
    }
  }

  console.log("accept merge: git 场景 / 三种合并档位 / 清理档位 / 清理警告 / 脏工作区点名 / team 并发守卫 / 共享执行者验收口径 / 冲突交接真唤醒 全部通过");
} finally {
  // 删舞台前先松开库文件,否则 Windows 上必然 EBUSY(理由见 tmp-db.ts 的 releaseTmpDb)。
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
