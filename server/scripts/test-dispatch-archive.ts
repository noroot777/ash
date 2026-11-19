// 派出去的子孙跟着派活的那条一起归档、一起取回（dispatch-archive.ts），以及团队 / 讨论停用后
// 建不出新的（shared/src/legacy-modes.ts）。
//
//   1. 名下整棵（含孙辈、含中间那层已经归档的底下）有一条没结束：归档整个挡回，一条都不动；界面那颗键读同一份判据。
//   2. 都结束了：整棵同一刻归档，各自的 worktree 和分支一起收；之前就单独归档的那条原样不动。
//   3. 取回：只带回同一刻归档的那几条。
//   4. 团队 / 讨论关着：新建团队 / 讨论任务、团队执行者、改成这两种模式、调度台派活一律拒；开着照旧。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { eq, inArray } from "drizzle-orm";
import { legacyModeRefusal } from "@navi/shared/legacy-modes";
import { releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "navi-dispatch-archive-"));
const repo = join(stage, "repo");
process.env.NAVI_DB = join(stage, "test.db");
process.env.NAVI_RUNS_DIR = join(stage, "runs");
// 线上默认是关着的；门禁带着 NAVI_LEGACY_TEAM_AND_DUET=1 跑老代码的回归（scripts/accept-test.mjs），这里先擦掉。
delete process.env.NAVI_LEGACY_TEAM_AND_DUET;

const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const branchExists = (name: string) => {
  try { git("show-ref", "--verify", "--quiet", `refs/heads/${name}`); return true; } catch { return false; }
};

try {
  execFileSync("git", ["init", "-b", "main", repo]);
  git("config", "user.name", "Navi Test");
  git("config", "user.email", "navi@example.test");
  writeFileSync(join(repo, "seed.txt"), "seed\n");
  git("add", "-A");
  git("commit", "-m", "seed");

  const { db, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks } = await import("../src/db/schema.js");
  const { setInstanceMode } = await import("../src/auth/mode.js");
  const { prepareWorktree, worktreeBranchName } = await import("../src/git.js");
  const { mountTaskArchiveRoutes } = await import("../src/task-archive-routes.js");
  const { mountTaskRoutes } = await import("../src/task-routes.js");
  const { readActionFacts } = await import("../src/task-actions.js");
  const { archiveVerdict } = await import("../src/task-action-verdicts.js");
  const { dispatchWorkers } = await import("../src/team/dispatch.js");
  await ensureSchema();
  await setInstanceMode("single", stage);

  const app = new Hono();
  mountTaskArchiveRoutes(app);
  mountTaskRoutes(app);
  const ts = new Date().toISOString();
  await db.insert(projects).values({ id: "project", name: "派活归档", repoPath: repo, createdAt: ts });
  const task = (id: string, extra: Partial<typeof tasks.$inferInsert> = {}) =>
    db.insert(tasks).values({ id, projectId: "project", title: id, body: "", mode: "single", status: "done", createdAt: ts, updatedAt: ts, ...extra });
  const row = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id))).at(0)!;
  const post = (path: string) => app.request(path, { method: "POST" });

  // 父 → 子（有 worktree）→ 孙（停着）；父 → 早就单独归档的子 → 它底下的孙（结束了）
  await task("parent");
  await task("child", { dispatchedBy: "parent", useWorktree: true });
  await task("grandchild", { dispatchedBy: "child", status: "paused" });
  const earlier = "2026-01-01T00:00:00.000Z";
  await task("archivedChild", { dispatchedBy: "parent", archived: true, archivedAt: earlier });
  await task("underArchived", { dispatchedBy: "archivedChild" });
  const ws = await prepareWorktree(repo, "child", "main");
  const childBranch = worktreeBranchName("child");
  assert.ok(existsSync(ws.path) && branchExists(childBranch), "前提：子任务有自己的 worktree 和分支");

  // ── 1. 孙辈停着：整棵挡回，界面那颗键读同一份 ───────────────────────────────
  {
    const verdict = archiveVerdict(await readActionFacts(await row("parent")));
    assert.equal(verdict.ok, false);
    assert.match(verdict.ok ? "" : verdict.reason, /「grandchild」停着/, "要说清是哪一条、在干什么");
    const response = await post("/tasks/parent/archive");
    assert.equal(response.status, 409);
    assert.match((await response.json() as { error: string }).error, /「grandchild」停着.*都结束了再归档/);
    for (const id of ["parent", "child", "grandchild", "underArchived"]) assert.equal((await row(id)).archived, false, `${id} 不该被动`);
    assert.ok(existsSync(ws.path), "挡回去时磁盘一样不动");
    console.log("✓ 名下有没结束的（孙辈也算）就整棵挡回，键和路由同一句");
  }

  // ── 2. 都结束了：整棵同一刻归档，worktree 和分支一起收 ─────────────────────
  {
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, "grandchild"));
    assert.equal(archiveVerdict(await readActionFacts(await row("parent"))).ok, true);
    const response = await post("/tasks/parent/archive");
    assert.equal(response.status, 200);
    const body = await response.json() as { cleanup: { items: { taskId: string; worktreeRemoved: boolean; branchDeleted: boolean }[] } };
    const parentAt = (await row("parent")).archivedAt;
    for (const id of ["child", "grandchild", "underArchived"]) {
      const r = await row(id);
      assert.equal(r.archived, true, `${id} 跟着归档`);
      assert.equal(r.archivedAt, parentAt, `${id} 和父任务落在同一刻`);
    }
    assert.equal((await row("archivedChild")).archivedAt, earlier, "之前单独归档的那条原样不动");
    const childItem = body.cleanup.items.find((item) => item.taskId === "child");
    assert.ok(childItem?.worktreeRemoved && childItem.branchDeleted, "子任务的 worktree 和分支跟着收了");
    assert.ok(!existsSync(ws.path) && !branchExists(childBranch));
    console.log("✓ 都结束了就整棵同一刻归档，子孙的 worktree 和分支一起收");
  }

  // ── 3. 取回：只带回同一刻归档的 ─────────────────────────────────────────────
  {
    assert.equal((await post("/tasks/parent/unarchive")).status, 200);
    const back = await db.select().from(tasks).where(inArray(tasks.id, ["parent", "child", "grandchild", "underArchived"]));
    assert.deepEqual(back.filter((r) => r.archived).map((r) => r.id), [], "这一次一起归档的全部回来");
    assert.equal((await row("archivedChild")).archived, true, "之前单独归档的不被拉回来");
    console.log("✓ 取回只带回同一刻归档的那几条");
  }

  // ── 4. 团队 / 讨论关着：建不出新的；开着照旧 ────────────────────────────────
  {
    const create = (body: Record<string, unknown>) => app.request("/tasks", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: "project", title: "新建", useWorktree: false, ...body }),
    });
    for (const mode of ["team", "duet"]) {
      const refused = await create({ mode });
      assert.equal(refused.status, 409, `${mode} 建不出来`);
      assert.match((await refused.json() as { error: string }).error, /已经停用/);
    }
    await task("lead", { mode: "team", status: "backlog" });
    const worker = await create({ parentId: "lead" });
    assert.equal(worker.status, 409, "团队执行者建不出来");
    await assert.rejects(dispatchWorkers("lead", [{ body: "干活" }]), /团队执行者已经停用/, "存量调度台也派不出新的执行者");
    const patched = await app.request("/tasks/parent", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "team" }),
    });
    assert.equal(patched.status, 409, "改不成团队任务");
    assert.equal((await create({})).status, 201, "普通任务照常建");

    process.env.NAVI_LEGACY_TEAM_AND_DUET = "1";
    assert.equal(legacyModeRefusal({ mode: "team" }), null);
    assert.equal(legacyModeRefusal({ parentId: "lead" }), null);
    assert.notEqual((await create({ mode: "duet" })).status, 409, "开着时讨论照旧建得出");
    delete process.env.NAVI_LEGACY_TEAM_AND_DUET;
    console.log("✓ 团队 / 讨论关着时建不出新的，开着照旧");
  }

  console.log("✓ test-dispatch-archive 全部通过");
} finally {
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
