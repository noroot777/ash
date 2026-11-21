// 收编智能体自建的工作区（foreign-worktrees.ts 认、task-worktree-adopt.ts 办）。
//
// 钉住的几件事：
//   1. 认：只认这条任务在里面干过活的结构化事实 —— 写入账里有落在里面的文件或命令工作目录、会话行记在那个
//      目录（或它底下）上、claude 会话文件里记的工作目录在里面；展示用的轨迹文本一概不读，所以只是提到过
//      路径的、引号里像命令的（`echo 'cd <目录>'`）都不算。Navi 管着的任务工作区（开了独立工作区的任务的
//      `.worktrees/<id>`）、分支是别的任务的任务分支的，一律不提；`.worktrees/` 底下没登记的照样是候选。
//   2. 收编：目录挪到 `.worktrees/<id>`、分支改名成 `navi/<id8>`，未提交的改动原样跟过去；起点冻结在跟合入分支的
//      分叉点上，「改动」只算智能体在那条分支上做的；任务行、会话行改指新目录，claude 会话文件搬过去，
//      下一回合给智能体一句交代；办完之后就是一条普通的开了独立工作区的任务，不再提示。
//      会话本来就在被收编的目录（或它的子目录）里跑的，会话行和 claude 会话文件同样跟过去，子目录照相对位置映射。
//      智能体恰好建在本任务标准位置 `.worktrees/<id>` 上的：不挪目录，只改分支名、登记。
//   3. 改名会碍着别人（分支是别的任务的合入目标，归档了的也算）、项目目录里有未提交的改动：拒绝并说清楚，
//      什么都不动；被收编的那个目录嵌在项目目录里时，它本身不算项目目录的改动。合入分支选什么跟这些无关：
//      项目目录没检出分支时，提示里不拦，提交时选一条就能办。
//   4. 半路失败（会话文件搬不过去）：分支名改回去、冻结 ref 删掉，可以直接重试；收回本身失败时照实说哪几处没还原。
//   5. 任务在跑时拒绝；预览实例一律拒绝（它的库是快照，仓库是真的）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
const { projects, sessions, taskWrites, tasks } = await import("../src/db/schema.js");
const { mountWorktreeMoveRoutes } = await import("../src/task-worktree-move-routes.js");
const { takeWorkspaceNote } = await import("../src/task-worktree-move.js");
const { claudeSessionFilePath } = await import("../src/handoff-collect.js");
const { taskBranchDiff } = await import("../src/git-diff.js");
const { baseRef } = await import("../src/task-branch-plan.js");
const { worktreeBranchName, worktreePathFor } = await import("../src/git.js");
const { sessionTracePath } = await import("../src/transcript.js");
const { undoAdopt } = await import("../src/task-worktree-adopt.js");
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

/**
 * 一条 claude 会话：会话行记在 `dir` 上（缺省 `worktreePath` 也是它），会话文件按 `dir` 的真实路径存，
 * 每条记录带着当时的工作目录（`cwds`，缺省就是 `dir`）。`commands` 写进展示用的执行轨迹 —— 认工作区时不读它。
 */
async function session(id: string, taskId: string, dir: string, opts: { worktreePath?: string; cwds?: string[]; commands?: string[] } = {}) {
  const cliSessionId = `cli-${id}`;
  await db.insert(sessions).values({
    id, taskId, role: "single", agentType: "claude", executor: "claude@test", cwd: dir, worktreePath: opts.worktreePath ?? dir, branch: "main",
    cliSessionId, cliConfigDir: claudeConfig, startedAt: at, endedAt: at, exitStatus: 0,
  });
  const trace = sessionTracePath(taskId, id);
  mkdirSync(join(trace, ".."), { recursive: true });
  writeFileSync(trace, (opts.commands ?? []).map((command, seq) => JSON.stringify({
    at, turnStartedAt: at, seq, event: { kind: "tool", name: "Bash", detail: JSON.stringify({ command }) },
  })).join("\n") + "\n");
  const file = claudeSessionFilePath(realpathSync(dir), cliSessionId, claudeConfig);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, (opts.cwds ?? [dir]).map((cwd) => JSON.stringify({ sessionId: cliSessionId, cwd })).join("\n") + "\n");
  return file;
}

/** 写入账里的一行（executors/tool-writes.ts 记的那种：真实路径；`weak` = codex 命令的工作目录）。 */
async function wrote(taskId: string, path: string, weak = 0) {
  const real = realpathSync(existsSync(path) ? path : dirname(path));
  await db.insert(taskWrites).values({ taskId, path: existsSync(path) ? real : join(real, basename(path)), weak, firstAt: at, lastAt: at });
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
    const sessionFile = await session("sess-adopt", id, repo);
    await wrote(id, join(agentWt, "agent.txt"));
    await wrote(id, join(root, "adopt-other-task"), 1);

    const before = await foreign(id);
    assert.deepEqual(before.worktrees.map((wt) => wt.path), [realpathSync(agentWt)], "只认在里面写过东西、又不归别人的那个");
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
    console.log("✓ an agent-made sibling worktree is detected from the write ledger and adopted into .worktrees/<id> on the task branch");
  }

  {
    const repo = await repository("nested");
    const id = "nestedtask01";
    await task(id, "nested");
    // claude 的 EnterWorktree 那种：嵌在项目目录里，会话行还记在项目目录上，claude 会话文件里的工作目录换成了它。
    const nested = join(repo, ".claude", "worktrees", "x");
    mkdirSync(join(nested, ".."), { recursive: true });
    git(repo, "worktree", "add", "-b", "worktree-x", nested);
    commit(nested, "nested.txt");
    await session("sess-nested", id, repo, { cwds: [repo, nested] });
    const found = await foreign(id);
    assert.equal(found.worktrees.length, 1, "claude 会话文件里记的工作目录在里面就认");
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
    console.log("✓ a worktree nested in the project dir is found by the claude cwd and does not count as project changes");
  }

  {
    const repo = await repository("shared-branch");
    const id = "sharedbr0001";
    await task(id, "shared-branch");
    const wt = join(root, "shared-branch-wt");
    git(repo, "worktree", "add", "-b", "integration", wt);
    await session("sess-shared", id, repo);
    await wrote(id, wt, 1);
    // 归档了也算依赖：取回之后它照样要找这条分支。
    await task("othertask001", "shared-branch", { useWorktree: true, mergeTargetBranch: "integration", title: "合进集成分支的那条", archived: true });

    const found = await foreign(id);
    assert.match(found.worktrees[0]!.blocker ?? "", /合进集成分支的那条」［已归档］/, "改名会碍着的那条任务点名说出来，归档的也算");
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
    await session("sess-rb", id, repo);
    await wrote(id, join(wt, "rb.txt"));
    // 新目录对应的会话目录的位置上被一个文件占着：复制必然失败，走「分支已经改过名之后」的失败分支。
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
    console.log("✓ a failure midway puts the directory, branch name and frozen ref back, and can be retried");
  }

  {
    // 收回本身也会失败（目录挪走之后原位置被别的东西占了）：照实说哪几处没还原，不报「已经收回原样」。
    const repo = await repository("undo-left");
    const from = join(root, "undo-left-wt");
    git(repo, "worktree", "add", "-b", "feat/left", from);
    const to = join(repo, ".worktrees", "undoleft0001");
    mkdirSync(join(repo, ".worktrees"));
    git(repo, "worktree", "move", from, to);
    git(repo, "branch", "-m", "feat/left", worktreeBranchName("undoleft0001"));
    mkdirSync(from);
    writeFileSync(join(from, "occupied"), "x");
    const left = await undoAdopt(repo, {
      plan: {}, renamed: { from: "feat/left", to: worktreeBranchName("undoleft0001") }, moved: { from, to }, created: [],
    });
    assert.equal(left.length, 1, left.join("\n"));
    assert.match(left[0]!, /工作区还在 .*没挪回/);
    assert.ok(left[0]!.includes(`git worktree move '${to}' '${from}'`), "给出能直接粘贴的手动还原命令");
    assert.match(left[0]!, /已经被别的东西占了，先把它挪开/, "原位置被占时先说要挪开它");
    assert.equal(hasRef(repo, "refs/heads/feat/left"), true, "能还原的那几项照样还原了");
    console.log("✓ a rollback that cannot fully restore says exactly what is left");
  }

  {
    // 轨迹文本里只是提到过路径、引号里像命令的都不算；`.worktrees/` 底下没登记的那个才是智能体干活的地方。
    const repo = await repository("evidence");
    const id = "evidence0001";
    await task(id, "evidence");
    const userWt = join(root, "evidence-user-wt");
    git(repo, "worktree", "add", "-b", "user-branch", userWt);
    mkdirSync(join(repo, ".worktrees"));
    const manual = join(repo, ".worktrees", "manual");
    git(repo, "worktree", "add", "-b", "manual-branch", manual);
    await session("sess-evidence", id, repo, { commands: [
      `echo 'User worktree, do not use: ${userWt}'`,
      `echo 'cd ${userWt}'`,
      `git -C ${userWt} log -1 # 看一眼`,
    ] });
    await wrote(id, join(manual, "manual.txt"));
    // 开了独立工作区的别的任务的标准目录：Navi 管着的，在里面写过也不提（分支不是任务分支的样子也一样）。
    await task("evidother001", "evidence", { useWorktree: true });
    const owned = join(repo, ".worktrees", "evidother001");
    git(repo, "worktree", "add", "-b", "custom-owned", owned);
    await wrote(id, join(owned, "owned.txt"));
    const found = await foreign(id);
    assert.deepEqual(found.worktrees.map((wt) => wt.branch), ["manual-branch"], "轨迹里提到、引号里像命令的用户目录不算；.worktrees/ 底下没登记的照样认");
    console.log("✓ trace text is not evidence, a Navi-owned worktree is skipped, and an unregistered one under .worktrees/ is found");
  }

  {
    // 会话本来就记在被收编的目录上（claude 从那里起跑），轨迹里没有路径：靠会话行认，收编时会话行和
    // 会话文件都跟过去（会话文件按被收编目录的真实路径存）。
    const repo = await repository("cwd-session");
    const id = "cwdsession01";
    await task(id, "cwd-session");
    const wt = join(root, "cwd-session-wt");
    git(repo, "worktree", "add", "-b", "feat/cwd", wt);
    commit(wt, "cwd.txt");
    await db.insert(sessions).values({
      id: "sess-cwd", taskId: id, role: "single", agentType: "claude", executor: "claude@test", cwd: wt, worktreePath: wt, branch: "feat/cwd",
      cliSessionId: "cli-cwd", cliConfigDir: claudeConfig, startedAt: at, endedAt: at, exitStatus: 0,
    });
    const source = claudeSessionFilePath(realpathSync(wt), "cli-cwd", claudeConfig);
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, `{"sessionId":"cli-cwd"}\n`);
    // 老会话行没记 `cwd`、只有 `worktreePath`：它实际就在那里跑，会话文件和旁挂目录同样要跟过去。
    await db.insert(sessions).values({
      id: "sess-legacy", taskId: id, role: "single", agentType: "claude", executor: "claude@test", cwd: null, worktreePath: wt, branch: "feat/cwd",
      cliSessionId: "cli-legacy", cliConfigDir: claudeConfig, startedAt: at, endedAt: at, exitStatus: 0,
    });
    const legacy = claudeSessionFilePath(realpathSync(wt), "cli-legacy", claudeConfig);
    writeFileSync(legacy, `{"sessionId":"cli-legacy"}\n`);
    mkdirSync(join(dirname(legacy), "cli-legacy"));
    writeFileSync(join(dirname(legacy), "cli-legacy", "agent.jsonl"), "sidecar");

    const found = await foreign(id);
    assert.equal(found.worktrees.length, 1, "会话行记在那个目录上就是证据");
    assert.equal(found.worktrees[0]!.seenAs, wt, "照会话里的写法说");
    const response = await adopt(id, { path: found.worktrees[0]!.path });
    assert.equal(response.status, 200, await response.clone().text());
    const path = worktreePathFor(repo, id);
    const moved = (await db.select().from(sessions).where(eq(sessions.id, "sess-cwd")))[0]!;
    assert.equal(moved.cwd, path, "原本就在被收编目录里的会话也改指新目录");
    assert.equal(moved.worktreePath, path);
    assert.equal(moved.branch, worktreeBranchName(id));
    assert.equal(readFileSync(claudeSessionFilePath(realpathSync(path), "cli-cwd", claudeConfig), "utf8"), `{"sessionId":"cli-cwd"}\n`,
      "会话文件从被收编目录的位置搬到新目录的位置");
    const legacyMoved = (await db.select().from(sessions).where(eq(sessions.id, "sess-legacy")))[0]!;
    assert.equal(legacyMoved.cwd, path, "没记 cwd 的老行按 worktreePath 改指新目录");
    const legacyTarget = claudeSessionFilePath(realpathSync(path), "cli-legacy", claudeConfig);
    assert.equal(readFileSync(legacyTarget, "utf8"), `{"sessionId":"cli-legacy"}\n`, "老行的会话文件按 worktreePath 那个位置搬过去");
    assert.equal(readFileSync(join(dirname(legacyTarget), "cli-legacy", "agent.jsonl"), "utf8"), "sidecar", "旁挂目录一起带上");
    console.log("✓ a session already running in the adopted worktree is detected and carried along, legacy rows without cwd included");
  }

  {
    // 会话跑在被收编目录的子目录里（monorepo 的某个包）：会话行和会话文件照相对位置映射到新目录的同一个子目录。
    const repo = await repository("sub-session");
    const id = "subsession01";
    await task(id, "sub-session");
    const wt = join(root, "sub-session-wt");
    git(repo, "worktree", "add", "-b", "feat/sub", wt);
    mkdirSync(join(wt, "pkg"));
    commit(wt, "pkg/sub.txt");
    const source = await session("sess-sub", id, join(wt, "pkg"), { worktreePath: wt });
    // 记在项目目录子目录上的另一条会话不跟着挪：项目目录没动。
    mkdirSync(join(repo, "docs"));
    await session("sess-repo-sub", id, join(repo, "docs"));

    const found = await foreign(id);
    assert.equal(found.worktrees.length, 1, "会话行记在它的子目录上也是在里面干过活");
    const response = await adopt(id, { path: found.worktrees[0]!.path });
    assert.equal(response.status, 200, await response.clone().text());
    const path = worktreePathFor(repo, id);
    const moved = (await db.select().from(sessions).where(eq(sessions.id, "sess-sub")))[0]!;
    assert.equal(moved.cwd, join(path, "pkg"), "工作目录映射到新目录的同一个子目录");
    assert.equal(moved.worktreePath, path);
    assert.equal(readFileSync(claudeSessionFilePath(realpathSync(join(path, "pkg")), "cli-sess-sub", claudeConfig), "utf8"),
      readFileSync(source, "utf8"), "会话文件搬到子目录对应的位置");
    assert.equal((await db.select().from(sessions).where(eq(sessions.id, "sess-repo-sub")))[0]!.cwd, join(repo, "docs"),
      "项目目录子目录上的会话不动");
    console.log("✓ a session in a subdirectory of the adopted worktree is mapped to the same subdirectory");
  }

  {
    // 智能体恰好把工作区建在了本任务的标准位置上：不挪目录，只改分支名、登记成独立工作区。
    const repo = await repository("standard");
    const id = "standard0001";
    await task(id, "standard");
    const path = worktreePathFor(repo, id);
    mkdirSync(join(repo, ".worktrees"));
    git(repo, "worktree", "add", "-b", "feat/std", path);
    commit(path, "std.txt");
    writeFileSync(join(path, "draft.txt"), "draft");
    await session("sess-std", id, repo);
    await wrote(id, join(path, "std.txt"));

    const found = await foreign(id);
    assert.equal(found.worktrees.length, 1, "本任务还没开独立工作区，标准位置上的这个不算受管");
    assert.equal(found.worktrees[0]!.blocker, null, found.worktrees[0]!.blocker ?? "");
    const response = await adopt(id, { path: found.worktrees[0]!.path });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(readFileSync(join(path, "draft.txt"), "utf8"), "draft", "目录原地不动");
    assert.equal(git(path, "rev-parse", "--abbrev-ref", "HEAD"), worktreeBranchName(id), "分支改成任务分支的名字");
    const after = await row(id);
    assert.equal(after.useWorktree, true);
    assert.equal((await db.select().from(sessions).where(eq(sessions.id, "sess-std")))[0]!.cwd, path);
    assert.deepEqual((await taskBranchDiff(repo, after)).files.map((file) => file.path), ["std.txt"]);
    assert.deepEqual((await foreign(id)).worktrees, [], "办完就是自己的工作区");
    console.log("✓ a worktree already at the task's standard path is adopted in place");
  }

  {
    // 项目目录没检出分支：提示里不拦（选一条合入分支就行），提交时给了合入分支就办。
    const repo = await repository("detached");
    const id = "detached0001";
    await task(id, "detached");
    const wt = join(root, "detached-wt");
    git(repo, "worktree", "add", "-b", "feat/det", wt);
    commit(wt, "det.txt");
    git(repo, "checkout", "--detach");
    await session("sess-det", id, repo);
    await wrote(id, join(wt, "det.txt"));
    const found = await foreign(id);
    assert.equal(found.mergeTarget, null, "没有可缺省的合入分支");
    assert.equal(found.worktrees[0]!.blocker, null, "合入分支怎么选不算拦路的条件");
    const missing = await adopt(id, { path: found.worktrees[0]!.path });
    assert.equal(missing.status, 400, "不给合入分支时说清楚要选一条");
    const response = await adopt(id, { path: found.worktrees[0]!.path, mergeTargetBranch: "main" });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await row(id)).mergeTargetBranch, "main");
    console.log("✓ the merge target is checked against the chosen branch, not the default");
  }

  {
    // 预览实例：库是快照、仓库是真的，收编一律不办（另起一个带 NAVI_PREVIEW=1 的进程，它在 import 时就定了）。
    const out = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      const { adoptionBlocker } = await import(${JSON.stringify(new URL("../src/task-worktree-adopt.ts", import.meta.url).pathname)});
      const refused = await adoptionBlocker({ id: "x" }, "/nowhere", { path: "/nowhere/wt", seenAs: "/nowhere/wt", branch: "b", head: "h", locked: false });
      console.log(refused?.message ?? "NOT REFUSED");
    `], { encoding: "utf8", env: { ...process.env, NAVI_PREVIEW: "1", NAVI_DB: join(root, "preview.db") }, cwd: new URL("..", import.meta.url).pathname });
    assert.match(out, /预览实例不做「收编智能体自建的工作区」/);
    console.log("✓ a preview instance refuses to adopt");
  }

  {
    const repo = await repository("running");
    const id = "runningtask1";
    await task(id, "running", { status: "running" });
    const wt = join(root, "running-wt");
    git(repo, "worktree", "add", "-b", "feat/run", wt);
    await session("sess-run", id, repo);
    await wrote(id, wt, 1);
    const refused = await adopt(id, { path: wt });
    assert.equal(refused.status, 409, "智能体正在跑时不挪它的目录");
    assert.equal(existsSync(wt), true);
    console.log("✓ a running task is not adopted");
  }
} finally {
  await removeTmpStage(realRoot);
  rmSync(root, { force: true });
}
