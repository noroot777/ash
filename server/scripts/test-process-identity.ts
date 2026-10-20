/**
 * 「这个号此刻还是它吗」—— kill / cleanup 的进程身份判据(第 1 轮审查 F2)。
 *
 * 要钉的那件事:**在册 ≠ 还活着,号还活着 ≠ 还是它**。根进程完全可能在收尾那几百毫秒里
 * 自己退出(落库、写 .md、算结算),号随即被系统分给用户的别的程序;此时还按「集合里有它」
 * 或者「kill(pid,0) 不抛」去发信号,打的就是无关进程。
 *
 * 判据分两种,分别对应两种证据:
 *   · 还握着 ChildProcess(自己的孩子)→ `exitCode/signalCode` 是权威答案:内核在父进程
 *     reap 之前不会把号分给别人,而 Node 正是 reap 到它时才填上这两个值;
 *   · 只有 pid(重启后接管的那一轮)→ 只能现查 `ps` 的启动时间,认领那一刻核过不算数。
 * 后代不受这条限制:继承追踪 fd 是长在文件对象上的身份证据,所以**根进程已经退出时照样要
 * 清后代**,只是不许再往那个号上发信号。
 *
 * 用真进程跑(不打模型):每个「旁观者」都代表「这个号现在已经是别人的程序」,它活下来才算
 * 判据生效。
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-process-identity-"));
process.env.ASH_DB = join(root, "ash.db");

const { childStillOurs, cleanupAfterRun, killByPid, killChild, openTrackFd, registerTrackFd } =
  await import("../src/executors/spawn.js");
const { isPidAlive } = await import("../src/platform.js");
const { inspectProcess } = await import("../src/proc.js");

const strays: ChildProcess[] = [];
/** 一个安静活着 60s 的真进程。detached = 自成进程组(killTree 打的就是组)。 */
function sleeper(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
  strays.push(child);
  return child;
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await wait(50);
  }
  return !isPidAlive(pid);
}

// ── ① 判据本体 ────────────────────────────────────────────────────────────────
{
  const live = sleeper();
  assert.equal(childStillOurs(live), true, "还没 reap 的自己的孩子:这个号一定还是它");
  assert.equal(childStillOurs({ exitCode: 0, signalCode: null } as ChildProcess), false, "已经退出的,号随时会被复用");
  assert.equal(childStillOurs({ exitCode: null, signalCode: "SIGKILL" } as ChildProcess), false, "被信号带走的同理");
  live.kill("SIGKILL");
}

// ── ② cleanupAfterRun:根进程已退出 → 后代照样清,那个号一刀不发 ────────────────
{
  const bystander = sleeper(); // 「这个号现在是别人的程序」
  const track = openTrackFd();
  assert.ok(track.fd !== null && track.path, "这条用例要靠追踪 fd 认后代");
  // 真·逃逸者:继承了追踪 fd(stdio 第 4 位),但不是 bystander 的孩子。
  const escapee = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: ["ignore", "ignore", "ignore", track.fd!],
    detached: true,
  });
  escapee.unref();
  strays.push(escapee);
  const exited = { pid: bystander.pid, exitCode: 0, signalCode: null, kill: () => {}, on: () => {} } as unknown as ChildProcess;
  registerTrackFd(exited, track);
  await cleanupAfterRun(exited);
  assert.ok(await goneWithin(escapee.pid!, 3000), "根进程退出了,它甩出去的后代仍然必须被收掉");
  assert.equal(isPidAlive(bystander.pid!), true, "根进程已退出 = 那个号可能已经是别人的,一刀都不许发");
  bystander.kill("SIGKILL");
}

// ── ③ killChild:同一判据,含 2s 后那一刀 ──────────────────────────────────────
{
  const bystander = sleeper();
  const exited = { pid: bystander.pid, exitCode: 0, signalCode: null, kill: () => {}, on: () => {} } as unknown as ChildProcess;
  killChild(exited);
  await wait(2400); // 等过延迟补刀那一枪
  assert.equal(isPidAlive(bystander.pid!), true, "stop 一个早就自己退了的回合,不该打到接手那个号的程序");
  bystander.kill("SIGKILL");
}

// ── ④ killByPid:只有 pid 时按 ps 的启动时间核身份 ───────────────────────────────
{
  const bystander = sleeper();
  killByPid(bystander.pid!, "Thu Jan  1 00:00:00 1970"); // 号活着,但换了主人
  await wait(2400);
  assert.equal(isPidAlive(bystander.pid!), true, "启动时间对不上 = 号被复用了,连 SIGTERM 都不许发");
  bystander.kill("SIGKILL");

  const mine = sleeper();
  const startedAt = inspectProcess(mine.pid!)?.startedAt ?? null;
  assert.ok(startedAt, "这条用例要靠 ps 的启动时间");
  killByPid(mine.pid!, startedAt);
  assert.ok(await goneWithin(mine.pid!, 3000), "身份对得上就照杀(接管回合的停止按钮靠它)");

  const legacy = sleeper();
  killByPid(legacy.pid!); // 不传启动时间 = 调用方自己核过(哨兵、preview-deps),保持老语义
  assert.ok(await goneWithin(legacy.pid!, 3000), "没给身份证据的调用方保持原语义,别把它们一起挡掉");
}

// ── ⑤ 组长已经死了、组里还有后代:号没人占 → 照打(「补刀不看组长死没死」)──────────
{
  const leader = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const kid = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    process.stdout.write(String(kid.pid));
    setTimeout(() => process.exit(0), 150);
  `], { stdio: ["ignore", "pipe", "ignore"], detached: true });
  let out = "";
  leader.stdout!.on("data", (chunk) => { out += String(chunk); });
  const leaderPid = leader.pid!;
  const startedAt = inspectProcess(leaderPid)?.startedAt ?? null;
  await new Promise<void>((resolve) => leader.on("exit", () => resolve()));
  const kidPid = Number(out.trim());
  assert.ok(kidPid > 1, "这条用例要拿到组里那个后代的 pid");
  if (isPidAlive(leaderPid)) {
    // 组长的号在这个窗口里被系统分给了别人(概率极低)。这时候「不发信号」才是对的,
    // 本用例的前提不成立,如实跳过而不是假装通过。
    console.log("   ~ 组长的号已被复用,跳过「组长已死仍补刀」这一条");
    process.kill(kidPid, "SIGKILL");
  } else {
    killByPid(leaderPid, startedAt);
    assert.ok(await goneWithin(kidPid, 3000), "组长先退场、后代还在组里时,那一刀必须照发(否则它永远留下)");
  }
}

for (const child of strays) {
  try { if (child.pid) process.kill(child.pid, "SIGKILL"); } catch { /* 已经没了 */ }
}
console.log("process-identity regressions ok");
process.exit(0);
