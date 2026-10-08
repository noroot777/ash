// 归档时的 worktree/分支去留（server/src/task-archive-cleanup.ts + 归档路由）。
//
// 覆盖「归档也删」这条行为的全部不变量：
//   1. 默认档 all：worktree 真的没了；分支还有未合并提交时**保留**（只用 `-d`，绝不 -D）
//   2. 分支已合并 → 连分支一起收掉
//   3. 设置 worktree：只删目录，分支一律留着
//   4. 设置 none：上线前的旧行为，磁盘一个字节不动
//   5. 清理失败不影响归档：worktree 脏 → 任务照样 archived，报告里带 git 原话
//   6. 别的任务钉着这个分支（worktreeBase）→ 分支不删，照实说原因
//   7. 团队：执行者的工作区跟着 lead 一起收
//   8. 取回时如实交代工作区实情（目录已不在、分支还在 → 下次运行会重建）
//   9. 清理排队期间被取回 → 这次清理作废，正在用的目录不许删（第 1 轮审查）
//  9b. 同上，但取回后还没点运行：回合锁空着，靠占锁后复查 archived 挡住（同上）
//  10. 删掉已合并的分支要留下恢复起点，取回重建回到任务完成时而不是开工点（同上）
//  11. 预览实例一律不清理：它的任务行指向真仓库（同上）
//  12. 团队：共用领队目录的执行者也要被锁住，取回挡在清理之后（第 2 轮审查）
//  13. 没冻结过开工点的旧任务，取回也按保存的完成提交重建（同上）
//  14. 恢复起点存不下来就保留分支，绝不报成「已清理」（同上）
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

const stage = mkdtempSync(join(tmpdir(), "ash-archive-cleanup-"));
const repo = join(stage, "repo");
process.env.ASH_DB = join(stage, "test.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const branchExists = (name: string) => {
  try { git(repo, "show-ref", "--verify", "--quiet", `refs/heads/${name}`); return true; }
  catch { return false; }
};

try {
  execFileSync("git", ["init", "-b", "main", repo]);
  git(repo, "config", "user.name", "Ash Test");
  git(repo, "config", "user.email", "ash@example.test");
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "seed");

  const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks, appSettings } = await import("../src/db/schema.js");
  const { setInstanceMode } = await import("../src/auth/mode.js");
  const { prepareWorktree, worktreeBranchName } = await import("../src/git.js");
  const { mountTaskArchiveRoutes } = await import("../src/task-archive-routes.js");
  const { summarizeArchiveCleanup } = await import("@ash/shared/project");
  await ensureSchema();
  await setInstanceMode("single", stage);

  const app = new Hono();
  mountTaskArchiveRoutes(app);
  const archive = (id: string) => app.request(`/tasks/${id}/archive`, { method: "POST" });
  const unarchive = (id: string) => app.request(`/tasks/${id}/unarchive`, { method: "POST" });
  const ts = new Date().toISOString();
  await db.insert(projects).values({ id: "project", name: "归档清理", repoPath: repo, createdAt: ts });

  // 分支名是 `ash/<id 前 8 位>`（worktreeBranchName），所以各用例的 id 前 8 位必须互不
  // 相同 —— 撞了的话第二个 prepareWorktree 直接报 "already used by worktree"。
  type TaskSeed = { id: string; status?: string; mode?: string; parentId?: string; worktreeBase?: string };
  const seed = async ({ id, status = "done", mode = "single", parentId, worktreeBase }: TaskSeed) => {
    await db.insert(tasks).values({
      id, projectId: "project", title: `任务 ${id}`, body: "", mode, status,
      ...(parentId ? { parentId } : {}), ...(worktreeBase ? { worktreeBase } : {}),
      createdAt: ts, updatedAt: ts,
    });
  };
  const setClean = async (value: "all" | "worktree" | "none") => {
    await db.insert(appSettings).values({ key: "archiveClean", value: JSON.stringify(value) })
      .onConflictDoUpdate({ target: appSettings.key, set: { value: JSON.stringify(value) } });
  };
  /** worktree 里落一个提交 —— 这才是「未验收任务」的常态：分支领先于 main。 */
  const commitIn = (path: string, name: string) => {
    writeFileSync(join(path, name), "work\n");
    git(path, "add", "-A");
    git(path, "commit", "-m", `work ${name}`);
  };

  // ── 1. 默认 all：目录删掉，未合并的分支留着 ──────────────────────────────
  {
    const id = "arcAplain01";
    await seed({ id });
    const ws = await prepareWorktree(repo, id, "main");
    commitIn(ws.path, "a.txt");
    const branch = worktreeBranchName(id);

    const response = await archive(id);
    const raw = await response.text();
    assert.equal(response.status, 200, raw);
    const body = JSON.parse(raw) as { task: { archived: boolean }; cleanup: { items: { worktreeRemoved: boolean; branchDeleted: boolean; branch: string | null; branchError: string | null }[] } };
    assert.equal(body.task.archived, true, "归档本身必须成功");
    assert.equal(existsSync(ws.path), false, "worktree 目录应被删除");
    assert.equal(branchExists(branch), true, "未合并的分支绝不能被删掉");
    const item = body.cleanup.items[0];
    assert.equal(item.worktreeRemoved, true);
    assert.equal(item.branchDeleted, false, "git branch -d 必须拒绝未合并分支");
    assert.equal(item.branch, branch, "保留下来的分支要在报告里露脸");
    assert.match(item.branchError ?? "", /not fully merged|未合并/i, "要带上 git 原话");
    assert.match(summarizeArchiveCleanup(body.cleanup as never), /^已清理 worktree；分支 .* 已保留（/, "单个任务别说「1 个 worktree」");

    // ── 8. 取回时交代实情：目录没了、分支还在 → 下次运行会重建
    const restored = await unarchive(id);
    const back = await restored.json() as { task: { archived: boolean }; restoreNote: string | null };
    assert.equal(back.task.archived, false);
    assert.match(back.restoreNote ?? "", new RegExp(`按分支 ${branch} 重建`), "取回必须说清工作区状态");
  }

  // ── 2. 分支已合并：两样都收掉 ───────────────────────────────────────────
  {
    const id = "arcBmerged2";
    await seed({ id });
    const ws = await prepareWorktree(repo, id, "main");
    const branch = worktreeBranchName(id);
    commitIn(ws.path, "b.txt");
    git(repo, "merge", "--no-edit", branch); // 相当于验收合并过了

    const body = await (await archive(id)).json() as { cleanup: { items: { branchDeleted: boolean }[] } };
    assert.equal(existsSync(ws.path), false);
    assert.equal(branchExists(branch), false, "已合并的分支该跟着收掉");
    assert.equal(body.cleanup.items[0].branchDeleted, true);
  }

  // ── 3. 设置 worktree：分支一律留着（即使已合并）───────────────────────────
  {
    await setClean("worktree");
    const id = "arcConlywt3";
    await seed({ id });
    const ws = await prepareWorktree(repo, id, "main");
    const branch = worktreeBranchName(id);
    commitIn(ws.path, "c.txt");
    git(repo, "merge", "--no-edit", branch);

    const body = await (await archive(id)).json() as { cleanup: { mode: string; items: { branch: string | null; worktreeRemoved: boolean }[] } };
    assert.equal(body.cleanup.mode, "worktree");
    assert.equal(existsSync(ws.path), false, "目录还是要删");
    assert.equal(branchExists(branch), true, "这一档不碰分支");
    assert.equal(body.cleanup.items[0].branch, null, "按设置不删 ≠ 删失败，不该报成保留项");
  }

  // ── 4. 设置 none：磁盘一个字节不动（上线前的旧行为）──────────────────────
  {
    await setClean("none");
    const id = "arcDnone004";
    await seed({ id });
    const ws = await prepareWorktree(repo, id, "main");
    const branch = worktreeBranchName(id);
    commitIn(ws.path, "d.txt");

    const body = await (await archive(id)).json() as { task: { archived: boolean }; cleanup: { mode: string; items: unknown[] } };
    assert.equal(body.task.archived, true);
    assert.equal(existsSync(ws.path), true, "none 档不许删目录");
    assert.equal(branchExists(branch), true, "none 档不许删分支");
    assert.deepEqual(body.cleanup.items, []);
    assert.equal(summarizeArchiveCleanup(body.cleanup as never), "", "没动过磁盘就别对用户说什么");
  }

  // ── 5. worktree 脏：归档照旧成功，清理如实失败 ──────────────────────────
  {
    await setClean("all");
    const id = "arcEdirty05";
    await seed({ id });
    const ws = await prepareWorktree(repo, id, "main");
    writeFileSync(join(ws.path, "dirty.txt"), "没提交的改动\n");

    const body = await (await archive(id)).json() as { task: { archived: boolean }; cleanup: { items: { worktreeRemoved: boolean; worktreeError: string | null }[] } };
    assert.equal(body.task.archived, true, "清理失败绝不能把归档一起挡回去");
    assert.equal(existsSync(ws.path), true, "脏目录必须原样留着（不带 --force）");
    assert.equal(body.cleanup.items[0].worktreeRemoved, false);
    assert.match(body.cleanup.items[0].worktreeError ?? "", /dirty\.txt/, "挡路的文件要摆在用户面前");
  }

  // ── 6. 别的任务钉着这个分支：不删分支，说清为什么 ─────────────────────────
  {
    const id = "arcFpinned6";
    await seed({ id });
    const ws = await prepareWorktree(repo, id, "main");
    const branch = worktreeBranchName(id);
    commitIn(ws.path, "f.txt");
    git(repo, "merge", "--no-edit", branch); // 已合并 → 否则 -d 本来就会拒，测不到这道闸
    await seed({ id: "arcFchild6c", status: "backlog", worktreeBase: branch });

    const body = await (await archive(id)).json() as { cleanup: { items: { branchDeleted: boolean; branchError: string | null }[] } };
    assert.equal(branchExists(branch), true, "子任务还钉在这个分支上，不能删");
    assert.equal(body.cleanup.items[0].branchDeleted, false);
    assert.match(body.cleanup.items[0].branchError ?? "", /依赖/, "要说清是被谁挡住的");
  }

  // ── 7. 团队：执行者的工作区跟着 lead 一起收 ─────────────────────────────
  {
    const lead = "arcGlead001";
    const worker = "arcHwork001";
    await seed({ id: lead, mode: "team", status: "done" });
    await seed({ id: worker, parentId: lead, status: "done" });
    const leadWs = await prepareWorktree(repo, lead, "main");
    const workerWs = await prepareWorktree(repo, worker, "main");

    const body = await (await archive(lead)).json() as { cleanup: { items: { taskId: string }[] } };
    assert.equal(existsSync(leadWs.path), false, "调度台的工作区要收");
    assert.equal(existsSync(workerWs.path), false, "执行者的工作区也要收");
    assert.deepEqual(body.cleanup.items.map((i) => i.taskId).sort(), [worker, lead].sort());
    const workerRow = (await db.select().from(tasks).where(eq(tasks.id, worker))).at(0)!;
    assert.equal(workerRow.archived, true, "执行者跟着归档（既有行为，别回退）");
  }

  // ── 9. 清理还在排队,用户先一步取回:这次清理必须作废 ────────────────────
  // 复现第 1 轮审查那条:归档先写 archived、再等仓库锁,等锁那段时间里用户在另一个页面
  // 点了取回并重新跑起来 —— 旧实现等到锁之后照删不误,正在跑的 agent 当场失去工作目录。
  {
    const id = "arcIrace001";
    await seed({ id });
    const ws = await prepareWorktree(repo, id, "main");
    commitIn(ws.path, "race.txt");

    const { withRepoLock } = await import("../src/repo-lock.js");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    // 占住仓库锁,模拟「别人的验收还没做完」——归档会卡在清理前那一步。
    const blocking = withRepoLock(repo, () => held);
    await new Promise((r) => setTimeout(r, 20));

    const archiving = archive(id);
    // 等任务行真的落成 archived(说明归档已经越过 db 那一步、正卡在仓库锁上)
    for (let i = 0; i < 200; i++) {
      if ((await db.select().from(tasks).where(eq(tasks.id, id))).at(0)?.archived) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, id))).at(0)?.archived, true, "归档应已写库并卡在清理前");

    const restored = await unarchive(id);
    assert.equal(restored.status, 200, "取回不该被清理挡住");
    const { claimTurn, releaseTurn } = await import("../src/runs.js");
    const started = claimTurn(id, "single");
    assert.equal(started, true, "取回之后必须能重新起跑（清理此刻还没占住锁）");

    release();
    await blocking;
    const body = await (await archiving).json() as { cleanup: { items: unknown[]; skipped: string | null } };
    releaseTurn(id);

    assert.equal(existsSync(ws.path), true, "已被取回并重新跑起来的任务,目录绝不能删");
    assert.deepEqual(body.cleanup.items, [], "作废的清理不该报成「删过了」");
    assert.match(body.cleanup.skipped ?? "", /在跑或已被取回/, "要说清这次为什么没清理");
  }

  // ── 9b. 取回了但还没点运行:回合锁是空的,照样不许删 ──────────────────────
  // 上一条靠「执行者占着回合锁」挡住清理。更常见的其实是用户点了取回、还没点运行:
  // 这时回合锁空着,清理占得到 —— 唯一拦得住它的是占锁之后**复查一次 archived**。
  // 没有这一道,取回之后目录照样在用户眼前消失(第 1 轮审查那条的另一半)。
  {
    const id = "arcJrace002";
    await seed({ id });
    const ws = await prepareWorktree(repo, id, "main");
    commitIn(ws.path, "race2.txt");

    const { withRepoLock } = await import("../src/repo-lock.js");
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const blocking = withRepoLock(repo, () => held);
    await new Promise((r) => setTimeout(r, 20));

    const archiving = archive(id);
    for (let i = 0; i < 200; i++) {
      if ((await db.select().from(tasks).where(eq(tasks.id, id))).at(0)?.archived) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, id))).at(0)?.archived, true, "归档应已写库并卡在清理前");
    assert.equal((await unarchive(id)).status, 200, "取回不该被清理挡住");

    release();
    await blocking;
    const body = await (await archiving).json() as { cleanup: { items: unknown[]; skipped: string | null } };

    assert.equal(existsSync(ws.path), true, "任务已被取回,哪怕还没起跑,目录也不能删");
    assert.equal(branchExists(worktreeBranchName(id)), true, "分支同理");
    assert.deepEqual(body.cleanup.items, [], "作废的清理不该报成「删过了」");
    assert.match(body.cleanup.skipped ?? "", /在跑或已被取回/, "要说清这次为什么没清理");
  }

  // ── 10. 手动合入后归档:删分支要留下恢复起点,取回重建回到完成时 ──────────
  {
    const { initializeBranchPlan, acceptedHeadRef, commitAt } = await import("../src/task-branch-plan.js");
    const { taskWorkspace } = await import("../src/task-workspace.js");
    const id = "arcJpinned1";
    const row = { id, projectId: "project", title: `任务 ${id}`, body: "", mode: "single", status: "done",
      useWorktree: true, createdAt: ts, updatedAt: ts };
    await db.insert(tasks).values(row);
    // 经真实初始化冻结开工点 —— 直接 prepareWorktree 的种子覆盖不到这条路。
    // initializeBranchPlan 只改**传入的对象**,得自己写回库,否则这一行的
    // worktreeStartCommit 还是空的,测的就不是「冻结过起点的任务」那条路了。
    await initializeBranchPlan(row as never, repo);
    await db.update(tasks).set({ worktreeStartCommit: (row as { worktreeStartCommit?: string }).worktreeStartCommit ?? null })
      .where(eq(tasks.id, id));
    const seeded = (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
    const ws = await taskWorkspace(seeded as never, repo);
    const startCommit = git(ws.path, "rev-parse", "HEAD");
    commitIn(ws.path, "feature.txt");
    const finishedCommit = git(ws.path, "rev-parse", "HEAD");
    const branch = worktreeBranchName(id);
    git(repo, "merge", "--ff-only", branch); // 手动合入,不走验收端点

    const body = await (await archive(id)).json() as { cleanup: { items: { branchDeleted: boolean }[] } };
    assert.equal(body.cleanup.items[0].branchDeleted, true, "已合并的分支该收掉");
    assert.equal(await commitAt(repo, acceptedHeadRef(id)), finishedCommit, "删分支前必须把末端记成恢复起点");
    // 主分支继续往前走:不推进的话「忽略恢复引用、改用 worktreeBase 当前 HEAD」这条
    // 错误路径恰好也落在完成提交上,断言就区分不出两者(第 2 轮审查指出的盲点)。
    writeFileSync(join(repo, "later.txt"), "主分支后来的改动\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "main moves on");
    assert.notEqual(git(repo, "rev-parse", "HEAD"), finishedCommit, "主分支必须已经领先于任务完成提交");

    const restored = await unarchive(id);
    const back = await restored.json() as { restoreNote: string | null };
    assert.match(back.restoreNote ?? "", /任务完成时的提交/, "取回提示要说清会从哪儿重建");

    const fresh = (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
    const rebuilt = await taskWorkspace(fresh as never, repo);
    assert.equal(git(rebuilt.path, "rev-parse", "HEAD"), finishedCommit,
      `重建应回到任务完成时的提交,而不是开工点 ${startCommit.slice(0, 8)}`);
    assert.equal(existsSync(join(rebuilt.path, "feature.txt")), true, "任务自己做完的东西必须在工作区里");
  }

  // ── 12. 团队:执行者共用领队目录,清理期间必须连它一起锁住 ──────────────────
  // 第 2 轮审查确定性复现:归档先把整支队伍标成 archived,而 workspaceParticipants 默认
  // 过滤 archived,于是清理只锁住领队;团队取回又是连执行者一起解冻的,执行者就能在领队
  // 目录正被删的同一刻起跑,刚开工就读不到项目文件。
  {
    const lead = "arcKlead001";
    const worker = "arcKwork001";
    await db.insert(tasks).values({
      id: lead, projectId: "project", title: "共用目录的领队", body: "", mode: "team",
      status: "done", useWorktree: true, createdAt: ts, updatedAt: ts,
    });
    // useWorktree=false 的执行者没有自己的目录,下一次跑就落在领队的 worktree 里
    // (nextRunDirOf → isolatedWorkspaceOwner 顺 parentId 走到领队)。
    await db.insert(tasks).values({
      id: worker, projectId: "project", title: "共用目录的执行者", body: "", mode: "single",
      status: "done", parentId: lead, useWorktree: false, createdAt: ts, updatedAt: ts,
    });
    const leadWs = await prepareWorktree(repo, lead, "main");
    commitIn(leadWs.path, "team.txt");
    const leadRow = async () => (await db.select().from(tasks).where(eq(tasks.id, lead))).at(0)!;
    const setArchived = async (value: boolean) => {
      for (const id of [lead, worker]) {
        await db.update(tasks).set({ archived: value, archivedAt: value ? ts : null }).where(eq(tasks.id, id));
      }
    };

    // (a) 根因:清理恰好跑在「整支队伍刚被标成 archived」之后,这一刻仍要圈得到执行者。
    await setArchived(true);
    const { workspaceParticipants } = await import("../src/task-workspace.js");
    const wide = await workspaceParticipants(await leadRow() as never, leadWs.path, { includeArchived: true });
    assert.ok(wide.some((peer) => peer.id === worker), "归档清理圈共用者时必须算上已归档的执行者");
    const narrow = await workspaceParticipants(await leadRow() as never, leadWs.path);
    assert.equal(narrow.some((peer) => peer.id === worker), false,
      "默认口径不许被这次改动带歪:已归档任务起不来,算进去只会平白占锁");

    // (b) 清理占着这批回合锁的时候取回,必须被挡回去 —— 而不是放执行者进正被删的目录。
    const { claimWorkspaceTurn, claimTurn, releaseTurn } = await import("../src/runs.js");
    const holding = claimWorkspaceTurn([lead, worker]);
    assert.ok(holding, "前提:这批回合锁能一次性占下来");
    const blocked = await unarchive(lead);
    assert.equal(blocked.status, 409, "清理正占着锁,取回该让用户稍后再点");
    assert.match((await blocked.json() as { error: string }).error, /正在清理/);
    holding!();

    // (c) 端到端:清理还在等仓库锁时整支队伍被取回 → 这次清理整体作废,目录原样留着。
    await setArchived(false);
    const { withRepoLock } = await import("../src/repo-lock.js");
    let unblock!: () => void;
    const held = new Promise<void>((resolve) => { unblock = resolve; });
    const blocking = withRepoLock(repo, () => held);
    await new Promise((r) => setTimeout(r, 20));

    const archiving = archive(lead);
    for (let i = 0; i < 200; i++) {
      if ((await db.select().from(tasks).where(eq(tasks.id, worker))).at(0)?.archived) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, worker))).at(0)?.archived, true,
      "执行者应已随团队一起归档");

    assert.equal((await unarchive(lead)).status, 200, "清理还没占到锁,取回照常放行");
    assert.equal(claimTurn(worker, "single"), true, "取回之后执行者确实能起跑 —— 所以这次清理必须整体作废");

    unblock();
    await blocking;
    const body = await (await archiving).json() as { cleanup: { items: unknown[]; skipped: string | null } };
    releaseTurn(worker);

    assert.equal(existsSync(leadWs.path), true, "执行者正在用的共用目录绝不能删");
    assert.equal(branchExists(worktreeBranchName(lead)), true, "目录还在,分支更不能动");
    assert.deepEqual(body.cleanup.items, [], "整支队伍已被取回,这次清理该整体作废");
    assert.match(body.cleanup.skipped ?? "", /在跑或已被取回/, "作废了就得当场说出来");
  }

  // ── 13. 没冻结过开工点的旧任务:取回也要按保存的完成提交重建 ──────────────
  {
    const { acceptedHeadRef, commitAt } = await import("../src/task-branch-plan.js");
    const { taskWorkspace } = await import("../src/task-workspace.js");
    const id = "arcLlegacy1";
    // 旧数据行:useWorktree=true、有 worktreeBase,但 worktreeStartCommit 是空的。
    await db.insert(tasks).values({
      id, projectId: "project", title: "没冻结起点的旧任务", body: "", mode: "single", status: "done",
      useWorktree: true, worktreeBase: "main", createdAt: ts, updatedAt: ts,
    });
    const legacy = (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
    assert.equal(legacy.worktreeStartCommit, null, "这一条的前提就是没有冻结起点");
    const ws = await taskWorkspace(legacy as never, repo);
    commitIn(ws.path, "legacy.txt");
    const finishedCommit = git(ws.path, "rev-parse", "HEAD");
    git(repo, "merge", "--ff-only", worktreeBranchName(id));

    await archive(id);
    assert.equal(await commitAt(repo, acceptedHeadRef(id)), finishedCommit, "恢复起点要存下来");
    // 主分支继续走,并且把任务那个文件删掉:重建要是落回 worktreeBase,文件就不见了。
    rmSync(join(repo, "legacy.txt"));
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "main drops it");

    const back = await (await unarchive(id)).json() as { restoreNote: string | null };
    assert.match(back.restoreNote ?? "", /任务完成时的提交/, "提示说会按完成提交重建");
    const fresh = (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
    const rebuilt = await taskWorkspace(fresh as never, repo);
    assert.equal(git(rebuilt.path, "rev-parse", "HEAD"), finishedCommit, "重建要落在完成提交,不是主分支当前 HEAD");
    assert.equal(existsSync(join(rebuilt.path, "legacy.txt")), true, "提示承诺的东西必须真在目录里");
  }

  // ── 14. 恢复起点存不下来:保留分支,而且绝不报成「已清理」──────────────────
  {
    const { acceptedHeadRef, commitAt } = await import("../src/task-branch-plan.js");
    const { taskWorkspace } = await import("../src/task-workspace.js");
    const id = "arcMlocked1";
    const row = { id, projectId: "project", title: "写 ref 会失败", body: "", mode: "single", status: "done",
      useWorktree: true, createdAt: ts, updatedAt: ts };
    await db.insert(tasks).values(row);
    const { initializeBranchPlan } = await import("../src/task-branch-plan.js");
    await initializeBranchPlan(row as never, repo);
    await db.update(tasks).set({ worktreeStartCommit: (row as { worktreeStartCommit?: string }).worktreeStartCommit ?? null })
      .where(eq(tasks.id, id));
    const seeded = (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
    const ws = await taskWorkspace(seeded as never, repo);
    commitIn(ws.path, "head-failed.txt");
    const branch = worktreeBranchName(id);
    git(repo, "merge", "--ff-only", branch);

    // 残留的 .lock 让 update-ref 写不进去,但不影响删目录/删分支本身。
    const lock = join(repo, ".git", acceptedHeadRef(id) + ".lock");
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, "");

    const body = await (await archive(id)).json() as { cleanup: { items: { branchDeleted: boolean; branchError: string | null; worktreeRemoved: boolean }[] } };
    const item = body.cleanup.items[0];
    assert.equal(await commitAt(repo, acceptedHeadRef(id)), null, "前提:这次确实没能存下恢复起点");
    assert.equal(item.branchDeleted, false, "存不下恢复起点就不许删分支");
    assert.equal(branchExists(branch), true, "分支是那份改动最后的副本,必须留着");
    assert.match(item.branchError ?? "", /恢复起点/, "要当场说清为什么留着分支");
    assert.equal(item.worktreeRemoved, true, "目录照常清理 —— 它的内容在分支里");
    rmSync(lock, { force: true });
  }

  console.log("[archive-cleanup] 全部断言通过");
  dbClient.close();
} finally {
  rmSync(stage, { recursive: true, force: true });
}
