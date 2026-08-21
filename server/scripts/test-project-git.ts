// 项目主仓 git 面板的回归测试。钉住 `git-project-ops.ts` 顶部那四条决定里最容易被
// 「优化」掉的三条：脏工作区不动手且绝不 stash、分支被别的 worktree 占着要拦在前面、
// 拉取失败不许把主仓留在 merge/rebase 中途。
//
// 每个用例自带临时仓库 + 一个本地 bare 当远端,不联网、不碰 ash 自己的仓库。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-project-git-test-"));
process.env.ASH_DB = join(root, "ash.db");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function write(repo: string, name: string, body: string) {
  writeFileSync(join(repo, name), body);
}

function commit(repo: string, message: string) {
  git(repo, "add", "-A");
  git(repo, "commit", "-m", message);
}

/** 一个带远端的仓库:`origin` 是本地 bare,`clone` 是第二份检出,用来在远端造新提交。 */
function makeRepo(name: string): { repo: string; origin: string; peer: string } {
  const origin = join(root, `${name}.git`);
  execFileSync("git", ["init", "--bare", "-b", "main", origin]);
  const repo = join(root, name);
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.name", "Ash Project Git Test");
  git(repo, "config", "user.email", "project-git@example.test");
  write(repo, "seed.txt", "seed\n");
  commit(repo, "seed");
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "--set-upstream", "origin", "main");

  const peer = join(root, `${name}-peer`);
  execFileSync("git", ["clone", origin, peer]);
  git(peer, "config", "user.name", "Ash Project Git Peer");
  git(peer, "config", "user.email", "peer@example.test");
  return { repo, origin, peer };
}

async function rejects(fn: () => Promise<unknown>, pattern: RegExp, label: string) {
  let message = "";
  try {
    await fn();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.ok(message, `${label}: 本该拒绝,却成功了`);
  assert.match(message, pattern, label);
  return message;
}

try {
  const {
    checkoutProjectBranch, fetchProject, pullProject, pushProject, readProjectGitState,
  } = await import("../src/git-project-ops.js");

  // ── 读:分支清单带 upstream / ahead / behind,并标出被别的 worktree 占着的分支 ──
  {
    const { repo, peer } = makeRepo("read");
    git(repo, "branch", "feature");
    git(repo, "branch", "taken");
    const wt = join(root, "read-wt");
    git(repo, "worktree", "add", wt, "taken");

    write(peer, "remote.txt", "remote\n");
    commit(peer, "remote commit");
    git(peer, "push");
    git(repo, "fetch");
    write(repo, "local.txt", "local\n");
    commit(repo, "local commit");

    const state = await readProjectGitState(repo);
    assert.equal(state.isRepo, true);
    assert.equal(state.branch.head, "main");
    assert.equal(state.branch.upstream, "origin/main");
    assert.equal(state.branch.ahead, 1, "本地领先 1");
    assert.equal(state.branch.behind, 1, "本地落后 1");
    assert.deepEqual(state.remotes, ["origin"]);

    const rows = new Map(state.branches.map((row) => [row.name, row]));
    assert.equal(rows.get("main")?.current, true);
    assert.equal(rows.get("main")?.upstream, "origin/main");
    assert.equal(rows.get("feature")?.worktree, null, "主仓自己检出的不算被占用");
    assert.ok(rows.get("taken")?.worktree, "被 worktree 检出的分支要标出占用者");
    // 主仓路径本身不能被算成「占用者」,否则当前分支会显示成切不过去。
    assert.equal(rows.get("main")?.worktree, null);

    // 不是仓库的路径给空壳而不是抛错——前端据此降级成「这个项目不是 Git 仓库」。
    const notRepo = await readProjectGitState(join(root, "nope"));
    assert.equal(notRepo.isRepo, false);
    assert.equal(notRepo.branches.length, 0);
  }

  // ── 切分支:脏工作区拦住且不 stash;被占用的分支拦住;未跟踪文件不算脏 ──
  {
    const { repo } = makeRepo("checkout");
    git(repo, "branch", "feature");
    git(repo, "branch", "taken");
    git(repo, "worktree", "add", join(root, "checkout-wt"), "taken");

    await rejects(
      () => checkoutProjectBranch(repo, "taken"),
      /正被另一个工作区检出/,
      "被占用的分支要拦在 git 报错之前",
    );
    await rejects(
      () => checkoutProjectBranch(repo, "nope"),
      /本地没有分支/,
      "不存在的分支名不许透传给 git",
    );
    await rejects(
      () => checkoutProjectBranch(repo, "--force"),
      /本地没有分支/,
      "flag 形状的参数必须先在清单里对上号",
    );

    // 未跟踪文件:git 不会碰它,切完还在原地。
    write(repo, "scratch.txt", "untracked\n");
    const ok = await checkoutProjectBranch(repo, "feature");
    assert.equal(ok.state.branch.head, "feature");
    assert.ok(existsSync(join(repo, "scratch.txt")), "未跟踪文件不该被切分支带走");

    // 已修改的跟踪文件:拦住,并且原样留在工作区(没被 stash 走)。
    write(repo, "seed.txt", "dirty\n");
    const message = await rejects(
      () => checkoutProjectBranch(repo, "main"),
      /未提交的改动/,
      "脏工作区必须拦住切分支",
    );
    assert.match(message, /不会替你 stash/);
    assert.equal(git(repo, "stash", "list"), "", "拒绝之后不许留下 stash");
    assert.match(git(repo, "status", "--porcelain"), /seed\.txt/, "改动必须原样留在工作区");
    assert.equal((await readProjectGitState(repo)).branch.head, "feature", "拒绝之后 HEAD 不许动");

    git(repo, "checkout", "--", "seed.txt");
    const back = await checkoutProjectBranch(repo, "main");
    assert.equal(back.state.branch.head, "main");
    const again = await checkoutProjectBranch(repo, "main");
    assert.match(again.message, /已经在/, "切到当前分支是幂等的,不该报错");
  }

  // ── fetch:拿到远端信息但不动工作树 ──
  {
    const { repo, peer } = makeRepo("fetch");
    write(peer, "remote.txt", "remote\n");
    commit(peer, "remote commit");
    git(peer, "push");

    const head = git(repo, "rev-parse", "HEAD");
    const result = await fetchProject(repo, "origin");
    assert.equal(result.state.branch.behind, 1);
    assert.equal(git(repo, "rev-parse", "HEAD"), head, "fetch 不许移动 HEAD");
    assert.ok(!existsSync(join(repo, "remote.txt")), "fetch 不许改工作树");

    await rejects(() => fetchProject(repo, "upstream"), /不存在/, "未知远端要拦住");
  }

  // ── 拉取:三种策略各自的成功路径 ──
  {
    // ff-only:能快进就快进。
    const ff = makeRepo("pull-ff");
    write(ff.peer, "remote.txt", "remote\n");
    commit(ff.peer, "remote commit");
    git(ff.peer, "push");
    const ffResult = await pullProject(ff.repo, "ff-only");
    assert.ok(existsSync(join(ff.repo, "remote.txt")), "快进后远端文件应到位");
    assert.match(ffResult.message, /已拉取/);
    const noop = await pullProject(ff.repo, "ff-only");
    assert.match(noop.message, /已经是最新/, "没得可拉时要说清楚,而不是假装拉了");

    // 分叉之后:ff-only 拒绝并指路,merge / rebase 各自走得通。
    for (const strategy of ["merge", "rebase"] as const) {
      const { repo, peer } = makeRepo(`pull-${strategy}`);
      write(peer, "theirs.txt", "theirs\n");
      commit(peer, "theirs");
      git(peer, "push");
      write(repo, "mine.txt", "mine\n");
      commit(repo, "mine");
      git(repo, "fetch");

      await rejects(() => pullProject(repo, "ff-only"), /分叉|快进拉不动/, "分叉时 ff-only 要指路");
      assert.equal((await readProjectGitState(repo)).operation, null, "失败后不许留半截状态");

      const result = await pullProject(repo, strategy);
      assert.ok(existsSync(join(repo, "theirs.txt")), `${strategy} 后远端文件应到位`);
      assert.ok(existsSync(join(repo, "mine.txt")), `${strategy} 后本地提交不许丢`);
      assert.equal(result.state.operation, null);
      const parents = git(repo, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length - 1;
      if (strategy === "merge") assert.equal(parents, 2, "merge 应产生合并提交");
      else assert.equal(parents, 1, "rebase 应保持线性历史");
    }
  }

  // ── 拉取撞冲突:必须回滚,不能把主仓留在 merge/rebase 中途 ──
  for (const strategy of ["merge", "rebase"] as const) {
    const { repo, peer } = makeRepo(`conflict-${strategy}`);
    write(peer, "seed.txt", "theirs\n");
    commit(peer, "theirs");
    git(peer, "push");
    write(repo, "seed.txt", "mine\n");
    commit(repo, "mine");
    git(repo, "fetch");
    const before = git(repo, "rev-parse", "HEAD");

    const message = await rejects(() => pullProject(repo, strategy), /冲突/, `${strategy} 冲突要如实报`);
    assert.match(message, /已经回滚/, `${strategy} 冲突后必须回滚`);
    const after = await readProjectGitState(repo);
    assert.equal(after.operation, null, `${strategy} 冲突后不许停在中途`);
    assert.equal(git(repo, "rev-parse", "HEAD"), before, `${strategy} 冲突后 HEAD 应回到原处`);
    assert.equal(after.branch.detached, false, "rebase 冲突不许把主仓留在游离 HEAD 上");
    assert.equal(after.dirty.merge, 0, "不许留下冲突标记");
  }

  // ── 拉取的前置条件:没 upstream / 游离 HEAD / 工作区脏 ──
  {
    const { repo } = makeRepo("pull-guard");
    git(repo, "checkout", "-b", "solo");
    await rejects(() => pullProject(repo, "ff-only"), /还没有 upstream/, "没 upstream 要说清楚");

    git(repo, "checkout", "main");
    write(repo, "seed.txt", "dirty\n");
    await rejects(() => pullProject(repo, "ff-only"), /未提交的改动/, "脏工作区必须拦住拉取");
    assert.equal(git(repo, "stash", "list"), "", "拉取被拒也不许留 stash");
    git(repo, "checkout", "--", "seed.txt");

    git(repo, "checkout", "--detach");
    await rejects(() => pullProject(repo, "ff-only"), /游离 HEAD/, "游离 HEAD 要拦住");
  }

  // ── 推送:有 upstream 走 upstream,没有则发布并建立 upstream ──
  {
    const { repo, origin } = makeRepo("push");
    write(repo, "one.txt", "one\n");
    commit(repo, "one");
    const pushed = await pushProject(repo, null);
    assert.match(pushed.message, /已推送/);
    assert.equal(pushed.state.branch.ahead, 0);
    assert.equal(git(origin, "rev-parse", "main"), git(repo, "rev-parse", "main"));

    git(repo, "checkout", "-b", "feature");
    write(repo, "two.txt", "two\n");
    commit(repo, "two");
    await rejects(() => pushProject(repo, null), /还没有 upstream/, "发布必须由用户指定远端");
    await rejects(() => pushProject(repo, "nope"), /不存在/, "未知远端要拦住");

    const published = await pushProject(repo, "origin");
    assert.match(published.message, /已发布/);
    assert.equal(published.state.branch.upstream, "origin/feature", "发布后要建立 upstream");
    assert.equal(git(origin, "rev-parse", "feature"), git(repo, "rev-parse", "feature"));

    git(repo, "checkout", "--detach");
    await rejects(() => pushProject(repo, "origin"), /游离 HEAD/, "游离 HEAD 没有可推送的分支");
  }

  // ── 推送的中途门禁:merge 卡住时不许把半成品 HEAD 发出去,但单纯脏工作区照推不误 ──
  {
    const { repo, origin } = makeRepo("push-midway");
    // 脏工作区:推的是已提交的历史,未提交的改动本来就不参与,不该拦。
    write(repo, "one.txt", "one\n");
    commit(repo, "one");
    write(repo, "seed.txt", "dirty\n");
    write(repo, "scratch.txt", "untracked\n");
    const dirtyPush = await pushProject(repo, null);
    assert.match(dirtyPush.message, /已推送/, "脏工作区不该拦住推送");
    assert.match(git(repo, "status", "--porcelain"), /seed\.txt/, "推送不许动工作区的改动");
    git(repo, "checkout", "--", "seed.txt");

    // merge 中途:HEAD 是半成品,拦住,且远端一步不许动。
    git(repo, "checkout", "-b", "theirs");
    write(repo, "seed.txt", "theirs\n");
    commit(repo, "theirs");
    git(repo, "checkout", "main");
    write(repo, "seed.txt", "mine\n");
    commit(repo, "mine");
    const remoteBefore = git(origin, "rev-parse", "main");
    try {
      git(repo, "merge", "theirs");
      assert.fail("这一步本该撞冲突");
    } catch { /* 冲突正是我们要的:仓库停在 merge 中途 */ }
    assert.equal((await readProjectGitState(repo)).operation, "merge", "前置条件:仓库确实停在 merge 中途");

    const midway = await rejects(() => pushProject(repo, null), /merge 中途/, "merge 中途必须拦住推送");
    assert.match(midway, /收尾或 abort/, "拒绝时要给出下一步怎么办");
    assert.equal(git(origin, "rev-parse", "main"), remoteBefore, "被拒之后远端一步都不许动");
    assert.equal((await readProjectGitState(repo)).operation, "merge", "拒绝不该顺手改变仓库状态");

    // 收尾之后照常能推。
    git(repo, "merge", "--abort");
    const after = await pushProject(repo, null);
    assert.match(after.message, /已推送/, "abort 之后应恢复可推送");
  }

  console.log("project git ops ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
