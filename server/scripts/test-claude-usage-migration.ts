// claude 账本回填的**迁移协议**：资源归属、维护互斥、写入边界、提交与回滚。
//
// 为什么跟 test-claude-usage-accounting.ts 分开：那一份钉的是「账该算成多少」（口径、
// 换算、判不出就跳过）；这一份钉的是「改这两套资源时怎么保证不留半成品」。两件事的失败
// 模式完全不同，分开钉，下一个人改坏哪一边都看得出是哪一边。
//
// 第 2 轮审查打回的三条，各自成段，别删：
// ① **拷贝验证不许改到原始 trace**：`--db` 换的是库，而 trace 由另一个环境变量各自解析，
//    于是「先在拷贝上验证」这条前提当场失效。归属因此改成成套决定（claude-usage-resources），
//    而且互斥是**真取锁**（maintenance-lock），不是只探一次活。
// ② **跨文件/跨库迁移要有一致的提交协议**：trace 文件和两张表是一个失败集；中途失败整体
//    回滚，连回滚都失败才落隔离记录并从此拒绝重跑；硬杀在「trace 写完、事务没提交」之间
//    靠恒等式可证明地恢复，不需要人介入。
// ③ **跳过项不许落账**：计划层用判别联合让跳过项**结构上**拿不出 `after`，apply 层再独立
//    复核一遍（双重闸）；库值跟记录对不上时不假设「trace 求和 == 当前库值」。
//
// 第 1 轮（顶级）审查打回的三条，同样各自成段：
// ④ **同级不是归属**：同一个目录里的第二份库不许改写 `<dir>/ash.db` 的 trace；路径一律
//    realpath 之后再比（软链到正式 runs 的「同级 runs」不算配套），锁也按资源键取满 ——
//    库 + runs 两把，所以共享目录是真被锁住的（见 claude-usage-resources / maintenance-lock）。
// ⑤ **「查对方 + 建自己」必须原子**：两边各自先查后建的话存在两边都通过检查的交错，所以
//    统一走一把短命占有锁（resource-claim），长命锁本身也带着内容原子出现。
// ⑥ **人工屏障三态**：没有未决记录 / 有有效记录 / 记录读不出来，是三种状态。第三种在计划
//    层和写入入口**都**整盘拒绝 —— 空集合表达不了「不知道」。
//
// **每个场景一套独立的库 + runs**，所以用子进程跑：RUNS_DIR 在模块加载时就冻成常量了，
// 一个进程里换不了。
//
// Run: npm -w server run test:usage
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TokenUsage } from "@ash/shared";

const self = fileURLToPath(import.meta.url);
const scenario = process.argv[2];

if (!scenario) {
  const scenarios = ["binding", "lock", "claim", "uncertain", "gate", "drift", "identity", "rollback",
    "quarantine", "barrier", "recover"];
  for (const name of scenarios) {
    const child = spawnSync(process.execPath, [...process.execArgv, self, name], { stdio: "inherit" });
    assert.ok(!child.error, `场景 ${name} 的子进程没起来：${child.error?.message ?? ""}`);
    assert.equal(child.status, 0, `场景 ${name} 没过`);
  }
  console.log("claude 回填迁移协议验证通过：资源成套绑定且归属可证、路径规范化后再比、"
    + "维护锁按资源键取满、取锁走原子占有协议、跳过项双重闸、人工屏障三态且不可读时整盘拒绝、"
    + "中途失败整体回滚、硬杀可证明恢复、回滚失败明确拒绝重跑");
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), `ash-usage-mig-${scenario}-`));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
delete process.env.ASH_RUNS_FALLBACK;

const usage = (input: number): TokenUsage =>
  ({ input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: null, turns: 1 });
/** 口径日期界之后（新 CLI：`result` 是整条线程的累计）。 */
const at = (index: number) => `2026-10-20T10:00:${String(index).padStart(2, "0")}.000Z`;

try {
  if (scenario === "binding") await binding();
  else if (scenario === "lock") await lock();
  else if (scenario === "claim") await claim();
  else await dataScenario(scenario);
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ── ① 资源归属：库和它的 runs 是一套，归属在绑定这一层显式决定 ──────────────────
async function binding() {
  const { resolveRepairResources } = await import("../src/claude-usage-resources.js");
  const data = join(root, "repo-data");
  const copy = join(root, "check", "ash.db");

  // 这就是第 2 轮审查 F1 的根因：指了库、没指 runs，环境里那份指着正式 runs。
  const derived = resolveRepairResources({
    db: copy, apply: true, env: { ASH_RUNS_DIR: join(data, "runs") }, dataDir: data,
  });
  assert.equal(derived.runsDir, join(root, "check", "runs"), "runs 必须跟着库走，不许沿用环境里那份");
  assert.equal(derived.refusal, null, "成套的拷贝可以 apply");

  const crossed = resolveRepairResources({ db: copy, runs: join(data, "runs"), apply: true, dataDir: data });
  assert.match(crossed.refusal!, /不是配套/, "可写的库指着别人的原始 runs，必须直接拒绝");
  assert.match(crossed.refusal!, /cp -R/, "拒绝还得告诉人怎么做对");
  assert.equal(
    resolveRepairResources({ db: copy, runs: join(data, "runs"), apply: false, dataDir: data }).refusal,
    null,
    "dry-run 一个字节都不写，允许拿正式 runs 给拷贝库预览清单",
  );

  // 从 worktree 里跑时本检出的 data/ 不存在，而 --db 指着主检出那份真生产库 —— 这条最该
  // 拦的用法，只跟本检出的 data/ash.db 比一个等号是拦不住的。
  assert.match(
    resolveRepairResources({ db: join(root, "another-checkout", "data", "ash.db"), apply: true, dataDir: data }).refusal!,
    /生产库/,
    "任何检出的 data/ash.db 都按生产库对待",
  );
  const production = resolveRepairResources({ apply: true, dataDir: data });
  assert.equal(production.dbFile, join(data, "ash.db"));
  assert.match(production.refusal!, /生产库/, "默认目标是生产库，没有 --force-production 一律拒");
  const forced = resolveRepairResources({ apply: true, forceProduction: true, dataDir: data });
  assert.equal(forced.refusal, null);
  assert.equal(forced.runsDir, join(data, "runs"), "生产库配套的就是 data/runs");

  // ── 第 1 轮审查 F1：同级只是必要条件，归属才是判据 ──────────────────────────
  // 同一个目录里放第二份库，拿它 --apply：旧版过「同级」这一关，改写的却是 ash.db 的 trace。
  const set = join(root, "copyset");
  mkdirSync(join(set, "runs"), { recursive: true });
  writeFileSync(join(set, "ash.db"), "");
  writeFileSync(join(set, "check.db"), "");
  const second = resolveRepairResources({ db: join(set, "check.db"), apply: true, dataDir: data });
  assert.match(second.refusal!, /不是 .*runs 的主人/, "同目录的第二份库对那份 runs 没有写权");
  assert.match(second.refusal!, /ash\.db/, "拒绝得说清主人是谁、该怎么拷");
  assert.equal(
    resolveRepairResources({ db: join(set, "check.db"), apply: false, dataDir: data }).refusal,
    null,
    "dry-run 不写东西，第二份库照样可以预览",
  );

  // 路径一律 realpath 之后再比：① 父目录别名指向同一套 → 放行，且锁键跟直连那次一模一样。
  const real = realpathSync(set);
  symlinkSync(set, join(root, "link"));
  const viaAlias = resolveRepairResources({ db: join(root, "link", "ash.db"), apply: true, dataDir: data });
  assert.equal(viaAlias.refusal, null, "经别名到达的同一套资源该放行");
  assert.deepEqual(
    viaAlias.lockKeys,
    resolveRepairResources({ db: join(set, "ash.db"), apply: true, dataDir: data }).lockKeys,
    "同一份资源经不同路径到达必须算出同一组锁键 —— 否则两把锁各锁一个名字，等于没锁",
  );
  assert.deepEqual(viaAlias.lockKeys, [join(real, "ash.db"), join(real, "runs")].sort());

  // ② 名字对、落点不对（拷贝目录里的 runs 是条指向正式 runs 的软链）→ 必须拒。
  const sneaky = join(root, "sneaky");
  mkdirSync(sneaky, { recursive: true });
  writeFileSync(join(sneaky, "ash.db"), "");
  symlinkSync(join(set, "runs"), join(sneaky, "runs"));
  const aliased = resolveRepairResources({ db: join(sneaky, "ash.db"), apply: true, dataDir: data });
  assert.match(aliased.refusal!, /不是配套/, "软链到别人的 runs，名字是同级也不算配套");
  assert.ok(
    aliased.refusal!.includes(join(real, "runs")),
    "拒绝信息要把规范化后的真实落点写出来，不然人看不出哪里不对",
  );

  // 测试台那种「两个环境变量成套给」照样放行；不成套则拒。
  assert.equal(
    resolveRepairResources({
      apply: true, dataDir: data,
      env: { ASH_DB: join(root, "x", "ash.db"), ASH_RUNS_DIR: join(root, "x", "runs") },
    }).refusal,
    null,
  );
  assert.match(
    resolveRepairResources({
      apply: true, dataDir: data,
      env: { ASH_DB: join(root, "x", "ash.db"), ASH_RUNS_DIR: join(data, "runs") },
    }).refusal!,
    /不是配套/,
  );
}

// ── ② 维护互斥：真取锁，两个方向都挡 ───────────────────────────────────────────
async function lock() {
  const maintenance = await import("../src/maintenance-lock.js");
  const { acquireDbSingletonLock, SingletonConflictError } = await import("../src/singleton.js");
  const dbFile = process.env.ASH_DB!;

  const { canonicalResourceKey } = await import("../src/resource-claim.js");
  const held = maintenance.acquireMaintenanceLock(dbFile, "test-migration");
  assert.ok(maintenance.liveMaintenanceHolderForDb(dbFile), "取到锁就得看得见持有者");
  assert.throws(
    () => maintenance.acquireMaintenanceLock(dbFile, "another"),
    maintenance.MaintenanceLockError,
    "第二个维护进程不许同时动这份库",
  );
  // 这一条才是「真取锁」跟「只探活」的区别：探活只能回答「刚才有没有」。
  assert.throws(
    () => acquireDbSingletonLock({ port: null }),
    (error: unknown) => error instanceof SingletonConflictError && /maintenance/i.test(error.message),
    "迁移跑着的时候 ash 不许起来",
  );

  held.release();
  assert.equal(maintenance.liveMaintenanceHolderForDb(dbFile), null);
  const singleton = acquireDbSingletonLock({ port: null });
  assert.ok(singleton, "锁放了之后服务就该起得来");
  singleton.release();

  // ── 第 1 轮审查 F1 的锁面：要改的文件在 runs 里，所以 runs 也得是一把锁 ──────
  const runsKey = canonicalResourceKey(process.env.ASH_RUNS_DIR!);
  const onRuns = maintenance.acquireMaintenanceLocks([runsKey], "test-runs-only");
  assert.throws(
    () => acquireDbSingletonLock({ port: null }),
    (error: unknown) => error instanceof SingletonConflictError && /maintenance/i.test(error.message),
    "只锁住 runs（别的库路径落到同一份 runs 上就是这种形状）也必须挡住服务启动",
  );
  // ASH_ALLOW_MULTI 的语义是「允许多个 ash 并存」，不是「允许踩正在迁移的库」。
  process.env.ASH_ALLOW_MULTI = "1";
  try {
    assert.throws(
      () => acquireDbSingletonLock({ port: null }),
      (error: unknown) => error instanceof SingletonConflictError && /maintenance/i.test(error.message),
      "ASH_ALLOW_MULTI=1 不是绕开维护锁的后门",
    );
  } finally {
    delete process.env.ASH_ALLOW_MULTI;
  }
  onRuns.release();

  // 同一份资源经不同路径到达 = 同一把锁（别名下各锁一个名字就等于没锁）。
  const aliasRoot = join(root, "alias");
  symlinkSync(root, aliasRoot);
  const viaAlias = maintenance.acquireMaintenanceLocks([join(aliasRoot, "ash.db")], "test-alias");
  assert.ok(
    maintenance.liveMaintenanceHolderFor(canonicalResourceKey(dbFile)),
    "经别名取的锁，规范化之后必须看得见",
  );
  assert.throws(
    () => acquireDbSingletonLock({ port: null }),
    SingletonConflictError,
    "经别名取的维护锁照样挡住服务启动",
  );
  viaAlias.release();

  // 多把一起取：中途有一把被人占着，已经取到的那几把必须全部放回去。
  const other = maintenance.acquireMaintenanceLocks([runsKey], "占着 runs");
  assert.throws(
    () => maintenance.acquireMaintenanceLocks([dbFile, runsKey], "两把一起要"),
    maintenance.MaintenanceLockError,
  );
  assert.equal(maintenance.liveMaintenanceHolderFor(canonicalResourceKey(dbFile)), null,
    "取锁失败不许留下半套锁");
  other.release();

  // 脚本被强杀之后那把锁必须自动失效，否则服务永远起不来。
  writeFileSync(maintenance.maintenanceLockFileForDb(dbFile), JSON.stringify({
    pid: 999_999, processStartedAt: new Date().toISOString(), processStartedAtMs: Date.now(),
    acquiredAt: new Date().toISOString(), note: "被强杀的脚本", token: "x", key: dbFile,
  }));
  assert.equal(maintenance.liveMaintenanceHolderForDb(dbFile), null, "pid 已经不在 = 陈旧锁");
  const afterStale = acquireDbSingletonLock({ port: null });
  assert.ok(afterStale, "陈旧的维护锁不许把服务永久挡在外面");
  afterStale.release();
}

// ── ③ 占有协议：「查对方 + 建自己」是原子的，长命锁带着内容原子出现 ─────────────
async function claim() {
  const { atomicCreateWithContent, claimFileFor, canonicalResourceKey, withResourceClaim, ResourceClaimError } =
    await import("../src/resource-claim.js");
  const { acquireDbSingletonLock } = await import("../src/singleton.js");
  const maintenance = await import("../src/maintenance-lock.js");
  const dbFile = process.env.ASH_DB!;

  // 锁文件必须**带着内容**出现：先建空文件再写的话，中间那一瞬别人读到一份读不懂的锁，
  // 会把活锁判成陈旧锁删掉，而第一个进程手里的 fd 还在、照样返回成功。
  const target = join(root, "atomic.lock");
  assert.equal(atomicCreateWithContent(target, JSON.stringify({ a: 1 })), true);
  assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { a: 1 });
  assert.equal(atomicCreateWithContent(target, JSON.stringify({ a: 2 })), false, "已经存在就返回 false，不覆盖");
  assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { a: 1 }, "也不许截断成半份");
  assert.ok(existsSync(target) && readFileSync(target, "utf8").length > 0);
  // 临时文件不许留。
  assert.deepEqual(
    readdirSync(root).filter((name) => name.endsWith(".tmp")), [],
    "atomicCreateWithContent 不许留下临时文件",
  );

  const held = maintenance.acquireMaintenanceLocks([dbFile], "test-claim");
  assert.ok(JSON.parse(readFileSync(maintenance.maintenanceLockFileForDb(dbFile), "utf8")).pid,
    "维护锁落盘即完整可读");
  held.release();

  // 占有锁被别人拿着的时候，服务启动这一侧不许「照常继续」—— 它必须等不到就拒。
  // 这就是审查用同步屏障复现的那个窗口：旧版两边各自先查后建，交错之后两边都通过。
  const key = canonicalResourceKey(dbFile);
  writeFileSync(claimFileFor(key), JSON.stringify({
    pid: process.pid, note: "假装别人正在起手", token: "x", at: new Date().toISOString(),
  }));
  assert.throws(() => acquireDbSingletonLock({ port: null }), ResourceClaimError,
    "占有锁在别人手里时，服务启动必须停下来，不许跟迁移交错");
  assert.throws(() => maintenance.acquireMaintenanceLocks([dbFile], "迁移也一样"), ResourceClaimError,
    "迁移那一侧用的是同一把占有锁");
  rmSync(claimFileFor(key));

  // 持有者已经不在了 = 陈旧占有锁，必须能回收，否则一次强杀就把两边永久挡住。
  writeFileSync(claimFileFor(key), JSON.stringify({
    pid: 999_999, note: "被强杀的起手动作", token: "x", at: new Date().toISOString(),
  }));
  const ok = acquireDbSingletonLock({ port: null });
  assert.ok(ok, "陈旧占有锁不许把服务永久挡在外面");
  ok.release();
  assert.equal(existsSync(claimFileFor(key)), false, "占有锁用完即走，不留痕");

  // 用完即放：同一把键可以接着被拿到（不是只能拿一次）。
  let ran = 0;
  withResourceClaim([dbFile], "第一次", () => { ran += 1; });
  withResourceClaim([dbFile], "第二次", () => { ran += 1; });
  assert.equal(ran, 2);
  assert.equal(existsSync(claimFileFor(key)), false);
}

// ── ④~⑥ 需要库的那几个场景 ────────────────────────────────────────────────────
async function dataScenario(name: string) {
  const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
  const { sessions, appSettings, usageCumulativeSnapshots } = await import("../src/db/schema.js");
  const { eq } = await import("drizzle-orm");
  const { appendSessionTrace, sessionTracePath } = await import("../src/transcript.js");
  const { planClaudeUsageRepair, plannedAfter, skipReason, CLAUDE_REPAIR_MARKER } =
    await import("../src/claude-usage-repair.js");
  const { applyClaudeUsageRepair } = await import("../src/claude-usage-apply.js");
  const { prepareTraceRewrite, writePreparedTrace, readUsageTrace, TRACE_BACKUP_SUFFIX } =
    await import("../src/claude-usage-trace.js");
  const { readUnresolvedState, writeUnresolvedRepair, unresolvedRepairFileForDb } =
    await import("../src/claude-usage-quarantine.js");
  await ensureSchema();

  const task = "mig";
  /** 按「账面 = 各条目逐轮相加」(改口径之前 v1 的行为)建一条历史会话。 */
  const seed = async (id: string, options: {
    thread: string;
    values: number[];
    /** 库里实际记着的 input。缺省 = 各条目之和；给别的值就是「有别的东西动过这笔账」。 */
    dbInput?: number;
    offset?: number;
  }) => {
    const offset = options.offset ?? 0;
    await db.insert(sessions).values({
      id, taskId: task, agentType: "claude", executor: "claude", role: "single",
      cliSessionId: options.thread, startedAt: at(offset),
      usageInput: options.dbInput ?? options.values.reduce((sum, value) => sum + value, 0),
      usageOutput: 0, usageCacheRead: 0, usageCacheWrite: 0, usageReasoning: 0, usageCostUsd: null,
      usageTurns: options.values.length,
    });
    options.values.forEach((value, index) => {
      const when = at(index + offset);
      appendSessionTrace(task, id, when, { kind: "usage", usage: usage(value), accounting: "incremental" }, when);
    });
  };
  const inputOf = async (id: string) =>
    (await db.select().from(sessions).where(eq(sessions.id, id)).get())!.usageInput;
  const markerRow = async () =>
    (await db.select().from(appSettings).where(eq(appSettings.key, CLAUDE_REPAIR_MARKER)).get()) ?? null;
  const snapshotCount = async () => (await db.select().from(usageCumulativeSnapshots)).length;
  const tracePath = (id: string) => sessionTracePath(task, id);
  const planOf = (plan: { sessions: { sessionId: string }[] }, id: string) =>
    plan.sessions.find((item) => item.sessionId === id)! as Awaited<
      ReturnType<typeof planClaudeUsageRepair>>["sessions"][number];

  if (name === "uncertain") {
    // 第 2 轮审查 F3 的验收口径：报成跳过的条目，库值前后一字不差。
    // 形状 100→200→100→200 只降了 1 次(不到一半) → 判不出；而库里记的是 400，不是 trace
    // 求和的 600 —— 上一版照样把 600 塞进 after 落了账，把一笔对的账改成了 1.5 倍。
    await seed("u1", { thread: "t-uncertain", values: [100, 200, 100, 200], dbInput: 400 });
    const plan = await planClaudeUsageRepair();
    const row = planOf(plan, "u1");
    assert.equal(row.regime, "uncertain");
    assert.equal(row.action.kind, "skip", "判不出就只诊断");
    assert.equal(plannedAfter(row), null, "跳过项结构上就拿不出可执行的改账值");
    assert.ok(skipReason(row), "必须明说为什么跳过");
    assert.equal(plan.traces.length, 0, "账不改，trace 也不改");
    const applied = await applyClaudeUsageRepair(plan);
    assert.equal(applied.committed, true);
    assert.equal(applied.sessions, 0);
    assert.equal(await inputOf("u1"), 400, "报成跳过的条目，apply 前后库值必须一模一样");
    assert.ok(readUsageTrace(task, "u1")!.every((entry) => entry.mark === "incremental"), "trace 也没动");
  }

  if (name === "gate") {
    // 双重闸：计划层出 bug（把跳过项填成可执行的改账值）时，apply 自己也得拦住。
    await seed("g1", { thread: "t-gate", values: [100, 200, 100, 200], dbInput: 400 });
    const plan = await planClaudeUsageRepair();
    assert.equal(planOf(plan, "g1").regime, "uncertain");
    const forged = {
      ...plan,
      sessions: plan.sessions.map((item) => item.sessionId === "g1"
        ? { ...item, action: { kind: "update" as const, after: usage(600), basis: "recompute" as const } }
        : item),
    };
    const result = await applyClaudeUsageRepair(forged);
    assert.equal(result.committed, false, "有一条越界就整轮不写");
    assert.equal(result.refused.length, 1);
    assert.match(result.refused[0]!, /uncertain/, "拒绝理由要指名道姓");
    assert.equal(await inputOf("g1"), 400, "apply 层不依赖计划层自觉");
    assert.equal(await markerRow(), null, "一个字节都没写，连回填标记都不该落");
  }

  if (name === "drift") {
    // 「不得假设历史 trace 求和必等于当前已正确的库值」：形状和日期都说累计，但库里记的
    // 数跟这些记录加不出来 —— 有别的东西动过这笔账，这一轮只诊断。
    await seed("d1", { thread: "t-drift", values: [100, 200, 300, 400], dbInput: 1234 });
    const plan = await planClaudeUsageRepair();
    const row = planOf(plan, "d1");
    assert.equal(row.regime, "cumulative");
    assert.equal(row.action.kind, "skip");
    assert.match(skipReason(row)!, /对不上/);
    assert.equal(row.recorded!.input, 1000, "记录求和要如实报出来，供人对照");
    assert.equal(plan.traces.length, 0);
    await applyClaudeUsageRepair(plan);
    assert.equal(await inputOf("d1"), 1234, "证明不了就不碰");
  }

  if (name === "identity") {
    // 内容身份：计划之后文件变过（新回合追加 / 别人改过），只核对「第 n 条命中了」会拿
    // 陈旧计划盖掉新内容。核对原值 → 整份不动，这条线程的账也跟着不动。
    await seed("i1", { thread: "t-id", values: [100, 200, 300] });
    const plan = await planClaudeUsageRepair();
    assert.ok(plannedAfter(planOf(plan, "i1")), "本来是要改账的");
    const text = readFileSync(tracePath("i1"), "utf8");
    assert.ok(text.includes('"input":200'));
    writeFileSync(tracePath("i1"), text.replace('"input":200', '"input":250'));
    const result = await applyClaudeUsageRepair(plan);
    assert.equal(result.traces.files, 0, "一份都不许写");
    assert.match(result.traces.failures.join("\n"), /跟计划当时读到的不一样/);
    assert.deepEqual(result.traces.failedThreads, ["t-id"]);
    assert.equal(result.sessions, 0);
    assert.equal(await inputOf("i1"), 600, "trace 验不过，这条线程的账也不动");
    assert.equal(await snapshotCount(), 0, "快照属于同一个失败集，也不许建");
    assert.ok(!existsSync(`${tracePath("i1")}${TRACE_BACKUP_SUFFIX}`), "没写过就不该留备份");
  }

  if (name === "rollback") {
    // F2 的验收口径：中途写失败后按提示重跑，最终总量仍是正确的 400。
    await seed("p1", { thread: "t-p", values: [100, 200] });
    await seed("p2", { thread: "t-p", values: [300, 400], offset: 2 });
    const plan = await planClaudeUsageRepair();
    assert.equal(plannedAfter(planOf(plan, "p1"))!.input, 200);
    assert.equal(plannedAfter(planOf(plan, "p2"))!.input, 200);
    const original = readFileSync(tracePath("p1"), "utf8");
    const obstruction = `${tracePath("p2")}.repair-tmp`;
    mkdirSync(obstruction); // 写第二份时必然失败

    const first = await applyClaudeUsageRepair(plan);
    assert.equal(first.committed, false);
    assert.equal(first.rolledBack, 1, "已经写下去的那一份要还原回来");
    assert.equal(first.unresolved, null, "能自动回滚就不该留隔离记录");
    assert.equal(readFileSync(tracePath("p1"), "utf8"), original, "回滚后原文一字不差");
    assert.equal(await inputOf("p1"), 300, "库一个字节没改");
    assert.equal(await inputOf("p2"), 700);
    assert.equal(await snapshotCount(), 0, "快照和账是同一个失败集");
    assert.equal(await markerRow(), null);

    rmSync(obstruction, { recursive: true });
    const retry = await applyClaudeUsageRepair(await planClaudeUsageRepair());
    assert.equal(retry.committed, true);
    assert.equal(await inputOf("p1"), 200);
    assert.equal(await inputOf("p2"), 200);
    assert.equal(await inputOf("p1") + await inputOf("p2"), 400, "按提示重跑，最终总量是正确的 400");
    const snapshot = await db.select().from(usageCumulativeSnapshots).get();
    assert.equal(snapshot!.sourceId, "claude:t-p");
    assert.equal(snapshot!.input, 400, "续聊这条线程时按整条线程的累计总量求差");
    assert.equal(snapshot!.baselineReady, true);
  }

  if (name === "recover") {
    // 硬杀在「trace 全写完、库事务还没提交」之间：**不需要人介入**。那时整条线程的条目
    // 全带 delta 标记，而「账 = 各条增量之和」是恒等式，重跑一次就可证明地收敛到正确值。
    await seed("r1", { thread: "t-r", values: [100, 200] });
    await seed("r2", { thread: "t-r", values: [300, 400], offset: 2 });
    const plan = await planClaudeUsageRepair();
    for (const rewrite of plan.traces) {
      const prepared = prepareTraceRewrite(rewrite);
      assert.notEqual(typeof prepared, "string", `预检没过：${String(prepared)}`);
      assert.equal(writePreparedTrace(prepared as Exclude<typeof prepared, string>), null);
    }
    assert.equal(await inputOf("r1"), 300, "模拟硬杀：trace 写完了，库还是旧账");

    const healed = await planClaudeUsageRepair();
    const row = planOf(healed, "r1");
    assert.equal(row.evidence, "settled", "条目全是结算过的，没有旧账要判");
    assert.equal(row.action.kind, "update");
    assert.equal(row.action.kind === "update" ? row.action.basis : null, "settled-drift", "靠恒等式恢复");
    const applied = await applyClaudeUsageRepair(healed);
    assert.equal(applied.committed, true);
    assert.equal(applied.traces.files, 0, "trace 已经是真实增量，不该再改一遍");
    assert.equal(await inputOf("r1"), 200);
    assert.equal(await inputOf("r2"), 200);
    const snapshot = await db.select().from(usageCumulativeSnapshots).get();
    assert.equal(snapshot!.input, 400, "累计基线也能从改写后的记录里重新拼出来");

    // 收敛之后必须幂等。
    const third = await planClaudeUsageRepair();
    assert.equal(third.sessions.filter((item) => plannedAfter(item)).length, 0);
  }

  if (name === "quarantine") {
    // 回滚**本身**也失败：这种状态下不许再推，落一份隔离记录并从此明确拒绝重跑。
    await seed("q1", { thread: "t-q", values: [100, 200] });
    await seed("q2", { thread: "t-q", values: [300, 400], offset: 2 });
    const plan = await planClaudeUsageRepair();
    const writeBlock = `${tracePath("q2")}.repair-tmp`;
    const restoreBlock = `${tracePath("q1")}.repair-rollback`;
    mkdirSync(writeBlock);
    mkdirSync(restoreBlock);

    const failed = await applyClaudeUsageRepair(plan);
    assert.equal(failed.committed, false);
    assert.equal(failed.rolledBack, 0, "一份都没还原成");
    assert.ok(failed.unresolved, "回滚失败必须留下隔离记录");
    const state = readUnresolvedState();
    assert.equal(state.kind, "pending");
    assert.deepEqual(state.kind === "pending" ? state.record.threads : null, ["t-q"]);
    assert.match(failed.traces.failures.join("\n"), /回滚失败/);
    assert.equal(await inputOf("q1"), 300, "库仍然一个字节没改");

    const refusing = await planClaudeUsageRepair();
    assert.equal(planOf(refusing, "q1").regime, "quarantined");
    assert.equal(planOf(refusing, "q1").action.kind, "skip");
    assert.match(skipReason(planOf(refusing, "q1"))!, /人工核对/);
    assert.match(refusing.warnings.join("\n"), /没结清/);
    assert.equal(refusing.traces.length, 0, "拒绝重跑 = 连 trace 都不再碰");
    const refused = await applyClaudeUsageRepair(refusing);
    assert.equal(refused.traces.files, 0);
    assert.equal(await inputOf("q1"), 300);

    // 人按提示收拾：还原备份 → 删隔离记录 → 重跑，才又能动。
    rmSync(writeBlock, { recursive: true });
    rmSync(restoreBlock, { recursive: true });
    writeFileSync(tracePath("q1"), readFileSync(`${tracePath("q1")}${TRACE_BACKUP_SUFFIX}`, "utf8"));
    rmSync(unresolvedRepairFileForDb());
    const final = await applyClaudeUsageRepair(await planClaudeUsageRepair());
    assert.equal(final.committed, true);
    assert.equal(await inputOf("q1"), 200);
    assert.equal(await inputOf("q2"), 200);
  }

  if (name === "barrier") {
    // 第 1 轮审查 F3：人工屏障**自己**读不出来时，不许退化成「谁都不用挡」。
    await seed("b1", { thread: "t-b", values: [100, 200] });
    const file = unresolvedRepairFileForDb();
    const unreadable: [string, string, RegExp][] = [
      ["截断（上次写到一半）", '{"at":"2026-10-28T00:00:00.000Z","threads":["t-b"', /完整的 JSON/],
      ["缺 threads 字段", '{"at":"2026-10-28T00:00:00.000Z","reason":"x"}', /缺 threads/],
      ["threads 是空的", '{"at":"2026-10-28T00:00:00.000Z","threads":[],"reason":"x"}', /空的/],
      ["threads 里有非字符串", '{"threads":[1,2]}', /不是字符串/],
      ["顶层不是对象", '"just a string"', /顶层不是对象/],
    ];
    for (const [label, text, detail] of unreadable) {
      writeFileSync(file, text);
      const read = readUnresolvedState();
      assert.equal(read.kind, "unreadable", `${label}：必须判成读不出来，不能当成「没有未决记录」`);
      assert.match(read.kind === "unreadable" ? read.detail : "", detail, label);

      const plan = await planClaudeUsageRepair();
      assert.equal(plan.unresolved.kind, "unreadable", label);
      assert.equal(plan.sessions.every((item) => item.action.kind === "skip"), true,
        `${label}：计划层结构上拿不出任何可写动作`);
      assert.equal(plan.traces.length, 0, `${label}：连 trace 都不许碰`);
      assert.equal(plan.snapshots.length, 0, `${label}：也不许顺手建基线`);
      assert.match(plan.warnings.join("\n"), /读不出来/, label);
      const refused = await applyClaudeUsageRepair(plan);
      assert.equal(refused.committed, false, label);
      assert.match(refused.refused.join("\n"), /整盘拒绝/, `${label}：写入入口也要自己判一遍`);
      assert.equal(await inputOf("b1"), 300, `${label}：库一个字节没改`);
    }

    // **双重闸**：计划是在屏障出现之前算的（满手可写动作），落地之前屏障坏了 —— 写入入口
    // 必须自己再读一次磁盘并整盘拒绝，而不是指望计划层已经把动作清空。
    rmSync(file);
    const fresh = await planClaudeUsageRepair();
    assert.ok(fresh.sessions.some((item) => item.action.kind === "update"), "先拿一份满手可写动作的计划");
    writeFileSync(file, '{"threads":["t-b"');
    const blocked = await applyClaudeUsageRepair(fresh);
    assert.equal(blocked.committed, false, "计划层没拦住的，写入入口要拦住");
    assert.equal(blocked.traces.files, 0);
    assert.equal(await inputOf("b1"), 300);

    // 往读不懂的那份上写新记录：旧文件不许直接盖掉，先存档，位置写进新记录。
    const written = writeUnresolvedRepair({
      at: new Date().toISOString(), threads: ["t-other"], files: [], reason: "另一次失败",
    });
    assert.equal(written, file);
    const merged = readUnresolvedState();
    assert.equal(merged.kind, "pending", "新记录必须是完整可读的（原子替换）");
    assert.deepEqual(merged.kind === "pending" ? merged.record.threads : null, ["t-other"]);
    const archived = (merged.kind === "pending" ? merged.record.files : []).find((item) => item.includes(".unreadable-"));
    assert.ok(archived && existsSync(archived), "读不懂的那份要存档下来，不能悄悄丢掉");
    assert.match(merged.kind === "pending" ? merged.record.reason : "", /读不懂/);

    // 有效记录只挡它点名的线程 —— 屏障不许过宽。
    const scoped = await planClaudeUsageRepair();
    assert.equal(scoped.unresolved.kind, "pending");
    assert.equal(planOf(scoped, "b1").action.kind, "update", "别的线程不在清单里，照常修");
    const done = await applyClaudeUsageRepair(scoped);
    assert.equal(done.committed, true);
    assert.equal(await inputOf("b1"), 200);
  }

  dbClient.close();
}
