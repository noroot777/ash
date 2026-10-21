/**
 * 「这个号此刻还是它吗」—— kill / cleanup 的进程身份判据(第 1 轮审查 F2)。
 *
 * **进程树快照与子树归属那一摊住在 `test-process-subtrees.ts`**(⑬–⑰):两边钉的是两个不同
 * 的问题(这边问号、那边问树),合起来顶破了 700 行。
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
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "ash-process-identity-"));
process.env.ASH_DB = join(root, "ash.db");
/** 把「清扫后的尾巴」压到 700ms(生产 60s),⑧ 才能在一条用例里看完整条寿命;**复核间隔**
 *  压到 300ms(生产 10 分钟),⑧ 才跨得过好几次复核 —— 老实现在那一刻无条件删文件。 */
const TRACK_MS = 700;
const RECHECK_MS = 300;
process.env.ASH_TRACK_EVIDENCE_MS = String(TRACK_MS);
process.env.ASH_TRACK_EVIDENCE_RECHECK_MS = String(RECHECK_MS);

const {
  childStillOurs, cleanupAfterRun, killByPid, killChild, pidRunStillAlive,
  openTrackFd, registerTrackFd, shareChildIdentity, markAdoptedChild,
} = await import("../src/executors/spawn.js");
const { IS_WINDOWS, isPidAlive } = await import("../src/platform.js");
const { inspectProcess } = await import("../src/proc.js");
const { processGenerationSync, stillSameGeneration } = await import("../src/process-generation.js");
const { MONITOR_UNIT_ENV, invalidateMonitorUnitScan } = await import("../src/monitor-unit-scan.js");
// ④ 两对断言按这个档位分支:macOS 的秒级启动时刻是粗档、win32 的亚秒级才是排他凭证,
// 于是同一段代码在两边**本该**给出不同结果(第 1 轮审查 N5)。
const { recordedGrade } = await import("../src/monitor-reclaim-evidence.js");
// 建库:清理责任要真的落进 `agent_cleanup_debts`,少了这一步「落库失败」会被读成
// 「这条路本来就不落库」,⑦ 的披露那一半就钉不住。
const { ensureSchema } = await import("../src/db/index.js");
await ensureSchema();
const { adoptUnitToken } = await import("../src/executors/unit-token.js");

/** 拼一个 detached.ts 那种合成句柄:字段齐全,但 exitCode 由回调补写,不是内核答案。 */
function synthetic(pid: number | undefined, fields: Partial<ChildProcess> = {}): ChildProcess {
  return { pid, exitCode: null, signalCode: null, kill: () => true, on: () => {}, ...fields } as unknown as ChildProcess;
}

const strays: ChildProcess[] = [];
/** 只拿到号的那些(别人进程组里的后代):收尾一并清掉,别把 sleep 留在机器上。 */
const strayPids: number[] = [];
/** 用例自己造的临时文件(输出文件那份证据):收尾删掉,别把垃圾留在 /tmp。 */
const tempFiles: string[] = [];
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

/**
 * 带**归属证据**的长跑进程 —— 生产路径上的进程一定有这两样之一(executors/unit-token.ts
 * 种记号,detached 把 stdout 重定向到这一次运行独有的文件),而 POSIX 的秒级启动时刻是粗档,
 * 单凭它不授权下刀。所以凡是断言「该杀掉」的用例都得照生产那样带上证据,否则测的是一条
 * 生产上不存在的退化路径。
 */
function provenSleeper(kind: "mark" | "outfile"): { child: ChildProcess; token: string | null; outPath: string | null } {
  if (kind === "mark") {
    const token = `test-unit-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      stdio: "ignore", detached: true, env: { ...process.env, [MONITOR_UNIT_ENV]: token },
    });
    child.unref();
    strays.push(child);
    invalidateMonitorUnitScan();
    return { child, token, outPath: null };
  }
  const outPath = join(tmpdir(), `ash-test-out-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  const fd = openSync(outPath, "w");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: ["ignore", fd, "ignore"], detached: true,
  });
  closeSync(fd);
  child.unref();
  strays.push(child);
  tempFiles.push(outPath);
  return { child, token: null, outPath };
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
// POSIX 专属:认后代靠继承的追踪 fd,而 openTrackFd 在 Windows 上明确返回空(那边没有零
// 依赖的反查手段)。Windows 的对应能力是「从已退出根进程保留下来的 ParentProcessId 往下
// 走」(killEscapees 的 IS_WINDOWS 分支),那条要在 Windows 真机上验,本机验不了就不假装。
if (IS_WINDOWS) {
  console.log("   ~ Windows 没有追踪 fd,跳过 ②(那边的对应路径是 ppid 树,需真机验)");
} else {
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

  // 身份对得上**而且拿得出第二份独立证据**才照杀 —— 接管回合的停止按钮靠这条。生产上
  // 两份证据各来自一处:记号(环境,跨 exec)、输出文件(stdout,这一次运行独有)。
  const marked = provenSleeper("mark");
  const markedStartedAt = inspectProcess(marked.child.pid!)?.startedAt ?? null;
  assert.ok(markedStartedAt, "这条用例要靠 ps 的启动时间");
  killByPid(marked.child.pid!, markedStartedAt, { unitToken: marked.token });
  assert.ok(await goneWithin(marked.child.pid!, 3000), "记号证明了归属:照杀(接管回合的停止按钮靠它)");

  const byFile = provenSleeper("outfile");
  const fileStartedAt = inspectProcess(byFile.child.pid!)?.startedAt ?? null;
  killByPid(byFile.child.pid!, fileStartedAt, { outPath: byFile.outPath });
  assert.ok(await goneWithin(byFile.child.pid!, 3000),
    "输出文件握在它手上 = 这个号还是这一次运行的根:照杀(记号上线前建的那些行靠这条)");

  // **两条线索都没有就一刀都不发。** 粗档的「pid + 秒级启动时刻相等」从来不是排他证明,
  // 一次秒级碰撞就够把信号发到别人身上(那是明确实测过的误杀)。这一档如实降级:不下刀,
  // 但要留下警告,不许静默 —— 静默失败只会让用户得出「按钮坏了」。
  const unproven = sleeper();
  const unprovenStartedAt = inspectProcess(unproven.pid!)?.startedAt ?? null;
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.join(" ")); };
  try {
    killByPid(unproven.pid!, unprovenStartedAt);
  } finally {
    console.warn = warn;
  }
  await wait(2400);                               // 连那一刀补刀的窗口也等过去
  // **这一档的预期取决于记下来那个读数有多精确,不取决于平台**(判据与生产同一个函数):
  //  · 粗档(POSIX 的秒级 `lstart`)—— 秒级相等从来不是排他证明 ⇒ 不下刀 + 留警告;
  //  · 排他档(win32 的 CreationDate 带毫秒)—— 那个读数自己就是凭证 ⇒ **照杀才是对的**。
  // 写成按精度分叉而不是「全平台都不许杀」:后者会把 win32 上正确的授权行为钉成缺陷,而
  // macOS 上跑过就通过,这件事一次都暴露不出来(本轮审查 N5)。
  if (unprovenStartedAt && recordedGrade(unprovenStartedAt) === "exclusive") {
    assert.ok(await goneWithin(unproven.pid!, 2000),
      "排他档:记下的读数带秒以下精度,它自己就是排他凭证 ⇒ 照杀");
  } else {
    assert.equal(isPidAlive(unproven.pid!), true, "证不出归属就一刀都不发(粗档 pid 不是排他凭证)");
    assert.ok(warnings.some((w) => w.includes(String(unproven.pid)) && w.includes("证不出就不下刀")),
      "没下刀必须留下痕迹:静默失败等于「按钮坏了」");
  }
  unproven.kill("SIGKILL");

  const gone = sleeper();
  const gonePid = gone.pid!;
  gone.kill("SIGKILL");
  await waitReaped(gone);
  killByPid(gonePid, "Thu Jan  1 00:00:00 1970"); // 号已经没了:不该抛,也不该乱打
  assert.equal(isPidAlive(gonePid), false, "号已经空了:不抛错,也不往这个号上发任何信号");
}

// ── ⑤ 组长在这一刀中途退场、组里那个忽略 TERM 的后代还在 ──────────────────────
// 这是真实现场:外层 shell 收到 SIGTERM 老老实实退了,它派生的那个忽略 SIGTERM 的东西
// (用户仓库里的 preinstall、自己管子进程的脚本都算)还留在原进程组里。补刀必须收掉它。
//
// **授权不是「号空着」,也不是「刚才探活确认过」**(两者都被实测否掉了:那个号被复用成新
// 组长、新组长又先退了的时候,它留下的组 id 同样是空号;而按 pid 键控的确认备忘会把另一次
// 明确的「这不是你的」洗回通过)。现在的授权是:**第一刀发出的那一刻根仍被证明着**,于是
// 组成员连代次一起被记下来,两秒后按那份名单逐个核代次补刀 —— 号换了主人的一刀不发。
//
// POSIX 专属:验的是 `kill(-pid)` 的进程组语义,Windows 上没有进程组(那边 killTree 是
// `taskkill /T`,按进程表的父子关系走,同一件事由它覆盖)。
if (IS_WINDOWS) {
  console.log("   ~ Windows 没有进程组,跳过 ⑤(那边同一件事由 taskkill /T 的树遍历覆盖)");
} else {
  // 组长:把 stdout 重定向到这一次运行独有的文件(生产上 detached 就是这么起的),那份
  // 文件就是它的归属证据;它自己派生一个**忽略 SIGTERM** 的后代,然后等着挨第一刀。
  const outPath = join(tmpdir(), `ash-test-grp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  const fd = openSync(outPath, "w");
  tempFiles.push(outPath);
  const leader = spawn(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const kid = spawn(process.execPath, ["-e",
      "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    require("node:fs").writeFileSync(${JSON.stringify(outPath)} + ".kid", String(kid.pid));
    process.on("SIGTERM", () => process.exit(0));   // 外层壳老实退场
    setTimeout(() => {}, 60000);
  `], { stdio: ["ignore", fd, "ignore"], detached: true });
  closeSync(fd);
  tempFiles.push(`${outPath}.kid`);
  const leaderPid = leader.pid!;
  const startedAt = inspectProcess(leaderPid)?.startedAt ?? null;
  // 等后代起来并把自己的号写出来
  for (let i = 0; i < 60 && !existsSync(`${outPath}.kid`); i += 1) await wait(50);
  const kidPid = Number(readFileSync(`${outPath}.kid`, "utf8").trim());
  assert.ok(kidPid > 1, "这条用例要拿到组里那个后代的 pid");
  strayPids.push(kidPid);
  // 前提:这一刻输出文件证明得出「这个号就是这一次运行的根」。
  assert.equal(pidRunStillAlive(leaderPid, startedAt), "alive", "前提:探活此刻认得它");
  killByPid(leaderPid, startedAt, { outPath });
  // 组长吃 TERM 立刻退场,后代忽略 TERM 活到两秒后那一刀。
  assert.ok(await goneWithin(leaderPid, 2000), "前提:组长收到 TERM 就退了");
  assert.ok(await goneWithin(kidPid, 4000),
    "第一刀那会儿记下的成员要按代次补完:组长先退场不等于这一组收干净了");
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

  // 探活档只问「它还在不在」:号 + 启动时刻对得上就够。
  const mine = provenSleeper("mark");
  const live = synthetic(mine.child.pid);
  markAdoptedChild(live, mine.child.pid!, inspectProcess(mine.child.pid!)?.startedAt ?? null);
  assert.equal(childStillOurs(live), true, "身份对得上:还是我们的进程(这一问是探活档)");
  // 但**下刀**要授权档:记号得跟着这个句柄过继过来,否则粗档 pid 不足以授权(见 kill.ts
  // 里 childStillOurs / childKillAuthorized 那两段)。生产上这一步由 adoptUnitToken 做,
  // 它的输入是库里那一列。
  adoptUnitToken(live, mine.token);
  await cleanupAfterRun(live);
  assert.ok(await goneWithin(mine.child.pid!, 3000), "身份对得上就照清(接回的那一轮也要能收干净)");

  // 同一个句柄、不给记号 ⇒ 探活档仍说「它还在」,授权档说「证不出」⇒ 一刀不发。
  // 这一条钉的是两档不许再合成一个(合了就必然在某个方向上错)。
  const unproven = sleeper();
  const bare = synthetic(unproven.pid);
  const bareStartedAt = inspectProcess(unproven.pid!)?.startedAt ?? null;
  markAdoptedChild(bare, unproven.pid!, bareStartedAt);
  assert.equal(childStillOurs(bare), true, "探活档:号没换主人,它确实还在");
  const result = await cleanupAfterRun(bare);
  await wait(2400);
  // 同一条按精度分叉的理由(见 ④ 那段):排他档上「授权档」本来就该放行。
  if (bareStartedAt && recordedGrade(bareStartedAt) === "exclusive") {
    assert.ok(await goneWithin(unproven.pid!, 2000), "排他档:授权档拿得出凭证 ⇒ 照清");
  } else {
    assert.equal(isPidAlive(unproven.pid!), true, "授权档:拿不出排他凭证就一刀不发");
    // **而且这一轮不许自称清理成功**(本轮审查 F2):进程还在、还能检测到,
    // `cleanupAfterRun` 必须如实答「还没收干净」,证据和清理责任都留着。
    assert.notEqual(result.kind, "empty", "证不出归属 ⇒ 清理结论不许是「确证清空」");
  }
  unproven.kill("SIGKILL");
}

// ── ⑧ 追踪证据的寿命:只按「还能不能取到人」判,不按时长判 ────────────────────────
// 钉两件事:
//  · codex 会话级常驻那条路 —— 一个回合一个进程,句柄的 cleanup 要等整条会话结束才跑。
//    证据按任何固定时长删,长会话里那些早退场的回合就再也捞不回后代(F2:先是 close+60s,
//    后是「注册后 24 小时」,判据都是时长);
//  · 清扫**抛错**那条路 —— 调用方还会再试一次(常驻把这个 child 留在册上),所以那一次
//    不许进删除倒计时(第 3 轮审查 F2)。
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
  // 跨过「close + 尾巴」那条老删除线,也跨过好几次复核:持有者还活着 ⇒ 一个字都不能删。
  await wait(Math.max(TRACK_MS * 2, RECHECK_MS * 4));
  assert.equal(existsSync(track.path!), true, "持有者还活着时,证据不许按时长销毁");
  await cleanupAfterRun(real);
  assert.ok(await goneWithin(holder.pid!, 3000), "迟到的清扫仍然要捞得回逃逸者");
  const deadline = Date.now() + TRACK_MS * 6;
  while (existsSync(track.path!) && Date.now() < deadline) await wait(50);
  assert.equal(existsSync(track.path!), false, "扫完了、也确认没人握着,才删:临时文件不会无限堆积");

  // 清扫中途失败:证据必须留给下一次重试(注入法是让清扫读根进程的号时抛错)。
  const track2 = openTrackFd();
  assert.ok(track2.path, "这条用例要靠第二个追踪文件");
  const broken = {
    get pid(): number { throw new Error("注入:清扫中途失败"); },
    exitCode: null, signalCode: null, kill: () => true, on: () => {},
  } as unknown as ChildProcess;
  registerTrackFd(broken, track2);
  await assert.rejects(() => cleanupAfterRun(broken), /清扫中途失败/, "清扫的错不许被吞掉");
  await wait(Math.max(TRACK_MS * 2, RECHECK_MS * 4));
  assert.equal(existsSync(track2.path!), true, "清扫失败 = 还没扫完,证据不许进删除倒计时");
}

// ── ⑨ 认过的后代丢掉追踪 fd 之后,补刀照样要落在它身上 ────────────────────────────
// 这是第 3 轮审查 F1 用生产 openResident 实测的那条缝:一个后代收到 SIGTERM 时顺手把继承
// fd 关掉,却继续在用户目录里写文件。上一版的补刀要求「此刻仍能取到证据」,于是它从 lsof
// 名单里一消失就被当成「号已换主」而放过(心跳从 17 涨到 156)。
// 现在的判据是「账上记过 + 代次仍对得上」—— 丢 fd 不等于换代。
if (IS_WINDOWS) {
  console.log("   ~ 同上(这条也要追踪 fd),跳过 ⑨");
} else {
  const track = openTrackFd();
  assert.ok(track.fd !== null && track.path, "这条用例要靠追踪文件");
  // SIGTERM 不吃,而且**就在收到 TERM 的那一刻主动放掉追踪 fd**,然后接着活。
  //
  // 从「起来 0.6 秒后定时关」改成「收到 TERM 时关」,是因为前者测的其实是另一件事:那 0.6 秒
  // 是从**它自己启动**算的,取证只要慢过这个窗口,第一次 lsof 就已经查不到它 —— 于是这条
  // 用例变成了「一个从没被认过的进程能不能被杀」(答案本该是不能),而它声称要钉的是
  // 「**认过之后**丢掉 fd 还能不能补刀」。真实案例(第 3 轮审查 F1 的那个后台服务)也正是
  // 收到 TERM 才顺手 close 的。挂在 trap 上之后这条用例不再跟取证耗时赛跑。
  const stubborn = spawn("/bin/sh", ["-c",
    "trap 'exec 3>&-' TERM; while :; do sleep 1; done"], {
    stdio: ["ignore", "ignore", "ignore", track.fd!],
    detached: true,
  });
  stubborn.unref();
  strays.push(stubborn);
  const exited = synthetic(undefined); // 没有根进程的号,只验后代那一条
  registerTrackFd(exited, track);
  await cleanupAfterRun(exited);
  assert.ok(await goneWithin(stubborn.pid!, 3000), "它自己关掉 fd 不等于换了主人,补刀必须照落");
}

// ── ⑩ 只有 pid 时:「号空着」不再等于「这一组还是我们的」 ─────────────────────────
// 老判据是无条件放行(理由:新进程不会跑进一个以空号为 id 的进程组)。漏的一步是**这个号
// 被复用成新的组长、新组长又先退了** —— 那时它留下的那一组的组 id 同样是个空号,几小时后
// 按下的停止会打在人家的组上(第 3 轮审查 F1)。
// 所以「号空着」只在我们**刚刚正面确认过它**的那一小会儿内作数。
if (IS_WINDOWS) {
  console.log("   ~ Windows 没有进程组(killByPid 走 taskkill /T),跳过 ⑩");
} else {
  // ⑩-a 从没确认过的空号:一刀都不许发,它那一组里的进程必须活着。
  const kidFile = join(root, "orphan-kid.pid");
  const leaderGone = spawn("/bin/sh", ["-c", `sleep 30 & echo $! > ${kidFile}; exit 0`], {
    stdio: "ignore", detached: true,
  });
  const leaderPid = leaderGone.pid!;
  const startedAt = inspectProcess(leaderPid)?.startedAt ?? null;
  await waitReaped(leaderGone);
  await wait(100);
  const orphanKid = Number(readFileSync(kidFile, "utf8").trim());
  assert.ok(orphanKid > 1 && isPidAlive(orphanKid), "前提:组长退场了,它的孩子还在原组里");
  strayPids.push(orphanKid);
  killByPid(leaderPid, startedAt);
  await wait(300);
  assert.equal(isPidAlive(orphanKid), true, "号空着、又没有刚确认过 ⇒ 这一组证不出是我们的,不许下刀");
  process.kill(orphanKid, "SIGKILL");

  // ⑩-b 正常停止那条路:**第一刀发出的那一刻根仍被证明着**,组长随后自己退了 —— 两秒后的
  // 补刀仍要落在第一刀那会儿记下的成员上(「忽略 SIGTERM 的后代还在原组里」正是补刀存在的
  // 理由)。跟 ⑤ 互补:那边的顽固后代是 node 的 SIGTERM handler,这边是 shell 的 `trap ""`。
  const stubbornKidFile = join(root, "stubborn-kid.pid");
  const leaderOut = join(root, "stubborn-leader.out");
  const leaderFd = openSync(leaderOut, "w");
  const leader = spawn("/bin/sh", [
    "-c",
    `/bin/sh -c 'trap "" TERM; sleep 30' & echo $! > ${stubbornKidFile}; sleep 0.4; exit 0`,
  ], { stdio: ["ignore", leaderFd, "ignore"], detached: true });
  closeSync(leaderFd);
  await wait(200);
  const stubbornKid = Number(readFileSync(stubbornKidFile, "utf8").trim());
  assert.ok(stubbornKid > 1 && isPidAlive(stubbornKid), "前提:组里有一个不吃 SIGTERM 的后代");
  strayPids.push(stubbornKid);
  killByPid(leader.pid!, inspectProcess(leader.pid!)?.startedAt ?? null, { outPath: leaderOut });
  assert.ok(await goneWithin(stubbornKid, 4000),
    "第一刀那会儿证明过的那一组:组长死了也要把补刀发完");
}

// ── ⑪ 代次闸本体:所有信号都从这一句过 ───────────────────────────────────────────
{
  const live = sleeper();
  const gen = processGenerationSync(live.pid!);
  assert.ok(gen, "这条用例要拿到代次戳");
  assert.equal(stillSameGeneration({ pid: live.pid!, gen: gen! }), true, "对得上 ⇒ 还是它");
  assert.equal(stillSameGeneration({ pid: live.pid!, gen: `${gen}x` }), false, "对不上 ⇒ 这个号换了主人,一刀都不发");
  // 探活同理:号上有人**不等于**还是它。老写法问的是 `kill(pid,0)`,号被别人接手之后它永远
  // 答「活着」,于是接回的那一轮再也不结束(任务卡 running、停止也没用)。
  assert.equal(
    pidRunStillAlive(live.pid!, "Thu Jan  1 00:00:00 1970"), "gone",
    "启动时刻对不上 = 当初那个已经退了,探活必须这么报(否则这一轮永不结束)",
  );
}

// ── ⑫ 启动期清掉上一个 ash 留下的追踪文件:只删「创建者已不在 + 此刻无人持有」 ────────
// 证据的寿命不再有硬期限(⑧),所以「进程整个没了、内存里的租约也没了」这条路得有人收
// (实测 tmpdir 里攒到过三千多个空文件)。这一条钉的是**不该删的两类必须活下来**,尤其是
// 「有持有者」那一类:`lsof` 回的是解析过的真实路径(macOS 上 /var → /private/var),按整条
// 路径比的话这一问永远答否,正要留着取证的那份会被当垃圾删掉。
if (IS_WINDOWS) {
  console.log("   ~ Windows 不开追踪文件,跳过 ⑫");
} else {
  const { sweepOrphanTrackFiles } = await import("../src/executors/spawn.js");
  const deadOwner = 999_999;
  assert.equal(isPidAlive(deadOwner), false, "这条用例要一个确定不存在的创建者 pid");
  const stamp = Date.now();
  // ① 创建者是我们自己(还活着)⇒ 另一个 ash 实例正用着的那类,不许碰
  const mine = join(tmpdir(), `ash-track-${process.pid}-${stamp}-selfown`);
  writeFileSync(mine, "");
  // ② 创建者已死、但还有活着的持有者 ⇒ 那一摊后代还在,证据必须留着
  const stillHeld = join(tmpdir(), `ash-track-${deadOwner}-${stamp}-held`);
  const heldFd = openSync(stillHeld, "w");
  const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
    stdio: ["ignore", "ignore", "ignore", heldFd],
    detached: true,
  });
  holder.unref();
  strays.push(holder);
  closeSync(heldFd);
  // ③ 创建者已死、也没人握着 ⇒ 真垃圾
  const orphan = join(tmpdir(), `ash-track-${deadOwner}-${stamp}-orphan`);
  writeFileSync(orphan, "");
  await wait(200);
  await sweepOrphanTrackFiles();
  assert.equal(existsSync(mine), true, "创建者还活着(可能是另一个 ash 实例)⇒ 不许删");
  assert.equal(existsSync(stillHeld), true, "还有活着的持有者 ⇒ 证据不许删");
  assert.equal(existsSync(orphan), false, "创建者已不在、又没人握着 ⇒ 该删");
  unlinkSync(mine);
  unlinkSync(stillHeld);
}

for (const child of strays) {
  try { if (child.pid) process.kill(child.pid, "SIGKILL"); } catch { /* 已经没了 */ }
}
for (const pid of strayPids) {
  try { process.kill(pid, "SIGKILL"); } catch { /* 已经没了 */ }
}
for (const path of tempFiles) {
  try { unlinkSync(path); } catch { /* 已经没了 */ }
}
console.log("process-identity regressions ok");
process.exit(0);
