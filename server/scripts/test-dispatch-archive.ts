// 派出去的子孙跟着派活的那条一起归档、一起取回（dispatch-archive.ts），以及团队 / 讨论停用后
// 建不出新的（shared/src/legacy-modes.ts）。
//
//   1. 名下整棵（含孙辈、含中间那层已经归档的底下）有一条没结束：归档整个挡回，一条都不动；界面那颗键读同一份判据。
//   2. 都结束了：整棵同一刻归档，各自的 worktree 和分支一起收；之前就单独归档的那条原样不动。
//   3. 取回：只带回同一刻归档的那几条。
//   4. 团队 / 讨论关着：新建团队 / 讨论任务、团队执行者、改成这两种模式、调度台派活一律拒；开着照旧。
//   5. 已归档的任务名下建不出没归档的新任务（POST /tasks 带 dispatchedBy 回 409）。
//   6. 建任务和整棵归档互斥：正在挂进来时归档挡回；正冻着时挂不进来。
//   7. 取回是一笔：父任务和子孙同一条语句解冻，中途失败不会只回来一半。
//   8. 归档冻上整棵之后读库出错：冻结位当场放掉，之后验收、派活、重试归档都照常。
//   9. 上层归档正在「判 → 写」时，树里已归档的那条取回不了（不然它漏在外面）；归档做完单独取回照旧。
//  10. 名下有调用者看不见的项目里的子孙：归档、取回整笔不做，不报那条的标题，也不碰它的磁盘。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { eq, inArray } from "drizzle-orm";
import { legacyModeRefusal } from "@navi/shared/legacy-modes";
import { releaseTmpDb } from "./tmp-db.js";

type Json = Record<string, unknown>;

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
  const { createTasks } = await import("../src/task-store.js");
  const { beginAccepting, beginFreezing, beginJoining, endAccepting } = await import("../src/acceptance-lock.js");
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

  const create = (body: Json) => app.request("/tasks", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "project", title: "新建", useWorktree: false, ...body }),
  });
  const newRow = (id: string, dispatchedBy: string) => ({
    id, projectId: "project", dispatchedBy, title: id, body: "", mode: "single", status: "backlog" as const,
    useWorktree: false, createdAt: ts, updatedAt: ts,
  });

  // ── 5. 已归档的名下建不出没归档的 ─────────────────────────────────────────
  {
    await task("closed");
    assert.equal((await post("/tasks/closed/archive")).status, 200);
    const refused = await create({ dispatchedBy: "closed", title: "迟来的子任务" });
    assert.equal(refused.status, 409, "派它的任务已归档就不建");
    assert.match((await refused.json() as { error: string }).error, /已归档/);
    assert.equal((await db.select().from(tasks).where(eq(tasks.dispatchedBy, "closed"))).length, 0, "一行都不落");
    console.log("✓ 已归档的任务名下建不出新任务");
  }

  // ── 6. 建任务和整棵归档互斥 ────────────────────────────────────────────────
  {
    await task("raceParent");
    await task("raceChild", { dispatchedBy: "raceParent" });
    // 孙辈正在落库（停在 beforeInsert）：归档挡回，落库照常，整棵都没归档。
    let release!: () => void;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const arrived = new Promise<void>((resolve) => { reached = resolve; });
    const creation = createTasks([newRow("raceGrandchild", "raceChild")], undefined, async () => { reached(); await paused; });
    await arrived;
    const archival = await post("/tasks/raceParent/archive");
    assert.equal(archival.status, 409, "名下正在挂进来时归档挡回");
    assert.match((await archival.json() as { error: string }).error, /正在加入/);
    release();
    await creation;
    for (const id of ["raceParent", "raceChild", "raceGrandchild"]) assert.equal((await row(id)).archived, false, `${id} 没被归档`);
    // 反过来：整棵正冻着（归档在「判 → 写」之间），孙辈挂不进来。
    const frozen = beginFreezing(["raceParent", "raceChild", "raceGrandchild"])!;
    assert.ok(frozen);
    await assert.rejects(createTasks([newRow("lateGrandchild", "raceChild")]), /正在归档/, "冻着时挂不进来");
    frozen();
    assert.equal((await db.select().from(tasks).where(eq(tasks.id, "lateGrandchild"))).length, 0);
    // 冻结放开后照常归档，刚才落库的孙辈一起走。
    await db.update(tasks).set({ status: "done" }).where(eq(tasks.id, "raceGrandchild"));
    assert.equal((await post("/tasks/raceParent/archive")).status, 200);
    assert.equal((await row("raceGrandchild")).archived, true);
    console.log("✓ 建任务和整棵归档互斥，两个方向都不会落出「归档了的名下有没归档的」");
  }

  // ── 7. 取回是一笔 ─────────────────────────────────────────────────────────
  {
    // 数「解冻」那几笔写；`failFirst` 时第一笔抛错（Hono 会把它打到 stderr，那一行是预期的）。
    const originalUpdate = db.update.bind(db);
    const countRestores = (failFirst: boolean) => {
      let writes = 0;
      db.update = ((table: never) => {
        const builder = originalUpdate(table);
        const originalSet = builder.set.bind(builder);
        builder.set = ((values: Json) => {
          if (values.archived === false && ++writes === 1 && failFirst) throw new Error("注入：解冻那一笔写失败");
          return originalSet(values as never);
        }) as typeof builder.set;
        return builder;
      }) as typeof db.update;
      return () => writes;
    };
    const family = ["raceParent", "raceChild", "raceGrandchild"];
    let writes = countRestores(true);
    try {
      assert.equal((await post("/tasks/raceParent/unarchive")).status, 500);
    } finally { db.update = originalUpdate; }
    for (const id of family) assert.equal((await row(id)).archived, true, `${id} 原样冻着，不会只回来一半`);
    writes = countRestores(false);
    try {
      assert.equal((await post("/tasks/raceParent/unarchive")).status, 200);
    } finally { db.update = originalUpdate; }
    assert.equal(writes(), 1, "父任务和子孙同一笔解冻（分两笔时第二笔失败就剩一半）");
    for (const id of family) assert.equal((await row(id)).archived, false, `${id} 一起回来`);
    console.log("✓ 取回是一笔，失败了整棵原样冻着、重试能整棵回来");
  }

  // ── 8. 冻上之后读库出错：冻结位当场放掉 ─────────────────────────────────
  {
    await task("leakParent");
    await task("leakChild", { dispatchedBy: "leakParent" });
    const originalSelect = db.select.bind(db);
    let armed = true;
    // 只在冻结已经生效（挂进来被挡住）时注入一次读库失败，之后立刻恢复。
    db.select = ((...args: never[]) => {
      if (armed) {
        const probe = beginJoining(["leakParent"]);
        if (!probe) {
          armed = false;
          throw new Error("注入：冻上之后读库失败");
        }
        probe();
      }
      return originalSelect(...args);
    }) as typeof db.select;
    try {
      assert.equal((await post("/tasks/leakParent/archive")).status, 500);
    } finally { db.select = originalSelect; }
    assert.equal(armed, false, "前提：确实是在冻着的时候出的错");
    for (const id of ["leakParent", "leakChild"]) assert.equal((await row(id)).archived, false);
    const joining = beginJoining(["leakParent", "leakChild"]);
    assert.ok(joining, "冻结位放掉了，名下能接着挂新任务");
    joining();
    assert.equal(beginAccepting("leakParent"), true, "也能验收");
    endAccepting("leakParent");
    assert.equal((await post("/tasks/leakParent/archive")).status, 200, "重试归档照常");
    console.log("✓ 冻上之后读库出错，冻结位当场放掉，重试照常");
  }

  // ── 9. 上层归档进行中，树里已归档的那条取回不了 ─────────────────────────
  {
    const earlierAt = "2026-11-18T00:00:00.000Z";
    await task("treeParent");
    await task("treeChild", { dispatchedBy: "treeParent", archived: true, archivedAt: earlierAt });
    await task("treeGrandchild", { dispatchedBy: "treeChild", archived: true, archivedAt: earlierAt });
    // 停在归档那一笔写之前，这时去取回子任务。
    const originalUpdate = db.update.bind(db);
    let armed = true;
    let concurrent: Response | null = null;
    db.update = ((table: never) => {
      const builder = originalUpdate(table);
      const originalSet = builder.set.bind(builder);
      builder.set = ((values: Json) => {
        const setBuilder = originalSet(values as never);
        if (values.archived === true && armed) {
          armed = false;
          const originalWhere = setBuilder.where.bind(setBuilder);
          setBuilder.where = (async (condition: never) => {
            concurrent = await post("/tasks/treeChild/unarchive");
            return originalWhere(condition);
          }) as typeof setBuilder.where;
        }
        return setBuilder;
      }) as typeof builder.set;
      return builder;
    }) as typeof db.update;
    let archival: Response;
    try {
      archival = await post("/tasks/treeParent/archive");
    } finally { db.update = originalUpdate; }
    assert.equal(archival.status, 200);
    assert.ok(concurrent, "前提：取回确实发生在归档写下去之前");
    assert.equal((concurrent as Response).status, 409, "冻着时取回挡回");
    assert.match(await (concurrent as Response).text(), /正在归档/);
    assert.equal((await row("treeParent")).archived, true);
    for (const id of ["treeChild", "treeGrandchild"]) assert.equal((await row(id)).archivedAt, earlierAt, `${id} 原样冻着，没漏在外面`);
    // 归档做完之后，单独取回早先归档的那条照旧。
    assert.equal((await post("/tasks/treeChild/unarchive")).status, 200);
    for (const id of ["treeChild", "treeGrandchild"]) assert.equal((await row(id)).archived, false, `${id} 单独取回照旧`);
    // 反过来：取回正在进行（冻着它那几条）时，上层归档冻不上。
    const unfreezing = beginFreezing(["treeChild", "treeGrandchild"])!;
    await db.update(tasks).set({ archived: false, archivedAt: null }).where(eq(tasks.id, "treeParent"));
    const blocked = await post("/tasks/treeParent/archive");
    assert.equal(blocked.status, 409, "取回进行中时上层归档挡回");
    unfreezing();
    console.log("✓ 上层归档进行中取回不了，取回进行中归档冻不上；做完之后单独取回照旧");
  }

  // ── 10. 名下有看不见的项目：整笔不做、不报标题、不碰磁盘 ──────────────────
  {
    const { users, projectMembers } = await import("../src/db/schema.js");
    const { setActor } = await import("../src/auth/context.js");
    const { resourceGate } = await import("../src/auth/resource-gate.js");
    const { computeTaskActions } = await import("../src/task-actions.js");
    const secretRepo = join(stage, "secret");
    execFileSync("git", ["init", "-b", "main", secretRepo]);
    execFileSync("git", ["-C", secretRepo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "seed"]);
    await db.insert(projects).values({ id: "secret", name: "别人的项目", repoPath: secretRepo, createdAt: ts });
    await task("scopeParent");
    await task("secretChild", { projectId: "secret", dispatchedBy: "scopeParent", title: "机密子任务", useWorktree: true });
    const secretWs = await prepareWorktree(secretRepo, "secretChild", "main");
    // 取回那一半：先在自用模式下整棵一起归档好（取回时它们同一刻）。
    await task("scopeArchived");
    await task("secretArchived", { projectId: "secret", dispatchedBy: "scopeArchived", title: "机密已归档" });
    assert.equal((await post("/tasks/scopeArchived/archive")).status, 200);

    await db.insert(users).values({ id: "reader", name: "reader", dirName: "reader", role: "member", status: "active", createdAt: ts });
    await db.insert(projectMembers).values({ projectId: "project", userId: "reader", role: "member", addedAt: ts });
    await setInstanceMode("multi", stage);
    const reader = { kind: "user", userId: "reader", role: "member", name: "reader" } as const;
    const scoped = new Hono();
    scoped.use("*", async (context, next) => { setActor(context, reader); await next(); });
    scoped.use("*", resourceGate());
    scoped.route("/api", app);

    const archival = await scoped.request("/api/tasks/scopeParent/archive", { method: "POST" });
    assert.equal(archival.status, 409, "名下有看不见的就不归档");
    const archivalText = await archival.text();
    assert.match(archivalText, /看不到的项目/);
    assert.doesNotMatch(archivalText, /机密/, "不报看不见那条的标题");
    assert.equal((await row("scopeParent")).archived, false);
    assert.equal((await row("secretChild")).archived, false);
    assert.ok(existsSync(secretWs.path) && execFileSync("git", ["-C", secretRepo, "branch", "--list", worktreeBranchName("secretChild")], { encoding: "utf8" }).trim(), "它的 worktree 和分支原样在");
    const actions = await computeTaskActions("scopeParent", reader);
    assert.equal(actions?.archive.ok, false, "界面那颗键读同一份");
    assert.doesNotMatch(JSON.stringify(actions), /机密/);

    const restore = await scoped.request("/api/tasks/scopeArchived/unarchive", { method: "POST" });
    assert.equal(restore.status, 409, "同一刻归档的里有看不见的就不取回");
    assert.doesNotMatch(await restore.text(), /机密/);
    assert.equal((await row("scopeArchived")).archived, true);
    assert.equal((await row("secretArchived")).archived, true);
    console.log("✓ 名下有看不见的项目时归档、取回整笔不做，不报标题、不碰磁盘");
  }

  console.log("✓ test-dispatch-archive 全部通过");
} finally {
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
