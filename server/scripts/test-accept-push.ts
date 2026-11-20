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
  const { moveBranchGuarded } = await import("../src/git-guarded-move.js");
  const { pushDestination } = await import("../src/task-accept-push.js");
  const { parseChoices } = await import("../src/accept-gate-handoff.js");
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

  // 7. 推的那一下被拒（远程在合完之后又被人推了）：如实报 push_rejected，不强推。
  {
    const { repo, remote } = makeStage("rejected");
    writeFileSync(join(repo, "mine.txt"), "mine\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "local");
    const theirs = pushFromOther(join(root, "rejected-other"), "other.txt", "other\n");
    const outcome = await pushTargetBranch(repo, "main", { remote: "origin", remoteBranch: "main", url: remote });
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

  // 11. 合完到推之间远程又被推了一个不冲突的提交（审查第 1 轮 F3）：退回本地合并、同步、重新合、再推，最后验收通过。
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

  // 12. 合完到推之间远程又被推了一个冲突的提交：退回本地合并、同步进来、重新合撞冲突 → 交回任务去解，
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

  // 13. 推不上去（远程拒收、远程也没动）：把这次合并从本地退回去，什么都没留下；任务照旧可以再验收。
  {
    const { repo, remote } = makeStage("refused");
    writeFileSync(join(remote, "hooks", "pre-receive"), "#!/bin/sh\necho nope >&2\nexit 1\n", { mode: 0o755 });
    const before = git(repo, "rev-parse", "main");
    const taskId = await seedTask(repo, "task.txt", "task\n");
    const result = await acceptTask(taskId, "human", { push: true });
    assert.equal(result.accepted, false);
    if (!result.accepted) assert.equal(result.reason, "push_failed");
    assert.equal(git(repo, "rev-parse", "main"), before, "推不上去就退回合并之前");
    assert.equal(git(repo, "status", "--porcelain"), "", "检出也跟着退回去了");
    assert.equal(git(remote, "rev-parse", "main"), before);
    assert.notEqual((await rowOf(taskId)).stage, "merged");
    assert.equal(readFileSync(join(wsOf.get(taskId)!, "task.txt"), "utf8"), "task\n", "任务工作区还在");
  }

  // 14. 带护栏挪分支（审查第 1 轮 F2）：有别的 git 拿着 index.lock 就不动；检出脏就不动；
  //     项目目录不在这个分支上就只挪 ref、不碰检出；正常时检出跟着挪、干净。
  {
    const { repo } = makeStage("guarded");
    const base = git(repo, "rev-parse", "main");
    writeFileSync(join(repo, "next.txt"), "next\n");
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
    assert.equal(dirty.ok, false);
    if (!dirty.ok) assert.equal(dirty.reason, "target_dirty");
    assert.equal(git(repo, "rev-parse", "main"), base);
    git(repo, "checkout", "-q", "--", "shared.txt");
    const stale = await moveBranchGuarded(repo, "main", next, base, "测试");
    assert.equal(stale.ok, false, "分支不在 from 上就不动");
    const moved = await moveBranchGuarded(repo, "main", base, next, "测试");
    assert.equal(moved.ok, true, moved.ok ? "" : moved.message);
    assert.equal(git(repo, "rev-parse", "main"), next);
    assert.equal(readFileSync(join(repo, "next.txt"), "utf8"), "next\n", "检出跟着挪");
    assert.equal(git(repo, "status", "--porcelain"), "", "索引和工作区都对齐");
    git(repo, "switch", "-q", "-c", "side", base);
    const refOnly = await moveBranchGuarded(repo, "main", next, base, "测试");
    assert.equal(refOnly.ok, true);
    assert.equal(git(repo, "rev-parse", "main"), base, "不在检出上的分支只挪 ref");
    assert.equal(git(repo, "rev-parse", "HEAD"), base);
    assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "side", "项目目录检出着的那个分支不受影响");
  }

  console.log("accept push: 推到哪 / 先同步再合再推 / 不推不碰远程 / 冲突交回任务 / 分叉与推不了都先拒 / 被拒不强推 / 门禁续做带冻结目的地 / 目的地变了就拒 / 推送地址与拉取地址分离 / 推送期间远程又动（不冲突重来、冲突交回任务） / 推不上去退回合并 / 带护栏挪分支 全部通过");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
process.exit(0);
