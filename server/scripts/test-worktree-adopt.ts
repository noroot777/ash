// 收编智能体自建的工作区（foreign-worktrees.ts 认、task-worktree-adopt.ts 办）。
//
// 钉住的几件事：
//   1. 认：只认这条任务会话里出现过的 linked worktree（绝对路径或相对项目目录的写法都算）；没出现过的、
//      Navi 自己的 `.worktrees/` 底下的、分支是别的任务的任务分支的，一律不提。
//   2. 收编：目录挪到 `.worktrees/<id>`、分支改名成 `navi/<id8>`，未提交的改动原样跟过去；起点冻结在跟合入分支的
//      分叉点上，「改动」只算智能体在那条分支上做的；任务行、会话行改指新目录，claude 会话文件搬过去，
//      下一回合给智能体一句交代；办完之后就是一条普通的开了独立工作区的任务，不再提示。
//   3. 改名会碍着别人（分支是别的任务的合入目标）、项目目录里有未提交的改动：拒绝并说清楚，什么都不动；
//      被收编的那个目录嵌在项目目录里时，它本身不算项目目录的改动。
//   4. 半路失败（会话文件搬不过去）：目录挪回去、分支名改回去、冻结 ref 删掉，可以直接重试。
//   5. 任务在跑时拒绝。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { removeTmpStage } from "./tmp-db.js";

const realRoot = realpathSync(mkdtempSync(join(tmpdir(), "navi-worktree-adopt-")));
// 项目路径走一层软链（像 macOS 上的 /tmp → /private/tmp）：git 登记的是真实路径，会话里多半是软链那种拼法。
const root = `${realRoot}-link`;
symlinkSync(realRoot, root);
process.env.NAVI_DB = join(root, "navi.db");
process.env.NAVI_RUNS_DIR = join(root, "runs");
const claudeConfig = join(root, "claude-config");

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, sessions, tasks } = await import("../src/db/schema.js");
const { mountWorktreeMoveRoutes } = await import("../src/task-worktree-move-routes.js");
const { takeWorkspaceNote } = await import("../src/task-worktree-move.js");
const { claudeSessionFilePath } = await import("../src/handoff-collect.js");
const { taskBranchDiff } = await import("../src/git-diff.js");
const { baseRef } = await import("../src/task-branch-plan.js");
const { worktreeBranchName, worktreePathFor } = await import("../src/git.js");
const { sessionTracePath } = await import("../src/transcript.js");
const { mentionsPath } = await import("../src/foreign-worktrees.js");
await ensureSchema();
const api = new Hono();
mountWorktreeMoveRoutes(api);
const at = new Date().toISOString();
const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0]!;
const commit = (repo: string, name: string) => {
  writeFileSync(join(repo, name), name);
  git(repo, "add", "--", name);
  git(repo, "commit", "-m", name);
  return git(repo, "rev-parse", "HEAD");
};
const hasRef = (repo: string, ref: string) => {
  try { git(repo, "show-ref", "--verify", "--quiet", ref); return true; } catch { return false; }
};

async function repository(id: string) {
  const repo = join(root, id);
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, "config", "user.name", "Adopt Test");
  git(repo, "config", "user.email", "adopt@example.test");
  commit(repo, "seed.txt");
  await db.insert(projects).values({ id, name: id, repoPath: repo, createdAt: at });
  return repo;
}

async function task(id: string, projectId: string, extra: Partial<typeof tasks.$inferInsert> = {}) {
  await db.insert(tasks).values({
    id, projectId, title: id, status: "done", mode: "single", useWorktree: false, workflowMode: "free",
    createdAt: at, updatedAt: at, ...extra,
  });
}

/** 一条 claude 会话：会话行记在项目目录上，执行轨迹里留下 `commands` 这几条工具调用。 */
async function session(id: string, taskId: string, repo: string, commands: string[], cliSessionId = `cli-${id}`) {
  await db.insert(sessions).values({
    id, taskId, role: "single", agentType: "claude", executor: "claude@test", cwd: repo, worktreePath: repo, branch: "main",
    cliSessionId, cliConfigDir: claudeConfig, startedAt: at, endedAt: at, exitStatus: 0,
  });
  const trace = sessionTracePath(taskId, id);
  mkdirSync(join(trace, ".."), { recursive: true });
  writeFileSync(trace, commands.map((command, seq) => JSON.stringify({
    at, turnStartedAt: at, seq, event: { kind: "tool", name: "Bash", detail: JSON.stringify({ command }) },
  })).join("\n") + "\n");
  const file = claudeSessionFilePath(realpathSync(repo), cliSessionId, claudeConfig);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, `{"sessionId":"${cliSessionId}"}\n`);
  return file;
}

const foreign = async (id: string) => {
  const response = await api.request(`/tasks/${id}/foreign-worktrees`);
  assert.equal(response.status, 200);
  return await response.json() as { worktrees: { path: string; branch: string; blocker: string | null }[]; mergeTarget: string | null };
};
const adopt = (id: string, body: unknown) => api.request(`/tasks/${id}/worktree-adopt`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

try {
  {
    assert.equal(mentionsPath(`cd /a/wt && ls`, "/a/wt"), true);
    assert.equal(mentionsPath(`cd /a/wt2 && ls`, "/a/wt"), false, "前缀相同的别的目录不算");
    assert.equal(mentionsPath(`{"file_path":"/a/wt/src/x.ts"}`, "/a/wt"), true, "目录里的文件算");
    assert.equal(mentionsPath(`git worktree add ../wt -b x`, "../wt"), true, "相对写法也算");
    assert.equal(mentionsPath(`cd x-.claude/w`, ".claude/w"), false);
    console.log("✓ a path mention needs path boundaries on both sides");
  }

  {
    const repo = await repository("adopt");
    const id = "adopttask001";
    await task(id, "adopt");
    // 智能体在兄弟目录里开了 feat/agent，提交了一个文件、还留着一个没提交的；之后 main 往前走了一步。
    const agentWt = join(root, "adopt-agent-wt");
    git(repo, "worktree", "add", "-b", "feat/agent", agentWt);
    const fork = git(repo, "rev-parse", "main");
    commit(agentWt, "agent.txt");
    writeFileSync(join(agentWt, "draft.txt"), "draft");
    commit(repo, "main-moved.txt");
    // 用户自己的 worktree（会话里没出现过）、别的任务的任务分支：都不提。
    git(repo, "worktree", "add", "-b", "user-own", join(root, "adopt-user-wt"));
    git(repo, "worktree", "add", "-b", "navi/othertas", join(root, "adopt-other-task"));
    const sessionFile = await session("sess-adopt", id, repo, [
      `git worktree add -b feat/agent ${agentWt}`,
      `cd ${agentWt} && git commit -am wip`,
      `cd ${join(root, "adopt-other-task")} && ls`,
    ]);

    const before = await foreign(id);
    assert.deepEqual(before.worktrees.map((wt) => wt.path), [realpathSync(agentWt)], "只认会话里出现过、又不归别人的那个");
    assert.equal(before.worktrees[0]!.branch, "feat/agent");
    assert.equal(before.worktrees[0]!.blocker, null, before.worktrees[0]!.blocker ?? "");
    assert.equal(before.mergeTarget, "main");
    assert.equal((await taskBranchDiff(repo, await row(id))).reason, "no_own_workspace");

    const response = await adopt(id, { path: before.worktrees[0]!.path });
    assert.equal(response.status, 200, await response.clone().text());
    const path = worktreePathFor(repo, id);
    const branch = worktreeBranchName(id);
    assert.equal(existsSync(agentWt), false, "原来的目录挪走了");
    assert.equal(readFileSync(join(path, "draft.txt"), "utf8"), "draft", "没提交的改动跟着目录过去");
    assert.equal(git(path, "rev-parse", "--abbrev-ref", "HEAD"), branch, "分支改成任务分支的名字");
    assert.equal(hasRef(repo, "refs/heads/feat/agent"), false, "旧分支名不在了");
    assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main", "项目目录的检出不动");

    const after = await row(id);
    assert.equal(after.useWorktree, true);
    assert.equal(after.worktreeBase, "main");
    assert.equal(after.mergeTargetBranch, "main");
    assert.equal(after.worktreeStartCommit, fork, "起点是跟合入分支的分叉点，不是 main 此刻的提交");
    assert.equal(git(repo, "rev-parse", baseRef(id)), fork, "冻结 ref 也钉在分叉点");
    const moved = (await db.select().from(sessions).where(eq(sessions.id, "sess-adopt")))[0]!;
    assert.equal(moved.cwd, path, "下一回合在新目录里续跑");
    assert.equal(moved.branch, branch);
    assert.equal(readFileSync(claudeSessionFilePath(realpathSync(path), "cli-sess-adopt", claudeConfig), "utf8"), readFileSync(sessionFile, "utf8"),
      "claude 会话文件按新目录的真实路径搬过去");

    const note = await takeWorkspaceNote(id);
    assert.match(note, /工作目录已更换/);
    assert.ok(note.includes(path) && note.includes(agentWt) && note.includes(branch), "说清旧目录、新目录和新分支名");

    const diff = await taskBranchDiff(repo, await row(id));
    assert.equal(diff.available, true, diff.reason);
    assert.deepEqual(diff.files.map((file) => file.path), ["agent.txt"], "改动只算智能体在那条分支上提交的，不混进 main 后来的");
    assert.deepEqual((await foreign(id)).worktrees, [], "收编之后就是自己的工作区，不再提示");
    console.log("✓ an agent-made sibling worktree is detected from the session and adopted into .worktrees/<id> on the task branch");
  }

  {
    const repo = await repository("nested");
    const id = "nestedtask01";
    await task(id, "nested");
    // claude 的 EnterWorktree 那种：嵌在项目目录里，会话里只写了相对路径。
    const nested = join(repo, ".claude", "worktrees", "x");
    mkdirSync(join(nested, ".."), { recursive: true });
    git(repo, "worktree", "add", "-b", "worktree-x", nested);
    commit(nested, "nested.txt");
    await session("sess-nested", id, repo, ["git worktree add -b worktree-x .claude/worktrees/x"]);
    const found = await foreign(id);
    assert.equal(found.worktrees.length, 1, "相对项目目录的写法也认");
    assert.equal(found.worktrees[0]!.blocker, null, "嵌在项目目录里的那个工作区本身不算项目目录的改动");

    writeFileSync(join(repo, "seed.txt"), "edited");
    const dirty = await foreign(id);
    assert.match(dirty.worktrees[0]!.blocker ?? "", /seed\.txt/, "项目目录里真有改动时说出是哪个文件");
    const refusedDirty = await adopt(id, { path: dirty.worktrees[0]!.path });
    assert.equal(refusedDirty.status, 409);
    assert.equal(existsSync(nested), true, "拒绝时什么都不动");
    git(repo, "checkout", "--", "seed.txt");

    const response = await adopt(id, { path: found.worktrees[0]!.path });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(existsSync(join(worktreePathFor(repo, id), "nested.txt")), true);
    assert.equal(git(worktreePathFor(repo, id), "status", "--porcelain"), "");
    console.log("✓ a worktree nested in the project dir is found by its relative path and does not count as project changes");
  }

  {
    const repo = await repository("shared-branch");
    const id = "sharedbr0001";
    await task(id, "shared-branch");
    const wt = join(root, "shared-branch-wt");
    git(repo, "worktree", "add", "-b", "integration", wt);
    await session("sess-shared", id, repo, [`cd ${wt}`]);
    await task("othertask001", "shared-branch", { useWorktree: true, mergeTargetBranch: "integration", title: "合进集成分支的那条" });

    const found = await foreign(id);
    assert.match(found.worktrees[0]!.blocker ?? "", /合进集成分支的那条/, "改名会碍着的那条任务点名说出来");
    const refused = await adopt(id, { path: found.worktrees[0]!.path });
    assert.equal(refused.status, 409);
    assert.equal(hasRef(repo, "refs/heads/integration"), true, "分支名没动");
    assert.equal(existsSync(wt), true, "目录没动");
    assert.equal(hasRef(repo, baseRef(id)), false, "没冻结开工点");
    assert.equal((await row(id)).useWorktree, false);
    console.log("✓ a branch another task depends on is not renamed, and nothing is touched");
  }

  {
    const repo = await repository("rollback");
    const id = "rollback0001";
    await task(id, "rollback");
    const wt = join(root, "rollback-wt");
    git(repo, "worktree", "add", "-b", "feat/rb", wt);
    commit(wt, "rb.txt");
    await session("sess-rb", id, repo, [`cd ${wt}`]);
    // 新目录对应的会话目录的位置上被一个文件占着：复制必然失败，走「目录已经挪过去之后」的失败分支。
    const blockedDir = dirname(claudeSessionFilePath(join(realRoot, "rollback", ".worktrees", id), "x", claudeConfig));
    mkdirSync(join(blockedDir, ".."), { recursive: true });
    writeFileSync(blockedDir, "not a directory");

    const path = (await foreign(id)).worktrees[0]!.path;
    const failed = await adopt(id, { path });
    assert.equal(failed.status, 409);
    assert.match((await failed.json()).error, /半路失败/);
    assert.equal(existsSync(wt), true, "目录挪回原处");
    assert.equal(existsSync(worktreePathFor(repo, id)), false);
    assert.equal(git(wt, "rev-parse", "--abbrev-ref", "HEAD"), "feat/rb", "分支名改回去");
    assert.equal(hasRef(repo, `refs/heads/${worktreeBranchName(id)}`), false);
    assert.equal(hasRef(repo, baseRef(id)), false, "冻结的开工点收回了");
    assert.equal((await row(id)).useWorktree, false);
    assert.equal((await db.select().from(sessions).where(eq(sessions.id, "sess-rb")))[0]!.cwd, repo, "会话行没改");

    rmSync(blockedDir);
    const retried = await adopt(id, { path });
    assert.equal(retried.status, 200, await retried.clone().text());
    console.log("✓ a failure after the move puts the directory, branch name and frozen ref back, and can be retried");
  }

  {
    const repo = await repository("running");
    const id = "runningtask1";
    await task(id, "running", { status: "running" });
    const wt = join(root, "running-wt");
    git(repo, "worktree", "add", "-b", "feat/run", wt);
    await session("sess-run", id, repo, [`cd ${wt}`]);
    const refused = await adopt(id, { path: wt });
    assert.equal(refused.status, 409, "智能体正在跑时不挪它的目录");
    assert.equal(existsSync(wt), true);
    console.log("✓ a running task is not adopted");
  }
} finally {
  await removeTmpStage(realRoot);
  rmSync(root, { force: true });
}
