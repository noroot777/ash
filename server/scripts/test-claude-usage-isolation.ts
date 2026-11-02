// 隔离资源集的那一半：**归属、互斥、占有协议**。
//
// 跟 test-claude-usage-migration.ts 分开只是因为行数（两边都快撞 700 行上限），钉的东西
// 是一类的：「这次回填动的到底是哪一套资源，以及同一时刻还有谁在动它」。账该算成多少在
// test-claude-usage-accounting.ts，提交/回滚/人工屏障在 test-claude-usage-migration.ts。
//
// 审查三次打回的同一类意见，一条一段，别删：
// ① **同级不是归属**（第 1 轮）：同一个目录里的第二份库不许改写 `<dir>/ash.db` 的 trace；
//    路径一律 realpath 之后再比，锁按资源键取满（库 + runs 两把）。
// ② **根目录过了不代表后代安全**（第 3 轮）：隔离副本里任意一级任务目录是条软链，写集就
//    落到别人家了 —— 判据必须落在**实际写集**（trace + 备份 + 两个临时文件）的真实落点上。
// ③ **「查对方 + 登记自己」必须在同一个临界区**（第 1、3 轮）：两边各自先查后建存在双方
//    都通过检查的交错；服务那一侧还要**登记在线**（单例锁按库命名、ASH_ALLOW_MULTI 压根
//    不写它，共享同一份 runs 的另一个库路径和多实例模式都探不到）。
// ④ **活着的占有者不按墙钟时间抢**（第 3 轮）：超时判死会让被 SIGSTOP、被慢盘卡住的持有者
//    在恢复之后和抢锁方同时写。
// ⑤ **路径字符串不是实体归属证明，撤销登记不是停止写入**（第 3 轮复核 F1/F2/F3/N1，场景 alias）：
//    写入点必须独占创建（悬空软链、硬链接两种别名都不许跟着写），备份必须「写满了才以正式名字
//    出现」，撤销在线登记和退出必须是同一件事，一组键的登记要么全成要么一个不留。
//
// **每个场景一套独立的库 + runs**，所以由 test-claude-usage-migration.ts 用子进程逐个拉起：
// RUNS_DIR 在模块加载时就冻成常量了，一个进程里换不了。
//
// Run: npm -w server run test:usage
import assert from "node:assert/strict";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync,
  symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { linkSync, openSync, closeSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TokenUsage } from "@ash/shared";

const SCENARIOS = ["binding", "lock", "claim", "online", "escape", "alias"] as const;

const scenario = process.argv[2];
if (!scenario || !SCENARIOS.includes(scenario as (typeof SCENARIOS)[number])) {
  console.error(`用法：tsx scripts/test-claude-usage-isolation.ts <${SCENARIOS.join("|")}>`);
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), `ash-usage-iso-${scenario}-`));
process.env.ASH_DB = join(root, "ash.db");
process.env.ASH_RUNS_DIR = join(root, "runs");
delete process.env.ASH_RUNS_FALLBACK;
delete process.env.ASH_ALLOW_MULTI;

const usage = (input: number): TokenUsage =>
  ({ input, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: null, turns: 1 });
const at = (index: number) => `2026-10-20T10:00:${String(index).padStart(2, "0")}.000Z`;

try {
  if (scenario === "binding") await binding();
  else if (scenario === "lock") await lock();
  else if (scenario === "claim") await claim();
  else if (scenario === "online") await online();
  else if (scenario === "escape") await escape();
  else await alias();
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
  // ── 第 3 轮审查 ④：活着的占有者**不按墙钟时间**抢 ─────────────────────────
  // 旧版「mtime 超过 30 秒就算陈旧」会在持有者被 SIGSTOP、被慢盘卡住、或者机器时钟跳一下
  // 的时候把锁抢走，于是两边在恢复之后同时写。判死只认 pid 这条硬事实。
  const old = Date.now() / 1000 - 600;
  utimesSync(claimFileFor(key), old, old);
  assert.ok(Date.now() - statSync(claimFileFor(key)).mtimeMs > 60_000, "夹具：这把锁看起来已经很旧了");
  assert.throws(() => acquireDbSingletonLock({ port: null }), ResourceClaimError,
    "持有者还活着，不管锁文件看起来多旧都不许抢");
  assert.throws(() => maintenance.acquireMaintenanceLocks([dbFile], "迁移也不许抢"), ResourceClaimError);
  assert.ok(existsSync(claimFileFor(key)), "更不许顺手把别人的锁删掉");
  rmSync(claimFileFor(key));

  // 读不懂的残骸是另一档：它不可能是「刚建好还没写完」（锁带着内容原子出现），放久了
  // 就得清掉，否则一次半截写入把两边永久挡住。
  writeFileSync(claimFileFor(key), "{坏的");
  utimesSync(claimFileFor(key), old, old);
  const afterCorpse = acquireDbSingletonLock({ port: null });
  assert.ok(afterCorpse, "读不懂又放了很久的残骸锁要能清掉");
  afterCorpse.release();

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

// ── ④ 在线登记：服务那一侧也要在共同临界区里登记自己 ───────────────────────────
async function online() {
  const maintenance = await import("../src/maintenance-lock.js");
  const presence = await import("../src/ash-presence.js");
  const { canonicalResourceKey, claimFileFor, resourceKeysFor } = await import("../src/resource-claim.js");
  const { acquireDbSingletonLock } = await import("../src/singleton.js");
  const dbFile = process.env.ASH_DB!;
  const runsDir = process.env.ASH_RUNS_DIR!;
  const keys = resourceKeysFor(dbFile, runsDir);
  const dbKey = canonicalResourceKey(dbFile);
  const runsKey = canonicalResourceKey(runsDir);

  // ① 这一查必须在 claim **里面**:claim 之外探一次只能证明「那一刻没有」。第 3 轮审查用
  //    真实服务实测了剩下那条交错 —— 探完没有 → 服务拿到 claim 起来 → 迁移再拿到 claim
  //    写维护锁 → 两边同时活着(BOTH_LIVE，服务 /api/health 还是 200)。
  let insideClaim: boolean | null = null;
  const held = maintenance.acquireMaintenanceLocks([dbFile], "test-online", {
    onlineProbe: () => {
      insideClaim = existsSync(claimFileFor(dbKey));
      return null;
    },
  });
  assert.equal(insideClaim, true, "在线探测必须发生在占有锁已经拿到之后 —— 否则就是 F2 那条交错");
  held.release();

  // ② 有活着的 ash 登记在案时，维护取锁一律拒绝。
  const shared = presence.registerAshPresence(keys, { port: 14321, mode: "shared" });
  assert.ok(presence.liveAshPresenceFor(dbKey), "登记完就该看得见");
  assert.ok(presence.liveAshPresenceFor(runsKey), "runs 这个键上也要有 —— 共享它的别的库路径才看得见");
  assert.throws(
    () => maintenance.acquireMaintenanceLocks(keys, "撞上在线服务"),
    maintenance.AshOnlineError,
    "ASH_ALLOW_MULTI 起的实例不写单例锁，但它在线这件事必须挡住离线回填",
  );
  // 只共享 runs 的那种形状（另一个库路径落到同一份 runs 上）同样要挡住。
  assert.throws(
    () => maintenance.acquireMaintenanceLocks([runsDir], "只锁 runs"),
    maintenance.AshOnlineError,
  );
  shared.release();
  assert.equal(presence.liveAshPresenceFor(dbKey), null, "放了之后不许留痕");
  maintenance.acquireMaintenanceLocks(keys, "没人在线了").release();

  // ③ 没主的登记不许把回填永久挡在外面，而且读的时候顺手清掉。
  const corpse = presence.presenceFileFor(dbKey, 999_999);
  writeFileSync(corpse, JSON.stringify({
    pid: 999_999, startedAt: new Date().toISOString(), processStartedAtMs: Date.now(),
    port: null, command: "被强杀的实例", key: dbKey, mode: "exclusive",
  }));
  assert.equal(presence.liveAshPresenceFor(dbKey), null, "pid 已经不在 = 残骸");
  assert.equal(existsSync(corpse), false, "残骸要顺手清掉");
  maintenance.acquireMaintenanceLocks(keys, "残骸不算在线").release();

  // ④ 反方向:ASH_ALLOW_MULTI 起的实例**自己**也必须留下在线记录（放这一步最后 —— 它没有
  //    可释放的锁对象，登记要等进程退出才撤）。
  process.env.ASH_ALLOW_MULTI = "1";
  assert.equal(acquireDbSingletonLock({ port: 14322 }), null, "多实例模式本来就不拿单例锁");
  delete process.env.ASH_ALLOW_MULTI;
  const seen = presence.liveAshPresenceFor(dbKey);
  assert.ok(seen, "放弃排他不等于放弃「让别人看见我在线」");
  assert.equal(seen.mode, "shared");
  assert.throws(() => maintenance.acquireMaintenanceLocks(keys, "撞上多实例"), maintenance.AshOnlineError);
}

// ── ⑤ 写集的真实落点：根目录过了不代表后代安全 ─────────────────────────────────
async function escape() {
  // 夹具就是第 3 轮审查那一份:副本自己有 runs 根，但根下面的任务目录是条指向源 runs 的软链。
  const source = join(root, "source");
  mkdirSync(join(source, "runs", "mig"), { recursive: true });
  mkdirSync(join(root, "runs"), { recursive: true });
  symlinkSync(join(source, "runs", "mig"), join(root, "runs", "mig"));

  const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
  const { sessions } = await import("../src/db/schema.js");
  const { appendSessionTrace, sessionTracePath } = await import("../src/transcript.js");
  const { planClaudeUsageRepair } = await import("../src/claude-usage-repair.js");
  const { applyClaudeUsageRepair } = await import("../src/claude-usage-apply.js");
  const { prepareTraceRewrite, traceEscapeReason } = await import("../src/claude-usage-trace.js");
  await ensureSchema();

  await db.insert(sessions).values({
    id: "e1", taskId: "mig", agentType: "claude", executor: "claude", role: "single",
    cliSessionId: "t-escape", startedAt: at(0), usageInput: 300, usageOutput: 0, usageCacheRead: 0,
    usageCacheWrite: 0, usageReasoning: 0, usageCostUsd: null, usageTurns: 2,
  });
  [100, 200].forEach((input, index) => appendSessionTrace(
    "mig", "e1", at(index), { kind: "usage", usage: usage(input), accounting: "incremental" }, at(index),
  ));
  // 写进去的其实是源那份(软链)，这正是要挡住的东西。
  const realPath = join(source, "runs", "mig", "e1.trace.jsonl");
  const before = readFileSync(realPath, "utf8");
  assert.equal(existsSync(sessionTracePath("mig", "e1")), true);

  assert.match(traceEscapeReason("mig", "e1")!, /不在本次隔离资源集里/, "父目录是软链就算越界");
  const plan = await planClaudeUsageRepair();
  assert.ok(plan.traces.length > 0, "计划层照常算得出改写清单（它只读）");

  // 单份写入自己也要拒 —— 绕过闸直接调也写不出去。
  const prepared = prepareTraceRewrite(plan.traces[0]!);
  assert.equal(typeof prepared, "string");
  assert.match(prepared as string, /不在本次隔离资源集里/);

  // 整轮拒绝:一条越界就一个字节都不写(不是只跳过那一份)。
  const result = await applyClaudeUsageRepair(plan);
  assert.equal(result.committed, false);
  assert.equal(result.traces.files, 0);
  assert.equal(result.sessions, 0);
  assert.match(result.refused.join("\n"), /不在本次隔离资源集里/);
  assert.equal(readFileSync(realPath, "utf8"), before, "源 trace 一个字节都没动");
  assert.equal(
    (await db.select().from(sessions).get())!.usageInput, 300,
    "账也一个字节没动",
  );
  assert.equal(
    readdirSync(join(source, "runs", "mig")).filter((name) => name !== "e1.trace.jsonl").length, 0,
    "连备份和临时文件都不许落到别人家",
  );
  dbClient.close();
}

// ── ⑥ 别名与生命周期：写入点独占创建、备份完整发布、下线即退出 ─────────────────
async function alias() {
  const { db, dbClient, ensureSchema } = await import("../src/db/index.js");
  const { sessions } = await import("../src/db/schema.js");
  const { appendSessionTrace, sessionTracePath } = await import("../src/transcript.js");
  const { planClaudeUsageRepair } = await import("../src/claude-usage-repair.js");
  const { applyClaudeUsageRepair } = await import("../src/claude-usage-apply.js");
  const { TRACE_BACKUP_SUFFIX } = await import("../src/claude-usage-trace.js");
  const presence = await import("../src/ash-presence.js");
  const maintenance = await import("../src/maintenance-lock.js");
  const { canonicalResourceKey, resourceKeysFor } = await import("../src/resource-claim.js");
  await ensureSchema();

  const seed = async (id: string) => {
    await db.insert(sessions).values({
      id, taskId: "mig", agentType: "claude", executor: "claude", role: "single",
      cliSessionId: `t-${id}`, startedAt: at(0), usageInput: 300, usageOutput: 0, usageCacheRead: 0,
      usageCacheWrite: 0, usageReasoning: 0, usageCostUsd: null, usageTurns: 2,
    });
    [100, 200].forEach((input, index) => appendSessionTrace(
      "mig", id, at(index), { kind: "usage", usage: usage(input), accounting: "incremental" }, at(index),
    ));
    return sessionTracePath("mig", id);
  };
  const accountOf = async (id: string) =>
    (await db.select().from(sessions).all()).find((row) => row.id === id)!.usageInput;

  // ① 临时文件名被**别名**占着时整轮拒绝，而且目录外那一份一个字节都不许动。两种别名各试一次：
  //    悬空软链（realpath 失败后退回「父目录 + 名字」，归属判据看不出问题）和硬链接（realpath
  //    本来就落在 runs 内）—— 两条都不是归属判据能拦住的，只有独占创建能。
  const outside = join(root, "outside-history.jsonl");
  writeFileSync(outside, "OUTSIDE_ORIGINAL\n");
  for (const [id, alias] of [["a1", "dangling"], ["a2", "hardlink"]] as const) {
    const trace = await seed(id);
    const temp = `${trace}.repair-tmp`;
    const target = join(root, `outside-${id}.jsonl`);
    if (alias === "dangling") symlinkSync(target, temp); // 落点还不存在
    else linkSync(outside, temp);
    const before = readFileSync(outside, "utf8");
    const report = await applyClaudeUsageRepair(await planClaudeUsageRepair());
    assert.equal(report.committed, false, `${alias}: 临时文件名被别名占着必须整轮拒绝`);
    assert.match(report.traces.failures.join("\n"), /这个名字已经被占着/);
    assert.match(report.traces.failures.join("\n"), /确认那份文件没用之后删掉它再重跑/);
    assert.equal(await accountOf(id), 300, `${alias}: 账一个字节没动`);
    assert.equal(existsSync(target), false, `${alias}: 不许跟着悬空软链在目录外造文件`);
    assert.equal(readFileSync(outside, "utf8"), before, `${alias}: 不许重写硬链接那头的旧历史`);
    rmSync(temp, { force: true });
  }

  // ② 备份**写满了才以正式名字出现**：在它那份唯一临时文件上注入「写一半就抛」，失败之后正式
  //    名字下不许留一份看起来可用、其实被截断的恢复材料（第 3 轮复核 F3 实测 460 → 40 字节）。
  const trace = await seed("a3");
  const backup = `${trace}${TRACE_BACKUP_SUFFIX}`;
  const original = readFileSync(trace, "utf8");
  // ESM 命名空间对象不可写，所以经 CJS 那份 node:fs 打桩（和 test-accept-gate-proof.ts 同款）。
  const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
  const realWrite = fs.writeFileSync;
  let injected = 0;
  fs.writeFileSync = ((path: unknown, data: unknown, ...rest: unknown[]) => {
    // 正式名字下压根不会被写，所以注入点是「以备份名开头的那份唯一临时文件」。
    if (injected === 0 && String(path).startsWith(`${backup}.`)) {
      injected += 1;
      closeSync(openSync(String(path), "wx"));
      realWrite(String(path), String(data).slice(0, 40));
      throw Object.assign(new Error("injected partial ENOSPC"), { code: "ENOSPC" });
    }
    return (realWrite as (...args: unknown[]) => void)(path, data, ...rest);
  }) as typeof realWrite;
  syncBuiltinESMExports();
  let first;
  try {
    first = await applyClaudeUsageRepair(await planClaudeUsageRepair());
  } finally {
    fs.writeFileSync = realWrite;
    syncBuiltinESMExports();
  }
  assert.equal(injected, 1, "注入没打到备份那次写入 —— 用例已经和实现漂了");
  assert.equal(first.committed, false, "备份没留下就不许继续改账");
  assert.equal(readFileSync(trace, "utf8"), original, "原 trace 保持原样");
  assert.equal(existsSync(backup), false, "半份备份绝不许以正式名字出现 —— 重跑只看 existsSync 就会信它");
  assert.equal(await accountOf("a3"), 300);
  const retry = await applyClaudeUsageRepair(await planClaudeUsageRepair());
  assert.equal(retry.committed, true, "故障过去之后照常跑完");
  assert.equal(readFileSync(backup, "utf8"), original, "重跑留下的必须是完整原文");
  assert.equal(await accountOf("a3"), 200);
  dbClient.close();

  // ③ 一组键的在线登记要么全成、要么一个不留：第二个键写不下去时第一份不许留在盘上（它带着活
  //    PID，会把离线回填永久挡在外面，而这个实例多半压根没起来）。
  const keys = resourceKeysFor(process.env.ASH_DB!, process.env.ASH_RUNS_DIR!);
  const blocked = join(root, "blocked-runs");
  writeFileSync(blocked, "不是目录，所以第二个键的 mkdir 会 ENOTDIR\n");
  assert.throws(() => presence.registerAshPresence([keys[0]!, join(blocked, "runs")],
    { port: null, mode: "shared" }));
  assert.equal(presence.liveAshPresenceFor(keys[0]!), null, "部分登记不算成功占用，必须整体撤销");
  maintenance.acquireMaintenanceLocks(keys, "部分登记已撤销").release();

  // ④ 登记读不懂时**既不清也不放过**：那一问没答上来，而它的下游是「要不要开始改别人正在写的
  //    历史」。曾经的实现把它清掉并回「没人在线」。
  const garbled = presence.presenceFileFor(canonicalResourceKey(process.env.ASH_DB!), 424_242);
  writeFileSync(garbled, "{ 这不是 JSON");
  assert.throws(() => presence.liveAshPresenceFor(canonicalResourceKey(process.env.ASH_DB!)),
    presence.AshPresenceUnknownError);
  assert.equal(existsSync(garbled), true, "读不懂的登记不许被当成残骸清掉");
  assert.throws(() => maintenance.acquireMaintenanceLocks(keys, "证明不了没人在线"),
    maintenance.AshOnlineError, "证明不了没人在线 = 按有人在线处理");
  rmSync(garbled, { force: true });

  // ⑤ ASH_ALLOW_MULTI 实例收到 SIGTERM 必须**退出**，不是只把自己的在线登记抹掉。只抹登记的话
  //    它照旧在写库和 trace，而离线回填查完一片干净当场开跑（第 3 轮复核 F2 实测 health 仍 200）。
  const child = spawn(process.execPath, ["--import", "tsx", "-e", `
    const { acquireDbSingletonLock } = await import(${JSON.stringify(join(import.meta.dirname, "../src/singleton.js"))});
    acquireDbSingletonLock({ port: null });
    console.log("REGISTERED");
    setInterval(() => {}, 1000);
  `], { env: { ...process.env, ASH_ALLOW_MULTI: "1" }, stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("子进程没能登记上线")), 30_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("REGISTERED")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const online = presence.liveAshPresenceFor(canonicalResourceKey(process.env.ASH_DB!));
  assert.equal(online?.mode, "shared", "多实例模式也要留下在线登记");
  assert.equal(online?.pid, child.pid);
  child.kill("SIGTERM");
  const outcome = await exited;
  assert.equal(outcome.signal, null, "信号处理器接住了，所以不是被信号打死的");
  assert.equal(outcome.code, 143, "撤销登记和退出是同一件事：排他那条路一直是 exit(143)");
  assert.equal(presence.liveAshPresenceFor(canonicalResourceKey(process.env.ASH_DB!)), null,
    "退出之后不许留下在线登记");
}
