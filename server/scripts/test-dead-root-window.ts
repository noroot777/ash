// **「这个号现在没人占」不是归属证明** —— 第 14 轮审查 F1 的机制本身。
//
// Windows 上根退出之后 `ParentProcessId` 仍然留着,那是找回孤儿后代的唯一线索(见
// `platform.ts` 顶部)。上一版据此把「根的号空出来了」直接当成了授权:`treeRootUsable`
// 在 `childKillAuthorized` 答假之后只补问一句 `!isPidAlive(pid)`,过了就把整棵同号 ppid
// 树收进击杀名单。可**父号是个裸数字,没有代次** —— 旧号被别的父进程占用、那个父进程再
// 退出,它留下的孩子照样带着同一个父号。
//
// 审查在 192.168.1.187 的真机上实测到这一下:拿一份过期身份(`startedAt` 填 2000 年)接管
// 一个陌生父进程的号,它活着时授权正确地答假、名单是空的;**它一退出,同一份旧身份就把
// 它的孩子收进名单并真的关掉了**(`parentPid=15512`、`writerPid=3256`、`deadTargets=[3256]`、
// `writerAliveAfter=false`)。
//
// 这份脚本按同一手法钉住四件事:
//
//  ① 伪造的旧身份**两阶段都不许授权** —— 陌生父进程活着时不许,它退出之后同样不许;
//  ② 那一档不许退化成「没有后代」:认不下也否不掉 ⇒ 如实留债、这一轮不算问清楚;
//  ③ **真后代照样回收**:根活着时我们证明过它,根随后退出,孤儿后代仍然进名单
//     (审查明确要求别用「全面禁用 Windows 后代清理」掩盖问题);
//  ④ 窗口之外的那一支被证伪 —— 号被复用之后生的孩子不进名单、也不留债;代次读不出来的
//     那一支留债但不下刀。
//
// 手法:平台伪造成 win32,进程表那一问走**真实的系统工具边界** —— PATH 前置一个可执行的
// `pwsh.exe` 夹具(Windows 那一路的表就是从它取的,见 `platform.ts` 的 `runPowerShell`)。
// 进程是真的、身份判定是真的、`collectEscapees` 是本体,只有「这台机器是 Windows」和
// 「表里有哪几行」是夹具给的。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.platform === "win32") {
  console.log("   ~ 真机就是 Windows 时这份夹具没有意义(表会被真 pwsh 答掉),整份跳过");
  process.exit(0);
}

const root = mkdtempSync(join(tmpdir(), "ash-dead-root-"));
const tablePath = join(root, "process-table.tsv");
const shimDir = join(root, "bin");
process.env.ASH_DB = join(root, "ash.db");

// ── 夹具:假 pwsh ─────────────────────────────────────────────────────────────
// `powerShellExe()` 先用 `-Command exit 0` 探一次活,再用 `-EncodedCommand` 取表。
mkdirSync(shimDir, { recursive: true });
const shim = join(shimDir, "pwsh.exe");
writeFileSync(shim, `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "-EncodedCommand" ]; then cat ${JSON.stringify(tablePath)}; exit 0; fi\ndone\nexit 0\n`);
chmodSync(shim, 0o755);
process.env.PATH = `${shimDir}:${process.env.PATH ?? ""}`;

type Row = { pid: number; ppid: number | null; startedAt: string | null; command?: string };
const iso = (ms: number) => new Date(ms).toISOString();
const putTable = (rows: Row[]): void => {
  writeFileSync(tablePath, rows.map((r) =>
    [r.pid, r.ppid ?? "", r.startedAt ?? "", r.command ?? "node fixture"].join("\t")).join("\n") + "\n");
};
putTable([{ pid: process.pid, ppid: 1, startedAt: iso(Date.now() - 60_000) }]);

// 平台伪造必须排在导入之前:`IS_WINDOWS` 是模块加载时求的值。
Object.defineProperty(process, "platform", { value: "win32" });

const { markAdoptedChild, childKillAuthorized } = await import("../src/executors/child-identity.js");
const { collectEscapees } = await import("../src/executors/escapees.js");
const { isPidAlive } = await import("../src/platform.js");

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const spawned: number[] = [];

/**
 * 真的起一对「父 + 脱离出去的后代」:父进程见到约定文件就退出,后代一直写心跳。
 *
 * 进程是真的 —— `isPidAlive` / `childKillAuthorized` 都在问真内核,夹具只负责「表里有哪几行」。
 */
async function spawnPair(tag: string): Promise<Pair> {
  const pidFile = join(root, `${tag}-pid`);
  const exitFile = join(root, `${tag}-exit`);
  const beat = join(root, `${tag}-beat`);
  const writer = `const fs=require('node:fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(beat)},'.'),50)`;
  const parent = `const fs=require('node:fs');const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(writer)}],{stdio:'ignore',detached:true});c.unref();fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{if(fs.existsSync(${JSON.stringify(exitFile)}))process.exit(0)},50)`;
  const proc = spawn(process.execPath, ["-e", parent], { stdio: "ignore" });
  spawned.push(proc.pid!);
  for (let i = 0; i < 400 && !existsSync(pidFile); i += 1) await wait(25);
  assert.ok(existsSync(pidFile), `${tag}:后代没起来`);
  const writerPid = Number(readFileSync(pidFile, "utf8"));
  spawned.push(writerPid);
  return { parentPid: proc.pid!, writerPid, letParentExit: () => writeFileSync(exitFile, "go") };
}
type Pair = { parentPid: number; writerPid: number; letParentExit: () => void };

/** 等一个号真的从内核里消失(父进程自己 `process.exit(0)`)。 */
async function awaitGone(pid: number, what: string): Promise<void> {
  for (let i = 0; i < 400 && isPidAlive(pid); i += 1) await wait(25);
  assert.equal(isPidAlive(pid), false, `${what}没退`);
}

let failures = 0;
const check = (name: string, fn: () => void | Promise<void>) => (async () => {
  try { await fn(); console.log(`   ✓ ${name}`); } catch (e: any) { failures += 1; console.error(`   ✗ ${name}\n     ${e?.message}`); }
})();

try {
  // ── ① + ② 伪造的旧身份:两阶段都不授权,而且不许答「没有后代」 ─────────────
  const foreign = await spawnPair("foreign");
  const foreignBorn = Date.now() - 5_000;
  putTable([
    { pid: process.pid, ppid: 1, startedAt: iso(Date.now() - 60_000) },
    { pid: foreign.parentPid, ppid: process.pid, startedAt: iso(foreignBorn) },
    { pid: foreign.writerPid, ppid: foreign.parentPid, startedAt: iso(foreignBorn + 100) },
  ]);
  const stale = { pid: foreign.parentPid, exitCode: 0, signalCode: null, kill: () => true } as any;
  markAdoptedChild(stale, foreign.parentPid, "2000-01-01T00:00:00.000Z");

  await check("① 陌生父进程还活着:授权答假、名单为空", async () => {
    assert.equal(childKillAuthorized(stale), false, "过期身份竟然拿到了授权");
    const live = await collectEscapees(stale);
    assert.deepEqual(live.targets.map((m) => m.pid), [], "父进程活着时就收了它的孩子");
  });

  foreign.letParentExit();
  await awaitGone(foreign.parentPid, "陌生父进程");
  putTable([
    { pid: process.pid, ppid: 1, startedAt: iso(Date.now() - 60_000) },
    { pid: foreign.writerPid, ppid: foreign.parentPid, startedAt: iso(foreignBorn + 100) },
  ]);

  await check("① 号空出来之后:同一份旧身份仍然不许授权(真机实测的那一下)", async () => {
    const dead = await collectEscapees(stale);
    assert.deepEqual(dead.targets.map((m) => m.pid), [], "号空出来就把陌生进程的孩子收进了名单");
    assert.equal(isPidAlive(foreign.writerPid), true, "陌生进程的孩子被杀了");
  });

  await check("② 那一档不许长成「没有后代」:留债 + 这一轮不算问清楚", async () => {
    const dead = await collectEscapees(stale);
    assert.equal(dead.answered, false, "认不下也否不掉,却自称问清楚了");
    assert.ok(dead.open.some((o) => o.pid === foreign.writerPid), `责任清单里没有它:${JSON.stringify(dead.open)}`);
    assert.ok(dead.faults.some((f) => f.includes(String(foreign.writerPid))), `故障里没说出它:${dead.faults.join(" / ")}`);
  });

  // ── ③ + ④ 真后代:根活着时证明过,根退出之后照样回收 ───────────────────────
  const mine = await spawnPair("mine");
  const rootBorn = Date.now() - 3_000;
  const live = { pid: mine.parentPid, exitCode: null, signalCode: null, kill: () => true } as any;
  putTable([
    { pid: process.pid, ppid: 1, startedAt: iso(Date.now() - 60_000) },
    { pid: mine.parentPid, ppid: process.pid, startedAt: iso(rootBorn) },
    { pid: mine.writerPid, ppid: mine.parentPid, startedAt: iso(rootBorn + 200) },
  ]);

  await check("③ 根还活着:后代进名单(授权来自句柄本身)", async () => {
    assert.equal(childKillAuthorized(live), true, "自己 spawn 的根竟然没授权");
    const swept = await collectEscapees(live);
    assert.ok(swept.targets.some((m) => m.pid === mine.writerPid), "根活着时就没收到后代");
  });

  mine.letParentExit();
  await awaitGone(mine.parentPid, "我们的根");
  live.exitCode = 0;                                  // Node 在 reap 到它时填上这一格
  const outsider = await spawnPair("outsider");       // 号被复用之后那个陌生父进程留下的孩子
  const murkyHead = 0x7ffff0;                         // 代次读不出来的那一支的头
  putTable([
    { pid: process.pid, ppid: 1, startedAt: iso(Date.now() - 60_000) },
    { pid: mine.writerPid, ppid: mine.parentPid, startedAt: iso(rootBorn + 200) },
    { pid: outsider.writerPid, ppid: mine.parentPid, startedAt: iso(Date.now() + 60_000) },
    { pid: murkyHead, ppid: mine.parentPid, startedAt: null },
    { pid: outsider.parentPid, ppid: murkyHead, startedAt: iso(rootBorn + 300) },
  ]);

  await check("③ 根退出之后:同一个后代仍然回收(能力没被全面禁用)", async () => {
    assert.equal(childKillAuthorized(live), false, "根已经退出,句柄却还握着授权");
    const swept = await collectEscapees(live);
    assert.ok(swept.targets.some((m) => m.pid === mine.writerPid),
      `根退出后丢了真后代:${JSON.stringify(swept.targets)} / ${swept.faults.join(" / ")}`);
  });

  await check("④ 窗口之外那一支已证伪:不进名单、也不留债", async () => {
    const swept = await collectEscapees(live);
    assert.ok(!swept.targets.some((m) => m.pid === outsider.writerPid), "收了号复用之后生的陌生孩子");
    assert.ok(!swept.open.some((o) => o.pid === outsider.writerPid), "给已证伪的那一支压了债");
  });

  await check("④ 代次读不出来那一支:留债但不下刀(含它名下有代次的成员)", async () => {
    const swept = await collectEscapees(live);
    assert.ok(!swept.targets.some((m) => m.pid === outsider.parentPid), "对归属核验不了的那一支下了刀");
    assert.ok(swept.open.some((o) => o.pid === murkyHead), "核验不了的那个头没留债");
    assert.ok(swept.open.some((o) => o.pid === outsider.parentPid),
      `它名下有代次的成员没留债:${JSON.stringify(swept.open)}`);
  });
} finally {
  for (const pid of spawned) { try { if (isPidAlive(pid)) process.kill(pid, "SIGKILL"); } catch { /* 已经没了 */ } }
  await wait(100);
  rmSync(root, { recursive: true, force: true });
}

console.log(failures ? `✗ 根退场归属窗口:${failures} 项不过` : "✓ 根退场归属窗口:四项都钉住了");
process.exit(failures ? 1 : 0);
