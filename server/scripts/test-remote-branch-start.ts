import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { releaseTmpDb } from "./tmp-db.js";

// 从远端分支开工：建任务前先 fetch 那一条、冻结远端此刻的提交，合入目标落到本地同名分支（没有就照远端建
// 跟踪分支），验收把成果合进那条本地分支而不是项目当前检出的 main。

const root = mkdtempSync(join(tmpdir(), "navi-remote-branch-start-"));
process.env.NAVI_DB = join(root, "navi.db");
process.env.NAVI_RUNS_DIR = join(root, "runs");
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, tasks } = await import("../src/db/schema.js");
const { mountTaskRoutes } = await import("../src/task-routes.js");
const { taskWorkspace } = await import("../src/task-workspace.js");
const { acceptTask } = await import("../src/task-accept.js");
const { listBranches, resolveTaskMergeTarget, staleBaseFallback } = await import("../src/git.js");
const { remoteStartNote } = await import("../src/remote-start-notice.js");
const { undoBranchPlanSideEffects } = await import("../src/task-branch-plan.js");
const { runRefAction } = await import("../src/git-workbench/refs.js");
await ensureSchema();
const api = new Hono();
mountTaskRoutes(api);
const at = new Date().toISOString();
const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
const commit = (repo: string, name: string) => {
  writeFileSync(join(repo, name), name);
  git(repo, "add", "--", name);
  git(repo, "commit", "-m", name);
  return git(repo, "rev-parse", "HEAD");
};
const identify = (repo: string) => {
  git(repo, "config", "user.name", "Remote Test");
  git(repo, "config", "user.email", "remote@example.test");
};
const post = (body: Record<string, unknown>) => api.request("/tasks", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ projectId: "remote", title: "远端开工", useWorktree: true, workflowMode: "free", ...body }) });
async function create(body: Record<string, unknown>) {
  const response = await post(body);
  assert.equal(response.status, 201, await response.clone().text());
  return row((await response.json()).id);
}

try {
  // 远端（裸仓库）+ 另一位协作者的克隆：远端分支都从那边推上去。
  const origin = join(root, "origin.git");
  execFileSync("git", ["init", "--bare", "-b", "main", origin], { stdio: "ignore" });
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  identify(repo);
  commit(repo, "seed.txt");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-u", "origin", "main");
  const peer = join(root, "peer");
  execFileSync("git", ["clone", origin, peer], { stdio: "ignore" });
  identify(peer);
  git(peer, "checkout", "-b", "feature-r");
  const firstPush = commit(peer, "feature-1.txt");
  git(peer, "push", "-u", "origin", "feature-r");
  git(repo, "fetch", "origin");
  git(repo, "remote", "set-head", "origin", "main");
  await db.insert(projects).values({ id: "remote", name: "remote", repoPath: repo, createdAt: at });

  const listed = await listBranches(repo);
  assert.deepEqual(listed.branches, ["main"], "local list stays local-only for old callers");
  assert.deepEqual(listed.remotes, ["origin"]);
  assert.deepEqual(listed.remoteBranches.map((branch) => branch.ref).sort(), ["origin/feature-r", "origin/main"], "origin/HEAD is not listed");
  assert.deepEqual(listed.remoteBranches.find((branch) => branch.ref === "origin/feature-r"),
    { ref: "origin/feature-r", fullRef: "refs/remotes/origin/feature-r", remote: "origin", branch: "feature-r" });
  console.log("✓ branch list carries remote branches separately and drops the origin/HEAD symref");

  // 本地记着的 origin/feature-r 落后于远端：建任务时得先拉到远端此刻那一版再冻结。
  const latest = commit(peer, "feature-2.txt");
  git(peer, "push");
  assert.equal(git(repo, "rev-parse", "origin/feature-r"), firstPush);
  const task = await create({ worktreeBase: "origin/feature-r" });
  assert.equal(task.worktreeStartCommit, latest, "remote base is fetched before the start is frozen");
  assert.equal(task.worktreeBase, "refs/remotes/origin/feature-r", "a recognized remote start is stored as the full ref");
  assert.equal(task.worktreeBaseBranch, "origin/feature-r", "the start reads as coming from the remote");
  assert.equal(task.mergeTargetBranch, "feature-r", "merges into the same-named local branch");
  assert.equal(git(repo, "rev-parse", "refs/heads/feature-r"), latest, "missing local branch is created from the remote");
  assert.equal(git(repo, "rev-parse", "--abbrev-ref", "feature-r@{upstream}"), "origin/feature-r", "and tracks it");
  assert.equal(git(repo, "symbolic-ref", "--short", "HEAD"), "main", "project checkout is untouched");
  console.log("✓ remote base fetches the latest commit, freezes it, and creates a tracking branch as the merge target");

  const ws = await taskWorkspace(task, repo);
  assert.equal(git(ws.path, "rev-parse", "HEAD"), latest, "worktree starts from the remote commit");
  assert.match((await remoteStartNote(task, ws, repo))!, /从远端分支 origin\/feature-r（提交 [0-9a-f]{7}）开工，验收合入本地分支 feature-r/);
  assert.equal(await remoteStartNote(task, { ...ws, fresh: false }, repo), null, "reused workspaces don't repeat the note");
  const work = commit(ws.path, "remote-task.txt");
  await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, task.id));
  assert.equal((await acceptTask(task.id)).accepted, true);
  assert.equal(git(repo, "show", "feature-r:remote-task.txt"), "remote-task.txt", "accepted into the local tracking branch");
  assert.doesNotThrow(() => git(repo, "merge-base", "--is-ancestor", work, "feature-r"));
  assert.throws(() => git(repo, "show", "main:remote-task.txt"), "never silently merged into the project checkout");
  console.log("✓ worktree starts from the remote commit and acceptance merges into the local tracking branch, not main");

  // 本地已有同名分支：直接用它当合入目标，不另建。
  const again = await create({ worktreeBase: "refs/remotes/origin/feature-r" });
  assert.equal(again.worktreeBase, "refs/remotes/origin/feature-r");
  assert.equal(again.mergeTargetBranch, "feature-r");
  // 显式给了合入分支就照它。
  const explicit = await create({ worktreeBase: "origin/feature-r", mergeTargetBranch: "main" });
  assert.equal(explicit.mergeTargetBranch, "main");
  console.log("✓ an existing local branch is reused as the target and an explicit merge target wins");

  // 从没 fetch 过的远端分支：建任务时拉下来。
  git(peer, "checkout", "-b", "never-fetched", "main");
  const fresh = commit(peer, "never-fetched.txt");
  git(peer, "push", "-u", "origin", "never-fetched");
  const unfetched = await create({ worktreeBase: "origin/never-fetched" });
  assert.equal(unfetched.worktreeStartCommit, fresh);
  assert.equal(unfetched.mergeTargetBranch, "never-fetched");
  console.log("✓ a remote branch that was never fetched locally is fetched at creation");

  // 远端上没有的分支、根本不存在的起点：建任务当场 400，不留下任务也不留下分支。
  const before = (await db.select().from(tasks)).length;
  const missing = await post({ worktreeBase: "origin/no-such-branch" });
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /远端 origin 上没有分支 no-such-branch/);
  const typo = await post({ worktreeBase: "no-such-thing" });
  assert.equal(typo.status, 400);
  assert.match((await typo.json()).error, /开工起点 no-such-thing 不存在/);
  assert.equal((await db.select().from(tasks)).length, before);
  assert.throws(() => git(repo, "rev-parse", "--verify", "refs/heads/no-such-branch"));
  console.log("✓ missing remote branch and unresolvable base are rejected with a clear 400 before anything is created");

  // 同名 tag：界面发的完整引用照样取远端那一版；短名照 git 的先后按 tag 算，不联网、不建分支。
  const remoteTip = git(repo, "rev-parse", "refs/remotes/origin/feature-r");
  const seed = git(repo, "rev-parse", "main");
  git(repo, "tag", "origin/feature-r", seed);
  const viaFullRef = await create({ worktreeBase: "refs/remotes/origin/feature-r" });
  assert.equal(viaFullRef.worktreeStartCommit, remoteTip, "a same-named tag cannot shadow the selected remote branch");
  assert.equal(viaFullRef.mergeTargetBranch, "feature-r");
  const viaTag = await create({ worktreeBase: "origin/feature-r" });
  assert.equal(viaTag.worktreeStartCommit, seed, "a short name that is also a tag means the tag, as git resolves it");
  assert.equal(viaTag.worktreeBaseBranch, null);
  assert.equal(await remoteStartNote(viaTag, { ...ws, fresh: true }, repo), null, "a tag start gets no remote note");
  git(repo, "tag", "-d", "origin/feature-r");
  console.log("✓ the full remote ref beats a same-named tag, and a short name that is a tag stays a tag");

  // 冻结起点写不进去（ref 目录不可写）：建任务失败，顺手建的跟踪分支一并收回。
  git(peer, "checkout", "-b", "rollback-remote", "main");
  commit(peer, "rollback-remote.txt");
  git(peer, "push", "-u", "origin", "rollback-remote");
  const frozenDir = join(repo, ".git", "refs", "ash", "task-bases");
  mkdirSync(frozenDir, { recursive: true });
  const countBefore = (await db.select().from(tasks)).length;
  chmodSync(frozenDir, 0o555);
  try {
    const blocked = await post({ worktreeBase: "refs/remotes/origin/rollback-remote" });
    assert.ok(blocked.status >= 400, `expected a failure, got ${blocked.status}`);
  } finally {
    chmodSync(frozenDir, 0o755);
  }
  assert.equal((await db.select().from(tasks)).length, countBefore);
  assert.throws(() => git(repo, "rev-parse", "--verify", "refs/heads/rollback-remote"), "the tracking branch made before the failure is removed");
  console.log("✓ a failure after the tracking branch is made rolls it back inside the branch plan");

  // 写 upstream 配置时 `.git/config` 被别的 git 进程锁着：建分支那一步已经成了、写配置失败，那条分支也收回。
  git(peer, "checkout", "-b", "config-locked", "main");
  commit(peer, "config-locked.txt");
  git(peer, "push", "-u", "origin", "config-locked");
  const lockedBefore = (await db.select().from(tasks)).length;
  writeFileSync(join(repo, ".git", "config.lock"), "");
  try {
    const locked = await post({ worktreeBase: "refs/remotes/origin/config-locked" });
    assert.equal(locked.status, 409, await locked.clone().text());
  } finally {
    rmSync(join(repo, ".git", "config.lock"), { force: true });
  }
  assert.equal((await db.select().from(tasks)).length, lockedBefore);
  assert.throws(() => git(repo, "rev-parse", "--verify", "refs/heads/config-locked"), "the branch made before the config write failed is removed");
  console.log("✓ a tracking branch whose upstream config cannot be written is removed, not left behind");

  // 空仓库里写错的显式起点也当场拒绝；没指定起点的照旧惰性创建。
  const empty = join(root, "empty");
  execFileSync("git", ["init", "-b", "main", empty], { stdio: "ignore" });
  await db.insert(projects).values({ id: "empty", name: "empty", repoPath: empty, createdAt: at });
  const emptyPost = (body: Record<string, unknown>) => api.request("/tasks", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "empty", title: "空仓库", useWorktree: true, workflowMode: "free", ...body }) });
  const mistyped = await emptyPost({ worktreeBase: "mistyped-base" });
  assert.equal(mistyped.status, 400, await mistyped.clone().text());
  assert.match((await mistyped.json()).error, /开工起点 mistyped-base 不存在/);
  const lazy = await emptyPost({});
  assert.equal(lazy.status, 201, await lazy.clone().text());
  console.log("✓ an explicit base that does not resolve is rejected in an empty repo too; no base stays lazy");

  // 工作台「检出为本地分支」：设 upstream 失败时把刚建的分支收回，也没切过去。
  const checkoutBefore = git(repo, "symbolic-ref", "--short", "HEAD");
  writeFileSync(join(repo, ".git", "config.lock"), "");
  try {
    await assert.rejects(runRefAction(repo, repo, { kind: "branch-create", name: "wb-track", target: remoteTip, checkout: true, track: "origin/feature-r" }, "test"));
  } finally {
    rmSync(join(repo, ".git", "config.lock"), { force: true });
  }
  assert.equal(git(repo, "symbolic-ref", "--short", "HEAD"), checkoutBefore, "a failed track never leaves the checkout switched");
  assert.throws(() => git(repo, "rev-parse", "--verify", "refs/heads/wb-track"), "and the half-made branch is removed");
  git(repo, "tag", "origin/feature-r", seed);
  await runRefAction(repo, repo, { kind: "branch-create", name: "wb-track", target: remoteTip, checkout: false, track: "origin/feature-r" }, "test");
  assert.deepEqual([git(repo, "config", "branch.wb-track.remote"), git(repo, "config", "branch.wb-track.merge")],
    ["origin", "refs/heads/feature-r"], "upstream binds the remote branch even with a same-named tag");
  git(repo, "tag", "-d", "origin/feature-r");
  console.log("✓ workbench track is all-or-nothing and binds the remote ref, not a same-named tag");

  // 起跑时的失效判断与合入目标解析：存在的远端分支不算失效，目标换成本地同名分支。
  assert.equal(await staleBaseFallback(repo, "origin/feature-r"), undefined, "an existing remote branch is not stale");
  assert.equal((await staleBaseFallback(repo, "gone-branch"))?.used, "main");
  assert.equal(await resolveTaskMergeTarget(repo, "origin/feature-r"), "feature-r");
  assert.equal(await resolveTaskMergeTarget(repo, "refs/remotes/origin/feature-r"), "feature-r");
  assert.equal(await resolveTaskMergeTarget(repo, "main"), "main");
  console.log("✓ runtime fallback keeps remote bases and the target chain maps origin/x to local x");

  // 落库失败时收回顺手建的跟踪分支；分支已经被动过就不碰。
  git(repo, "branch", "rollback-me", "main");
  await undoBranchPlanSideEffects(repo, { trackingBranch: { name: "rollback-me", commit: git(repo, "rev-parse", "main") } });
  assert.throws(() => git(repo, "rev-parse", "--verify", "refs/heads/rollback-me"));
  git(repo, "branch", "moved", "main");
  await undoBranchPlanSideEffects(repo, { trackingBranch: { name: "moved", commit: firstPush } });
  assert.ok(git(repo, "rev-parse", "--verify", "refs/heads/moved"), "a branch that moved since creation is kept");
  console.log("✓ rollback removes the created tracking branch only while it is untouched");
} finally {
  await releaseTmpDb();
  rmSync(root, { recursive: true, force: true });
}
