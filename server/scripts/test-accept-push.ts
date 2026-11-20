// 验收「推送到远程」那一档的回归用例（task-accept-push.ts / git-accept-remote.ts）：
// 先把远程的新提交快进进本地目标分支，在临时检出里合好、先推远程（不强推），远程收下了才快进本地；
// 远程的新改动跟任务撞冲突照常交回任务去解；本地和远程分叉、拉不到远程、不提交、没有远程，都在动 git 之前拒绝。
//
// 每个用例自带一个临时仓库 + 一个裸仓库当远程（再 clone 一份当「别人」往远程推），出不了临时目录。
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const { pushCommit, resolvePushTarget } = await import("../src/git-accept-remote.js");
  const { moveBranchGuarded } = await import("../src/git-guarded-move.js");
  const { pushDestination } = await import("../src/task-accept-push.js");
  const { parseChoices } = await import("../src/accept-gate-handoff.js");
  const { saveProjectGitCredential } = await import("../src/git-credentials.js");
  const { mergeTaskBranch } = await import("../src/git-accept.js");
  await ensureSchema();

  const createdAt = new Date().toISOString();
  let seq = 0;
  const wsOf = new Map<string, string>();
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
    wsOf.set(taskId, ws.path);
    return taskId;
  };
  const rowOf = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!;
  const projectOf = async (taskId: string) => (await db.select().from(projects).where(eq(projects.id, (await rowOf(taskId)).projectId))).at(0)!;
  /** 一次性的 pre-push 钩子：Navi 推的那一刻，「别人」先往远程推一个提交（模拟合完到推之间远程又动了）。 */
  const raceOnPush = (repo: string, other: string, file: string, content: string) => {
    const hook = join(repo, ".git", "hooks", "pre-push");
    writeFileSync(hook, `#!/bin/sh\nrm -f "$0"\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX\n`
      + `cd ${JSON.stringify(other)} && git pull -q --ff-only && printf %b ${JSON.stringify(content)} > ${JSON.stringify(file)}`
      + ` && git add -A && git commit -q -m "race ${file}" && git push -q origin main\n`, { mode: 0o755 });
  };
  const stageOf = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0)!.stage;

  // 1. 推到哪：照 git 自己的口径（pushRemote → pushDefault → 上游 → origin）；没有远程就不提供。
  {
    const bare = join(root, "no-remote");
    execFileSync("git", ["init", "-q", "-b", "main", bare]);
    assert.equal(await resolvePushTarget(bare, "main"), null, "没有远程就没有可推的地方");
    const { repo, remote } = makeStage("resolve");
    assert.deepEqual(await resolvePushTarget(repo, "main"), { remote: "origin", remoteBranch: "main", url: remote });
    git(repo, "remote", "add", "mirror", remote);
    git(repo, "config", "branch.main.pushRemote", "mirror");
    assert.deepEqual(await resolvePushTarget(repo, "main"), { remote: "mirror", remoteBranch: "main", url: remote }, "pushRemote 优先");
    git(repo, "config", "--unset", "branch.main.pushRemote");
    git(repo, "branch", "-q", "trunk");
    assert.deepEqual(await resolvePushTarget(repo, "trunk"), { remote: "origin", remoteBranch: "trunk", url: remote }, "没上游时推到 origin 的同名分支");
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

  // 7. 推的那一下被拒（远程在合完之后又被人推了）：如实报 push_rejected，不强推。推的是给定的那个提交。
  {
    const { repo, remote } = makeStage("rejected");
    writeFileSync(join(repo, "mine.txt"), "mine\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "local");
    const theirs = pushFromOther(join(root, "rejected-other"), "other.txt", "other\n");
    const outcome = await pushCommit(repo, git(repo, "rev-parse", "main"), { remote: "origin", remoteBranch: "main", url: remote }, null);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason, "push_rejected");
    assert.equal(git(remote, "rev-parse", "main"), theirs, "被拒就是被拒，远程上别人的提交不许盖掉");
  }

  // 8. 门禁跑完自动接着验收的那一次带的是冻结下来的目的地：存下来的读得回来，坏值、只有 true 都不当真。
  {
    const dest = { branch: "main", remote: "origin", remoteBranch: "main", url: "/x.git" };
    assert.deepEqual(parseChoices(JSON.stringify({ by: "human", push: dest }))?.push, dest);
    assert.equal(parseChoices(JSON.stringify({ by: "human", push: true }))?.push, undefined, "续做只认冻结的目的地");
    assert.equal(parseChoices(JSON.stringify({ by: "human", push: { ...dest, url: 3 } }))?.push, undefined);
    assert.equal(parseChoices(JSON.stringify({ by: "human" }))?.push, undefined);
  }

  // 9. 确认的目的地和执行时解析出来的不是同一处（审查第 1 轮 F1）：拒，什么都不动；一样就照常推。
  {
    const { repo, remote } = makeStage("dest-changed");
    const mirror = join(root, "dest-changed-mirror.git");
    execFileSync("git", ["clone", "-q", "--bare", remote, mirror]);
    const taskId = await seedTask(repo, "task.txt", "task\n");
    const shown = (await pushDestination(await rowOf(taskId), await projectOf(taskId)))!;
    assert.deepEqual(shown, { branch: "main", remote: "origin", remoteBranch: "main", url: remote });
    git(repo, "remote", "add", "mirror", mirror);
    git(repo, "config", "branch.main.pushRemote", "mirror");
    const before = git(repo, "rev-parse", "main");
    const changed = await acceptTask(taskId, "human", { push: shown });
    assert.equal(changed.accepted, false);
    if (!changed.accepted) assert.equal(changed.reason, "push_destination_changed");
    assert.equal(git(repo, "rev-parse", "main"), before, "目的地变了就不合");
    assert.equal(git(mirror, "rev-parse", "main"), before, "也不推到新的那一处");
    git(repo, "config", "--unset", "branch.main.pushRemote");
    const same = await acceptTask(taskId, "human", { push: shown });
    assert.equal(same.accepted, true, same.accepted ? "" : same.error);
    assert.equal(git(remote, "rev-parse", "main"), git(repo, "rev-parse", "main"), "推到的就是确认的那一处");
    assert.equal(git(mirror, "rev-parse", "main"), before);
  }

  // 10. 拉取地址和推送地址指向不同仓库（审查第 1 轮 N2）：从接收推送的那一个拉、推给它，拉取那个不碰。
  {
    const { repo, remote } = makeStage("pushurl");
    const receiver = join(root, "pushurl-receiver.git");
    execFileSync("git", ["clone", "-q", "--bare", remote, receiver]);
    const writer = join(root, "pushurl-writer");
    execFileSync("git", ["clone", "-q", receiver, writer]);
    identity(writer);
    const theirs = pushFromOther(writer, "receiver.txt", "receiver\n");
    git(repo, "remote", "set-url", "--push", "origin", receiver);
    const fetchSide = git(remote, "rev-parse", "main");
    const taskId = await seedTask(repo, "task.txt", "task\n");
    const result = await acceptTask(taskId, "human", { push: true });
    assert.equal(result.accepted, true, result.accepted ? "" : result.error);
    git(repo, "merge-base", "--is-ancestor", theirs, "main");
    assert.equal(git(receiver, "rev-parse", "main"), git(repo, "rev-parse", "main"), "推给的是推送地址那个仓库");
    assert.equal(git(remote, "rev-parse", "main"), fetchSide, "拉取地址那个仓库不碰");
  }

  // 11. 合完到推之间远程又被推了一个不冲突的提交（审查第 1 轮 F3）：本地没动过，同步、从头重新合、再推，最后验收通过。
  {
    const { repo, remote } = makeStage("race-clean");
    const taskId = await seedTask(repo, "task.txt", "task\n");
    raceOnPush(repo, join(root, "race-clean-other"), "other.txt", "other\n");
    const result = await acceptTask(taskId, "human", { push: true });
    assert.equal(result.accepted, true, result.accepted ? "" : result.error);
    assert.equal(result.push?.ok, true);
    assert.equal(git(remote, "rev-parse", "main"), git(repo, "rev-parse", "main"));
    assert.equal(readFileSync(join(repo, "other.txt"), "utf8"), "other\n", "期间别人推的那个提交同步进来了");
    assert.equal(readFileSync(join(repo, "task.txt"), "utf8"), "task\n");
    assert.equal(git(repo, "status", "--porcelain"), "", "项目目录干净");
  }

  // 12. 合完到推之间远程又被推了一个冲突的提交：同步进来、从头重新合撞冲突 → 交回任务去解，
  //     任务的分支和工作区都还在、没有落已验收；远程只有别人的那一个。
  {
    const { repo, remote } = makeStage("race-conflict");
    const taskId = await seedTask(repo, "shared.txt", "task side\n");
    raceOnPush(repo, join(root, "race-conflict-other"), "shared.txt", "their side\n");
    const result = await acceptTask(taskId, "human", { push: true });
    assert.equal(result.accepted, false);
    if (result.accepted) throw new Error("推送期间撞了冲突不该验收通过");
    assert.equal(result.reason, "merge_conflict");
    assert.equal(result.conflictHandoff?.notified, true, "冲突交回任务去解");
    const theirs = git(remote, "rev-parse", "main");
    assert.equal(git(repo, "rev-parse", "main"), theirs, "本地 main 是远程那一头，不带这次没推上去的合并");
    assert.equal(git(repo, "show", "main:shared.txt"), "their side");
    assert.equal(git(repo, "status", "--porcelain"), "");
    assert.notEqual((await rowOf(taskId)).stage, "accepted");
    assert.notEqual((await rowOf(taskId)).stage, "merged", "没推上去就不算合完");
    assert.equal(readFileSync(join(wsOf.get(taskId)!, "shared.txt"), "utf8"), "task side\n", "任务工作区还在，交回去能接着解");
  }

  // 13. 推不上去（远程拒收、远程也没动）：本地一个字节都没动（先推后落本地），什么都没留下；任务照旧可以再验收。
  {
    const { repo, remote } = makeStage("refused");
    writeFileSync(join(remote, "hooks", "pre-receive"), "#!/bin/sh\necho nope >&2\nexit 1\n", { mode: 0o755 });
    const before = git(repo, "rev-parse", "main");
    const taskId = await seedTask(repo, "task.txt", "task\n");
    const result = await acceptTask(taskId, "human", { push: true });
    assert.equal(result.accepted, false);
    if (!result.accepted) assert.equal(result.reason, "push_failed");
    assert.equal(git(repo, "rev-parse", "main"), before, "推不上去本地 main 就没动过");
    assert.equal(git(repo, "status", "--porcelain"), "", "检出也没动过");
    assert.equal(git(remote, "rev-parse", "main"), before);
    assert.notEqual((await rowOf(taskId)).stage, "merged");
    assert.equal(readFileSync(join(wsOf.get(taskId)!, "task.txt"), "utf8"), "task\n", "任务工作区还在");
  }

  // 14. 带护栏挪分支（审查第 1 轮 F2）：有别的 git 拿着 index.lock 就不动；这次要改的文件在检出里改着就不动，
  //     无关文件改着照挪、改动原样留着（审查第 3 轮 F2）；项目目录不在这个分支上就只挪 ref、不碰检出；正常时检出跟着挪。
  {
    const { repo } = makeStage("guarded");
    const base = git(repo, "rev-parse", "main");
    writeFileSync(join(repo, "next.txt"), "next\n");
    writeFileSync(join(repo, "shared.txt"), "next shared\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "next");
    const next = git(repo, "rev-parse", "main");
    git(repo, "reset", "-q", "--hard", base);
    writeFileSync(join(repo, ".git", "index.lock"), "");
    const busy = await moveBranchGuarded(repo, "main", base, next, "测试");
    assert.equal(busy.ok, false);
    if (!busy.ok) assert.equal(busy.reason, "target_busy");
    assert.equal(git(repo, "rev-parse", "main"), base);
    rmSync(join(repo, ".git", "index.lock"));
    writeFileSync(join(repo, "shared.txt"), "dirty\n");
    const dirty = await moveBranchGuarded(repo, "main", base, next, "测试");
    assert.equal(dirty.ok, false, "这次要改的文件改着：会被覆盖，不动");
    if (!dirty.ok) assert.equal(dirty.reason, "target_dirty");
    assert.equal(git(repo, "rev-parse", "main"), base);
    assert.equal(readFileSync(join(repo, "shared.txt"), "utf8"), "dirty\n", "用户的改动原样在");
    git(repo, "checkout", "-q", "--", "shared.txt");
    writeFileSync(join(repo, ".gitignore"), ".worktrees/\nlocal-edit\n");
    const stale = await moveBranchGuarded(repo, "main", next, base, "测试");
    assert.equal(stale.ok, false, "分支不在 from 上就不动");
    const moved = await moveBranchGuarded(repo, "main", base, next, "测试");
    assert.equal(moved.ok, true, moved.ok ? "" : moved.message);
    assert.equal(git(repo, "rev-parse", "main"), next);
    assert.equal(readFileSync(join(repo, "next.txt"), "utf8"), "next\n", "检出跟着挪");
    assert.equal(readFileSync(join(repo, "shared.txt"), "utf8"), "next shared\n");
    assert.equal(git(repo, "status", "--porcelain"), "M .gitignore", "无关文件的改动留着，其余索引和工作区都对齐");
    git(repo, "checkout", "-q", "--", ".gitignore");
    git(repo, "switch", "-q", "-c", "side", base);
    const refOnly = await moveBranchGuarded(repo, "main", next, base, "测试");
    assert.equal(refOnly.ok, true);
    assert.equal(git(repo, "rev-parse", "main"), base, "不在检出上的分支只挪 ref");
    assert.equal(git(repo, "rev-parse", "HEAD"), base);
    assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "side", "项目目录检出着的那个分支不受影响");
  }

  // 15. 目标分支哪儿都没检出时，挪它的那一下和别人 `git switch` 它撞在一起（审查第 2 轮 F1 实测的那一幕）：
  //     先占住再挪，那一下 switch 被 git 拒掉，项目目录还在原来的分支上、干净，不会凭空多出暂存改动。
  //     三处同形的挪法都钉：推送档的带护栏挪分支、普通纯快进、合并预览档的发布。
  {
    const shim = join(root, "shim");
    mkdirSync(shim, { recursive: true });
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    // 第一次见到挪 refs/heads/<分支> 的 update-ref 时，先在项目目录里 switch 过去（stderr 记进 mark），再照常执行。
    writeFileSync(join(shim, "git"), [
      "#!/bin/sh",
      'if [ -n "$SHIM_REPO" ] && [ ! -e "$SHIM_MARK" ]; then',
      "  u=; r=",
      '  for a in "$@"; do [ "$a" = update-ref ] && u=1; [ "$a" = "refs/heads/$SHIM_BRANCH" ] && r=1; done',
      `  if [ -n "$u" ] && [ -n "$r" ]; then "${realGit}" -C "$SHIM_REPO" switch -q "$SHIM_BRANCH" 2>"$SHIM_MARK" || true; touch "$SHIM_MARK"; fi`,
      "fi",
      `exec "${realGit}" "$@"`,
      "",
    ].join("\n"), { mode: 0o755 });
    const racing = async <T>(repo: string, run: () => Promise<T>): Promise<{ value: T; refused: string }> => {
      const mark = join(root, `mark-${seq++}`);
      const saved = { ...process.env };
      Object.assign(process.env, { PATH: `${shim}:${process.env.PATH}`, SHIM_REPO: repo, SHIM_BRANCH: "main", SHIM_MARK: mark });
      try { return { value: await run(), refused: existsSync(mark) ? readFileSync(mark, "utf8") : "（没触发）" }; }
      finally { for (const key of ["PATH", "SHIM_REPO", "SHIM_BRANCH", "SHIM_MARK"]) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } }
    };
    const unchecked = (repo: string) => {
      git(repo, "switch", "-q", "-c", "side");
      return git(repo, "rev-parse", "main");
    };
    const untouched = (repo: string, what: string) => {
      assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "side", `${what}：项目目录还在原来的分支上`);
      assert.equal(git(repo, "status", "--porcelain"), "", `${what}：没有凭空多出的改动`);
    };

    { // 推送档的带护栏挪分支（同步快进、推上去之后快进本地都走它）
      const { repo } = makeStage("claim-guarded");
      const base = unchecked(repo);
      writeFileSync(join(repo, "shared.txt"), "remote next\n");
      git(repo, "commit", "-q", "-am", "next");
      const next = git(repo, "rev-parse", "HEAD");
      git(repo, "reset", "-q", "--hard", base);
      const { value, refused } = await racing(repo, () => moveBranchGuarded(repo, "main", base, next, "测试"));
      assert.equal(value.ok, true, value.ok ? "" : value.message);
      assert.match(refused, /already (used by worktree|checked out)/, "占着期间别人检出不了它");
      assert.equal(git(repo, "rev-parse", "main"), next);
      untouched(repo, "带护栏挪分支");
      assert.equal(git(repo, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length, 1, "占用的临时 worktree 拆掉了");
    }
    { // 普通纯快进（验收合并没设门禁时）
      const { repo } = makeStage("claim-ff");
      const taskId = await seedTask(repo, "task.txt", "task\n");
      unchecked(repo);
      const { value, refused } = await racing(repo, () => acceptTask(taskId, "human"));
      assert.equal(value.accepted, true, value.accepted ? "" : value.error);
      assert.match(refused, /already (used by worktree|checked out)/);
      assert.equal(git(repo, "show", "main:task.txt"), "task");
      untouched(repo, "纯快进");
    }
    { // 合并预览档的发布（带测过的树）
      const { repo } = makeStage("claim-tested");
      const taskId = await seedTask(repo, "task.txt", "task\n");
      const base = unchecked(repo);
      const source = git(wsOf.get(taskId)!, "rev-parse", "HEAD");
      const { value, refused } = await racing(repo, () => mergeTaskBranch(repo, taskId, "main", "safe",
        { sourceCommit: source, expectedTarget: base, expectedTree: git(repo, "rev-parse", `${source}^{tree}`) }));
      assert.equal(value.ok, true, value.ok ? "" : value.message);
      assert.match(refused, /already (used by worktree|checked out)/);
      assert.equal(git(repo, "rev-parse", "main"), source);
      untouched(repo, "合并预览档发布");
    }
  }

  // 16. 项目里存了账号（私有仓库）：验收这一档的拉和推都带上它（审查第 2 轮 F3），同「更新远程」那几个入口。
  //     远程是要求 Basic 认证的 smart HTTP（git http-backend），凭证只存在 Navi 库里，不在 URL、不在 git 配置里。
  {
    const { repo, remote, other } = makeStage("credential");
    const theirs = pushFromOther(other, "theirs.txt", "theirs\n");
    const requests: { method: string; authed: boolean }[] = [];
    const expected = `Basic ${Buffer.from("push-user:push-token").toString("base64")}`;
    const server = createServer((req, res) => {
      const authed = req.headers.authorization === expected;
      requests.push({ method: req.method ?? "", authed });
      if (!authed) { res.writeHead(401, { "www-authenticate": 'Basic realm="push"' }).end(); return; }
      const url = new URL(req.url ?? "/", "http://localhost");
      const cgi = spawn("git", ["http-backend"], { env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: "1",
        REMOTE_USER: "push-user", REQUEST_METHOD: req.method ?? "GET", PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: String(req.headers["content-type"] ?? ""), ...(req.headers["content-encoding"] ? { HTTP_CONTENT_ENCODING: String(req.headers["content-encoding"]) } : {}) } });
      req.pipe(cgi.stdin);
      const chunks: Buffer[] = [];
      cgi.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      cgi.on("close", () => {
        const all = Buffer.concat(chunks);
        const split = all.indexOf("\r\n\r\n");
        const head = all.subarray(0, split).toString().split("\r\n");
        const status = Number(head.find((line) => line.startsWith("Status:"))?.split(" ")[1] ?? 200);
        const headers = Object.fromEntries(head.filter((line) => !line.startsWith("Status:")).map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]));
        res.writeHead(status, headers).end(all.subarray(split + 4));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const url = `http://127.0.0.1:${port}/${remote.slice(root.length + 1)}`;
      git(repo, "remote", "set-url", "origin", url);
      const taskId = await seedTask(repo, "task.txt", "task\n");
      await saveProjectGitCredential((await rowOf(taskId)).projectId, "push-user", "push-token");
      const result = await acceptTask(taskId, "human", { push: true });
      assert.equal(result.accepted, true, result.accepted ? "" : result.error);
      git(repo, "merge-base", "--is-ancestor", theirs, "main");
      assert.equal(git(remote, "rev-parse", "main"), git(repo, "rev-parse", "main"), "带着项目里的账号推上去了");
      assert.ok(requests.some((r) => r.method === "POST" && r.authed), "推送那一下是认证过的");
      assert.equal(git(repo, "remote", "get-url", "origin"), url, "账号没写进远程地址");
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  // 17. 推的是临时检出里合出来的那个提交，不是「推那一刻本地 main 指着谁」（审查第 3 轮 F1）：推的同时另一个终端
  //     往本地 main 上提交了一个（等同于把合并撤掉、改了别的）。远程收下的仍是这次合并、验收完成；本地 main 被挪过就不硬快进，
  //     如实报本地落后（localBehind），那个终端的提交原样留着。
  {
    const { repo, remote } = makeStage("local-moved");
    const taskId = await seedTask(repo, "task.txt", "task\n");
    const source = git(wsOf.get(taskId)!, "rev-parse", "HEAD");
    const branch = git(wsOf.get(taskId)!, "rev-parse", "--abbrev-ref", "HEAD");
    writeFileSync(join(repo, ".git", "hooks", "pre-push"), ["#!/bin/sh", 'rm -f "$0"', "unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX",
      `cd ${JSON.stringify(repo)} && git commit -q --allow-empty -m meanwhile`, ""].join("\n"), { mode: 0o755 });
    const result = await acceptTask(taskId, "human", { push: true });
    assert.equal(result.accepted, true, result.accepted ? "" : result.error);
    assert.equal(result.push?.ok, true);
    if (result.push?.ok) {
      assert.equal(result.push.commit, source, "推的是这次合并的结果");
      assert.ok(result.push.localBehind, "本地没跟上要说出来");
    }
    assert.equal(git(remote, "rev-parse", "main"), source, "远程是任务的成果");
    assert.equal(git(repo, "log", "-1", "--format=%s", "main"), "meanwhile", "那个终端的提交原样留着，没被硬快进盖掉");
    assert.equal(await stageOf(taskId), "accepted");
    assert.equal(git(repo, "rev-parse", branch), source, "本地 main 没含它，任务分支留着不删");
  }

  // 18. 用户在项目目录改着一个无关文件，推的那一刻远程又被推了新提交（审查第 3 轮 F2）：不冲突就同步、从头重合、推上去，
  //     冲突就交回任务去解 —— 两种都不因为那个无关改动卡住，那个改动原样留着。
  for (const [name, file, content] of [["dirty-race-clean", "other.txt", "other\n"], ["dirty-race-conflict", "shared.txt", "their side\n"]] as const) {
    const { repo, remote } = makeStage(name);
    const taskId = await seedTask(repo, file === "shared.txt" ? "shared.txt" : "task.txt", file === "shared.txt" ? "task side\n" : "task\n");
    writeFileSync(join(repo, ".gitignore"), ".worktrees/\nlocal-edit\n");
    raceOnPush(repo, join(root, `${name}-other`), file, content);
    const result = await acceptTask(taskId, "human", { push: true });
    assert.equal(readFileSync(join(repo, ".gitignore"), "utf8"), ".worktrees/\nlocal-edit\n", `${name}：无关改动原样留着`);
    if (file === "other.txt") {
      assert.equal(result.accepted, true, result.accepted ? "" : result.error);
      assert.equal(git(remote, "rev-parse", "main"), git(repo, "rev-parse", "main"));
      assert.equal(git(repo, "show", "main:other.txt"), "other");
      assert.equal(git(repo, "show", "main:task.txt"), "task");
      assert.equal(git(repo, "status", "--porcelain"), "M .gitignore");
    } else {
      assert.equal(result.accepted, false);
      if (result.accepted) throw new Error("撞冲突不该验收通过");
      assert.equal(result.reason, "merge_conflict", result.error);
      assert.equal(result.conflictHandoff?.notified, true, "冲突交回任务去解，不是报一句 push_diverged");
      assert.equal(git(repo, "rev-parse", "main"), git(remote, "rev-parse", "main"), "本地 main 同步到了远程那一头");
      assert.notEqual(await stageOf(taskId), "merged");
    }
  }

  // 19. 远程已经收下、只差清理（审查第 3 轮第 1 条）：推的同时本地 main 被另一个终端提交过（快进不了），任务工作区里
  //     还有没提交的编辑（清理被挡）。处理掉编辑再点验收：远程含着记下的那次合并，不再要求本地先同步，直接收尾。
  {
    const { repo, remote } = makeStage("pushed-cleanup-retry");
    const taskId = await seedTask(repo, "shared.txt", "task version\n");
    const ws = wsOf.get(taskId)!;
    const source = git(ws, "rev-parse", "HEAD");
    writeFileSync(join(repo, ".git", "hooks", "pre-push"), ["#!/bin/sh", 'rm -f "$0"', "unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX",
      `cd ${JSON.stringify(repo)} && git commit -q --allow-empty -m meanwhile`,
      `printf 'extra\\n' >> ${JSON.stringify(join(ws, "shared.txt"))}`, ""].join("\n"), { mode: 0o755 });
    const first = await acceptTask(taskId, "human", { push: true });
    assert.equal(first.accepted, false);
    if (first.accepted) throw new Error("任务工作区有编辑，清理应当停下");
    assert.equal(first.reason, "worktree_remove_failed", first.error);
    assert.equal(first.push?.ok, true);
    assert.equal(git(remote, "rev-parse", "main"), source, "远程已经收下");
    assert.equal(await stageOf(taskId), "merged");
    git(ws, "checkout", "-q", "--", "shared.txt");
    const second = await acceptTask(taskId, "human", { push: true });
    assert.equal(second.accepted, true, second.accepted ? "" : `${second.reason}: ${second.error}`);
    if (second.push?.ok) assert.ok(second.push.localBehind, "本地还是没跟上，照实说");
    assert.equal(await stageOf(taskId), "accepted");
    assert.equal(git(repo, "log", "-1", "--format=%s", "main"), "meanwhile", "不替用户同步、不覆盖他那个提交");
    assert.equal(git(remote, "rev-parse", "main"), source);
  }

  // 20. 推的那一刻别人推了同一文件的冲突改动，而用户正在项目目录改着这个文件（审查第 3 轮第 2 条）：本地同步不了，
  //     照样按远程那一头交回任务去解，用户的编辑原样在；任务解完、用户的编辑还在时，不冲突但本地同步不了就停下说明；
  //     用户收拾好之后再点，正常推上去。
  {
    const { repo, remote } = makeStage("overlap-race");
    const taskId = await seedTask(repo, "shared.txt", "task version\n");
    const ws = wsOf.get(taskId)!;
    const other = join(root, "overlap-race-other");
    writeFileSync(join(repo, ".git", "hooks", "pre-push"), ["#!/bin/sh", 'rm -f "$0"', "unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX",
      `printf 'user editing\\n' > ${JSON.stringify(join(repo, "shared.txt"))}`,
      `cd ${JSON.stringify(other)} && printf 'other version\\n' > shared.txt && git commit -q -am other && git push -q origin main`, ""].join("\n"), { mode: 0o755 });
    const base = git(repo, "rev-parse", "main");
    const result = await acceptTask(taskId, "human", { push: true });
    assert.equal(result.accepted, false);
    if (result.accepted) throw new Error("撞冲突不该验收通过");
    assert.equal(result.reason, "merge_conflict", result.error);
    assert.deepEqual(result.conflictFiles, ["shared.txt"]);
    const theirs = git(remote, "rev-parse", "main");
    assert.equal(result.conflictHandoff?.notified, true, "冲突交回任务去解");
    assert.ok(result.conflictHandoff?.message.includes(theirs.slice(0, 12)), "让任务去合远程那个提交，不是本地那份旧的 main");
    assert.equal(readFileSync(join(repo, "shared.txt"), "utf8"), "user editing\n", "用户的编辑原样在");
    assert.equal(git(repo, "rev-parse", "main"), base);
    assert.notEqual(await stageOf(taskId), "merged");
    // 任务照交接说的去合远程那个提交、解掉冲突。
    try { git(ws, "merge", "-q", theirs); } catch {}
    writeFileSync(join(ws, "shared.txt"), "task version\n");
    git(ws, "commit", "-q", "-am", "resolve");
    const blocked = await acceptTask(taskId, "human", { push: true });
    assert.equal(blocked.accepted, false);
    if (!blocked.accepted) assert.equal(blocked.reason, "target_dirty", blocked.error);
    assert.equal(readFileSync(join(repo, "shared.txt"), "utf8"), "user editing\n");
    assert.equal(git(remote, "rev-parse", "main"), theirs, "没冲突但本地同步不了：停下，远程不动");
    git(repo, "checkout", "-q", "--", "shared.txt");
    const done = await acceptTask(taskId, "human", { push: true });
    assert.equal(done.accepted, true, done.accepted ? "" : done.error);
    assert.equal(git(remote, "show", "main:shared.txt"), "task version");
    assert.equal(git(remote, "rev-parse", "main"), git(repo, "rev-parse", "main"));
  }

  // 21. 门禁之前那次同步就被挡住（远程早有冲突的新提交，用户改着同一个文件）：同样交回任务去合远程那一头。
  {
    const { repo, remote, other } = makeStage("overlap-prepare");
    const taskId = await seedTask(repo, "shared.txt", "task version\n");
    const theirs = pushFromOther(other, "shared.txt", "other version\n");
    writeFileSync(join(repo, "shared.txt"), "user editing\n");
    const result = await acceptTask(taskId, "human", { push: true });
    assert.equal(result.accepted, false);
    if (result.accepted) throw new Error("撞冲突不该验收通过");
    assert.equal(result.reason, "merge_conflict", result.error);
    assert.equal(result.conflictHandoff?.notified, true);
    assert.ok(result.conflictHandoff?.message.includes(theirs.slice(0, 12)));
    assert.equal(readFileSync(join(repo, "shared.txt"), "utf8"), "user editing\n");
    assert.equal(git(remote, "rev-parse", "main"), theirs);
  }

  console.log("accept push: 推到哪 / 先同步再合再推 / 不推不碰远程 / 冲突交回任务 / 分叉与推不了都先拒 / 被拒不强推 / 门禁续做带冻结目的地 / 目的地变了就拒 / 推送地址与拉取地址分离 / 推送期间远程又动（不冲突重来、冲突交回任务） / 推不上去本地不动 / 带护栏挪分支 / 挪没检出的分支先占住（三处） / 拉推带项目账号 / 推的是合出来的提交、本地被挪过只报落后 / 检出里有无关改动照样同步重合或交回冲突 / 远程已收下只差清理再点就收尾 / 本地同步不了照样按远程那一头交回冲突 全部通过");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
