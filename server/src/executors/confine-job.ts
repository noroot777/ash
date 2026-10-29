// **Windows 这一侧的内核圈定**:Job Object。判定语义与 Linux 那一份共用(见 kernel-confine.ts),
// 这里只解决「在 Windows 上怎么把那个集合做出来、还能查得回来」。
//
// ── 为什么非得有一个守圈的旁进程 ──────────────────────────────────────────────
//
// Node 这一侧没有 Job Object 的绑定,所以只有两条路:native 绑定,或者 PowerShell 侧路。
// 先按最省的那种试了一遍 —— `CreateJobObject` + `AssignProcessToJobObject` 之后把句柄全
// 关掉、让成员进程自己把这个对象撑住。**这条路实测走不通**(2026-10-22,真机
// 192.168.1.187,Windows 11 26100 / PowerShell 5.1):
//
//     assign=ok  assign_ms=2
//     list_right_after=err:open:2          ← ERROR_FILE_NOT_FOUND
//
// 成员进程还活得好好的,可那个**名字**随最后一个句柄一起从对象管理器里消失了(内核对象的
// 名字是句柄引用撑着的,成员进程撑的是对象本体、不是名字)。于是「按名字把圈打开再枚举」
// 这一步整个不成立。
//
// 换成**守圈进程**那一版,同一台机器上全程通过:
//
//     holder_pid=5416   holder_ws_mb=73.2
//     list_from_other_process=pids:19104,       list_ms=7     ← 另一个进程按名字查得到
//     list_after_grandchild=pids:19104,20712,21472,            ← 圈定之后出生的后代也在集合里
//     terminate=ok   → 三个号全部 gone
//     marker_exists=True   holder_alive=False                  ← 圈空了它自己写下凭据并退出
//     list_after_terminate=err:open:2
//
// ── 一次运行一个守圈进程:也实测走不通,所以改成**一个常驻的守所有圈** ──────────
//
// 上面那组数字是「手动把守圈进程起好了再 assign」测出来的。接到生产路径上之后,同一台真机
// 上一次性守圈进程**整个失效**:
//
//     verdict=unknown   grand_alive_after=true
//     read_after_cleanup={"kind":"absent","why":"Job Object Local\\ash-agent-… 查不到"}
//
// 原因是时序:起一个守圈进程要 PowerShell 启动 + `Add-Type` 现编译那段 C#,实测约 180 ms,
// 而 `OpenProcess` 必须赶在**根还活着**的时候 —— 一次性 agent 的回合比这短得多(诊断里的
// 根几十毫秒就退了),于是 assign 永远失败、圈从头到尾没建起来。每次运行 73 MB 换来的是一台
// 结构性失效的设备。
//
// 所以守圈进程改成**整台机器一个、常驻**(`sharedHolder`):
//
//   · 它启动时把那段 C# 编译一次,之后每次 `enroll` 只是往它的 stdin 写一行 —— assign 落在
//     毫秒级,赶得上短命的根;
//   · 73 MB 从「每次运行」变成「每台机器」;
//   · 它为每个圈各留一个句柄,所以名字活着、别的进程查得到(这是整条路的前提);
//   · assign 成功后它写下 `<凭据>.ready`,父进程**同步**等得到(见 `settleHeld`)。
//
// 还剩的窗口如实记下:**第一次** `enroll` 要等它启动(~180 ms)。那段时间里出生又立刻退出
// 的根圈不住 —— 那时这台设备照旧弃权(`absent`),不会误判成「收干净了」。
//
// ── 这边的能力只有一档:`since-enroll` ───────────────────────────────────────
//
// `AssignProcessToJobObject` 只能在 `spawn` **之后**发生(拿不到 `CREATE_SUSPENDED`),而且
// 要等守圈进程起来。所以 fork 到 assign 之间有一个窗口,窗口里出生又立刻脱离的后代不在集合
// 里 —— 于是这台设备在 Windows 上**只有「非空」算证据,「空」一律不说话**(判据见
// kernel-confine.ts 顶部)。这一档仍然值得做:那边另外两台设备(资源记号、运行专属文件)
// 是**结构性弃权**的(读不到别的进程的环境块、没有 lsof 等价物),内核圈定是那个平台上
// 唯一一台能把「还有成员活着」正面证出来的设备。
//
// 刀只有一档也是平台本来的样子:`TerminateJobObject` 没有「优雅」这一说,而 Windows 上
// 既有的第一刀本来就是 `taskkill /T /F`(见 kill.ts 的 `killChild`),所以这里把 TERM 和
// KILL 都映射到它,不新增任何破坏性。
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IS_WINDOWS, powerShell, powerShellSync } from "../platform.js";
import { processGenerationsAsync, processGenerationsSync } from "../process-generation.js";
import type { ConfineMember, ConfineRead, Confinement } from "./kernel-confine.js";

/** Job Object 的名字。`Local\` = 当前登录会话的命名空间(跨会话不可见,正是我们要的边界)。 */
const jobName = (token: string): string => `Local\\ash-agent-${token.replace(/[^A-Za-z0-9._-]/g, "_")}`;

/**
 * 「这个圈**建起来过**」的就绪文件。常驻守圈进程在 assign 成功之后写它。
 *
 * 为什么是文件而不是一句回话:父进程要能**同步**等到它 —— 读和下刀都是同步接口,而同步
 * 等一个 stdout 事件会把 node 的事件循环堵死。
 *
 * 它同时是「名字查不到」这件事的分水岭:没有它 ⇒ 圈压根没建起来(这台设备弃权);有它而
 * 名字又查不到 ⇒ 句柄那一侧出事了(集合再也查不回来),如实记成这一问没答出来。
 */
const readyPath = (name: string): string =>
  join(tmpdir(), "ash-confine", `${name.replace(/[^A-Za-z0-9._-]/g, "_")}.ready`);

export function openJobConfinement(token: string): Confinement | null {
  if (!IS_WINDOWS) return null;
  // **顺手预热守圈进程**。它第一次启动要 PowerShell 起步 + `Add-Type` 现编译那段 C#(真机
  // 实测约 180 ms),而 `enroll` 紧跟在 `spawn` 之后 —— 预热放在这里,这 180 ms 就跟 CLI
  // 自己的启动并行跑掉了。之后同一台机器上的每一次 `enroll` 只是写一行,毫秒级。
  //
  // 第一次仍有那个窗口:**比预热还短命的根**(几十毫秒就退出)赶不上,`OpenProcess` 会
  // 失败、圈建不起来 —— 那时这台设备如实弃权(`absent`),不会冒充「收干净了」。
  sharedHolder();
  return jobConfinement(jobName(token), false);
}

export function reopenJobConfinement(id: string): Confinement | null {
  if (!IS_WINDOWS || !id.startsWith("Local\\")) return null;
  return jobConfinement(id, true);
}

/**
 * **常驻守圈进程**(整台机器一个)。它不在任何圈里,所以整圈下刀不会把它自己杀掉。
 *
 * **不能 `detached`**,这是在 192.168.1.187 那台真机上实测出来的:node 在 Windows 上把
 * `detached` 翻成 `DETACHED_PROCESS`(新进程没有控制台),而 `powershell.exe` 是控制台
 * 应用 —— 它**立刻以 code=0 空退**,一个字都不输出,圈从头到尾没建起来。四种组合各起一个
 * 圈查下来:
 *
 *   detached + hide + stderr ignore(原本的写法) → 守圈 code=0,查圈 `err:open:2`
 *   detached + hide + stderr pipe                → 同上
 *   detached + 不 hide                            → 同上
 *   **不 detached** + hide                        → 守圈报到,查圈 `pids:24076,`
 *
 * 代价如实记下:attached 的守圈进程**活不过起它的那个进程**(同一台机器上实测:父进程退出
 * 1 秒后圈名就查不到了 —— 那台机器的终端会话给整条进程树套了 job)。所以 Windows 上这台
 * 设备的有效范围是 **ash 自己这条命之内**(清扫发生在回合末尾,够用),跨 server 重启那一档
 * 照旧弃权 —— `reopenJobConfinement` 那条路本来就把「名字没了」记成 `absent` 而不是
 * `unqueryable`,两边正好对上。
 *
 * `unref` 是必须的:否则这个子进程会吊住 node 的事件循环,一次性脚本永远退不出来。
 */
let shared: { proc: ChildProcess; dead: boolean } | null = null;

function sharedHolder(): { proc: ChildProcess; dead: boolean } | null {
  if (shared && !shared.dead) return shared;
  shared = null;
  try {
    const proc = spawn("powershell", [
      "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(serveScript(), "utf16le").toString("base64"),
    ], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    // **监听先挂,再判号**。PATH 里没有 `powershell` 时 `spawn` 不抛:它返回一个没有 pid 的
    // 句柄,然后在下一个 tick 发 `error`(ENOENT)。上一版在那之前就 `return null` 了,
    // 于是那个事件没有监听器 —— node 把它升级成未捕获异常,**整个 server 当场退出**,而
    // 这台设备本该做的只是弃权。实测触发点:把平台伪造成 win32 的回归在 macOS 上跑生产路径。
    const box = { proc, dead: false };
    proc.once("exit", () => { box.dead = true; });
    proc.once("error", () => { box.dead = true; });
    if (!proc.pid) { box.dead = true; return null; }
    proc.stdin?.on("error", () => { box.dead = true; });
    proc.stdout?.on("data", () => { /* 读空管道而已:真正的就绪信号在盘上(见 readyPath) */ });
    proc.unref();
    (proc.stdout as unknown as { unref?: () => void })?.unref?.();
    (proc.stdin as unknown as { unref?: () => void })?.unref?.();
    shared = box;
    sweepStaleReady();
    return box;
  } catch {
    return null;
  }
}

/**
 * 把**早就过期的**就绪信号扫掉。`dispose()` 只在判空成功那一刻发生,所以判定落在 unknown
 * 的那些运行会把自己的那一个留在盘上(几个字节,但会一直攒)。年龄门取得很宽(一天),
 * 因为一个回合再长也到不了那儿,而删早了只会让那个圈的读数退成弃权、不会误判成「收干净」。
 */
let sweptStale = false;
function sweepStaleReady(): void {
  if (sweptStale) return;
  sweptStale = true;
  try {
    const dir = join(tmpdir(), "ash-confine");
    const cutoff = Date.now() - 24 * 3600_000;
    for (const name of readdirSync(dir)) {
      const f = join(dir, name);
      try { if (statSync(f).mtimeMs < cutoff) rmSync(f, { force: true }); } catch { /* 正被人用着 */ }
    }
  } catch { /* 目录还不存在 */ }
}

/** 常驻守圈进程是不是已经没了。没起过也算(那时候根本没请求出去过)。 */
const holderDead = (): boolean => !shared || shared.dead;

/** 往常驻守圈进程写一行请求。写不出去(它死了/起不来)返回 false —— 那就是弃权那一档。 */
function askHolder(line: string): boolean {
  const box = sharedHolder();
  if (!box || box.dead) return false;
  try {
    box.proc.stdin?.write(`${line}\n`);
    return true;
  } catch {
    box.dead = true;
    return false;
  }
}

/** 同步等待(毫秒)。读/下刀那一刻才用得到,所以堵住事件循环这点代价只落在收尾路径上。 */
const sleepSync = (ms: number): void => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 等不了就不等 */ }
};

/**
 * 起圈是异步的(PowerShell 启动 + `Add-Type` 编译 C# 实测 ~180ms),而一个回合可能比这更
 * 短。**所以读和下刀之前先等一下那个就绪文件**:等不到就照常往下走(弃权那一档),等到了
 * 就把 `held` 认下来。等待只发生在收尾路径上,不占交互延迟;上限很短,免得把一次清扫拖长。
 */
const HELD_WAIT_MS = 2_500;

function jobConfinement(name: string, reopened: boolean): Confinement {
  const ready = readyPath(name);
  /** 这个圈建起来过:就绪文件在,或者本进程刚看到它出现。 */
  let held = false;
  let asked = false;
  /** 已经请求圈住的那个号。**同一个号再 enroll 一次是空操作**(接口说的幂等就是这个)。 */
  let heldPid: number | null = null;
  /** 这一轮已经等过一次了。**等第二次毫无意义**:守圈进程要么起来了、要么已经死了。 */
  let settledOnce = false;
  /** 整圈的刀已经下成了。Windows 只有一档刀,所以这件事一旦成立就不必再下第二次。 */
  let terminated = false;
  /**
   * 把「圈到底建起来没有」问实:只在**本进程请求过**、而就绪信号还没出现时才等。
   *
   * **整轮至多等一次**(第 1 轮审查 F4):收尾那条路上 `read()` 和 `killAll()` 都会先叫它,
   * 以前各自能烧掉一个 `HELD_WAIT_MS` —— 守圈进程真的死了的时候,一次清理白等 5 秒。
   * 等不出来就是等不出来,第二次等只是把同一个结论再付一遍钱。
   */
  const settleHeld = (): void => {
    if (held || reopened || !asked || settledOnce) return;
    settledOnce = true;
    for (let waited = 0; waited < HELD_WAIT_MS; waited += 50) {
      if (existsSync(ready)) { held = true; return; }
      if (holderDead()) return;                     // 守圈的那个进程没了,再等也等不出来
      sleepSync(50);
    }
  };
  /** 同上,等的时候不占事件循环。跟同步版共用「整轮至多等一次」那个标记。 */
  const settleHeldAsync = async (): Promise<void> => {
    if (held || reopened || !asked || settledOnce) return;
    settledOnce = true;
    for (let waited = 0; waited < HELD_WAIT_MS; waited += 50) {
      if (existsSync(ready)) { held = true; return; }
      if (holderDead()) return;
      await new Promise((r) => { setTimeout(r, 50); });   // 不 unref:见 ash-mcp-probe.ts 的 wait
    }
  };
  /**
   * 读数里「不是成员名单」的那几种答案怎么解释 —— 同步/异步两版共用一份,口径漂不了。
   */
  const notMembers = (line: string): ConfineRead => {
    // ERROR_FILE_NOT_FOUND:名字不在了。名字是句柄撑着的,所以这件事只有两种解释。
    if (/^err:open:2$/.test(line)) {
      // ① 建起来过、现在名字没了 ⇒ 句柄那一侧出了事(守圈进程被杀 / 已经 drop 过),
      //    圈里还有没有成员**再也查不回来** ⇒ 如实记成这一问没答出来(可重试)。
      if (held) {
        return { kind: "unqueryable", why: `Job Object ${name} 的句柄已经不在了,集合查不回来` };
      }
      // ② 压根没建起来(请求没发出去 / 还没来得及 / 这是重新打开的圈)⇒ 这台设备弃权。
      //    刻意**不**记成 `unqueryable`:那是一句「再问多少次都一样」的话,记成「这一次
      //    没答出来」会让那一行永远停在可重试状态上,每一轮清扫都重跑同样的查询、永远
      //    销不掉(弃权与重试的处置相反,见 cleanup-result.ts 顶部那四档)。
      return { kind: "absent", why: `Job Object ${name} 查不到(圈没建起来,或者句柄已经交还)` };
    }
    if (!line) return { kind: "unqueryable", why: "这台机器上 PowerShell 没答出来" };
    return { kind: "unqueryable", why: `Job Object ${name} 这一刻读不出成员:${line}` };
  };
  return {
    id: name,
    enroll(pid: number): boolean {
      // 重新打开的圈不再请求 hold:那个圈的句柄在别处(或者已经没了),这里再 hold 一次只会
      // 撞上 `err:dup`,而 assign 的根本来就已经在圈里了。
      if (reopened || !Number.isInteger(pid) || pid <= 1) return false;
      // **幂等要名副其实**:同一个号第二次进来答 true(它已经在圈里了),只有换了个号才是
      // 「这台设备圈不住它」—— 一个 Job 在这条路上只认一个根,它的后代靠继承进集合
      // (接口注释写着幂等,而上一版第二次一律答 false,第 2 轮审查指出口径不一致)。
      if (asked) return pid === heldPid;
      try {
        mkdirSync(join(tmpdir(), "ash-confine"), { recursive: true });
        rmSync(ready, { force: true });             // 上一次运行留下的同名就绪信号不许认下来
      } catch { /* 目录建不出来:退化成「建没建起来分不清」,仍然不误判 */ }
      if (!askHolder(["hold", name, String(pid), readyBase(name)].join("\t"))) return false;
      asked = true;
      heldPid = pid;
      return true;
    },
    /**
     * Windows 上**没有** `exec` 前圈定这条路:`AssignProcessToJobObject` 只能在 spawn 之后
     * 发生(拿不到 `CREATE_SUSPENDED`)。所以这台设备在那边恒是 `since-enroll` —— 弃权这
     * 一档如实留着,不许让它冒充 `whole-run`(那会把一个有窗口的集合当成确定集合)。
     */
    preExecEnv(): null {
      return null;
    },
    read(): ConfineRead {
      settleHeld();
      const line = lastLine(powerShellSync(jobScript(name, "list"), 15_000));
      if (line.startsWith("pids:")) {
        return { kind: "members", members: parseMembers(line.slice(5)), coverage: "since-enroll" };
      }
      return notMembers(line);
    },
    async readAsync(): Promise<ConfineRead> {
      await settleHeldAsync();
      const line = lastLine(await powerShell(jobScript(name, "list"), 15_000));
      if (line.startsWith("pids:")) {
        return { kind: "members", members: await parseMembersAsync(line.slice(5)), coverage: "since-enroll" };
      }
      return notMembers(line);
    },
    killAll(): number {
      // **这一刀成功过就不再下**(第 1 轮审查 F4)。Windows 上只有一档刀:`sig` 根本没用上,
      // 收尾那条路的 TERM 和补刀的 KILL 下的是同一刀 —— 而 `TerminateJobObject` 带走的是
      // 整个 Job,第二次调用除了再起一次 PowerShell(几百毫秒)什么都不会发生。
      if (terminated) return 0;
      // **先把圈等出来再下刀**:名字还不存在时 `TerminateJobObject` 连句柄都开不到,这一刀
      // 会静默打空(真机实测过:一次性 agent 的回合比起圈还短,孙进程就这么活下来了)。
      settleHeld();
      const out = powerShellSync(jobScript(name, "terminate"), 15_000).trim();
      if (!/(^|\n)ok\s*$/.test(out)) return -1;    // 没成就不记账:下一刀还得真下
      terminated = true;
      return 1;
    },
    async killAllAsync(): Promise<number> {
      if (terminated) return 0;                     // 口径同 killAll
      await settleHeldAsync();
      const out = (await powerShell(jobScript(name, "terminate"), 15_000)).trim();
      if (!/(^|\n)ok\s*$/.test(out)) return -1;
      terminated = true;
      return 1;
    },
    dispose(): void {
      // 判空成功之后才会走到这里(见 kill.ts)。把句柄交还给守圈进程 —— 不交还的话这台
      // 机器上每跑一次就多攒一个句柄,名字也一直占着。
      if (asked) askHolder(["drop", name].join("\t"));
      try { rmSync(ready, { force: true }); } catch { /* 下次 enroll 还会清一遍 */ }
    },
  };
}

/** PowerShell 输出的最后一个非空行 —— C# 那一侧每个动作只答一行。 */
const lastLine = (out: string): string =>
  out.trim().split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";

/** 交给守圈进程的凭据前缀(它自己拼 `.ready`)—— 跟 `readyPath` 必须一致。 */
const readyBase = (name: string): string => readyPath(name).replace(/\.ready$/, "");

/**
 * **代次一次问完,不逐个问**(第 1、2 轮审查 F4 / F1 的合并修法)。
 *
 * 代次在 Windows 上每个号要起一次进程表查询(`Get-CimInstance`,百毫秒量级)。上一版逐个
 * 问、只给前 8 个成员取,于是一次收尾最多白付 8 次冷启动;第 1 轮审查把它砍成「一律不取」,
 * 代价是**成员从此没有身份**:整圈下过刀之后,只要那个号被内核分配给了别的程序,账上那一笔
 * 就按「号上有进程在跑」永远核销不掉 —— 一个无关进程被报成「本次运行的残留」(第 2 轮审查
 * F1)。现在走 `processGenerationsSync`:**一次读数**给出全部成员的代次,两头都成立。
 *
 * 代次在这条路上是**身份**而不是下刀凭证:`TerminateJobObject` 是整圈一次,内核自己按成员
 * 关系下刀,不按号发信号,所以没有「读到号 → 发信号」之间那条缝要靠代次去堵。它的用处只有
 * 一个 —— 让「这个号后来换了主人」成为一条**退出证据**(cleanup-result.ts 的 `provenGone`)。
 */
function parseMembers(raw: string): ConfineMember[] {
  const members: ConfineMember[] = [];
  const pids = memberPids(raw);
  if (!pids.length) return members;
  const gens = processGenerationsSync(pids);
  // 取不到代次的照旧记 `null`(进程刚退掉、或者这一刻问不出来):那一档只能等那个号彻底
  // 空掉才核销,是**更保守**的一侧,不会把一笔责任提前销掉。
  for (const pid of pids) members.push({ pid, gen: gens.get(pid) ?? null });
  return members;
}

/** `parseMembers` 的异步版:代次那一问不再同步起 PowerShell。 */
async function parseMembersAsync(raw: string): Promise<ConfineMember[]> {
  const pids = memberPids(raw);
  if (!pids.length) return [];
  const gens = await processGenerationsAsync(pids);
  return pids.map((pid) => ({ pid, gen: gens.get(pid) ?? null }));
}

/** 名单里的号(去掉 0/1 和解析不了的)。 */
function memberPids(raw: string): number[] {
  const pids: number[] = [];
  for (const part of raw.split(",")) {
    const pid = Number(part.trim());
    if (Number.isInteger(pid) && pid > 1) pids.push(pid);
  }
  return pids;
}

/** PowerShell 单引号字面量的转义(同 scripts/win-remote/ps.mjs 的 psq)。 */
const psq = (s: string): string => `'${s.replace(/'/g, "''")}'`;

const addType = `Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString(`
  + `[Convert]::FromBase64String(${psq(Buffer.from(jobCsharp(), "utf8").toString("base64"))})))`;

/** 查/杀这两个一次性动作。走 `-EncodedCommand`,所以命令里不存在引号转义问题。 */
function jobScript(name: string, op: "list" | "terminate"): string {
  return [
    "$ErrorActionPreference='Stop'",
    addType,
    op === "list" ? `[AshJob]::List(${psq(name)})` : `[AshJob]::Terminate(${psq(name)})`,
  ].join("\n");
}

/** 常驻守圈进程跑的那段:编译一次 C#,然后进 `Serve()` 的读行循环。 */
function serveScript(): string {
  return [
    "$ErrorActionPreference='Stop'",
    addType,
    "[AshJob]::Serve()",
  ].join("\n");
}

/**
 * P/Invoke 那一层。放在 C# 里而不是 PowerShell 里有两个理由:`JOBOBJECT_BASIC_PROCESS_ID_LIST`
 * 的变长结构在 PowerShell 侧要手搓 `Marshal`,写出来比这段长得多;而且 `Add-Type` 实测只要
 * **179 ms**(真机),不值得为省这一下把结构体解析搬到脚本里。
 */
function jobCsharp(): string {
  return `
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class AshJob {
  const uint JOB_QUERY = 0x0004, JOB_TERMINATE = 0x0008;
  const uint PROC_TERMINATE = 0x0001, PROC_SET_QUOTA = 0x0100;
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern IntPtr CreateJobObjectW(IntPtr attr, string name);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, uint len, IntPtr ret);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool CloseHandle(IntPtr h);

  // JOBOBJECT_BASIC_PROCESS_ID_LIST:两个 DWORD 之后是 ULONG_PTR 的变长数组(8 字节对齐)。
  // 缓冲区不够时内核返回 ERROR_MORE_DATA(234),按倍数重试。
  static string Ids(IntPtr job) {
    for (int cap = 64; cap <= 8192; cap *= 4) {
      int size = 8 + IntPtr.Size * cap;
      IntPtr buf = Marshal.AllocHGlobal(size);
      try {
        if (!QueryInformationJobObject(job, 3, buf, (uint)size, IntPtr.Zero)) {
          int e = Marshal.GetLastWin32Error();
          if (e == 234) continue;
          return "err:query:" + e;
        }
        int count = Marshal.ReadInt32(buf, 4);
        StringBuilder sb = new StringBuilder("pids:");
        for (int i = 0; i < count; i++) sb.Append(Marshal.ReadIntPtr(buf, 8 + i * IntPtr.Size).ToInt64()).Append(",");
        return sb.ToString();
      } finally { Marshal.FreeHGlobal(buf); }
    }
    return "err:query:toomany";
  }

  // 常驻守圈。协议是**一行一条请求**,从 stdin 进、stdout 出,全是 ASCII:
  //
  //     hold <圈名> <根的号> <凭据路径>   → ok:hold / err:…   同时写下 <凭据>.ready
  //     drop <圈名>                       → ok:drop
  //     ping                              → ok:ping
  //
  // 为什么要**留着句柄**:内核对象的名字是句柄引用撑着的,句柄一关名字就从对象管理器里
  // 消失(这条是真机实测出来的,见文件头)。所以每个圈留一个句柄在这个字典里,直到 drop。
  //
  // 为什么**不在这里判空**:判空是判据那一侧的事(cleanup-result.ts),这里只负责「名字
  // 活着、集合查得到」。圈空了之后由调用方 dispose() 发 drop,句柄随之关闭。
  public static int Serve() {
    System.Collections.Generic.Dictionary<string, IntPtr> held =
      new System.Collections.Generic.Dictionary<string, IntPtr>();
    Console.Out.WriteLine("ready");
    Console.Out.Flush();
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      string[] parts = line.Split(new char[] {'\t'});
      string verb = parts[0];
      string answer = "err:verb:" + verb;
      if (verb == "ping") answer = "ok:ping";
      else if (verb == "hold" && parts.Length >= 4) answer = Hold(held, parts[1], parts[2], parts[3]);
      else if (verb == "drop" && parts.Length >= 2) answer = Drop(held, parts[1]);
      Console.Out.WriteLine(answer);
      Console.Out.Flush();
    }
    foreach (IntPtr h in held.Values) CloseHandle(h);
    return 0;
  }

  static string Hold(System.Collections.Generic.Dictionary<string, IntPtr> held,
                     string name, string pidText, string markerPath) {
    int pid;
    if (!int.TryParse(pidText, out pid)) return "err:pid:" + pidText;
    if (held.ContainsKey(name)) return "err:dup:" + name;
    IntPtr job = CreateJobObjectW(IntPtr.Zero, name);
    if (job == IntPtr.Zero) return "err:create:" + Marshal.GetLastWin32Error();
    IntPtr proc = OpenProcess(PROC_SET_QUOTA | PROC_TERMINATE, false, (uint)pid);
    if (proc == IntPtr.Zero) { int e1 = Marshal.GetLastWin32Error(); CloseHandle(job); return "err:openproc:" + e1; }
    bool ok = AssignProcessToJobObject(job, proc);
    int e2 = Marshal.GetLastWin32Error();
    CloseHandle(proc);
    if (!ok) { CloseHandle(job); return "err:assign:" + e2; }
    held[name] = job;
    // **就绪信号写在盘上**,不只写 stdout:父进程要能**同步**等到它(同步等 stdout 事件会
    // 把 node 的事件循环堵死),而下刀之前必须确认圈真的建起来了 —— 名字还不存在时
    // TerminateJobObject 连句柄都开不到,那一刀会静默打空。
    try { System.IO.File.WriteAllText(markerPath + ".ready", "held"); } catch {}
    return "ok:hold";
  }

  static string Drop(System.Collections.Generic.Dictionary<string, IntPtr> held, string name) {
    IntPtr job;
    if (!held.TryGetValue(name, out job)) return "ok:drop";
    held.Remove(name);
    CloseHandle(job);
    return "ok:drop";
  }

  public static string List(string name) {
    IntPtr job = OpenJobObjectW(JOB_QUERY, false, name);
    if (job == IntPtr.Zero) return "err:open:" + Marshal.GetLastWin32Error();
    try { return Ids(job); } finally { CloseHandle(job); }
  }

  public static string Terminate(string name) {
    IntPtr job = OpenJobObjectW(JOB_TERMINATE, false, name);
    if (job == IntPtr.Zero) return "err:open:" + Marshal.GetLastWin32Error();
    bool ok = TerminateJobObject(job, 1);
    int e = Marshal.GetLastWin32Error();
    CloseHandle(job);
    return ok ? "ok" : "err:terminate:" + e;
  }
}
`;
}

/** 回归要按同一份源码在真机上跑一遍 P/Invoke,所以把它和那两段脚本一起导出去。 */
export const jobProbeSources = { csharp: jobCsharp, script: jobScript, serve: serveScript };
