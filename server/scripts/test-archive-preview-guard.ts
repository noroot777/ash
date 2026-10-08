// 预览实例里归档不许碰真仓库（第 1 轮审查确定性复现的那条）。
//
// 预览实例（`ASH_PREVIEW=1`）连的是主库的**快照**，任务行却指向**真**仓库路径。
// `removeWorktree` 自带 `assertNotPreviewInstance`，所以目录还在时删不动；但
// `git branch -d` 原来没有这道闸 —— 于是「目录已被清掉、只剩分支」的任务，从预览
// 实例归档一下就能把真分支删掉。
//
// 这个用例必须单开一个进程：`IS_PREVIEW_INSTANCE` 在模块加载时就定死了。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

process.env.ASH_PREVIEW = "1"; // 必须在任何 src 模块被 import 之前
const stage = mkdtempSync(join(tmpdir(), "ash-archive-preview-"));
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
  const { projects, tasks } = await import("../src/db/schema.js");
  const { setInstanceMode } = await import("../src/auth/mode.js");
  const { IS_PREVIEW_INSTANCE } = await import("../src/preview-instance.js");
  const { prepareWorktree, worktreeBranchName } = await import("../src/git.js");
  const { mountTaskArchiveRoutes } = await import("../src/task-archive-routes.js");
  const { discardTaskWorkspace } = await import("../src/workspace-cleanup.js");
  await ensureSchema();
  await setInstanceMode("single", stage);
  assert.equal(IS_PREVIEW_INSTANCE, true, "这个用例的全部前提是「此刻就是预览实例」");

  const app = new Hono();
  mountTaskArchiveRoutes(app);
  const ts = new Date().toISOString();
  await db.insert(projects).values({ id: "project", name: "预览隔离", repoPath: repo, createdAt: ts });

  // ── 1. 归档路由：整段清理跳过，真分支原样留着 ───────────────────────────
  {
    const id = "preview0001";
    await db.insert(tasks).values({ id, projectId: "project", title: "预览里的任务", body: "", mode: "single", status: "done", createdAt: ts, updatedAt: ts });
    const ws = await prepareWorktree(repo, id, "main");
    const branch = worktreeBranchName(id);
    // 目录先移走：保护只覆盖 removeWorktree 的那条路正是从这里绕过去的。
    rmSync(ws.path, { recursive: true, force: true });

    const response = await app.request(`/tasks/${id}/archive`, { method: "POST" });
    const body = await response.json() as { task: { archived: boolean }; cleanup: { items: unknown[]; skipped: string | null } };
    assert.equal(response.status, 200, "归档本身在预览实例里照常可用（它只是快照里的状态）");
    assert.equal(body.task.archived, true);
    assert.equal(branchExists(branch), true, "预览实例绝不能删真仓库的分支");
    assert.deepEqual(body.cleanup.items, [], "一项都不该清理");
    assert.match(body.cleanup.skipped ?? "", /预览实例/, "要说清为什么没清理");
  }

  // ── 2. 底层入口同样被挡：删任务那条路不能成为绕行口 ──────────────────────
  {
    const id = "preview0002";
    await db.insert(tasks).values({ id, projectId: "project", title: "另一个", body: "", mode: "single", status: "done", createdAt: ts, updatedAt: ts });
    const ws = await prepareWorktree(repo, id, "main");
    const branch = worktreeBranchName(id);
    rmSync(ws.path, { recursive: true, force: true });

    const result = await discardTaskWorkspace(repo, id, { worktree: false, branch: true });
    assert.equal(result.branchDeleted, false, "discardTaskWorkspace 的分支删除也必须被挡住");
    assert.match(result.branchError ?? "", /预览实例/, "挡住的理由要如实回给调用方");
    assert.equal(branchExists(branch), true);
  }

  console.log("[archive-preview-guard] 全部断言通过");
  dbClient.close();
} finally {
  rmSync(stage, { recursive: true, force: true });
}
