// 「谁有权改这个状态」的回归(任务 hprbvyaE6SDy 第 1 轮独立审查 F1/F2/F3)。
//
// 上一版把队列占位回滚的所有权寄托在**回合锁**上:回滚占着锁提交,新一轮就 claim 不进来。
// 但回合锁只挡得住走 `claimTurn` 的人,而生产路径上有两个改状态的人不走它 ——
//   · 用户点停止:`/tasks/:id/stop` 直接 `setTaskStatus(canceled)`;
//   · 下一次占位认领:`claimQueueSeat` 排的是自己那条 `serializeQueueClaims` 链,同一个
//     任务重新认领一次就换了代次,而库里的状态**恰好还是 queued**。
// 于是旧回滚照样提交:实测停止回 200、库里 canceled,旧回滚结束后变回 failed;世代从
// 3 换到 4 之后旧回滚也照样把后来者的占位撤回终态。
//
// 覆盖:
//   ① `setTaskStatus` 的条件写本身(expectStatus / commitGuard 的语义、以及**过期的写一个副作用
//      都不发布**);
//   ② 真实窄缝里的两种后来者 —— 在「整行已读出、CAS 还没发出」的那一瞬注入停止 /
//      注入一次完整的重新认领,断言 seat 的 rollback 与 scheduler 的守卫都不提交;
//   ③ 放开回合占位只有**账号本人**按得动,agent 的回合凭证 403;
//   ④ 放开之后如果任务仍点不动,如实说并留下 `incomplete` 痕迹(不再谎称可以运行)。
//
// 为什么单独一个文件:`test-turn-reclaim.ts` 已经 560 行,再塞这几节会越过 700 行的硬上限;
// 名字也不叫 turn-ownership —— 那个名字已经被第 11/12 轮审查那份回归占着(讲的是回合锁与
// 预约槽的原子性,不是队列占位)。两份各自起隔离库,`npm run test:turn-reclaim` 依次跑。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";

const root = mkdtempSync(join(tmpdir(), "ash-turn-ownership-"));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
process.env.ASH_SUSPECT_TURN_MS = "20";

const { ensureSchema, db, dbClient } = await import("../src/db/index.js");
const { projects, queueItems, tasks } = await import("../src/db/schema.js");
const { createTasks } = await import("../src/task-store.js");
const { claimTurn, releaseTurn } = await import("../src/runs.js");
const { setTaskStatus } = await import("../src/status.js");
const { bus } = await import("../src/bus.js");
const { claimQueueSeat, queueClaimError, seatGeneration } = await import("../src/queue-seat.js");
const { reclaimStrandedSeat } = await import("../src/scheduler.js");
const { releaseSuspectTurn } = await import("../src/turn-lock-reclaim.js");
const { noteUserActionOutcome, recentRejectionNotices } = await import("../src/user-action-rejection.js");
const { mountTaskRunRoutes } = await import("../src/task-run-routes.js");
const { mountTaskRoutes } = await import("../src/task-routes.js");
const { personalWriteGate, isHumanOnlyPath } = await import("../src/auth/personal-gate.js");
const { actorOf } = await import("../src/auth/context.js");
const { authGate } = await import("../src/auth/middleware.js");
const { resourceGate } = await import("../src/auth/resource-gate.js");
const { writeSystemSetting } = await import("../src/app-settings.js");
const { invalidateInstanceConfig } = await import("../src/auth/mode.js");

await ensureSchema();
const stamp = new Date().toISOString();
await db.insert(projects).values({
  id: "p1", name: "turn ownership", repoPath: join(root, "repo"),
  apiKeys: null, workflowId: null, createdAt: stamp,
});

const baseTask = {
  projectId: "p1", groupId: null, parentId: null, body: "test", mode: "single", status: "failed",
  labels: "[]", dependsOn: "[]", resumeDependsOn: "[]", agentType: "codex",
  executorId: null, model: null, reasoningEffort: null, autoTitle: false,
  duet: null, team: null, reportBack: false, scheduleId: null,
  createdAt: stamp, updatedAt: stamp,
  useWorktree: false, worktreeBase: null, originTaskId: null, workflowMode: "free",
};

const api = new Hono();
mountTaskRunRoutes(api);
const post = (path: string, body?: unknown) =>
  api.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? (path.endsWith("/reclaim-turn") ? { acknowledgeDuplicateRisk: true } : {})),
  });

const statusOf = async (taskId: string): Promise<string | undefined> =>
  (await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId))).at(0)?.status;

// ── 窄缝注入 ─────────────────────────────────────────────────────────────────
// 要测的那个交错只存在于 `setTaskStatus` 内部:整行 SELECT 已经返回、CAS UPDATE 还没发出。
// 所以在底层 client 上挂一次性钩子:匹配到读 tasks 的那条语句时,**语句照常执行**(拿到的
// 就是真实结果),只把它的 continuation 推迟到注入动作跑完 —— 这正是「读到的东西已经过期」
// 那一瞬。生产代码一个字没改。
const realExecute = dbClient.execute.bind(dbClient);
let inject: null | (() => Promise<unknown>) = null;
let onTaskWrite: null | (() => void) = null;
type Executor = typeof dbClient.execute;
dbClient.execute = ((stmt: Parameters<Executor>[0]) => {
  const sql = String(typeof stmt === "string" ? stmt : (stmt as { sql?: string }).sql ?? "");
  const out = realExecute(stmt);
  if (onTaskWrite && /^\s*update\s+"tasks"/i.test(sql)) {
    const notify = onTaskWrite;
    onTaskWrite = null;
    notify();
  }
  if (inject && /^\s*select/i.test(sql) && sql.includes('"tasks"')) {
    const run = inject;
    inject = null;
    return out.then(async (res) => { await run(); return res; });
  }
  return out;
}) as Executor;

// ── ① 条件写的语义 ───────────────────────────────────────────────────────────
// 这是 F1 的根因层:认领、停止、回滚争的必须是**同一条可原子核验的语句**。再读一次库、
// 再查一次归属都不算 —— `setTaskStatus` 自己内部就隔着 await。
await createTasks([
  { ...baseTask, id: "t-cas", title: "cas", status: "queued" },
  { ...baseTask, id: "t-owns", title: "owns", status: "queued" },
]);

{
  // 状态已经被权威后来者改走 ⇒ 期望值对不上 ⇒ 不写、返回 false。
  await db.update(tasks).set({ status: "canceled" }).where(eq(tasks.id, "t-cas"));
  const committed = await setTaskStatus("t-cas", "failed", { expectStatus: "queued" });
  assert.equal(committed, false, "期望状态对不上时不许提交");
  assert.equal(await statusOf("t-cas"), "canceled", "过期的补偿不许盖掉权威后来者写的状态");

  // 状态对得上就照常写。
  await db.update(tasks).set({ status: "queued" }).where(eq(tasks.id, "t-cas"));
  assert.equal(await setTaskStatus("t-cas", "failed", { expectStatus: "queued" }), true);
  assert.equal(await statusOf("t-cas"), "failed");
}

{
  // 提交守卫补的是另一种过期:状态**恰好还是**期望值,但那已经是后来者重新占下的同一个
  // 状态(队列占位换了代次)。谓词说「不归我」就不许写。
  const committed = await setTaskStatus("t-owns", "failed", {
    expectStatus: "queued",
    commitGuard: async () => false,
  });
  assert.equal(committed, false, "归属谓词否证时不许提交");
  assert.equal(await statusOf("t-owns"), "queued", "不归我的那一代状态一个字都不许动");
  assert.equal(await setTaskStatus("t-owns", "failed", { expectStatus: "queued", commitGuard: (commit) => commit() }), true);
}

// ── ② 真实窄缝:停止抢在回滚的 CAS 之前落库 ──────────────────────────────────
// 实测形态(审查 `stop-rollback-smoke.log`):回滚的 setTaskStatus 已经读出旧行、还没提交,
// 这时用户点停止 —— HTTP 200、库里 canceled;旧回滚继续跑完,库里变成 failed,锁也空了。
// 用户看到的是「刚显示已取消,又跳回失败」。
await createTasks([{ ...baseTask, id: "t-stopwin", title: "stop wins", status: "failed" }]);
await db.insert(queueItems).values({ id: "qi-stopwin", queueId: "q-stopwin", taskId: "t-stopwin", position: 0, createdAt: stamp });

{
  const claim = await claimQueueSeat("t-stopwin");
  assert.ok(claim.ok && claim.seat, "占位该认领得到");
  assert.equal(await statusOf("t-stopwin"), "queued");
  // 停止直接写库 —— 它就是不走 claimTurn 的那一类写入者,这是本节的要点。
  inject = async () => {
    await db.update(tasks).set({ status: "canceled" }).where(eq(tasks.id, "t-stopwin"));
  };
  await claim.seat!.release();
  assert.equal(inject, null, "注入必须真的发生过,否则这一节什么都没测到");
  assert.equal(
    await statusOf("t-stopwin"),
    "canceled",
    "旧回滚不许盖掉用户点停止写下的 canceled —— 那正是实测里「已取消又跳回失败」",
  );
  assert.equal(seatGeneration("t-stopwin"), 0, "这一代不再有负责人,号码必须清掉");
}

// ── ③ 一个任务不许叠出第二代占位 ────────────────────────────────────────────
// 实测形态(审查 `seat-window.json`):旧回滚还在提交,新 seat 仍认领成功(它走的是另一条
// 链),世代 3 → 4。两代并存本身就是所有权混乱:第二代读到的 prevStatus 是**第一代占下的
// 那个 queued**,它的回滚于是成了「写回 queued」,任务停在排队中;两代还同时在动同一行。
// 所以认领那一步就该挡住,而不是等到提交时比代次。
await createTasks([{ ...baseTask, id: "t-regen", title: "regen", status: "failed" }]);
await db.insert(queueItems).values({ id: "qi-regen", queueId: "q-regen", taskId: "t-regen", position: 0, createdAt: stamp });

{
  const first = await claimQueueSeat("t-regen");
  assert.ok(first.ok && first.seat);
  const genBefore = seatGeneration("t-regen");

  // 同一条链上直接再认领一次:挡回,且话术说真话(不许套用「同队有人在跑」—— 挡路的
  // 是它自己,用户会去等一个不存在的前项)。
  const again = await claimQueueSeat("t-regen");
  assert.equal(again.ok, false, "这个任务已经有一代活着的占位,不许叠第二代");
  assert.equal(again.ok === false && again.self, true, "要标明挡路的是自己那一代");
  assert.match(queueClaimError(again as { blockers: string[]; self?: boolean }), /另一条启动路径/);
  assert.equal(seatGeneration("t-regen"), genBefore, "被挡的认领不许换代");

  // 窄缝里也一样:回滚正在提交时另一条入口来认领,照样挡回,于是旧回滚的归属仍然成立。
  let inWindow: Awaited<ReturnType<typeof claimQueueSeat>> | null = null;
  inject = async () => { inWindow = await claimQueueSeat("t-regen"); };
  await first.seat!.release();
  assert.equal(inject, null, "注入必须真的发生过,否则这一节什么都没测到");
  assert.equal(inWindow !== null && (inWindow as { ok: boolean }).ok, false, "窄缝里的认领同样被挡");
  assert.equal(await statusOf("t-regen"), "failed", "没有后来者抢走,第一代的回滚照常提交");
  assert.equal(seatGeneration("t-regen"), 0, "回滚落地后号码必须清掉,否则兜底会一直让位");

  // 号码清了之后,下一次认领就该正常放行 —— 挡的是「同时」,不是「以后」。
  const later = await claimQueueSeat("t-regen");
  assert.ok(later.ok && later.seat, "占位释放之后要能重新认领");
  await later.seat!.release();
  assert.equal(await statusOf("t-regen"), "failed");
}

// ── ④ 守卫侧对称:scheduler 的补偿同样不许盖掉后来者 ────────────────────────
await createTasks([
  { ...baseTask, id: "t-guard", title: "guard", status: "queued" },
  { ...baseTask, id: "t-guard2", title: "guard owns", status: "queued" },
]);
await db.insert(queueItems).values({ id: "qi-guard2", queueId: "q-guard2", taskId: "t-guard2", position: 0, createdAt: stamp });

{
  // (a) 期望状态被权威后来者改走 → 不提交。
  inject = async () => {
    await db.update(tasks).set({ status: "canceled" }).where(eq(tasks.id, "t-guard"));
  };
  await reclaimStrandedSeat("t-guard", "q-guard", "failed", { repush: "never" });
  assert.equal(inject, null, "注入必须真的发生过");
  assert.equal(await statusOf("t-guard"), "canceled", "守卫补偿同样不许盖掉权威后来者");
}

{
  // (b) 状态**恰好还是** queued,但窗口里已经有 seat 认领了它 —— 守卫收的是「无主的
  // queued」,这一具已经有主,一个字都不许动。
  let claimed: Awaited<ReturnType<typeof claimQueueSeat>> | null = null;
  inject = async () => { claimed = await claimQueueSeat("t-guard2"); };
  await reclaimStrandedSeat("t-guard2", "q-guard2", "failed", { repush: "never" });
  assert.equal(inject, null, "注入必须真的发生过");
  assert.ok(claimed && (claimed as { ok: boolean }).ok, "窗口里的认领该成功(此刻还没有活着的占位)");
  assert.notEqual(seatGeneration("t-guard2"), 0, "认领之后这具 queued 就有主了");
  assert.equal(await statusOf("t-guard2"), "queued", "有主的 queued 不许被守卫撤回终态");
  // 这一代的 `prevStatus` 就是它认领之前读到的那个 queued(它接手的本来就是一具遗留),
  // 所以它的 release 是空转:任务仍停在 queued,号码清掉。这是对的 —— seat 的回滚目标
  // 定义就是「我占位之前库里是什么」,它不该替别人留下的遗留猜一个终态。真正持有正确
  // 回滚目标的是 `reclaimStrandedSeat`(prevStatus 由欠下这次启动的那一方传进来),
  // 号码一清它下一趟就接得上。本节要钉的是**守卫那一笔没有写进去**。
  await (claimed as { seat: { release(): Promise<void> } }).seat.release();
  assert.equal(await statusOf("t-guard2"), "queued");
  assert.equal(seatGeneration("t-guard2"), 0, "号码必须清掉,否则守卫永远在读库之前让位");
  await reclaimStrandedSeat("t-guard2", "q-guard2", "failed", { repush: "never" });
  assert.equal(await statusOf("t-guard2"), "failed", "持有正确回滚目标的那一方来收,才收得干净");
}

// ── ⑤ 放开回合占位只有账号本人按得动 ────────────────────────────────────────
// 实测(审查 `agent-reclaim-smoke.log`):只带 `x-ash-source-task-id` + `x-ash-turn-token`
// 的 agent 请求拿到 200、`reclaimed:true`,另一个任务的锁被放开,日志还记成「用户主动放开」。
// 这条路存在的全部理由是「系统判不了原持有者死没死,所以交给知情的人判」,把一次 agent
// 发来的请求当成用户知情同意,等于把这个设计的唯一前提抽掉。
assert.equal(isHumanOnlyPath("/api/tasks/abc/reclaim-turn"), true);
assert.equal(isHumanOnlyPath("/api/tasks/abc/stop"), false, "停止不在真人专属之列");
assert.equal(isHumanOnlyPath("/api/tasks/abc/reclaim-turn/extra"), false, "只认那条路径本身");

{
  const gated = new Hono();
  let authenticatedAs = "";
  gated.use("*", authGate());
  gated.use("*", resourceGate());
  gated.use("*", async (c, next) => {
    authenticatedAs = actorOf(c).kind;
    return next();
  });
  gated.use("*", personalWriteGate());
  // 这道闸按**完整路径**判(生产里 api 挂在 /api 之下),所以测试也必须带上那一层 ——
  // 不带的话路由能通、闸却一句 `startsWith("/api/")` 就放行了,等于什么都没测。
  const inner = new Hono();
  mountTaskRunRoutes(inner);
  mountTaskRoutes(inner);
  gated.route("/api", inner);

  await createTasks([
    { ...baseTask, id: "t-gate", title: "gate", status: "queued" },
    { ...baseTask, id: "source-agent", title: "source", status: "running", activeTurnToken: "valid-turn" },
    { ...baseTask, id: "source-team", title: "resident lead", mode: "team", status: "idle", activeTurnToken: null, workflowMode: "preset" },
  ]);
  assert.equal(claimTurn("t-gate"), true);
  await new Promise((r) => setTimeout(r, 40)); // 过了可疑阈值

  for (const mode of ["multi", "single"]) {
    await writeSystemSetting("instanceMode", mode);
    invalidateInstanceConfig();
    const asAgent = await gated.request("/api/tasks/t-gate/reclaim-turn", {
      method: "POST",
      headers: { "content-type": "application/json", "x-ash-source-task-id": "source-agent", "x-ash-turn-token": "valid-turn" },
      body: JSON.stringify({ acknowledgeDuplicateRisk: true }),
    });
    assert.equal(authenticatedAs, "agent", `${mode} 模式必须保留真实的任务身份`);
    assert.equal(asAgent.status, 403, "agent 的回合凭证不许按这个开关");
    assert.match((await asAgent.json() as { error: string }).error, /只有账号本人/);
    assert.equal(claimTurn("t-gate"), false, "403 之后那把锁必须还在");
  }

  const invalidCredentials: Record<string, string>[] = [
    { "x-ash-source-task-id": "source-agent", "x-ash-turn-token": "expired" },
    { "x-ash-source-task-id": "source-agent" },
    { "x-ash-turn-token": "valid-turn" },
    { "x-ash-source-task-id": "source-team" },
    { "x-ash-source-task-id": "", "x-ash-turn-token": "" },
  ];
  for (const headers of invalidCredentials) {
    const invalid = await gated.request("/api/tasks/t-gate/reclaim-turn", {
      method: "POST", headers, body: JSON.stringify({ acknowledgeDuplicateRisk: true }),
    });
    assert.equal(invalid.status, 403, "真人专属闸必须拒绝无效或不完整的任务凭证");
  }

  for (const headers of invalidCredentials) {
    const read = await gated.request("/api/tasks/t-gate", { headers });
    assert.equal(read.status, 200, "自用模式的普通请求不应被全局身份闸抢先拒绝");
    assert.equal(authenticatedAs, "single");
  }
  const staleCreation = await gated.request("/api/tasks", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ash-source-task-id": "source-agent", "x-ash-turn-token": "expired" },
    body: JSON.stringify({ projectId: "p1", title: "expired creation", useWorktree: false }),
  });
  assert.equal(staleCreation.status, 409, "过期回合应由业务路由按原语义拒绝");
  assert.match((await staleCreation.json() as { error: string }).error, /创建来源的回合身份已过期/);
  for (const status of ["idle", "running"]) {
    await db.update(tasks).set({ status, activeTurnToken: null }).where(eq(tasks.id, "source-team"));
    const headers = { "content-type": "application/json", "x-ash-source-task-id": "source-team" };
    const created = await gated.request("/api/tasks", {
      method: "POST", headers,
      body: JSON.stringify({ projectId: "p1", title: `resident ${status}`, useWorktree: false }),
    });
    assert.equal(created.status, 201, "常驻调度台没有回合令牌也应按既有来源判据创建任务");
    const child = await created.json() as { id: string; creationOrigin: { kind: string; taskId: string } };
    assert.equal(child.creationOrigin.kind, "agent");
    assert.equal(child.creationOrigin.taskId, "source-team");
    const read = await gated.request(`/api/tasks/${child.id}`, { headers });
    assert.equal(read.status, 200, "调度台可读取任务信息");
    const patched = await gated.request("/api/tasks/t-gate", {
      method: "PATCH", headers, body: JSON.stringify({ title: `lead patched ${status}` }),
    });
    assert.equal(patched.status, 200, "调度台可修改在运行/排队的执行者任务");
  }
  await writeSystemSetting("instanceMode", "multi");
  invalidateInstanceConfig();
  const unauthenticated = await gated.request("/api/tasks/t-gate", {
    headers: { "x-ash-source-task-id": "source-team" },
  });
  assert.equal(unauthenticated.status, 401, "来源头不能绕过多人登录边界");
  await writeSystemSetting("instanceMode", "single");
  invalidateInstanceConfig();

  const noConsent = await gated.request("/api/tasks/t-gate/reclaim-turn", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(noConsent.status, 400, "默认本机身份不等于确认风险");
  const crossSite = await gated.request("/api/tasks/t-gate/reclaim-turn", {
    method: "POST", headers: { origin: "https://other.example" },
    body: JSON.stringify({ acknowledgeDuplicateRisk: true }),
  });
  assert.equal(crossSite.status, 403, "跨站请求不能冒充用户确认");
  assert.equal(claimTurn("t-gate"), false, "授权失败不能释放锁");

  // 同一条路,真人(自用模式的隐式本地用户)照常放行。
  const asHuman = await gated.request("/api/tasks/t-gate/reclaim-turn", {
    method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ acknowledgeDuplicateRisk: true }),
  });
  assert.equal(asHuman.status, 200, "账号本人该按得动");
  assert.equal((await asHuman.json() as { reclaimed: boolean }).reclaimed, true);
}

// ── ⑥ 放开之后仍点不动:如实说,并留下痕迹 ──────────────────────────────────
// 实测(审查 `reclaim-http.txt`):POST reclaim 回 200「现在可以继续运行」,紧接着 POST run
// 回 409 `status:"queued"`。放开只撤内存里那把锁,库里的状态归另一个人负责,而这条路要救的
// 正是「没有人会来负责」的遗留。开关随 remedy 变 null 一起消失,用户就没有下一步了。
await createTasks([
  { ...baseTask, id: "t-stuck", title: "stuck", status: "queued" },
  { ...baseTask, id: "t-free", title: "free", status: "failed" },
]);

{
  assert.equal(claimTurn("t-stuck"), true);
  await new Promise((r) => setTimeout(r, 40));
  const res = await post("/tasks/t-stuck/reclaim-turn");
  assert.equal(res.status, 200);
  const body = await res.json() as { reclaimed: boolean; runnable: boolean; nextStep: string | null; note: string };
  assert.equal(body.reclaimed, true, "锁确实该放开 —— 它是真的占着不动");
  assert.equal(body.runnable, false, "任务还停在 queued,不许声称现在可以运行");
  assert.match(body.nextStep ?? "", /停止/, "没恢复就得给出下一步(点一次停止把它收掉)");
  assert.doesNotMatch(body.note, /^已放开这个任务的回合占位，现在可以继续运行/);

  // 这一步的痕迹必须是持久的:开关一消失,它就是用户唯一还看得见的下一步。
  const notices = await recentRejectionNotices("t-stuck");
  const incomplete = notices.find((n) => n.action === "放开回合占位" && n.outcome === "incomplete");
  assert.ok(incomplete, "放开了却仍点不动,要留一条 incomplete 痕迹");
  assert.match(incomplete!.reason, /停止/);

  // run 仍会被挡回 —— 这正是上面那句话的依据,不是推断。
  const run = await post("/tasks/t-stuck/run");
  assert.equal(run.status, 409);
  assert.equal((await run.json() as { status: string }).status, "queued");
  assert.equal((await post("/tasks/t-stuck/stop")).status, 200);
  assert.equal(await statusOf("t-stuck"), "canceled", "提示中的停止动作必须真的把任务恢复到可运行状态");
}

{
  // 对照:状态本来就可运行时,成功就是成功,不许多出一条「没到位」的痕迹。
  assert.equal(claimTurn("t-free"), true);
  await new Promise((r) => setTimeout(r, 40));
  const body = await (await post("/tasks/t-free/reclaim-turn")).json() as
    { runnable: boolean; nextStep: string | null; note: string };
  assert.equal(body.runnable, true);
  assert.equal(body.nextStep, null);
  assert.match(body.note, /现在可以继续运行/);
  const notices = await recentRejectionNotices("t-free");
  assert.equal(notices.filter((n) => n.outcome === "incomplete").length, 0);
}

// ── ⑦ 两档结果各自存得住、读得回 ───────────────────────────────────────────
// 「点了没执行」和「执行了没到位」是两件事,措辞完全不同,所以存的是维度而不是让前端去猜
// reason 的字面。
await createTasks([{ ...baseTask, id: "t-outcome", title: "outcome" }]);
{
  assert.equal(await noteUserActionOutcome("t-outcome", "运行", "rejected", "同队还有在跑的"), true);
  assert.equal(await noteUserActionOutcome("t-outcome", "放开回合占位", "incomplete", "还停在排队中"), true);
  const notices = await recentRejectionNotices("t-outcome");
  assert.equal(notices.length, 2);
  assert.deepEqual(
    new Set(notices.map((n) => `${n.action}/${n.outcome}`)),
    new Set(["运行/rejected", "放开回合占位/incomplete"]),
  );
  // 去重要分档:同一个动作、同一句理由,两种结果不是同一条事实。
  assert.equal(await noteUserActionOutcome("t-outcome", "运行", "rejected", "同队还有在跑的"), false);
  assert.equal(await noteUserActionOutcome("t-outcome", "运行", "incomplete", "同队还有在跑的"), true);
}

for (const firstWriter of ["claim", "reclaim"]) {
  const taskId = `write-gate-${firstWriter}`;
  await createTasks([{ ...baseTask, id: taskId, title: taskId, status: firstWriter === "claim" ? "failed" : "queued" }]);
  await db.insert(queueItems).values({ queueId: taskId, taskId, position: 0, createdAt: stamp });
  const published: string[] = [];
  const unsubscribe = bus.subscribe((event) => {
    if (event.type === "task.status" && event.taskId === taskId) published.push(event.status);
  });
  const transaction = await dbClient.transaction();
  const writeStarted = new Promise<void>((resolve) => { onTaskWrite = resolve; });
  let claim: ReturnType<typeof claimQueueSeat>;
  let reclaim: ReturnType<typeof reclaimStrandedSeat>;
  try {
    if (firstWriter === "claim") {
      claim = claimQueueSeat(taskId);
      await writeStarted;
      assert.equal(seatGeneration(taskId), 0, "认领写门被占时尚未发号");
      reclaim = reclaimStrandedSeat(taskId, taskId, "failed", { repush: "never" });
    } else {
      reclaim = reclaimStrandedSeat(taskId, taskId, "failed", { repush: "never" });
      await writeStarted;
      claim = claimQueueSeat(taskId);
    }
  } finally {
    await transaction.commit();
  }
  const claimed = await claim!;
  await reclaim!;
  assert.ok(claimed.ok && claimed.seat, "两个合法提交次序中认领都必须成功");
  assert.equal(await statusOf(taskId), "queued", "补偿不能撤销刚认领成功的 queued");
  assert.notEqual(seatGeneration(taskId), 0);
  assert.deepEqual(published, firstWriter === "claim" ? ["queued"] : ["failed", "queued"], "过期补偿不能发布终态副作用");
  unsubscribe();
  await claimed.seat!.release();
}

for (const id of ["t-gate", "t-free"]) releaseTurn(id);
dbClient.execute = realExecute as Executor;
await new Promise<void>((resolve) => setImmediate(resolve));
await dbClient.close?.();
console.log("seat-ownership regressions ok");
