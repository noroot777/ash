// 团队验收期间成员集合不能长（team-acceptance-hold.ts 文件头）：验收占住的是开始那一刻的那一批，多出来的那位
// 不在占位里、照样能起跑改共享目录（审查实测：团队落了「已验收」，新建的执行者正在跑）。
//
// 钉住的几件事：
// ① 建执行者已经过了路由检查、正要落库，这时去验收团队 → 不验收（验收、更新基线都说清是在加执行者）；落库之后才放开；
// ② 验收已经在进行（停在落章的事务门口），这时建执行者 → 409，验收照常落章，库里没有多出来的执行者；
//    过了路由里那一句早拒、在落库前排队时验收开始了 → 落库那一道照样拒；加成员之间按计数，没占全就一个不占；
//    普通任务一样占（挂靠关系不会变，mode 会变）；
// ③ 审查任务那一支（reviewOf 指向团队的共享执行者）同样占住它所属的团队；
// ④ 加成员之间不互斥：建执行者落库途中，调度台派活不会被当成「正在验收」拒掉；
// ⑤ 兜底：绕过互斥直接多出一位共享执行者，落章那一个事务认得出来 —— 不盖章，说清原因；
// ⑥ 加着成员的时候不删、不归档团队（不然新来的落在没了 / 归档了的团队名下）；
// ⑦ 占哪几位不看 mode：落库排队期间普通任务改成团队并验收，落库那一道照样拒（第 2 轮审查的复现）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireTmpDb, releaseTmpDb } from "./tmp-db.js";

const stage = mkdtempSync(join(tmpdir(), "ash-team-accept-crew-"));
process.env.ASH_DB = join(stage, "ash.db");
process.env.ASH_RUNS_DIR = join(stage, "runs");
requireTmpDb("test-team-accept-crew");

/** 一个挂起点：到了就停住，等 release()。 */
function gate() {
  let reached!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => { reached = resolve; });
  const opened = new Promise<void>((resolve) => { release = resolve; });
  return { arrived, opened, reached, release };
}

let failure: unknown = null;
try {
  const { Hono } = await import("hono");
  const { eq } = await import("drizzle-orm");
  const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
  const { projects, tasks } = await import("../src/db/schema.js");
  const { authGate } = await import("../src/auth/middleware.js");
  const { mountTaskRoutes } = await import("../src/task-routes.js");
  const { mountTaskArchiveRoutes } = await import("../src/task-archive-routes.js");
  const { acceptTask } = await import("../src/task-accept.js");
  const { dispatchWorkers } = await import("../src/team/dispatch.js");
  const { commitAcceptanceStage, CrewChanged } = await import("../src/review-acceptance.js");
  const { finalizeAcceptance } = await import("../src/task-accept-finalize.js");
  const { holdTeamForAcceptance, holdScope } = await import("../src/team-acceptance-hold.js");
  const { admissionKeysOf, admitMembers } = await import("../src/team-admission.js");
  const admitTeamMembers = async (refs: string[]) => admitMembers(await admissionKeysOf(refs));
  const { beginAccepting, beginAdmitting, endAccepting, isAdmitting } = await import("../src/acceptance-lock.js");
  const { isTaskBusy, taskBusyRejection } = await import("../src/task-busy.js");
  const { updateTaskBase } = await import("../src/task-base-update.js");
  const { withRepoLock } = await import("../src/repo-lock.js");

  await ensureSchema();
  const at = new Date().toISOString();
  await db.insert(projects).values({ id: "p", name: "项目", repoPath: stage, createdAt: at } as never);
  const lead = (id: string) => db.insert(tasks).values({
    id, projectId: "p", title: `团队 ${id}`, body: "", mode: "team", status: "idle", useWorktree: false, createdAt: at, updatedAt: at,
  } as never);
  const app = new Hono();
  app.use("*", authGate());
  const api = new Hono();
  mountTaskRoutes(api);
  mountTaskArchiveRoutes(api);
  app.route("/api", api);
  const create = (body: Record<string, unknown>) => app.request("/api/tasks", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "p", title: "后加的执行者", body: "x", workflowMode: "preset", useWorktree: false, ...body }),
  });
  const crewOf = async (leadId: string) => (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.parentId, leadId))).map((row) => row.id);
  const stageOf = async (id: string) => (await db.select({ stage: tasks.stage }).from(tasks).where(eq(tasks.id, id))).at(0)?.stage ?? null;

  // 建任务停在落库那一步（已经过了路由里的全部检查）。
  const originalInsert = db.insert.bind(db);
  let insertHold: ReturnType<typeof gate> | null = null;
  db.insert = ((table: unknown) => {
    const builder = originalInsert(table as never);
    const held = insertHold;
    if (table !== tasks || !held) return builder;
    insertHold = null;
    const values = builder.values.bind(builder);
    builder.values = ((input: unknown) => {
      const query = values(input as never);
      const run = query.then.bind(query);
      query.then = ((resolve: never, reject: never) => {
        held.reached();
        return held.opened.then(() => run(resolve, reject));
      }) as never;
      return query;
    }) as never;
    return builder;
  }) as typeof db.insert;
  /** 让下一次建任务停在落库前；返回建任务的响应和这个挂起点。 */
  const pausedCreate = async (body: Record<string, unknown>) => {
    const held = insertHold = gate();
    const response = create(body);
    await held.arrived;
    return { response, held };
  };

  // ── ① 建执行者落库途中验收 ───────────────────────────────────────────────
  {
    await lead("L1");
    const { response, held } = await pausedCreate({ parentId: "L1" });
    const refused = await acceptTask("L1", "human", { expectedResultVersion: "-" });
    assert.equal(refused.accepted, false, "执行者正要落库：这时不验收");
    assert.match(JSON.stringify(refused), /名下正在加入新的任务/, "说清是在加任务，不是「正在验收」");
    assert.match((await updateTaskBase("L1", "-")).error ?? "", /名下正在加入新的任务/, "更新基线撞上的也照实说");
    held.release();
    assert.equal((await response).status, 201, "执行者照常建好");
    assert.equal((await crewOf("L1")).length, 1);
    assert.equal(beginAccepting("L1"), true, "落库之后才放开：验收开得了");
    endAccepting("L1");
  }

  // ── ② 验收停在落章的事务门口，这时建执行者 ───────────────────────────────
  {
    await lead("L2");
    const originalTransaction = db.transaction.bind(db);
    let attempt: Response | null = null;
    db.transaction = (async (...args: unknown[]) => {
      if (new Error().stack?.includes("commitAcceptanceStage")) {
        db.transaction = originalTransaction as typeof db.transaction;
        attempt = await create({ parentId: "L2" });
      }
      return (originalTransaction as (...rest: unknown[]) => Promise<unknown>)(...args);
    }) as typeof db.transaction;
    const accepted = await acceptTask("L2", "human", { expectedResultVersion: "-" });
    db.transaction = originalTransaction as typeof db.transaction;
    assert.ok(attempt, "确实在落章之前建过一次");
    assert.equal(attempt!.status, 409, "验收进行中：加不进新执行者");
    assert.match(JSON.stringify(await attempt!.json()), /所属团队正在验收/);
    assert.equal(accepted.accepted, true, `验收照常落章：${JSON.stringify(accepted)}`);
    assert.deepEqual(await crewOf("L2"), [], "库里没有多出来的执行者");
    // 路由里那一句是观察式的早拒；过了它之后验收才开始，落库前那一道照样拒（挂在执行者名下的，也认它的上级）。
    await db.insert(tasks).values({
      id: "W2", projectId: "p", parentId: "L2", title: "共享执行者", body: "", mode: "single", status: "done",
      useWorktree: false, endedAt: at, createdAt: at, updatedAt: at,
    } as never);
    assert.equal(beginAccepting("L2"), true);
    assert.equal(await admitTeamMembers(["L2"]), null, "验收进行中：加不进来");
    assert.equal(await admitTeamMembers(["W2"]), null, "挂在它的执行者名下也加不进来");
    assert.equal(beginAccepting("W2"), true, "没占全就一个都不占（先占上的那一位放掉了）");
    endAccepting("W2");
    endAccepting("L2");
    const admitted = await admitTeamMembers(["W2"]);
    assert.ok(admitted, "验收结束就加得进来");
    assert.equal(beginAccepting("L2"), false, "加着的时候验收开不了");
    admitted!();
    assert.equal(beginAccepting("L2"), true);
    endAccepting("L2");
  }

  // ── ②' 过了路由里那一句早拒、在落库前排队时验收开始了 ─────────────────
  {
    await lead("L7");
    // 先占住这个仓库的锁：建任务过了路由检查，停在落库前的排队上。
    const queued = gate();
    const holding = withRepoLock(stage, async () => { queued.reached(); await queued.opened; });
    await queued.arrived;
    const response = create({ parentId: "L7" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(beginAccepting("L7"), true, "这时验收开始了");
    queued.release();
    await holding;
    const refused = await response;
    assert.equal(refused.status, 409, "落库那一道拒：加不进来");
    assert.match(JSON.stringify(await refused.json()), /挂靠的任务正在验收/);
    assert.deepEqual(await crewOf("L7"), [], "没有落库");
    endAccepting("L7");
    // 加成员之间按计数：一处放了，另一处还占着。
    const first = admitMembers(["L7"])!;
    const second = admitMembers(["L7"])!;
    first();
    assert.equal(beginAccepting("L7"), false, "还有一处在加：验收开不了");
    second();
    assert.equal(beginAccepting("L7"), true);
    endAccepting("L7");
  }

  // ── ②'' 占哪几位只看挂靠关系，不看 mode：普通任务也一样占 ──────────────────
  {
    await db.insert(tasks).values({ id: "S1", projectId: "p", title: "普通任务", body: "", mode: "single", status: "done", useWorktree: false, endedAt: at, createdAt: at, updatedAt: at } as never);
    assert.deepEqual(await admissionKeysOf(["S1"]), ["S1"], "普通任务：占它自己");
    assert.deepEqual((await admissionKeysOf(["W2"])).sort(), ["L2", "W2"], "团队执行者连同调度台");
    assert.deepEqual(await admissionKeysOf(["gone"]), ["gone"], "查不到的也占（它的上级查不到就不连）");
    assert.equal(beginAccepting("S1"), true);
    const derived = await create({ parentId: "S1", title: "派生的子任务" });
    assert.equal(derived.status, 409, "普通任务验收期间也不往它名下落任务");
    assert.match(JSON.stringify(await derived.json()), /挂靠的任务正在验收/);
    endAccepting("S1");
    assert.equal((await create({ parentId: "S1", title: "派生的子任务" })).status, 201, "验收结束照常派生");
  }

  // ── ③ 审查任务那一支：reviewOf 指向团队的共享执行者 ─────────────────────
  {
    await lead("L3");
    await db.insert(tasks).values({
      id: "W3", projectId: "p", parentId: "L3", title: "共享执行者", body: "", mode: "single", status: "done",
      useWorktree: false, endedAt: at, createdAt: at, updatedAt: at,
    } as never);
    // reviewOf 这条路由不落库，建出来的是普通顶层单任务，只能走自由工作流（起手式已停止新建）。
    const { response, held } = await pausedCreate({ reviewOf: "W3", title: "审查", workflowMode: "free" });
    const refused = await acceptTask("L3", "human", { expectedResultVersion: "-" });
    assert.equal(refused.accepted, false, "审查任务正要落库：它所属的团队不验收");
    assert.match(JSON.stringify(refused), /名下正在加入新的任务/);
    held.release();
    assert.equal((await response).status, 201);
    assert.equal(beginAccepting("L3"), true, "落库之后放开");
    endAccepting("L3");
  }

  // ── ④ 加成员之间不互斥 ───────────────────────────────────────────────────
  {
    await lead("L4");
    const { response, held } = await pausedCreate({ parentId: "L4" });
    // 落库本身在同一把仓库锁里排队（task-store.ts createTasks）：派活这一下排在后面，但不该被当成「正在验收」拒掉。
    const dispatching = dispatchWorkers("L4", [{ body: "派的活" }], { run: false });
    held.release();
    assert.equal((await dispatching).tasks.length, 1, "建执行者落库途中，调度台照样派得了活");
    assert.equal((await response).status, 201);
    assert.equal((await crewOf("L4")).length, 2);
    assert.equal(beginAccepting("L4"), true, "两边都落库之后放开");
    endAccepting("L4");
  }

  // ── ⑤ 兜底：落章那一个事务认得出多出来的共享执行者 ─────────────────────
  {
    await lead("L5");
    const release = await holdTeamForAcceptance("L5");
    assert.deepEqual([...holdScope("L5")], ["L5"]);
    await db.insert(tasks).values({
      // 新来的没有结束时刻：成果版本看不出它（task-result-version.ts），只有成员集合看得出。
      id: "W5", projectId: "p", parentId: "L5", title: "绕过互斥进来的", body: "", mode: "single", status: "running",
      useWorktree: false, createdAt: at, updatedAt: at,
    } as never);
    await assert.rejects(commitAcceptanceStage("L5", "accepted", {}, undefined, holdScope("L5")), CrewChanged, "多出来一位：这一章不盖");
    assert.equal(await stageOf("L5"), null);
    const row = (await db.select().from(tasks).where(eq(tasks.id, "L5"))).at(0)!;
    const finalized = await finalizeAcceptance(row, "已验收", false);
    assert.equal(finalized.failure?.reason, "result_changed", "验收收尾照实拒绝");
    assert.match(finalized.failure?.error ?? "", /验收途中团队加进了新的执行者/);
    assert.equal(await stageOf("L5"), null, "没落章");
    // 开独立 worktree 的那种不算：改不到团队的目录，验收也不给它盖章。
    await db.update(tasks).set({ useWorktree: true }).where(eq(tasks.id, "W5"));
    await commitAcceptanceStage("L5", "accepted", {}, undefined, holdScope("L5"));
    assert.equal(await stageOf("L5"), "accepted");
    release();
    await new Promise((resolve) => setTimeout(resolve, 150)); // 放开之后补送消息那一下还要读库
  }

  // ── ⑥ 派活途中归档、删除团队：等它落完（派活原来整趟占着验收锁，顺带挡住这两样）──────
  {
    await lead("L6");
    const queued = gate();
    const holding = withRepoLock(stage, async () => { queued.reached(); await queued.opened; });
    await queued.arrived;
    const dispatching = dispatchWorkers("L6", [{ body: "派的活" }], { run: false });
    for (let i = 0; i < 200 && !isAdmitting("L6"); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(isAdmitting("L6"), true, "派活占着加成员的位");
    const archived = await app.request("/api/tasks/L6/archive", { method: "POST" });
    assert.equal(archived.status, 409, "派活途中不归档");
    assert.match(await archived.text(), /名下正在加入新的任务/);
    assert.match((await taskBusyRejection("L6", "删除"))?.error ?? "", /名下正在加入新的任务（执行者、子任务或审查），结束后再删除/, "派活途中不删");
    queued.release();
    await holding;
    assert.equal((await dispatching).tasks.length, 1);
    assert.equal(await taskBusyRejection("L6", "删除"), null, "落完就能删");
    // 执行者名下正在加审查：归档团队同样等它。
    const [worker] = await crewOf("L6");
    const reviewing = beginAdmitting(worker!)!;
    const blocked = await app.request("/api/tasks/L6/archive", { method: "POST" });
    assert.equal(blocked.status, 409);
    assert.match(await blocked.text(), /名下正在加入新的任务，结束后再归档/);
    assert.equal(isTaskBusy({ id: worker!, status: "backlog" }), true, "删项目、清残留那一道同一个判据");
    reviewing();
    assert.equal((await app.request("/api/tasks/L6/archive", { method: "POST" })).status, 200, "都落完了照常归档");
  }

  // ── ⑦ 落库排队期间普通任务改成团队、开始验收：落库那一道照样拒（名单不按排队前的 mode 算）──
  {
    await db.insert(tasks).values({ id: "M7", projectId: "p", title: "起初是普通任务", body: "", mode: "single", status: "done", useWorktree: false, endedAt: at, createdAt: at, updatedAt: at } as never);
    const queued = gate();
    const holding = withRepoLock(stage, async () => { queued.reached(); await queued.opened; });
    await queued.arrived;
    const creating = create({ parentId: "M7", title: "后加的执行者" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const patched = await app.request("/api/tasks/M7", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "team" }) });
    assert.equal(patched.status, 200, "排队期间改成团队（这时还没在验收）");
    // 验收落章之后、函数返回之前放开仓库锁：排着的那一次这才落库。
    const originalTransaction = db.transaction.bind(db);
    let attempt: Response | null = null;
    db.transaction = (async (...args: unknown[]) => {
      if (!new Error().stack?.includes("commitAcceptanceStage")) return (originalTransaction as (...rest: unknown[]) => Promise<unknown>)(...args);
      db.transaction = originalTransaction as typeof db.transaction;
      const result = await (originalTransaction as (...rest: unknown[]) => Promise<unknown>)(...args);
      queued.release();
      await holding;
      attempt = await creating;
      return result;
    }) as typeof db.transaction;
    const accepted = await acceptTask("M7", "human", { expectedResultVersion: at });
    db.transaction = originalTransaction as typeof db.transaction;
    assert.equal(accepted.accepted, true, `验收照常落章：${JSON.stringify(accepted)}`);
    assert.ok(attempt, "确实在验收途中落库过一次");
    assert.equal(attempt!.status, 409, "验收还没结束：落不进来");
    assert.deepEqual(await crewOf("M7"), [], "库里没有多出来的执行者");
    await new Promise((resolve) => setTimeout(resolve, 150)); // 放开之后补送消息那一下还要读库
  }

  db.insert = originalInsert as typeof db.insert;
  await dbClient.close();
  console.log("test-team-accept-crew: ok");
} catch (error) {
  failure = error;
} finally {
  await new Promise((resolve) => setTimeout(resolve, 200));
  await releaseTmpDb();
  rmSync(stage, { recursive: true, force: true });
}
if (failure) {
  console.error(failure);
  process.exit(1);
}
