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
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-process-identity-"));
process.env.ASH_DB = join(root, "ash.db");
/** 把「清扫后的尾巴」压到 700ms(生产 60s),⑧ 才能在一条用例里看完整条寿命;兜底那一档
 *  仍留得足够长(生产 24h),否则它会先于尾巴到期,⑧ 验的就不是同一件事了。 */
const TRACK_MS = 700;
process.env.ASH_TRACK_EVIDENCE_MS = String(TRACK_MS);
process.env.ASH_TRACK_EVIDENCE_BACKSTOP_MS = String(5 * 60_000);

const {
  childStillOurs, cleanupAfterRun, killByPid, killChild,
  openTrackFd, registerTrackFd, shareChildIdentity, markAdoptedChild,
} = await import("../src/executors/spawn.js");
const { IS_WINDOWS, isPidAlive } = await import("../src/platform.js");
const { inspectProcess } = await import("../src/proc.js");

/** 拼一个 detached.ts 那种合成句柄:字段齐全,但 exitCode 由回调补写,不是内核答案。 */
function synthetic(pid: number | undefined, fields: Partial<ChildProcess> = {}): ChildProcess {
  return { pid, exitCode: null, signalCode: null, kill: () => true, on: () => {}, ...fields } as unknown as ChildProcess;
}

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
/** 等到 Node reap 到它、退出身份落下来为止。`sleeper()` 是 unref 的,光等 'exit' 事件会把
 *  事件循环等空(定时器才撑得住它,顺带给 libuv 收 SIGCHLD 的机会)。 */
async function waitReaped(child: ChildProcess, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await wait(25);
}
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

  // startedAt 现在是**必传项**:以前缺省值是「放行」,于是忘了传的调用方静默绕过整条判据
  // (第 2 轮审查 F1)。传 null 的含义是「我没记下启动时间」,退化成存在性检查而不是免检。
  const legacy = sleeper();
  killByPid(legacy.pid!, null);
  assert.ok(await goneWithin(legacy.pid!, 3000), "传 null = 退化成存在性检查,别把这些调用方一起挡掉");
  const gone = sleeper();
  const gonePid = gone.pid!;
  gone.kill("SIGKILL");
  await waitReaped(gone);
  killByPid(gonePid, "Thu Jan  1 00:00:00 1970"); // 号已经没了:不该抛,也不该乱打
  assert.equal(isPidAlive(gonePid), false, "号已经空了,照打(组里可能还有后代)也打不到别人");
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

// ── ⑥ 合成句柄:身份来自真进程的内核状态,不看自己那两个补写字段 ──────────────────
{
  const bystander = sleeper(); // 「合成品手上那个号现在是别人的程序」
  const real = sleeper();
  const child = synthetic(bystander.pid); // exitCode 仍是 null —— detached.ts 由 onExit 回调补写
  shareChildIdentity(real, child);
  assert.equal(childStillOurs(child), true, "真进程还活着:身份有效");
  real.kill("SIGKILL");
  await waitReaped(real); // 等 Node reap 到它,signalCode 才落下来
  assert.equal(childStillOurs(child), false, "真进程已退出 → 合成品自己那两个 null 不作数");
  killChild(child);
  await wait(2400); // 等过延迟补刀那一枪
  assert.equal(isPidAlive(bystander.pid!), true, "合成句柄的 stop 也不许打到接手那个号的程序");
  bystander.kill("SIGKILL");
}

// ── ⑦ 接回句柄(只有号 + 启动时间):cleanup 这条路也要过同一判据 ───────────────────
{
  const bystander = sleeper();
  const stale = synthetic(bystander.pid);
  markAdoptedChild(stale, bystander.pid!, "Thu Jan  1 00:00:00 1970");
  assert.equal(childStillOurs(stale), false, "启动时间对不上 = 这个号换了主人");
  await cleanupAfterRun(stale); // cleanup 不经过句柄的 kill(),身份判据必须自己长在里面
  assert.equal(isPidAlive(bystander.pid!), true, "接回句柄的 cleanup 同样一刀不许发");
  bystander.kill("SIGKILL");

  const mine = sleeper();
  const live = synthetic(mine.pid);
  markAdoptedChild(live, mine.pid!, inspectProcess(mine.pid!)?.startedAt ?? null);
  assert.equal(childStillOurs(live), true, "身份对得上:还是我们的进程");
  await cleanupAfterRun(live);
  assert.ok(await goneWithin(mine.pid!, 3000), "身份对得上就照清(接回的那一轮也要能收干净)");
}

// ── ⑧ 追踪证据的寿命归清扫方,不归根进程的 close ──────────────────────────────────
// 钉的是 codex 会话级常驻:一个回合一个进程,句柄的 cleanup 要等整条会话结束才跑。证据
// 一旦按「根进程 close + 一分钟」删,长会话里那些早退场的回合就再也捞不回后代(F2)。
if (IS_WINDOWS) {
  console.log("   ~ Windows 没有追踪 fd(openTrackFd 直接返回空),跳过 ⑧");
} else {
  const track = openTrackFd();
  assert.ok(track.fd !== null && track.path, "这条用例要靠追踪文件");
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: ["ignore", "ignore", "ignore", track.fd!],
    detached: true,
  });
  holder.unref();
  strays.push(holder);
  // 根进程:起来就退,把 'close' 走完 —— 以前这一刻就是删除倒计时的起点。
  const real = spawn(process.execPath, ["-e", ""], {
    stdio: ["ignore", "ignore", "ignore", track.fd!],
    detached: true,
  });
  registerTrackFd(real, track);
  await new Promise<void>((resolve) => real.on("close", () => resolve()));
  await wait(TRACK_MS * 2); // 跨过「close + 延迟」那条老删除线
  assert.equal(existsSync(track.path!), true, "根进程 close 不是证据的死期 —— 清扫方还没来");
  await cleanupAfterRun(real);
  assert.ok(await goneWithin(holder.pid!, 3000), "迟到的清扫仍然要捞得回逃逸者");
  const deadline = Date.now() + TRACK_MS * 6;
  while (existsSync(track.path!) && Date.now() < deadline) await wait(50);
  assert.equal(existsSync(track.path!), false, "清扫方扫完之后才删:临时文件不会无限堆积");
}

// ── ⑨ 补刀前现场重新取证:号码不是身份 ───────────────────────────────────────────
if (IS_WINDOWS) {
  console.log("   ~ 同上(这条也要追踪 fd),跳过 ⑨");
} else {
  const track = openTrackFd();
  assert.ok(track.fd !== null && track.path, "这条用例要靠追踪文件");
  // 一个「SIGTERM 不吃」的后代,并且在那 2 秒等待窗口里**主动放掉追踪 fd**:到补刀那一刻
  // 它已经不是我们的证据了。它代表「这个号在这 2 秒里被系统分给了别人」—— SIGTERM 正是
  // 为了让它们退出,退出就意味着号可复用,所以不能拿 2 秒前的号码快照当身份(F1)。
  const stubborn = spawn("/bin/sh", ["-c", 'trap "" TERM; sleep 0.6; exec 3>&-; sleep 30'], {
    stdio: ["ignore", "ignore", "ignore", track.fd!],
    detached: true,
  });
  stubborn.unref();
  strays.push(stubborn);
  const exited = synthetic(undefined); // 没有根进程的号,只验后代那一条
  registerTrackFd(exited, track);
  await cleanupAfterRun(exited);
  assert.equal(isPidAlive(stubborn.pid!), true, "补刀那一刻已经取不到它 = 不是我们的号,一刀都不许发");
  process.kill(stubborn.pid!, "SIGKILL");
}

for (const child of strays) {
  try { if (child.pid) process.kill(child.pid, "SIGKILL"); } catch { /* 已经没了 */ }
}
console.log("process-identity regressions ok");
process.exit(0);
