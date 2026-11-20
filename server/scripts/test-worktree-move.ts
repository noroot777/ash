// 把没有独立工作区的任务改到 `navi/<id8>` worktree（task-worktree-move.ts）。
//
// 钉住的几件事：
//   1. 用户入口（任务没在跑）：当场建出 worktree，起点按分支冻结，任务行、会话行一起改指新目录；claude 的会话
//      文件（连旁挂目录）复制到新目录对应的位置；下一回合要贴给智能体的那句「目录换了」取一次就没了；
//      改之前「改动」说的是没有独立工作区，改之后能按任务分支算出 diff。
//   2. 项目目录里有未提交的改动：一律拒绝、说出是哪个文件，什么都不建（没有 worktree、没有任务分支、没有冻结 ref）。
//   3. 智能体入口（任务正在跑、带着这一回合的身份）：只登记 + 留续跑交代；下一回合开头办掉。办不成也清掉登记，
//      把原因留给智能体。没带回合身份的，任务在跑时一律拒。
//   4. 已经在独立工作区里的任务拒绝；还没办的登记可以撤回。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { removeTmpStage } from "./tmp-db.js";

const realRoot = realpathSync(mkdtempSync(join(tmpdir(), "navi-worktree-move-")));
// 项目路径故意走一层软链（像 macOS 上的 /tmp → /private/tmp）：claude 按进程的真实目录存会话文件，
// 库里记的却是软链那种拼法，搬会话文件时两边都得按真实路径对上。
const root = `${realRoot}-link`;
symlinkSync(realRoot, root);
process.env.NAVI_DB = join(root, "navi.db");
process.env.NAVI_RUNS_DIR = join(root, "runs");
// claude 的会话文件一律落在这个临时配置目录里（会话行记着它），不碰真的 ~/.claude。
const claudeConfig = join(root, "claude-config");

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const { db, ensureSchema } = await import("../src/db/index.js");
const { projects, sessions, tasks } = await import("../src/db/schema.js");
const { mountWorktreeMoveRoutes } = await import("../src/task-worktree-move-routes.js");
const { applyPendingWorktreeMove, takeWorkspaceNote } = await import("../src/task-worktree-move.js");
const { claudeSessionFilePath } = await import("../src/handoff-collect.js");
const { taskBranchDiff } = await import("../src/git-diff.js");
const { baseRef } = await import("../src/task-branch-plan.js");
const { worktreeBranchName, worktreePathFor } = await import("../src/git.js");
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
  git(repo, "config", "user.name", "Move Test");
  git(repo, "config", "user.email", "move@example.test");
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

async function claudeSession(id: string, taskId: string, cwd: string, cliSessionId: string) {
  await db.insert(sessions).values({
    id, taskId, role: "single", agentType: "claude", executor: "claude@test", cwd, worktreePath: cwd, branch: "main",
    cliSessionId, cliConfigDir: claudeConfig, startedAt: at, endedAt: at, exitStatus: 0,
  });
  const file = claudeSessionFilePath(realpathSync(cwd), cliSessionId, claudeConfig);
  mkdirSync(join(file, "..", cliSessionId, "subagents"), { recursive: true });
  writeFileSync(file, `{"sessionId":"${cliSessionId}"}\n`);
  writeFileSync(join(file, "..", cliSessionId, "subagents", "agent-1.jsonl"), "{}\n");
}

const post = (id: string, body: unknown, headers: Record<string, string> = {}) => api.request(`/tasks/${id}/worktree-move`, {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});

try {
  {
    const repo = await repository("user-move");
    git(repo, "checkout", "-b", "feature");
    const featureHead = commit(repo, "feature.txt");
    git(repo, "checkout", "main");
    const id = "usermove0001";
    await task(id, "user-move");
    await claudeSession("sess-user", id, repo, "cli-user-1");
    assert.equal((await taskBranchDiff(repo, await row(id))).reason, "no_own_workspace", "改之前没有任务分支可比，不该说成分支被清理");

    const response = await post(id, { base: "feature" });
    assert.equal(response.status, 200, await response.clone().text());
    const moved = (await response.json()).moved as { path: string; branch: string };
    const path = worktreePathFor(repo, id);
    assert.equal(moved.path, path);
    assert.equal(moved.branch, worktreeBranchName(id));

    const after = await row(id);
    assert.equal(after.useWorktree, true);
    assert.equal(after.worktreeBase, "feature");
    assert.equal(after.worktreeStartCommit, featureHead, "起点冻结在起点分支此刻的提交");
    assert.equal(after.worktreeBaseBranch, "feature");
    assert.equal(after.mergeTargetBranch, "feature", "没给合入分支时按起点定（跟新建任务同一份规则）");
    assert.equal(after.worktreeMoveRequest, null);
    assert.equal(git(path, "rev-parse", "HEAD"), featureHead);
    assert.equal(git(path, "rev-parse", "--abbrev-ref", "HEAD"), worktreeBranchName(id));
    assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main", "项目目录的检出不动");
    assert.ok(hasRef(repo, baseRef(id)), "开工点照新建任务那样钉住");

    const session = (await db.select().from(sessions).where(eq(sessions.id, "sess-user")))[0]!;
    assert.equal(session.cwd, path, "下一回合按会话行上的目录起跑，必须改指新目录");
    assert.equal(session.worktreePath, path);
    assert.equal(session.branch, worktreeBranchName(id));
    const carried = claudeSessionFilePath(realpathSync(path), "cli-user-1", claudeConfig);
    assert.equal(readFileSync(carried, "utf8"), `{"sessionId":"cli-user-1"}\n`, "claude 会话文件跟着搬到新目录的项目目录下");
    assert.ok(existsSync(join(carried, "..", "cli-user-1", "subagents", "agent-1.jsonl")), "旁挂目录一并带上");
    assert.ok(existsSync(claudeSessionFilePath(realpathSync(repo), "cli-user-1", claudeConfig)), "原来那份留着（复制，不是挪走）");

    const note = await takeWorkspaceNote(id);
    assert.match(note, /工作目录已更换/);
    assert.ok(note.includes(path) && note.includes(repo), "说清新目录和原目录");
    assert.equal(await takeWorkspaceNote(id), "", "那句话只说一次");

    commit(path, "work.txt");
    const diff = await taskBranchDiff(repo, await row(id));
    assert.equal(diff.available, true, diff.reason);
    assert.deepEqual(diff.files.map((file) => file.path), ["work.txt"], "改动按任务分支相对起点算");

    const again = await post(id, { base: "main" });
    assert.equal(again.status, 409, "已经在独立工作区里的不能再改");
    console.log("✓ user entry moves an idle task into its own worktree and carries the claude session");
  }

  {
    const repo = await repository("dirty-project");
    const id = "dirtymove002";
    await task(id, "dirty-project");
    writeFileSync(join(repo, "stray.txt"), "uncommitted\n");
    const response = await post(id, { base: "main" });
    assert.equal(response.status, 409);
    const error = (await response.json()).error as string;
    assert.match(error, /stray\.txt/, "说出是哪个文件");
    assert.match(error, /不会替你搬走或丢掉/);
    const after = await row(id);
    assert.equal(after.useWorktree, false);
    assert.equal(existsSync(worktreePathFor(repo, id)), false, "什么都不建");
    assert.equal(hasRef(repo, `refs/heads/${worktreeBranchName(id)}`), false);
    assert.equal(hasRef(repo, baseRef(id)), false);
    assert.equal(readFileSync(join(repo, "stray.txt"), "utf8"), "uncommitted\n", "未提交的改动原样留着");
    console.log("✓ uncommitted changes in the project directory refuse the move and leave everything in place");
  }

  {
    const repo = await repository("agent-move");
    const id = "agentmove003";
    await task(id, "agent-move", { status: "running", activeTurnToken: "turn-1", activeDirectionToken: "dir-1" });
    await claudeSession("sess-agent", id, repo, "cli-agent-1");

    const anonymous = await post(id, { base: "main" });
    assert.equal(anonymous.status, 409, "任务在跑时没带回合身份的一律拒");

    const response = await post(id, { base: "main" }, { "x-navi-turn-token": "turn-1", "x-navi-direction-token": "dir-1" });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).requested, true);
    let current = await row(id);
    assert.equal(current.useWorktree, false, "这一回合还在跑，目录换不得");
    assert.equal(JSON.parse(current.worktreeMoveRequest!).base, "main");
    assert.match(current.resumePrompt ?? "", /改到独立工作区/, "留续跑交代：这一回合结束落已暂停，等 Navi 叫起");

    // 回合结束、下一回合开头（turn-session-pick.ts 调的就是它）。
    await db.update(tasks).set({ status: "paused", activeTurnToken: null, activeDirectionToken: null }).where(eq(tasks.id, id));
    const next = await row(id);
    await applyPendingWorktreeMove(next);
    assert.equal(next.useWorktree, true, "传进来的任务行就地刷成新值");
    current = await row(id);
    assert.equal(current.worktreeMoveRequest, null);
    const session = (await db.select().from(sessions).where(eq(sessions.id, "sess-agent")))[0]!;
    assert.equal(session.cwd, worktreePathFor(repo, id));
    assert.ok(existsSync(claudeSessionFilePath(realpathSync(worktreePathFor(repo, id)), "cli-agent-1", claudeConfig)));
    assert.match(await takeWorkspaceNote(id), /工作目录已更换/);
    console.log("✓ agent entry records the request and the next turn applies it before picking the session");
  }

  {
    const repo = await repository("agent-move-fails");
    const id = "agentfail004";
    await task(id, "agent-move-fails", { status: "running", activeTurnToken: "turn-2", activeDirectionToken: "dir-2" });
    const response = await post(id, { base: "main" }, { "x-navi-turn-token": "turn-2", "x-navi-direction-token": "dir-2" });
    assert.equal(response.status, 200, await response.clone().text());
    // 登记之后、下一回合之前，项目目录里多了一处未提交的改动：办不成。
    writeFileSync(join(repo, "late.txt"), "late\n");
    await db.update(tasks).set({ status: "paused", activeTurnToken: null, activeDirectionToken: null }).where(eq(tasks.id, id));
    await applyPendingWorktreeMove(await row(id));
    const after = await row(id);
    assert.equal(after.useWorktree, false);
    assert.equal(after.worktreeMoveRequest, null, "办不成也清掉登记，不让下一回合再撞一次");
    const note = await takeWorkspaceNote(id);
    assert.match(note, /没做成/);
    assert.match(note, /late\.txt/, "原因原样告诉智能体");
    console.log("✓ a pending move that cannot be applied is cleared and the reason goes to the agent");
  }

  {
    await repository("cancel-move");
    const id = "cancelmove05";
    await task(id, "cancel-move", { status: "running", activeTurnToken: "turn-3", activeDirectionToken: "dir-3" });
    const response = await post(id, { base: "main" }, { "x-navi-turn-token": "turn-3", "x-navi-direction-token": "dir-3" });
    assert.equal(response.status, 200);
    const cancelled = await api.request(`/tasks/${id}/worktree-move`, { method: "DELETE" });
    assert.equal(cancelled.status, 200, await cancelled.clone().text());
    assert.equal((await row(id)).worktreeMoveRequest, null);
    assert.match(await takeWorkspaceNote(id), /撤回/);
    const missing = await post(id, { base: "no-such-branch" }, { "x-navi-turn-token": "turn-3", "x-navi-direction-token": "dir-3" });
    assert.equal(missing.status, 400, "起点读不出提交当场说清");
    console.log("✓ a pending move can be withdrawn; an unreadable start point is refused up front");
  }
} finally {
  await removeTmpStage(realRoot);
  rmSync(root, { force: true });
}
