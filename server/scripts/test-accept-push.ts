// 验收「推送到远程」那一档的回归用例（task-accept-push.ts / git-accept-remote.ts）：
// 先把远程的新提交快进进本地目标分支再合、合完推上去不强推；远程的新改动跟任务撞冲突照常交回任务去解；
// 本地和远程分叉、拉不到远程、不提交、没有远程，都在动 git 之前拒绝。
//
// 每个用例自带一个临时仓库 + 一个裸仓库当远程（再 clone 一份当「别人」往远程推），出不了临时目录。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

const root = mkdtempSync(join(tmpdir(), "navi-accept-push-test-"));
process.env.NAVI_DB = join(root, "navi.db");
process.env.NAVI_RUNS_DIR = join(root, "runs");
process.on("exit", () => { try { rmSync(root, { recursive: true, force: true }); } catch {} });
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const identity = (repo: string) => {
  git(repo, "config", "user.name", "Navi Push Test");
  git(repo, "config", "user.email", "push@example.test");
};

/** 项目仓库 + 裸远程（main 已推上去、设好上游）+ 「别人」的克隆。 */
function makeStage(name: string): { repo: string; remote: string; other: string } {
  const repo = join(root, name);
  const remote = join(root, `${name}.git`);
  const other = join(root, `${name}-other`);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  identity(repo);
  writeFileSync(join(repo, ".gitignore"), ".worktrees/\n");
  writeFileSync(join(repo, "shared.txt"), "seed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "-q", "-u", "origin", "main");
  execFileSync("git", ["clone", "-q", remote, other]);
  identity(other);
  return { repo, remote, other };
}

/** 「别人」往远程 main 推一个提交。 */
function pushFromOther(other: string, file: string, content: string): string {
  git(other, "pull", "-q", "--ff-only");
  writeFileSync(join(other, file), content);
  git(other, "add", "-A");
  git(other, "commit", "-q", "-m", `other ${file}`);
  git(other, "push", "-q", "origin", "main");
  return git(other, "rev-parse", "HEAD");
}

try {
  const { prepareWorktree } = await import("../src/git.js");
  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks } = await import("../src/db/schema.js");
  const { acceptTask } = await import("../src/task-accept.js");
  const { pushTargetBranch, resolvePushTarget } = await import("../src/git-accept-remote.js");
  const { parseChoices } = await import("../src/accept-gate-handoff.js");
  await ensureSchema();

  const createdAt = new Date().toISOString();
  let seq = 0;
  /** 在 repo 上建一个项目 + 一个已完成的任务（分支上改了 file）。 */
  const seedTask = async (repo: string, file: string, content: string, project: Partial<typeof projects.$inferInsert> = {}) => {
    seq += 1;
    const projectId = `push-project-${seq}`;
    const taskId = `pushtask${String(seq).padStart(4, "0")}`;
    await db.insert(projects).values({ id: projectId, name: `push-${seq}`, repoPath: repo, createdAt, ...project });
    const ws = await prepareWorktree(repo, taskId, "main");
    writeFileSync(join(ws.path, file), content);
    git(ws.path, "add", "-A");
    git(ws.path, "commit", "-q", "-m", `task ${file}`);
    await db.insert(tasks).values({
      id: taskId, projectId, title: file, body: "", mode: "single", status: "done", stage: "verified",
      labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "claude",
      useWorktree: true, worktreeBase: "main", mergeTargetBranch: "main",
      autoTitle: false, createdAt, updatedAt: createdAt,
    });
    return taskId;
  };
  const stageOf = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!.stage;

  // 1. 推到哪：照 git 自己的口径（pushRemote → pushDefault → 上游 → origin）；没有远程就不提供。
  {
    const bare = join(root, "no-remote");
    execFileSync("git", ["init", "-q", "-b", "main", bare]);
    assert.equal(await resolvePushTarget(bare, "main"), null, "没有远程就没有可推的地方");
    const { repo, remote } = makeStage("resolve");
    assert.deepEqual(await resolvePushTarget(repo, "main"), { remote: "origin", remoteBranch: "main" });
    git(repo, "remote", "add", "mirror", remote);
    git(repo, "config", "branch.main.pushRemote", "mirror");
    assert.deepEqual(await resolvePushTarget(repo, "main"), { remote: "mirror", remoteBranch: "main" }, "pushRemote 优先");
    git(repo, "config", "--unset", "branch.main.pushRemote");
    git(repo, "branch", "-q", "trunk");
    assert.deepEqual(await resolvePushTarget(repo, "trunk"), { remote: "origin", remoteBranch: "trunk" }, "没上游时推到 origin 的同名分支");
    git(repo, "config", "branch.trunk.remote", ".");
    assert.equal(await resolvePushTarget(repo, "trunk"), null, "上游是本地分支：不推");
  }

  // 2. 远程在这期间被别人推了一个不冲突的提交：先同步进本地 main，再合，再推；远程和本地 main 一致，两边的改动都在。
  {
    const { repo, remote } = makeStage("sync-push");
    const taskId = await seedTask(repo, "task.txt", "task\n");
    const theirs = pushFromOther(join(root, "sync-push-other"), "other.txt", "other\n");
    const result = await acceptTask(taskId, "human", { push: true });
    assert.equal(result.accepted, true, result.accepted ? "" : result.error);
    if (!result.accepted) throw new Error(result.error);
    assert.equal(result.push?.ok, true, "选了推送就要真的推上去");
    const local = git(repo, "rev-parse", "main");
    assert.equal(git(remote, "rev-parse", "main"), local, "远程 main 就是本地合完的那一个");
    git(repo, "merge-base", "--is-ancestor", theirs, "main");
    assert.equal(readFileSync(join(repo, "task.txt"), "utf8"), "task\n", "项目目录检出着 main，合进来的文件在工作区里");
    assert.equal(readFileSync(join(repo, "other.txt"), "utf8"), "other\n", "远程的新提交同步进来了");
    assert.equal(await stageOf(taskId), "accepted");
    if (result.push?.ok) assert.equal(result.push.commit, local);
  }

  // 3. 没选推送：照老样子只合本地，远程一动不动。
  {
    const { repo, remote } = makeStage("no-push");
    const before = git(remote, "rev-parse", "main");
    const taskId = await seedTask(repo, "local.txt", "local\n");
    const result = await acceptTask(taskId, "human", {});
    assert.equal(result.accepted, true);
    if (!result.accepted) throw new Error(result.error);
    assert.equal(result.push, undefined);
    assert.equal(git(remote, "rev-parse", "main"), before, "没选推送就不许碰远程");
    assert.notEqual(git(repo, "rev-parse", "main"), before);
  }

  // 4. 远程的新提交跟任务撞冲突：本地 main 已同步到远程那一头，合并撞冲突、交回任务去解；远程和任务分支都没动。
  {
    const { repo, remote } = makeStage("conflict");
    const taskId = await seedTask(repo, "shared.txt", "task side\n");
    const theirs = pushFromOther(join(root, "conflict-other"), "shared.txt", "their side\n");
    const result = await acceptTask(taskId, "human", { push: true });
    assert.equal(result.accepted, false);
    if (result.accepted) throw new Error("撞冲突不该验收通过");
    assert.equal(result.reason, "merge_conflict");
    assert.deepEqual(result.conflictFiles, ["shared.txt"]);
    assert.equal(result.conflictHandoff?.notified, true, "冲突要交回任务自己解");
    assert.equal(git(repo, "rev-parse", "main"), theirs, "本地 main 已快进到远程那一头，任务 git merge main 就能拿到远程的改动");
    assert.equal(git(remote, "rev-parse", "main"), theirs, "远程一个字没动");
    assert.equal(git(repo, "status", "--porcelain"), "", "冲突已回滚，项目目录干净");
    assert.notEqual(await stageOf(taskId), "accepted");
  }

  // 5. 本地 main 有没推的提交、远程也有新的（分叉）：不替他合，什么都不动。
  {
    const { repo, remote } = makeStage("diverged");
    const taskId = await seedTask(repo, "task.txt", "task\n");
    writeFileSync(join(repo, "mine.txt"), "mine\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "local unpushed");
    const localBefore = git(repo, "rev-parse", "main");
    const theirs = pushFromOther(join(root, "diverged-other"), "other.txt", "other\n");
    const result = await acceptTask(taskId, "human", { push: true });
    assert.equal(result.accepted, false);
    if (result.accepted) throw new Error("分叉了不该验收");
    assert.equal(result.reason, "push_diverged");
    assert.equal(git(repo, "rev-parse", "main"), localBefore, "本地 main 不动");
    assert.equal(git(remote, "rev-parse", "main"), theirs, "远程不动");
    // 不推送照样能验收（分叉是用户自己的事，不挡不推的那一按）。
    const plain = await acceptTask(taskId, "human", {});
    assert.equal(plain.accepted, true, plain.accepted ? "" : plain.error);
  }

  // 6. 推不了的几种：不提交、没有远程、拉不到远程 —— 都在动 git 之前拒绝。
  {
    const { repo, remote } = makeStage("refuse");
    const before = git(repo, "rev-parse", "main");
    const noCommit = await seedTask(repo, "nc.txt", "nc\n");
    const r1 = await acceptTask(noCommit, "human", { push: true, commit: false });
    assert.equal(r1.accepted, false);
    if (!r1.accepted) assert.equal(r1.reason, "push_unavailable", "不提交就没有可推的");
    assert.equal(git(repo, "rev-parse", "main"), before);
    assert.equal(git(repo, "status", "--porcelain"), "", "拒绝时项目目录一个字没动");

    git(repo, "remote", "set-url", "origin", join(root, "missing.git"));
    const r2 = await acceptTask(noCommit, "human", { push: true });
    assert.equal(r2.accepted, false);
    if (!r2.accepted) assert.equal(r2.reason, "push_fetch_failed", "拉不到远程就不合");
    assert.equal(git(repo, "rev-parse", "main"), before);

    git(repo, "remote", "remove", "origin");
    const r3 = await acceptTask(noCommit, "human", { push: true });
    assert.equal(r3.accepted, false);
    if (!r3.accepted) assert.equal(r3.reason, "push_no_remote");
    assert.equal(git(repo, "rev-parse", "main"), before);
    void remote;
  }

  // 7. 推的那一下被拒（远程在合完之后又被人推了）：如实报 push_rejected，不强推。
  {
    const { repo, remote } = makeStage("rejected");
    writeFileSync(join(repo, "mine.txt"), "mine\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "local");
    const theirs = pushFromOther(join(root, "rejected-other"), "other.txt", "other\n");
    const outcome = await pushTargetBranch(repo, "main", { remote: "origin", remoteBranch: "main" });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason, "push_rejected");
    assert.equal(git(remote, "rev-parse", "main"), theirs, "被拒就是被拒，远程上别人的提交不许盖掉");
  }

  // 8. 门禁跑完自动接着验收的那一次要带上「推送」：存下来的选择读得回来，坏值不当真。
  {
    assert.equal(parseChoices(JSON.stringify({ by: "human", push: true }))?.push, true);
    assert.equal(parseChoices(JSON.stringify({ by: "human", push: "yes" }))?.push, undefined);
    assert.equal(parseChoices(JSON.stringify({ by: "human" }))?.push, undefined);
  }

  console.log("accept push: 推到哪 / 先同步再合再推 / 不推不碰远程 / 冲突交回任务 / 分叉与推不了都先拒 / 被拒不强推 / 门禁续做带上推送 全部通过");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
