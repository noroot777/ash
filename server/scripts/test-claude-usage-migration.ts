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
// 第 3 轮（顶级）审查打回的三条**根因**钉在哪：
// ⑦ 写集的真实落点、⑧ 在线登记与占有协议、⑨ 未知范围单调 —— 前两条连同 ④⑤ 一起搬去了
//    `test-claude-usage-isolation.ts`（两边都快撞 700 行上限，分法按「归属/互斥」对「账与
//    提交」切）；⑨ 留在本文件的 `barrier` 场景里。
//
// **每个场景一套独立的库 + runs**，所以用子进程跑：RUNS_DIR 在模块加载时就冻成常量了，
// 一个进程里换不了。隔离那几个场景的子进程跑的是另一个文件，见下面的派发表。
//
// Run: npm -w server run test:usage
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname, join as joinPath } from "node:path";
import { fileURLToPath } from "node:url";
import type { TokenUsage } from "@ash/shared";

const self = fileURLToPath(import.meta.url);
const scenario = process.argv[2];

/**
 * 哪个场景归哪个文件跑 —— 隔离那一半搬出去了，但入口仍是这一个。
 *
 * 清单在这儿**抄**了一份而不是 import 过来：那个文件是个场景入口，模块一加载就按 argv[2]
 * 跑场景，import 它等于在派发器里先跑一遍它的用法提示然后 exit 2。两边对不上的话下面那条
 * 断言会当场报出来。
 */
const ISOLATION_SCENARIOS = ["binding", "lock", "claim", "online", "escape", "alias"] as const;
const isolation = joinPath(dirname(self), "test-claude-usage-isolation.ts");
const fileOf = (name: string) =>
  (ISOLATION_SCENARIOS as readonly string[]).includes(name) ? isolation : self;

if (!scenario) {
  const scenarios = [...ISOLATION_SCENARIOS, "uncertain", "gate", "drift", "identity", "rollback",
    "quarantine", "barrier", "recover"];
  const declared = readFileSync(isolation, "utf8").match(/\bSCENARIOS = \[(.*?)\]/s)?.[1] ?? "";
  for (const name of ISOLATION_SCENARIOS) {
    assert.ok(declared.includes(`"${name}"`), `${isolation} 里没有场景 ${name} —— 两份清单漂了`);
  }
  for (const name of scenarios) {
    const child = spawnSync(process.execPath, [...process.execArgv, fileOf(name), name], { stdio: "inherit" });
    assert.ok(!child.error, `场景 ${name} 的子进程没起来：${child.error?.message ?? ""}`);
    assert.equal(child.status, 0, `场景 ${name} 没过`);
  }
  console.log("claude 回填迁移协议验证通过：资源成套绑定且归属可证、路径规范化后再比、写集按真实"
    + "落点判、维护锁按资源键取满、取锁走原子占有协议且在线登记在临界区内复查、活着的占有者不按"
    + "墙钟抢、跳过项双重闸、人工屏障三态且不可读时整盘拒绝、未知范围单调只有人能消、中途失败"
    + "整体回滚、硬杀可证明恢复、回滚失败明确拒绝重跑");
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
  await dataScenario(scenario);
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ── 账、提交协议、人工屏障：需要库的那几个场景 ─────────────────────────────────
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
    // 口径判不出的那条线程:它这一轮唯一的写入动作是「留待建基线」的累计快照，用来钉住
    // 「屏障点名了它，计划里又没有 update，闸还得拦住那张快照」（第 3 轮审查 F3 第三例）。
    await seed("b2", { thread: "t-uncertain", values: [100, 200, 100, 200], dbInput: 400, offset: 4 });
    const file = unresolvedRepairFileForDb();
    const unreadable: [string, string, RegExp][] = [
      ["截断（上次写到一半）", '{"at":"2026-10-28T00:00:00.000Z","threads":["t-b"', /完整的 JSON/],
      ["缺 threads 字段", '{"at":"2026-10-28T00:00:00.000Z","reason":"x"}', /缺 threads/],
      ["threads 是空的", '{"at":"2026-10-28T00:00:00.000Z","threads":[],"reason":"x"}', /空的/],
      ["threads 里有非字符串", '{"threads":[1,2]}', /不是字符串/],
      ["顶层不是对象", '"just a string"', /顶层不是对象/],
      // **类型对不等于身份有效**：空白身份匹配不上任何一条 CLI 线程，靠它代表「挡住了」
      // 是假的 —— 第 3 轮审查实测这一份被读成 pending，随后 300 被改成了 200。
      ["threads 里是空白身份", '{"threads":["  ","t-b"]}', /空白身份/],
      ["unknownScope 字段坏了", '{"threads":["t-b"],"unknownScope":"坏了"}', /未知范围无法确认已消解/],
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

    // ── 未知范围**单调**：追加别的失败记录不许缩小已有的阻止范围 ──────────────
    // 上一版在这儿断言「存档之后只挡新线程、旧线程恢复 update」，那正是第 3 轮审查实测的
    // 漏洞：读不懂的那份装着谁谁都不知道，新记录替它作不了证。旧文件照旧要存档（不丢证据），
    // 但**状态仍然是 unreadable**，只有人删掉整份文件才算消解。
    const written = writeUnresolvedRepair({
      at: new Date().toISOString(), threads: ["t-other"], files: [], reason: "另一次失败",
    });
    assert.equal(written, file);
    const merged = readUnresolvedState();
    assert.equal(merged.kind, "unreadable", "写了一份漂亮的新记录不等于未知范围消解了");
    assert.match(merged.kind === "unreadable" ? merged.detail : "", /未知范围|不可知/);
    const record = JSON.parse(readFileSync(file, "utf8")) as {
      threads: string[]; files: string[]; reason: string;
      unknownScope?: { detail: string; archived: string | null };
    };
    assert.deepEqual(record.threads, ["t-other"], "新记录本身仍要如实写下它知道的那几条");
    assert.ok(record.unknownScope, "未知范围标记必须留在文件里 —— 它就是那份持久拒绝标志");
    const archived = record.files.find((item) => item.includes(".unreadable-"));
    assert.ok(archived && existsSync(archived), "读不懂的那份要存档下来，不能悄悄丢掉");
    assert.equal(record.unknownScope!.archived, archived, "存档位置要写进标记里，人才找得到");
    assert.match(record.reason, /读不懂/);
    const stillBlocked = await planClaudeUsageRepair();
    assert.equal(stillBlocked.sessions.every((item) => item.action.kind === "skip"), true,
      "带着未知范围时，计划层照旧一个可写动作都拿不出来");
    assert.equal(stillBlocked.snapshots.length, 0);
    assert.equal((await applyClaudeUsageRepair(stillBlocked)).committed, false);
    assert.equal(await inputOf("b1"), 300, "库一个字节没改");

    // ── 人工消解之后 ①：被点名线程这一轮**只有快照**要写，闸也得拦住 ───────────
    // 双重闸的第二面。b2 那条线程口径判不出，所以它这一轮唯一的写入动作是一张「留待建
    // 基线」的累计快照 —— 计划是在屏障出现之前算的（计划层那一侧会整条 continue 掉，拿
    // 不到这张快照），落地之前屏障才点名了它。闸只看 sessions 和 trace 的话，这张快照会
    // 落进 usage_cumulative_snapshots，下一轮续聊就按它求差（第 3 轮审查 F3 第三例）。
    rmSync(file); // 这一下代表人核对完备份、把文件删了
    const beforeBarrier = await planClaudeUsageRepair();
    assert.equal(planOf(beforeBarrier, "b2").action.kind, "skip", "它本来就判不出口径，没有 update");
    assert.ok(beforeBarrier.snapshots.some((item) => item.sourceId === "claude:t-uncertain"),
      "夹具：屏障还没出现时，计划里确实有这条线程的快照");
    writeUnresolvedRepair({
      at: new Date().toISOString(), threads: ["t-uncertain"], files: [], reason: "那条线程回滚失败过",
    });
    assert.equal(readUnresolvedState().kind, "pending", "干净起点上写出来的就是普通的 pending");
    const snapshotRefused = await applyClaudeUsageRepair(beforeBarrier);
    assert.equal(snapshotRefused.committed, false);
    assert.match(snapshotRefused.refused.join("\n"), /不许写累计快照/,
      "隔离的是整条线程，不是只有 sessions 那一行");
    assert.equal(await snapshotCount(), 0, "一张快照都没落");
    assert.equal(await inputOf("b1"), 300, "一条被挡住就整轮拒绝，别的线程也跟着不动");

    // ── 人工消解之后 ②：有效记录只挡它点名的线程 —— 屏障不许过宽 ────────────────
    rmSync(file);
    writeUnresolvedRepair({
      at: new Date().toISOString(), threads: ["t-other"], files: [], reason: "一条跟谁都不沾边的线程",
    });
    const scoped = await planClaudeUsageRepair();
    assert.equal(scoped.unresolved.kind, "pending");
    assert.equal(planOf(scoped, "b1").action.kind, "update", "别的线程不在清单里，照常修");
    const done = await applyClaudeUsageRepair(scoped);
    assert.equal(done.committed, true);
    assert.equal(await inputOf("b1"), 200);
    assert.equal(await snapshotCount(), 2, "没被挡住的两条线程各落一张基线快照（t-b 重算得出、t-uncertain 留待建）");
  }

  dbClient.close();
}
