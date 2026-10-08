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
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  console.log("[archive-cleanup] 全部断言通过");
  dbClient.close();
} finally {
  rmSync(stage, { recursive: true, force: true });
}
