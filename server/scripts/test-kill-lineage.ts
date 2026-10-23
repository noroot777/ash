// **从拓扑生成可击杀目标时,每一条父子边都要自己拿得出凭证** —— 第 17 轮审查 F1/F2/F3。
//
// 三条修复是同一笔改动的三个面,所以钉在同一份脚本里:
//
//  · F1 裸父号不是归属证明。上一版只给**已退场的根的第一层**设了筛子,活根整树和任何
//    深层边都是「父号相同 ⇒ 我们的后代」。真机实测:一个比真根早出生 3.32 秒的无关心跳
//    进程(12356),父号被模拟成新根号之后,生产枚举 `targets=[12356]`、下刀 `hit=[12356]`。
//  · F2 「这一轮读不到」被当成了「根退场了」,于是根其实还活着,它之后才派生的真后代落在
//    区间之外、被判成外人。真机实测:根 24388 活着时注入一次空 CreationDate,后代 21788
//    的 `ppid` 确实是 24388,最终 `targets=[] open=[] answered=true`、债表空,心跳 10→42。
//  · F3 根的存活区间只在清扫时登记,而清扫跑在根 reap **之后** —— 正常完成那条路压根建不
//    起区间。真机实测:根 11832、真实直接孩子 7848 `ppid=11832`,两次 cleanup 都答 unknown,
//    孩子还活着、心跳 14→83;额外先扫一次活根的对照组就能回收。
//
// 四节,各自覆盖不同的东西,**哪一节在哪个平台上跑得到写在它自己的开头**:
//
//  ① 纯判据(`siftLineage`):两种内核前提都显式传参,所以**任何平台都跑**,原生 Windows
//     也不例外(上一版整份 `process.platform === "win32"` 就跳过,等于那台机器零覆盖);
//  ② 根生命周期三档(`root-life.ts`):真进程 + 手搭的表,同样任何平台都跑;
//  ③ 夹具里的**生产路径**:平台伪造成 win32,进程表 / 单进程查询 / `taskkill` 全部走真实的
//     系统工具边界(PATH 前置三个可执行夹具)。`spawnForRun` → 根正常退出 → `cleanupAfterRun`,
//     **中间不预扫描** —— 上一版的回归在这里偷偷先调了一次 `collectEscapees`,于是 F3 这个
//     确定性回退测不出来。原生 Windows 上这一节没有意义(表会被真 pwsh 答掉),跳过;
//  ④ 原生 Windows 的同一条生产路径,**零注入**:真表、真 `taskkill`、真后代。只在 win32 跑。
import assert from "node:assert/strict";
import type { ProcessTableSnapshot } from "../src/process-generation.js";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NATIVE_WINDOWS = process.platform === "win32";
const home = mkdtempSync(join(tmpdir(), "ash-kill-lineage-"));
const tablePath = join(home, "process-table.tsv");
const shimDir = join(home, "bin");
process.env.ASH_DB = join(home, "ash.db");
process.env.ASH_ALLOW_REAL_AGENT = "1";

// ── 夹具:三个可执行文件 ──────────────────────────────────────────────────────
// 进程表那一问走**真实的系统工具边界**(`platform.ts` 的 `runPowerShell` / `powerShellSync`
// 都是 `-EncodedCommand`),单进程查询走同一个出口,击杀走 `taskkill`。
//
// 表里**有哪几行是夹具给的,哪一行还活着是内核答的**:shim 每次都按 `kill -0` 过滤一遍。
// 这一点很要紧 —— 不然「下过刀之后它退了没有」这一问会被一张静态表骗过去。
if (!NATIVE_WINDOWS) {
  mkdirSync(shimDir, { recursive: true });
  const pwsh = join(shimDir, "pwsh.exe");
  writeFileSync(pwsh, [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    "if (!process.argv.includes('-EncodedCommand')) process.exit(0);",
    "const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };",
    `for (const line of fs.readFileSync(${JSON.stringify(tablePath)}, 'utf8').split('\\n')) {`,
    "  if (!line.trim()) continue;",
    "  if (alive(Number(line.split('\\t')[0]))) console.log(line);",
    "}",
  ].join("\n"));
  chmodSync(pwsh, 0o755);
  // `resolveLaunch` 在 win32 上按 PATHEXT 判「这是个能起的文件」,macOS 的 `node` 没有扩展名。
  symlinkSync(process.execPath, join(shimDir, "node.exe"));
  const taskkill = join(shimDir, "taskkill");
  writeFileSync(taskkill, [
    "#!/bin/sh",
    'pid=""',
    'while [ $# -gt 0 ]; do if [ "$1" = "/PID" ]; then pid="$2"; fi; shift; done',
    '[ -n "$pid" ] && kill -9 "$pid" 2>/dev/null',
    "exit 0",
  ].join("\n"));
  chmodSync(taskkill, 0o755);
  process.env.PATH = `${shimDir}:${process.env.PATH ?? ""}`;
  process.env.PATHEXT = ".EXE";
  writeFileSync(tablePath, "");
  // 平台伪造必须排在导入之前:`IS_WINDOWS` 是模块加载时求的值。
  Object.defineProperty(process, "platform", { value: "win32" });
}

const { siftLineage } = await import("../src/executors/lineage.js");
const { observeRootLife, registerRootLife, rootStand } = await import("../src/executors/root-life.js");
const { collectEscapees, killEscapees } = await import("../src/executors/escapees.js");
const { cleanupAfterRun } = await import("../src/executors/kill.js");
const { markAdoptedChild } = await import("../src/executors/child-identity.js");
const { tableFromRows } = await import("../src/process-generation.js");
const { spawnForRun } = await import("../src/executors/detached.js");
const { isPidAlive } = await import("../src/platform.js");
const { dbClient, ensureSchema } = await import("../src/db/index.js");

// 债表要真的在:`rememberEscapees` / `dischargeOpen` 落的是结构化成员,
// 表不在的话「留债」这一问会被降级成一行警告,③ 里那几条断言就测了个空。
await ensureSchema();

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iso = (ms: number) => new Date(ms).toISOString();
const spawned: number[] = [];

let failures = 0;
const check = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
  try { await fn(); console.log(`   ✓ ${name}`); }
  catch (e: any) { failures += 1; console.error(`   ✗ ${name}\n     ${e?.message}`); }
};

type Row = { pid: number; ppid: number | null; startedAt: string | null };
const tableOf = (rows: Row[]): ProcessTableSnapshot =>
  tableFromRows({ rows: rows.map((r) => ({ ...r, command: "fixture" })), unnamed: 0 });

// ── ① 纯判据:逐边核父代 ──────────────────────────────────────────────────────
// 两种内核前提都显式传参(见 `lineage.ts` 的 ① ②),所以这一节在任何平台上都跑得到。
{
  console.log("① 逐边核父代(纯判据,两种内核前提)");
  const t0 = Date.parse("2026-03-01T10:00:00.000Z");
  const at = (offset: number) => iso(t0 + offset);
  const live = { state: "live" as const, from: t0, fromRes: 1 };
  const tree = tableOf([
    { pid: 100, ppid: 1, startedAt: at(0) },        // 根
    { pid: 101, ppid: 100, startedAt: at(100) },    // 真后代
    { pid: 102, ppid: 100, startedAt: at(-5000) },  // 比根还老 ⇒ 陈旧父号
    { pid: 103, ppid: 101, startedAt: at(-4000) },  // 深层边上的陈旧父号
    { pid: 104, ppid: 100, startedAt: null },       // 这一代核验不了
    { pid: 105, ppid: 104, startedAt: at(200) },    // 挂在它下面,代次自己读得出来
  ]);

  await check("活根整树也逐边核:比根还老的那个已证伪(F1 真机读数的形状)", () => {
    const v = siftLineage(tree, 100, live, { kernelReparents: false });
    assert.equal(v.get(101), "kin", "真后代被拒了");
    assert.equal(v.get(102), "foreign", "比根早出生 5 秒的无关进程仍被当成本次运行的后代");
  });

  await check("深层边自己也要核:一支的结论不许整支传下去", () => {
    const v = siftLineage(tree, 100, live, { kernelReparents: false });
    assert.equal(v.get(103), "foreign", "深层边上的陈旧父号混进了已认领分支");
  });

  await check("父亲那一代读不出来 ⇒ 它名下整支 murky(不授权,也不否定)", () => {
    const v = siftLineage(tree, 100, live, { kernelReparents: false });
    assert.equal(v.get(104), "murky");
    assert.equal(v.get(105), "murky", "父亲证不出来,孩子却拿到了下刀授权");
  });

  await check("内核会重父的平台:活父亲名下整支照收(POSIX 能力一点不少)", () => {
    const v = siftLineage(tree, 100, live, { kernelReparents: true });
    assert.equal(v.get(101), "kin");
    assert.equal(v.get(102), "kin", "POSIX 上陈旧父号不存在,却把成员判成了外人");
    assert.equal(v.get(103), "kin");
  });

  await check("闭区间:根确证退场之后出生的已证伪,区间之内的照收", () => {
    const closed = { state: "exited" as const, from: t0, fromRes: 1, to: t0 + 1000, toRes: 1 };
    const rows = tableOf([
      { pid: 200, ppid: 100, startedAt: at(500) },
      { pid: 201, ppid: 100, startedAt: at(5000) },
    ]);
    const v = siftLineage(rows, 100, closed, { kernelReparents: false });
    assert.equal(v.get(200), "kin");
    assert.equal(v.get(201), "foreign", "号被接手之后生的孩子仍被收进名单");
    // 重父的内核上,**根已退场**这一档同样要核:① 的前提是父亲还在这一次读数里。
    const posix = siftLineage(rows, 100, closed, { kernelReparents: true });
    assert.equal(posix.get(201), "foreign", "根已退场时 POSIX 也不该跳过时间这一问");
  });

  await check("容差来自戳自己的精度,不是一个写死的 ±2 秒", () => {
    // 秒级戳(`ps -o lstart` 那一档,文本里没有小数):1 秒的倒挂分辨不出来 ⇒ 不下结论。
    const coarse = tableOf([
      { pid: 301, ppid: 300, startedAt: "2026-03-01T10:00:09Z" },
      { pid: 302, ppid: 300, startedAt: "2026-03-01T10:00:07Z" },
    ]);
    const coarseStand = {
      state: "live" as const, from: Date.parse("2026-03-01T10:00:10Z"), fromRes: 1000,
    };
    const cv = siftLineage(coarse, 300, coarseStand, { kernelReparents: false });
    assert.equal(cv.get(301), "kin", "秒级精度下 1 秒的倒挂不该被当成反证");
    assert.equal(cv.get(302), "foreign", "秒级精度下 3 秒的倒挂没判出来");
    // 毫秒戳(Windows 的 `CreationDate` 走 `ToString('o')`):100 毫秒的倒挂就是反证。
    // 上一版写死的 ±2000ms 会把这一条放过去 —— 那正是 F1 的第三个实例。
    const fine = tableOf([{ pid: 401, ppid: 400, startedAt: "2026-03-01T10:00:10.400Z" }]);
    const fineStand = {
      state: "live" as const, from: Date.parse("2026-03-01T10:00:10.500Z"), fromRes: 1,
    };
    assert.equal(
      siftLineage(fine, 400, fineStand, { kernelReparents: false }).get(401), "foreign",
      "毫秒精度的读数被 ±2 秒的放水盖过去了",
    );
  });
}

// ── ② 根生命周期:存活已确认 / 这一轮未知 / 退出已确认 ────────────────────────
{
  console.log("② 根这一代的生命周期三档");
  /** 一个真进程 + 一个能发 `exit` 的句柄(真 ChildProcess 的最小形状)。 */
  const handleFor = (pid: number): ChildProcess => {
    const h: any = new EventEmitter();
    h.pid = pid; h.exitCode = null; h.signalCode = null; h.kill = () => true;
    return h as ChildProcess;
  };
  const sleeper = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  spawned.push(sleeper.pid!);
  const pid = sleeper.pid!;
  const born = Date.now() - 1000;

  await check("第一次读到那一代:落点是「存活已确认」,下界用表上那一行", () => {
    const child = handleFor(pid);
    registerRootLife(child, born);
    const table = tableOf([{ pid, ppid: 1, startedAt: iso(born) }]);
    observeRootLife(child, table);
    const stand = rootStand(child, table);
    assert.equal(stand.state, "live");
    assert.equal(stand.state === "live" ? stand.from : null, born);
  });

  await check("这一轮读不到那一代:**不许封上界**(F2 的机制本身)", async () => {
    const child = handleFor(pid);
    registerRootLife(child, born);
    observeRootLife(child, tableOf([{ pid, ppid: 1, startedAt: iso(born) }]));
    // 这一轮 `CreationDate` 为空 —— `tableFromRows` 合法地把它放进 unverified。
    const blind = tableOf([{ pid, ppid: 1, startedAt: null }]);
    observeRootLife(child, blind);
    assert.notEqual(rootStand(child, blind).state, "exited", "读不到被当成了「根退场了」");
    await wait(60);
    // 之后根**真的**退场:上界必须是这一刻,不是刚才那次读不到的时刻。
    const exitedAt = Date.now();
    (child as any).exitCode = 0;
    child.emit("exit", 0, null);
    const stand = rootStand(child, blind);
    assert.equal(stand.state, "exited");
    assert.ok(
      stand.state === "exited" && stand.to >= exitedAt - 5,
      `上界被那次读不到提前封死了:${JSON.stringify(stand)}(真实退场 ${exitedAt})`,
    );
  });

  await check("同源换代是正面反证 ⇒ 封上界;跨问法的不等只是比不出来 ⇒ 不封", () => {
    const changed = handleFor(pid);
    registerRootLife(changed, born);
    observeRootLife(changed, tableOf([{ pid, ppid: 1, startedAt: iso(born) }]));
    (changed as any).exitCode = 0;                 // 句柄已 reap,表上那一行换了代
    observeRootLife(changed, tableOf([{ pid, ppid: 1, startedAt: iso(born + 5000) }]));
    assert.equal(rootStand(changed, tableOf([])).state, "exited", "同源换代没被当成退出证明");

    const crossed = handleFor(pid);
    registerRootLife(crossed, born);
    observeRootLife(crossed, tableOf([{ pid, ppid: 1, startedAt: iso(born) }]));
    (crossed as any).exitCode = 0;
    // 另一种问法(Linux 的节拍戳):跟 `t:` 比不出相等,那是「问不出来」不是「换代了」。
    const jiffies: ProcessTableSnapshot = {
      kids: new Map(), gens: new Map([[pid, "j:98765"]]),
      unverified: new Set(), unnamed: 0, unlinked: new Set(),
    };
    observeRootLife(crossed, jiffies);
    assert.equal(rootStand(crossed, jiffies).state, "unknown", "跨问法的不等被当成了换代反证");
  });

  await check("接回来的根(没在创建那一刻登记过)⇒ 落点未知,一个成员都不按父号扩", () => {
    const adopted = handleFor(pid);
    (adopted as any).exitCode = 0;
    markAdoptedChild(adopted, pid, "2000-01-01T00:00:00.000Z");
    assert.equal(rootStand(adopted, tableOf([{ pid, ppid: 1, startedAt: iso(born) }])).state, "unknown");
  });
}

// ── ③ 夹具里的生产路径(原生 Windows 上跳过这一节:表会被真 pwsh 答掉) ──────────
const rows: Row[] = [];
const putTable = (): void => writeFileSync(
  tablePath,
  rows.map((r) => [r.pid, r.ppid ?? "", r.startedAt ?? "", "node fixture"].join("\t")).join("\n") + "\n",
);

type Run = { child: ChildProcess; rootPid: number; bornAt: number; beat: string; spawnWriter: () => void; letExit: () => void };

/** 真的走一遍生产入口:`spawnForRun` 起根,根见到约定文件就派生一个脱离出去的后代。 */
function startRun(tag: string): Run {
  const spawnFile = join(home, `${tag}.spawn`);
  const exitFile = join(home, `${tag}.exit`);
  const pidFile = join(home, `${tag}.pid`);
  const beat = join(home, `${tag}.beat`);
  const writer = `const fs=require('node:fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(beat)},'.'),40)`;
  const parent = `const fs=require('node:fs');let on=false;setInterval(()=>{`
    + `if(!on&&fs.existsSync(${JSON.stringify(spawnFile)})){on=true;`
    + `const k=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(writer)}],{stdio:'ignore',detached:true});`
    + `k.unref();fs.writeFileSync(${JSON.stringify(pidFile)},String(k.pid));}`
    + `if(fs.existsSync(${JSON.stringify(exitFile)}))process.exit(0);},30)`;
  const bornAt = Date.now();
  const bin = NATIVE_WINDOWS ? process.execPath : join(shimDir, "node.exe");
  const child = spawnForRun(home, bin, ["-e", parent], "", undefined, {
    out: join(home, `${tag}.out`), err: join(home, `${tag}.err`), rc: join(home, `${tag}.rc`),
  });
  child.stdout?.resume();
  child.stderr?.resume();
  assert.ok(child.pid, `${tag}:根没起来`);
  spawned.push(child.pid!);
  return {
    child, rootPid: child.pid!, bornAt, beat,
    spawnWriter: () => writeFileSync(spawnFile, "go"),
    letExit: () => writeFileSync(exitFile, "go"),
  };
}

/** 等后代起来,返回它的号(顺带登记进清场名单)。 */
async function awaitWriter(tag: string): Promise<number> {
  const pidFile = join(home, `${tag}.pid`);
  for (let i = 0; i < 400 && !existsSync(pidFile); i += 1) await wait(25);
  assert.ok(existsSync(pidFile), `${tag}:后代没起来`);
  const pid = Number(readFileSync(pidFile, "utf8"));
  spawned.push(pid);
  return pid;
}

/** 起一个光占号的真进程(当「无关进程」「核验不了的中间层」用)。 */
function sleeper(): number {
  const proc = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  spawned.push(proc.pid!);
  return proc.pid!;
}

async function awaitGone(pid: number, what: string): Promise<void> {
  for (let i = 0; i < 200 && isPidAlive(pid); i += 1) await wait(25);
  assert.equal(isPidAlive(pid), false, `${what}没退`);
}

if (!NATIVE_WINDOWS) {
  console.log("③ 夹具里的生产路径(平台伪造成 win32,系统工具走真实边界)");
  rows.push({ pid: process.pid, ppid: 1, startedAt: iso(Date.now() - 60_000) });
  putTable();

  // ── F3:正常完成,**不预扫描** ────────────────────────────────────────────
  await check("F3 生产路径:根正常退出后 cleanupAfterRun 仍收得回逃逸后代(全程不预扫描)", async () => {
    const run = startRun("normal");
    rows.push({ pid: run.rootPid, ppid: process.pid, startedAt: iso(run.bornAt) });
    putTable();
    run.spawnWriter();
    const writerPid = await awaitWriter("normal");
    rows.push({ pid: writerPid, ppid: run.rootPid, startedAt: iso(Date.now()) });
    putTable();
    const ended = once(run.child, "exit");
    run.letExit();
    await ended;
    await awaitGone(run.rootPid, "根");
    const result = await cleanupAfterRun(run.child);
    await awaitGone(writerPid, "逃逸后代");
    const settled = readFileSync(run.beat, "utf8").length;
    await wait(250);
    assert.equal(readFileSync(run.beat, "utf8").length, settled, "后代被关掉之后心跳还在长");
    assert.equal(result.kind, "empty", `清理没答空:${JSON.stringify(result)}`);
  });

  // ── F2:根活着时读不到它那一代,之后才派生的真后代仍要收得回 ────────────────
  await check("F2 一轮读不到那一代:根其实还活着,它之后派生的真后代照样收得回", async () => {
    const run = startRun("fault");
    const rootRow: Row = { pid: run.rootPid, ppid: process.pid, startedAt: iso(run.bornAt) };
    rows.push(rootRow);
    putTable();
    // 根还活着的时候来一次扫描(停止按钮走的就是 `killEscapees`),而这一轮表里根那一行的
    // `CreationDate` 是空的 —— Windows 真机上合法地会出现。
    rootRow.startedAt = null;
    putTable();
    await killEscapees(run.child, "SIGTERM");
    assert.equal(isPidAlive(run.rootPid), true, "夹具里的根不该在这一步就退场");
    rootRow.startedAt = iso(run.bornAt);
    putTable();
    // 故障之后才派生的真后代。
    run.spawnWriter();
    const writerPid = await awaitWriter("fault");
    rows.push({ pid: writerPid, ppid: run.rootPid, startedAt: iso(Date.now()) });
    putTable();
    const ended = once(run.child, "exit");
    run.letExit();
    await ended;
    await awaitGone(run.rootPid, "根");
    const swept = await collectEscapees(run.child);
    assert.ok(
      swept.targets.some((m) => m.pid === writerPid),
      `故障之后出生的真后代被判成外人:targets=${JSON.stringify(swept.targets)} open=${JSON.stringify(swept.open)}`,
    );
    const result = await cleanupAfterRun(run.child);
    await awaitGone(writerPid, "逃逸后代");
    assert.equal(result.kind, "empty", `清理没答空:${JSON.stringify(result)}`);
  });

  // ── F1:活根整树 + 深层边 ────────────────────────────────────────────────
  await check("F1 活根整树:比根早出生的无关进程不进名单、也不被关掉", async () => {
    const run = startRun("lineage");
    const stranger = sleeper();                    // 真进程,只是父号被模拟成了根号
    const kid = sleeper();                         // 真后代(出生在根之后)
    const murky = sleeper();                       // 中间层,这一代核验不了
    const below = sleeper();                       // 挂在它下面
    rows.push(
      { pid: run.rootPid, ppid: process.pid, startedAt: iso(run.bornAt) },
      { pid: stranger, ppid: run.rootPid, startedAt: iso(run.bornAt - 5_000) },
      { pid: kid, ppid: run.rootPid, startedAt: iso(run.bornAt + 50) },
      { pid: murky, ppid: run.rootPid, startedAt: null },
      { pid: below, ppid: murky, startedAt: iso(run.bornAt + 80) },
    );
    putTable();
    const swept = await killEscapees(run.child, "SIGTERM");
    await wait(400);
    assert.ok(!swept.hit.includes(stranger), `对比根早出生 5 秒的无关进程下了刀:hit=${swept.hit}`);
    assert.equal(isPidAlive(stranger), true, "无关进程被关掉了(真机上那一下的形状)");
    assert.ok(!swept.open.some((o) => o.pid === stranger), "给已证伪的那一支压了债");
    assert.ok(swept.hit.includes(kid), `真后代没收回来:hit=${swept.hit} / ${swept.faults.join(" / ")}`);
    assert.ok(!swept.hit.includes(below), "对一条核验不了的父子边下面的成员下了刀");
    assert.equal(isPidAlive(below), true, "核验不了归属的成员被关掉了");
    for (const pid of [murky, below]) {
      assert.ok(swept.open.some((o) => o.pid === pid), `${pid} 没留债:${JSON.stringify(swept.open)}`);
    }
    run.letExit();
  });
}

// ── ④ 原生 Windows:同一条生产路径,零注入 ────────────────────────────────────
if (NATIVE_WINDOWS) {
  console.log("④ 原生 Windows 生产路径(真表、真 taskkill、零注入)");
  await check("F3 原生:根正常退出后 cleanupAfterRun 收得回真后代(全程不预扫描)", async () => {
    const run = startRun("native");
    run.spawnWriter();
    const writerPid = await awaitWriter("native");
    const ended = once(run.child, "exit");
    run.letExit();
    await ended;
    await awaitGone(run.rootPid, "根");
    const result = await cleanupAfterRun(run.child);
    await awaitGone(writerPid, "逃逸后代");
    assert.equal(result.kind, "empty", `清理没答空:${JSON.stringify(result)}`);
  });
}

for (const pid of spawned) { try { if (isPidAlive(pid)) process.kill(pid, "SIGKILL"); } catch { /* 已经没了 */ } }
await wait(150);
const leaked = spawned.filter(isPidAlive);
if (leaked.length) { failures += 1; console.error(`   ✗ 清场:还有进程活着 ${leaked.join(",")}`); }
// Windows 不许删还开着的文件,库句柄不先关掉 `rmSync` 就 EBUSY,把这一趟的结论盖成红的。
await dbClient.close();
try { rmSync(home, { recursive: true, force: true }); }
catch (e) { console.error(`   · 临时目录没删干净(不影响结论):${(e as Error).message}`); }

console.log(failures ? `✗ 逐边核父代:${failures} 项不过` : "✓ 逐边核父代:四节全部钉住");
process.exit(failures ? 1 : 0);
