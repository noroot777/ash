// `test-ash-mcp-probe.ts` 的第 9、10、11、12 块：探测层的**结构约束**，「没启动」/门闩扫地、
// 按号下刀的身份关，以及读数与下刀走异步版那一块。
// 单拆出来只是为了让主测试文件守住 700 行上限 —— 它们仍由主测试调用、跟着
// `test:ash-mcp-probe` 一起跑，不是独立的回归。
//
// macOS 上圈定如实弃权，所以「圈建不成 → 不启动」「整圈刀 → 核销」这两条只能在真机上
// 跑。断言刻意写成**否定式**（危险形状不存在）而不是某一种写法 —— 上一轮钉
// `return gone ?? byClose` 的表达式形状，实现一换就恒红，而恒红的断言钉不住任何东西。
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { probeCli as ProbeCli } from "../src/ash-mcp-probe.js";
import { sweepStaleGates } from "../src/ash-mcp-gate.js";

export function checkProbeStructure(): void {
  const src = readFileSync(new URL("../src/ash-mcp-probe.ts", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*(?:\/\/|\/?\*)/.test(l)).join("\n");

  const fnBody = (body: string, head: string): string => {
    const at = body.indexOf(head);
    assert.ok(at >= 0, `${head} 不见了`);
    const end = body.indexOf("\n}", at);
    return body.slice(at, end > 0 ? end : undefined);
  };

  // **一台归属设备都拿不到时，一条指令都不准起。** 写成位置关系而不是某一句的形状：
  // 要的不变量是「这道闸在 spawn 之前」。
  const probeBody = fnBody(code, "export async function probeCli");
  const guardAt = probeBody.search(/if \(!confine\) return notStarted\(/);
  const spawnAt = probeBody.indexOf("spawn(launch.file");
  assert.ok(guardAt >= 0 && spawnAt > guardAt,
    "拿不到能核销的归属设备就不做这次探测 —— 不准退回直接起 CLI（第 6 轮 B1 / 第 1 轮 B1）");

  // **进程组不准再参与核销**（第 1 轮 B1）：后代一个 setsid 就出圈，原组的 ESRCH 推不出
  // 整次运行干净。组刀照留（killTree 内部那一刀在 platform.ts），但这个文件里不准再出现
  // 拿进程组**探活**的写法。
  assert.ok(!/kill\(-\s*\w+\s*,\s*0\s*\)/.test(code),
    "原组的 ESRCH 不是「整次运行已清理」的证据（第 1 轮 B1，macOS 真机实测）");
  // **追踪 fd 整台设备已经撤掉**（第 2 轮 N4/N5）。两条理由各自独立成立：
  //  · 它到不了 CLI —— 门闩那一跳是 `spawnSync(stdio: "inherit")`，只转发 0/1/2，
  //    Node 的 spawn 又把非 stdio 的 fd 都 CLOEXEC 掉（本轮实测：`lsof` 答空，而 `ps`
  //    明明看得见那个后代）。断了之后它答的正是「没人握着」—— 一个假的核销。
  //  · 就算接通也是冗余的 —— 在「圈定不完整就不启动」之下，能被 lsof 看见的后代必然
  //    已经在圈里，圈的读数本来就覆盖它。
  assert.ok(!/TrackFd|trackHolders|probeFileHolders|residueFromProbe|holdersMayExist/.test(code),
    "追踪 fd 在这条链上只会答出一个假的「空」，而且冗余 —— 不准再接回来（第 2 轮 N4/N5）");

  // **下刀的返回值不构成核销**（第 2 轮 B1）：Linux <5.14 那条降级路径枚举成员逐个
  // `killOne`，失败被咽掉照样 `sent += 1`，返回的是**尝试数** —— 跟 `cgroup.kill` 那条
  // 真原子路径返回的 1 长得一模一样，调用方分辨不出来。所以不准据它判事。
  // 同步/异步两版下刀（`killAll` / `killAllAsync`）都在这条规矩里，查整份文件而不只是
  // `settleUnit` —— 下刀已经收进了 `cutUnit` 那个小函数。
  const settleBody = fnBody(code, "async function settleUnit");
  const KILL = String.raw`(?:await\s+)?[\w.?]*killAll(?:Async)?\(`;
  assert.ok(!new RegExp(String.raw`(?:const|let|var)\s+\w+\s*=\s*${KILL}`).test(code),
    "killAll 的返回值不准存下来 —— 存下来就是打算拿它判事（第 2 轮 B1）");
  assert.ok(!new RegExp(String.raw`(?:if|while|\?\?|&&|\|\||return)\s*\(?${KILL}`).test(code),
    "killAll 的返回值不准参与判断（降级路径返回的是尝试数，第 2 轮 B1）");
  // 正面那半：下刀之后必须回到**读数**上去证。
  assert.ok(!/(?:killAll(?:Async)?|cutUnit)\([^)]*\);\s*killTree\([^)]*\);\s*discharge\(/.test(settleBody),
    "不准杀完就核销 —— 中间必须有一次读数（第 2 轮 B1）");
  assert.match(settleBody, /while \([\s\S]*?unitResidue\(unit\)[\s\S]*?\}/,
    "复核要成环地问，直到证空或者预算用完");
  // **这个文件里一次都不准按进程号下刀**（第 1、2 轮 F2）：`killTree(pid)` 在 Windows 上是
  // 异步起一个 `taskkill /PID n /T /F`，真正按这个号 `OpenProcess` 的是稍后才启动的另一个
  // 进程 —— 「我发起调用时它还没被回收」证不到那一刻，这中间号可以已经归别人。要下刀只有
  // 两条路：走圈（`cutRun` → `cutUnit`，号由内核现读），或者走 `child.kill()`（锚在 libuv
  // 握着的句柄上，不是号）。
  assert.ok(!/killTree\(/.test(code),
    "不准再按进程号起树击杀 —— 走圈或走 child 自己的句柄（第 2 轮 F2）");
  const ownKill = fnBody(code, "export function killOwnProcess");
  const knives = (body: string): number => (body.match(/\.kill\(/g) ?? []).length;
  assert.ok(knives(ownKill) > 0 && /child\.kill\(/.test(ownKill),
    "killOwnProcess 必须用 child 自己的句柄下刀（第 2 轮 F2）");
  assert.equal(knives(code), knives(ownKill),
    "下刀只许在 killOwnProcess 这一处 —— 别的位置走圈（第 2 轮 F2）");
  assert.ok(/stillOurs\(child\)/.test(ownKill),
    "下刀之前仍要确认这是我们这次运行的子进程（第 1 轮 F2）");
  // 收壳那一档也不准按号探活:号被复用之后它答的是别人的生死。
  const shellBody = fnBody(code, "async function discardShell");
  assert.ok(!/isPidRunning\(/.test(shellBody),
    "壳的死亡证明只认「已被回收」，不认按号探活（第 1 轮 F2）");
  // **钉函数体里有哪几件事，不钉它们写成什么样。** 这一轮和上一轮各被形状断言咬过一次：
  // 钉 `return gone ?? byClose`、钉 `confine.read().kind === …` 的那两条，实现一换写法就
  // 恒红，而恒红的断言钉不住任何东西。
  assert.match(code, /confirmHeld\(/, "开门之前必须确认归属，不能直接 open");
  const confirm = fnBody(code, "async function confirmHeld");
  assert.match(confirm, /enroll\(pid\)/, "确认归属要先 enroll");
  // enroll 写的是 Node stream，read() 内部 Atomics.wait 会把事件循环堵死 —— 中间不把那次
  // 写等出去，hold 请求根本发不出去（真机实测：第一次碰巧成功，之后是 absent）。
  assert.match(confirm, /await wait\(HOLD_FLUSH_MS\)/,
    "enroll 之后必须把那次异步写等出去（第 6 轮真机）");
  assert.match(confirm, /kind === "members"/,
    "enroll 答 true 只说明请求发出去了 —— 必须读到 members 才算圈真的建成");
  assert.match(code, /await settleUnit\([^)]*"timeout"\)/,
    "超时路径必须**等**收尾做完才说「问不出来」");
  assert.match(code, /void settleUnit\([^)]*"ended"\)/,
    "正常结束路径也必须收尾（根 close 不代表后代结束）");

  assert.ok(!/byClose/.test(code),
    "close 不准再当证据：后代不持管道时它来得更早，持管道时它根本不来（第 6 轮第 4 点）");
  assert.ok(!/finally\s*\{[\s\S]{0,200}?dispose\(/.test(code),
    "finally 里不准撤销身份：dispose 的契约是「调用方已经判空」，它自己不杀成员");

  // **判据层不准拿预判当分支**（新链第 2 轮第 1 条）：走 CLI 档还是文件档，只看探测自己的
  // 收场（`not-started`）。预判跟探测真实的失败面对不上 —— 一引用它，「预判说能、真起不来」
  // 那条路就又落回「问不出来 ⇒ 放行」。
  const reach = readFileSync(new URL("../src/ash-mcp-reachability.ts", import.meta.url), "utf8")
    .split("\n").filter((l) => !/^\s*(?:\/\/|\/?\*)/.test(l)).join("\n");
  assert.ok(!/confineAbstention/.test(reach),
    "判据层不准引用 confineAbstention —— 分支依据必须是这次探测的收场");
  // **只有 CLI 本人给出能解释的答案才直接下结论**（新链第 3 轮第 2 条）：没启动、问不出来、
  // 看不懂、预算用完都是 unknown，一律先过配置文件那一档；目录被截断同理。
  // 只看 CLI 那一档（`reachWith`）：配置文件那一档自己的 unknown 放行是对的，那是两档都说不出来。
  const cliTier = fnBody(reach, "async function reachWith");
  assert.match(cliTier, /state === "unknown"\) return fromFiles\(/,
    "没拿到答案的那一问要退到配置文件那一档，不是放行");
  assert.ok(!/state === "unknown"\) return ok\(/.test(cliTier), "unknown 不准直接放行");
  assert.ok(!/if \(!complete\) return ok\(/.test(cliTier), "目录被截断时不准直接放行");
}

/**
 * 第 10 块：**读数与下刀一律走异步版** —— 探测期间事件循环不准被同步 PowerShell 堵住。
 * 搬到这个文件只是为了让主测试文件守住 700 行上限，它仍由主测试调用。
 */
export async function checkAsyncUnitCalls(probeCli: typeof ProbeCli): Promise<void> {
  const stage = mkdtempSync(join(tmpdir(), "ash-mcp-async-unit-"));
  const pause = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });
  try {
  // 新链第 1 轮审查第 4 条：Windows 上 Job 的每次读数、每一刀都要起 PowerShell（实测 1~1.7
  // 秒），探测走同步版时派审请求处理期间整个 server 卡住。这里拿一台替身把那个形状摆出来：
  // 同步版**真的**同步堵 900 ms（跟 PowerShell 一样占住线程），异步版同样耗时但不占线程。
  // 探测期间挂一个 50 ms 的心跳，断言最大间隔远小于 900 —— 退回同步版这条当场就红。
  // 正常结束（读数）和超时（下刀 + 复核）两条路各走一遍。不分平台：验的是探测层自己的选择。
  {
    const BLOCK_MS = 900;
    const calls = { syncRead: 0, syncKill: 0, asyncRead: 0, asyncKill: 0 };
    const hog = (ms: number) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
    // **这台替身必须真的下刀**：它伪装的是「每一问都慢」，不是「不杀」。真设备
    // （cgroup.kill / TerminateJobObject）都真杀，而收尾现在**只通过执行单元下刀**
    // （本轮 F2 撤掉了按旧根号的补刀），替身不杀就没有任何东西会杀 —— 那个挂住的假 CLI
    // 会攥着输出管道活下来，这个测试进程从此退不出去（实测：整套回归卡死在这一块）。
    let slowRoot = 0;
    const cutTree = (pid: number): void => {
      if (!pid) return;
      try {
        if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
        else process.kill(-pid, "SIGKILL");
      } catch { /* 已经没了 */ }
    };
    const slowStand = (token: string) => ({
      id: token,
      enroll: (pid: number) => { slowRoot = pid; return true; },
      preExecEnv: () => null,
      read: () => { calls.syncRead++; hog(BLOCK_MS); return { kind: "members", members: [], coverage: "since-enroll" }; },
      readAsync: async () => {
        calls.asyncRead++;
        await pause(BLOCK_MS);
        return { kind: "members" as const, members: [], coverage: "since-enroll" as const };
      },
      killAll: () => { calls.syncKill++; hog(BLOCK_MS); cutTree(slowRoot); return 1; },
      killAllAsync: async () => { calls.asyncKill++; await pause(BLOCK_MS); cutTree(slowRoot); return 1; },
      dispose: () => {},
    }) as unknown as NonNullable<ReturnType<NonNullable<Parameters<typeof probeCli>[5]>>>;

    const dir = join(stage, "slow-cli");
    mkdirSync(dir, { recursive: true });
    const hang = join(dir, "hang.mjs");
    const hangPid = join(dir, "hang.pid");
    writeFileSync(hang,
      'import { writeFileSync } from "node:fs";\n'
      + `writeFileSync(${JSON.stringify(hangPid)}, String(process.pid));\n`
      + "setInterval(() => {}, 1000);\n");
    const shim = (posix: string, windows: string): void => {
      if (process.platform === "win32") writeFileSync(join(dir, "codex.cmd"), windows);
      else { const f = join(dir, "codex"); writeFileSync(f, posix); chmodSync(f, 0o755); }
    };
    const pathWas = process.env.PATH;
    process.env.PATH = `${dir}${delimiter}${pathWas ?? ""}`;
    /** 跑一次探测，返回那段时间里心跳的最大间隔。 */
    const gapDuring = async (timeoutMs: number): Promise<number> => {
      let last = Date.now();
      let worst = 0;
      const tick = setInterval(() => { const t = Date.now(); worst = Math.max(worst, t - last); last = t; }, 50);
      try {
        await probeCli("codex", ["mcp", "list", "--json"], process.env, undefined, timeoutMs, slowStand);
        await pause(BLOCK_MS * 3);                     // 正常结束那条的收尾在后台跑，等它走完
      } finally { clearInterval(tick); }
      return worst;
    };
    try {
      shim("#!/bin/sh\nprintf '[]'\n", "@echo off\r\n<nul set /p=[]\r\nexit /b 0\r\n");
      const ended = await gapDuring(8_000);
      shim(`#!/bin/sh\nexec "${process.execPath}" "${hang}"\n`,
        `@echo off\r\n"${process.execPath}" "${hang}"\r\n`);
      const timedOut = await gapDuring(1_500);
      assert.equal(calls.syncRead + calls.syncKill, 0,
        `有异步版时一次都不准走同步版（${JSON.stringify(calls)}）`);
      assert.ok(calls.asyncRead > 0 && calls.asyncKill > 0, `两条路都该走到：${JSON.stringify(calls)}`);
      assert.ok(ended < BLOCK_MS / 2 && timedOut < BLOCK_MS / 2,
        `探测期间事件循环不准被读数/下刀堵住：正常结束最大间隔 ${ended} ms、超时 ${timedOut} ms`);
    } finally {
      process.env.PATH = pathWas;
      // 兜底：替身那一刀万一没打到（Windows 的 `/T` 在父子树断掉时就打不到），测试自己收。
      if (existsSync(hangPid)) {
        const leftover = Number(readFileSync(hangPid, "utf8").trim());
        if (leftover > 1) { try { process.kill(leftover, "SIGKILL"); } catch { /* 已经没了 */ } }
      }
    }
  }
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

/**
 * **下刀只认我们自己攥着的子进程句柄**（第 1、2 轮审查 F2）。
 *
 * 结构断言钉的是「别处不准出现按号下刀」，这一条钉的是这把刀本身答得对不对：活着的下得去、
 * 真的死掉；已经退出并被回收的一刀都不发（那一刻那个号可能已经是别人的）。两个平台都跑得
 * 出来，不依赖内核圈定 —— Windows 上 `child.kill` 打的是 libuv 握着的句柄，连号都不经手。
 */
export async function checkKillIdentity(killOwnProcess: (child: ChildProcess) => boolean): Promise<void> {
  // ① 活着的:下得去刀,而且真的被收掉。
  const alive = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await new Promise<void>((r) => { alive.once("spawn", r); });
  assert.equal(killOwnProcess(alive), true, "还活着 ⇒ 下得去刀");
  await new Promise<void>((r) => { alive.once("exit", () => r()); });
  // ② 已经被回收的:一刀都不准发 —— 这个号此刻可能已经是别人的了。
  assert.equal(killOwnProcess(alive), false, "退出并被回收之后一刀都不准发（号复用，F2）");
  // ③ 压根没起来(spawn 失败)就没有号可杀。
  const nope = spawn(join(tmpdir(), `ash-no-such-binary-${Date.now()}`), [], { stdio: "ignore" });
  nope.once("error", () => {});
  assert.equal(killOwnProcess(nope), false, "压根没起来的时候不准下刀");
}

/**
 * 一条指令都没起的那几种收场，必须答「没启动」而不是「问不出来」—— 判据层只有拿到前者才会
 * 退到配置文件那一档（新链第 2 轮第 1 条）。两种都不准把目标执行起来。
 */
export async function checkNotStarted(probeCli: typeof ProbeCli): Promise<void> {
  const stage = mkdtempSync(join(tmpdir(), "ash-mcp-notstarted-"));
  try {
    const marker = join(stage, "ran");
    const args = ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`];
    // ① 一台归属设备都拿不到（不管预判怎么说）。
    const none = await probeCli("node", args, process.env, undefined, 3_000, () => null);
    assert.equal(none.kind, "not-started", `拿不到归属设备 ⇒ 没启动：${JSON.stringify(none)}`);
    assert.ok(none.kind === "not-started" && none.why.trim(), "要说得出为什么没启动");
    // ② 设备给了，但这一次圈没建成（enroll 失败）—— 预判说「能」、运行期起不来的那种形状。
    const broken = {
      id: "broken", enroll: () => false, preExecEnv: () => null,
      read: () => ({ kind: "absent", why: "没建成" }), killAll: () => 0, dispose: () => {},
    } as unknown as NonNullable<ReturnType<NonNullable<Parameters<typeof ProbeCli>[5]>>>;
    const unheld = await probeCli("node", args, process.env, undefined, 3_000, () => broken);
    assert.equal(unheld.kind, "not-started", `圈没建成 ⇒ 没启动：${JSON.stringify(unheld)}`);
    assert.ok(!existsSync(marker), "没启动的那几种收场，目标一条指令都不准执行");
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * 门闩目录的回收不能只靠那个不被等待的后台收尾（新链第 2 轮第 4 条）：启动扫地按 mtime 收掉
 * 陈旧的，刚建的不碰（可能是另一个 ash 实例正用着的）。
 */
export function checkGateSweep(): void {
  const root = mkdtempSync(join(tmpdir(), "ash-mcp-gate-sweep-"));
  try {
    const stale = join(root, "stale");
    const fresh = join(root, "fresh");
    mkdirSync(stale);
    mkdirSync(fresh);
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(stale, old, old);
    assert.equal(sweepStaleGates(Date.now(), root), 1, "只收陈旧的那一个");
    assert.ok(!existsSync(stale), "陈旧的门闩目录要被收掉");
    assert.ok(existsSync(fresh), "刚建的不准碰 —— 可能有探测正用着");
    assert.equal(sweepStaleGates(Date.now(), join(root, "missing")), 0, "根目录不存在时安静返回");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
