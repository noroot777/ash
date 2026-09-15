// 「合并后不提交」那一档**验收之后**的收尾：核对现场、替用户落成提交、产物被丢掉之后
// 重新合一次。从 test-accept-commit-setting.ts 拆出来的 —— 那套验的是「合完要不要替你
// 提交」这个选择本身，这套验的是选了「不提交」之后那份改动的下场。
//
// 钉住的现场（2026-09-15）：用户选了不提交，验收完界面只给一句和正常验收一样的「验收
// 完成」，他看不出还欠一步、也找不到收尾的地方。所以这里逐条验：事实列分得出这一档、
// 现场三种态各判得对、动作只在该动的时候动（拿不准一律拒绝，绝不硬提交）。
//
// 每个用例自带一个临时仓库，checkout 和 ref 更新一律出不了临时目录。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "ash-pending-merge-test-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
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
  git(repo, "config", "user.name", "Ash Pending Test");
  git(repo, "config", "user.email", "pending@example.test");
  writeFileSync(join(repo, ".gitignore"), ".worktrees/\n");
  writeFileSync(join(repo, "shared.txt"), "seed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "seed");
  return repo;
}

try {
  const { prepareWorktree, worktreeBranchName } = await import("../src/git.js");
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks } = await import("../src/db/schema.js");
  const { acceptTask } = await import("../src/task-accept.js");
  const {
    commitPendingMerge, pendingMergeState, remergePendingMerge,
  } = await import("../src/task-accept-pending.js");
  await ensureSchema();

  const createdAt = new Date().toISOString();
  const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
  // 一个仓库 + 一个项目 + 一个待验收任务；`commit` 决定项目设置那一档。
  const stage = async (name: string, taskId: string, file: string, acceptCommit = false) => {
    const repo = makeRepo(name);
    const projectId = `${name}-project`;
    await db.insert(projects).values({ id: projectId, name, repoPath: repo, acceptCommit, createdAt });
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
    return { repo, projectId, base: git(repo, "rev-parse", "main") };
  };
  const stateOf = async (taskId: string) => {
    const result = await pendingMergeState(taskId);
    if ("ok" in result) throw new Error(`读现场失败：${result.error}`);
    return result.state;
  };

  // 1. 还躺着没提交 → 事实列认得出这一档，卡片能给出「现在提交」，提交之后一切收口。
  {
    const taskId = "pmstaged0001";
    const { repo, base } = await stage("staged", taskId, "pending.txt");
    const accepted = await acceptTask(taskId);
    assert.equal(accepted.accepted, true);
    if (!accepted.accepted) throw new Error(accepted.error);
    assert.equal(accepted.merge, "no_commit");

    const seeded = await row(taskId);
    assert.equal(seeded.acceptedMergeMethod, "no_commit", "「怎么合的」必须落成事实列，不能让 UI 靠 null 去猜");
    assert.ok(seeded.acceptedPendingTree, "不提交那一档要留下索引内容指纹，否则事后没有核对的依据");
    assert.equal(seeded.acceptedMergeCommit, null);

    const staged = await stateOf(taskId);
    assert.equal(staged?.kind, "staged");
    assert.equal(staged?.canCommit, true);
    assert.equal(staged?.canRemerge, false, "改动还在，重新合只会被自己判成脏工作区");
    assert.deepEqual(staged?.stagedFiles, ["pending.txt"]);
    assert.match(staged!.message, /还躺在/);

    const done = await commitPendingMerge(taskId);
    assert.equal(done.ok, true);
    if (!done.ok) throw new Error(done.error);
    assert.notEqual(git(repo, "rev-parse", "main"), base, "点了「现在提交」就该真的产生提交");
    assert.equal(git(repo, "rev-parse", "main"), done.commit);
    assert.equal(git(repo, "log", "-1", "--pretty=%s"), `squash 合并 ${worktreeBranchName(taskId)}`,
      "提交消息沿用正常验收那一条");
    assert.equal(git(repo, "status", "--porcelain"), "", "提交完工作区就该干净了");
    const after = await row(taskId);
    assert.equal(after.acceptedMergeCommit, done.commit, "快照要补齐，合并结果审查靠它");
    assert.equal(after.acceptedMergeMethod, "no_commit", "「当初是不提交那一档验收的」是事实，不该被改写");
    // 清理重跑：squash 出来的是新提交，git 不认为分支已合并，所以只报告、绝不 -D。
    assert.equal(hasRef(repo, worktreeBranchName(taskId)), true, "分支不许被强删");
    assert.ok(done.notices?.some((notice) => /保留/.test(notice)), `清理重跑要如实说分支留着：${done.notices}`);
    assert.equal(done.state.kind, "committed");
    assert.equal((await stateOf(taskId))?.kind, "committed");

    // 收口之后再点一次：什么都没得做，如实 409（而不是又提交一次空提交）。
    const again = await commitPendingMerge(taskId);
    assert.equal(again.ok, false);
    if (again.ok) throw new Error("已经收尾的不该还能再提交一次");
    assert.equal(again.reason, "not_pending");
  }

  // 2. 索引被人动过 → 拿不准就拒绝，一个字节都不提交（不能把无关改动裹进这次合并）。
  {
    const taskId = "pmforeign001";
    const { repo, base } = await stage("foreign", taskId, "mine.txt");
    const accepted = await acceptTask(taskId);
    assert.equal(accepted.accepted, true);
    if (!accepted.accepted) throw new Error(accepted.error);

    // 用户在这中间自己 `git add` 了一个无关文件。
    writeFileSync(join(repo, "unrelated.txt"), "someone else\n");
    git(repo, "add", "unrelated.txt");

    const foreign = await stateOf(taskId);
    assert.equal(foreign?.kind, "foreign");
    assert.equal(foreign?.canCommit, false);
    assert.match(foreign!.message, /不替你提交/);

    const refused = await commitPendingMerge(taskId);
    assert.equal(refused.ok, false);
    if (refused.ok) throw new Error("索引对不上时绝不能硬提交");
    assert.equal(refused.reason, "foreign");
    assert.equal(git(repo, "rev-parse", "main"), base, "拒绝就得真的什么都没做");
    assert.equal((await row(taskId)).acceptedMergeCommit, null);
  }

  // 3. 改动被 reset --hard 丢了 → 认出来，并给「重新合一次」这条出路（现场里用户走投无路
  //    的直接原因就是这个入口在 stage=accepted 时被前端整个关死了）。
  {
    const taskId = "pmdiscard001";
    const { repo, base } = await stage("discarded", taskId, "lost.txt");
    const accepted = await acceptTask(taskId);
    assert.equal(accepted.accepted, true);
    if (!accepted.accepted) throw new Error(accepted.error);
    git(repo, "reset", "--hard");

    const discarded = await stateOf(taskId);
    assert.equal(discarded?.kind, "discarded");
    assert.equal(discarded?.canCommit, false);
    assert.equal(discarded?.canRemerge, true, "来源分支还在，就得给重新合一次的出路");

    const remerged = await remergePendingMerge(taskId, true);
    assert.equal(remerged.ok, true);
    if (!remerged.ok) throw new Error(remerged.error);
    assert.notEqual(git(repo, "rev-parse", "main"), base);
    assert.equal(git(repo, "show", "main:lost.txt"), "lost.txt", "重新合就得把那份改动真的合回去");
    const after = await row(taskId);
    assert.ok(after.acceptedMergeCommit, "这一次落了提交，快照要记下来");
    assert.notEqual(after.acceptedMergeMethod, "no_commit", "这一次是提交了的，事实列要跟着更新");
    assert.equal(remerged.state.kind, "committed");
  }

  // 4. 用户自己把那份改动提交了 → 按**内容**认出来（不认提交消息），顺手补齐快照。
  {
    const taskId = "pmbackfil001";
    const { repo } = await stage("backfill", taskId, "theirs.txt");
    const accepted = await acceptTask(taskId);
    assert.equal(accepted.accepted, true);
    if (!accepted.accepted) throw new Error(accepted.error);
    git(repo, "commit", "-m", "我自己提交的");
    const mine = git(repo, "rev-parse", "main");

    const committed = await stateOf(taskId);
    assert.equal(committed?.kind, "committed");
    assert.equal(committed?.commit, mine);
    assert.match(committed!.message, /你自己已经把那份改动提交了/);
    assert.equal((await row(taskId)).acceptedMergeCommit, mine, "读一眼现场就该把快照补齐");
  }

  // 5. 正常（落提交）那一档压根不该出现这张卡：事实列不是 no_commit 就直接没有现场可核对。
  {
    const taskId = "pmnormal0001";
    await stage("normal", taskId, "normal.txt", true);
    const accepted = await acceptTask(taskId);
    assert.equal(accepted.accepted, true);
    if (!accepted.accepted) throw new Error(accepted.error);
    assert.notEqual(accepted.merge, "no_commit");
    assert.equal(await stateOf(taskId), null, "落了提交的验收没有待收尾的合并");
    const refused = await commitPendingMerge(taskId);
    assert.equal(refused.ok, false);
    if (refused.ok) throw new Error("没有待收尾的合并却能提交");
    assert.equal(refused.reason, "not_pending");
  }

  console.log("accept pending-merge regression passed");
} finally {
  releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
