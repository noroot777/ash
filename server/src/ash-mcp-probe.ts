// ash MCP 预检的**探测执行层**：起一条只读 CLI 子命令，把两个输出通道原样带回来，
// 并保证**自己起的进程不会留在机器上**。
//
// 单独一层是因为这里只有一个职责：进程的生死。判据（谁算有登记、哪些目录要问）在
// `ash-mcp-reachability.ts`，那边一次预检会调这里很多遍。
//
// ── 为什么不能用 execFile 的 timeout ────────────────────────────────────────
//
// 第 3 轮审查在 Windows 真机上实测：15 秒超时到点后，预检确实返回了「问不出来」并放行，
// 但自己起的那个 node 查询进程还活着（`hungPid=6024, childStillAlive=true`），25 秒兜底
// 也没来，最后靠审查脚本 taskkill 才收回。原因是 npm 装的 CLI 是 `.cmd` 垫片，真实启动
// 形如 `cmd.exe /c codex.cmd …`——`execFile` 的 timeout 只向 **cmd.exe 这层包装**发信号，
// 底下真正干活的那个进程没人管。而这个进程不在任何任务的 RunHandle 里，停止任务也找不回
// 它，重复超时就重复累积。
//
// 所以超时自己管，而且判据是**执行单元**，不是根进程。两个平台的执行单元不是同一台设备：
//
//  · **POSIX**：`detached` 让它自成进程组。进程组在 `spawn` 那一刻由内核建立、覆盖这次
//    运行的全程，而且**不依赖组长活着** —— 根先退出，`kill(-pgid)` 照样打得到剩下的成员，
//    `kill(-pgid, 0)` 也照样答得出「还有没有人」。对「起一条只读子命令」这个场景，这就是
//    一份完整归属，不需要再叠一台设备（所以这边**不开圈**）。
//  · **Windows**：没有进程组这回事，`taskkill /T` 走的是**父子树**，根一死这棵树就断了。
//    第 4 轮审查在真机上造出了这个形状（垫片用 `start /b` 起查询后自己退出）：两轮
//    `taskkill /T /F` 都按那个已死的 PID 发，查询进程活得好好的。那边唯一的归属设备是
//    **内核圈定**（`kernel-confine.ts` 的 Job Object）—— 成员归属由内核记着，不靠父子边。
//
// ── Windows：归属必须在 CLI 跑起来**之前**就建成 ────────────────────────────
//
// 第 5 轮改成「spawn 之后紧跟 enroll」仍然漏：`AssignProcessToJobObject` 拿不到
// `CREATE_SUSPENDED`，fork 到 assign 之间那个窗口里出生又脱离父树的后代进不了集合，
// 而守圈进程**首次**启动要 ~180 ms。第 6 轮审查在真机上打中了它 —— 等来 assign 时根已经
// 没了，`OpenProcess` 失败、刚建的空 Job 被关掉，圈从头到尾没建成：
//
//     COLD_TREE parent=24796 parentAlive=false child=25704 childAlive=true
//     readyMarkersSeen=[]
//
// 那一刻补刀补不回来（要查的集合压根不存在），`enroll` 的 true 也证明不了什么（它只代表
// hold 请求写进了守圈进程的 stdin）。所以 Windows 上改成**门闩式启动**（`ash-mcp-gate.ts`）：
//
//   spawn 的是一层壳 → 壳同步等 go 文件（期间必然活着、一个后代都不生）
//   → 父进程 enroll + **读到 `members` 才算圈建成**（`read()` 内部会等守圈进程的 ready 凭据）
//   → 开门 → CLI 这才出生，它和它的后代继承这个 Job
//
// 于是 CLI 这棵树**整体**在圈内：窗口里没有能脱离的进程，`members` 的空因此构成证明
// （见 `unitResidue` 的 `gated`），`TerminateJobObject` 的成功也因此是整棵树的终止。
// **归属建不起来就不启动 CLI**，直接回「问不出来」放行 —— 宁可这一条预检不做，也不留
// 一个谁都查不回去的后台查询（第 6 轮审查原话：无法建立时直接返回未知而不启动不受控查询）。
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { IS_WINDOWS, isPidRunning, killTree } from "./platform.js";
import { resolveLaunch } from "./executors/bin-resolve.js";
import { prepareGate, type Gate } from "./ash-mcp-gate.js";
import { openConfinement, type Confinement } from "./executors/kernel-confine.js";

export interface ProbeResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 单次探测最多收这么多输出。只读子命令的正常输出远小于此，超了说明问错了东西。 */
const MAX_OUTPUT = 8 * 1024 * 1024;
/** 下刀之后给它多久咽气。预算用完还证不了空就如实上报，不再干等。 */
const REAP_GRACE_MS = 3_000;
/**
 * 进程退出之后，再给输出这么久到齐。
 *
 * **判「结束了」用 `exit`，不用 `close`** —— `close` 等的是所有管道都关闭，而垫片
 * `start /b` 起的后代会继承那两个管道、把它们一直攥着：那时进程早退出了、答案也早写完了，
 * close 却永远不来。第 6 轮真机诊断里这条形状让一次本来成功的探测（CLI rc=0、stdout 完整）
 * 白白等到超时、被当成「问不出来」。所以 exit 之后只给输出一个短窗口，不赌 close 会来。
 */
const OUTPUT_DRAIN_MS = 150;
/** 开门前收壳时，确认它真的死了的轮询上限。壳没有后代，这一步很快。 */
const SHELL_REAP_MS = 2_000;
/**
 * `enroll` 之后、问「圈建成没有」之前，先等这么久。
 *
 * **这段等待是在等一次异步写落地，不是保险起见的 sleep。** `Confinement.enroll` 在 Windows
 * 上是往常驻守圈进程的 stdin 写一行 —— Node stream 的写入真正进管道发生在事件循环的 poll
 * 阶段，而 `setTimeout(0)` 的回调在 timers 阶段，**可能还赶在那次 pending write 前面**
 * （真机实测：`wait(0)` 不够，`sleep(400)` 就成）。而紧跟其后的 `read()` 内部用
 * `Atomics.wait` 同步等就绪文件，一旦进去就把事件循环整段堵死，那一行再也发不出去。
 *
 * 基线那一侧没有「请求已送达」的回执（`enroll` 的 true 只代表 `stdin.write` 没抛），所以
 * 这边只能用时间兜，并给一次重试 —— **这一条因此是时序敏感的**，真机上 300ms 有时够有时
 * 不够（`read()` 自己又会同步起一次 PowerShell 把事件循环堵上 1~1.5 秒）。彻底解掉要给
 * `enroll` 加一个可 await 的送达回执，那是基线那一侧的改动。
 *
 * 等够一点反而更快：ready 凭据先落地的话，`read()` 内部的 `settleHeld` 当场就返回，省掉
 * 它那 2.5 秒的等待。门闩壳就在等开门，这段等待不占任何别的东西。
 */
const HOLD_FLUSH_MS = 500;

/** 赛跑用的等待：**unref** —— 这个 timer 不该把 server 的事件循环拖住不退。 */
const delay = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms).unref?.(); });
/**
 * 收尾用的等待：**不 unref**，因为收尾必须真的走完。
 *
 * 用 unref 的那个会漏：被探测的进程一被收掉，它的 handle 全部释放、事件循环当场就空了，
 * unref 的 timer 从此永不触发 —— 收尾卡在半路，连那句「收不干净」都喊不出来
 * （实测：回归跑出 `unsettled top-level await`）。
 */
const wait = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

/**
 * 这个执行单元此刻的残留读数。**`null` = 这几台设备都没给出结论**，不是「空」。
 *
 * 三档的解释**照抄既有消费者** `cleanup-result.ts` 的 `confinedResidue`：
 *  · `absent`      —— 圈压根没建起来、或者句柄已经交还 ⇒ 这台设备**不说话**。上一版把它
 *    读成「已经回收」，于是 Windows 冷启动那次泄漏连警告都没打（第 5 轮审查实测）。
 *  · `unqueryable` —— 这一刻问不到 ⇒ 不说话（留着下一轮再问）。
 *  · `members`     —— 非空就是**还有残留**（僵尸不算，跟那边同一条判据）。
 *
 * **`gated` 才是「空算不算证明」的依据，不是设备自报的 `coverage`。** 设备在 Windows 上恒
 * 报 `since-enroll`，说的是「enroll 发生在 spawn 之后」这件**时序**事实；而门闩之下被 spawn
 * 的是一层**不生后代**的壳，CLI 是在圈建成并核实之后才出生的 —— 对 CLI 这棵树来说没有任何
 * 空窗，集合是确定的，所以空构成证明。这不是放松设备的语义（它那句话对它自己仍然成立），
 * 是调用方在它之上**自己把窗口关掉了**；关不掉的时候（没门闩）就老老实实只认 `coverage`。
 */
export function unitResidue(
  pid: number,
  confine: Confinement | null,
  gated: boolean,
): "remaining" | "gone" | null {
  if (confine) {
    const read = confine.read();
    if (read.kind === "members") {
      if (read.members.some((m) => isPidRunning(m.pid))) return "remaining";
      return gated || read.coverage === "whole-run" ? "gone" : null;
    }
    return null;                                      // absent / unqueryable：都不说话
  }
  if (IS_WINDOWS) return null;                        // 没圈又没进程组：这里答不了
  try {
    process.kill(-pid, 0);
    return "remaining";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : null;
  }
}

/**
 * 收尾：把这次探测自己起的东西收干净，**每条结束路径都要走一遍**。
 *
 * 上一版只在超时分支收，正常 `close` 直接返回 —— 第 5 轮审查实测：包装把查询用
 * `detached + stdio=ignore` 起出去、自己正常退出，3.6 秒就返回了结论，查询还活着。
 * 根进程的 close 从来不代表它的后代结束了。
 *
 * 判据分三层，强的先用：
 *  ① 能当场证空就什么都不用做（POSIX 常走这条：一次 `kill(-pgid, 0)` 而已）。
 *  ② **整圈刀**：`TerminateJobObject` 是内核级的「这个集合全部终止」。门闩之下 CLI 整棵树
 *     都在集合里，所以这一刀下成了就是整棵树的终止 —— 这点很要紧，因为那边的读数要起
 *     PowerShell，能少起一次就少起一次。**没有门闩就不能这么推**（集合可能缺了空窗里
 *     跑掉的那些），那时这一刀只是「尽力」，仍要回到读数上去证。
 *  ③ 都不成：退回 `killTree` + 读数，两轮。仍然证不了空就**披露，并且不撤销身份**
 *     （`dispose` 的契约是「调用方已经判空」，它自己只交还句柄、不杀成员；成员还在时撤掉
 *     身份等于把唯一还能查回去的线索丢了）。
 *
 * **`close` 不参与任何一条路**（第 6 轮审查第 4 点）：后代不持有管道时它来得更早，持有时它
 * 根本不来。这里连「提前醒来」都只认 `exit`（进程退出），close 一次都不问。
 */
async function settleUnit(
  child: ChildProcess,
  confine: Confinement | null,
  gated: boolean,
  exited: Promise<unknown>,
  why: "timeout" | "ended",
): Promise<void> {
  const pid = child.pid;
  if (!pid) { confine?.dispose(); return; }

  // ① 正常结束 + 能当场证空。只在 POSIX 走：Windows 的读数要起一次 PowerShell，比直接
  //    下刀还贵。
  if (why === "ended" && !IS_WINDOWS && unitResidue(pid, confine, gated) === "gone") {
    confine?.dispose();
    return;
  }

  // ② 整圈刀。门闩成立时这一刀的成功就是整棵树的终止，可以直接核销。
  const cut = confine ? confine.killAll("SIGKILL") : -1;
  killTree(pid, "SIGKILL");
  if (cut >= 0 && gated) { confine?.dispose(); return; }

  // ③ 退回读数：等到预算用完为止。
  //
  // **宽限必须真的等**。上一版写的是 `race([closed, delay(宽限)])` —— 根进程早就 close 了
  // 的时候（正常退出路径一律如此）那个 race 当场就 resolve，于是「两轮宽限」其实是两次
  // 零延迟空转：刚被 SIGKILL 的后代还没被 reap，`kill(-pgid, 0)` 对僵尸照旧成功，于是
  // 明明收干净了却喊出「收不干净」。`closed` 不参与判据（它什么都证明不了），只在根还
  // 没退出时用来提前醒来一次。
  //
  // 读数的代价分平台：POSIX 一次 `kill(-pgid, 0)` 便宜，密一点收敛快；Windows 每次读要
  // 起一次同步 PowerShell，所以那边按整段宽限只读两次。
  const step = IS_WINDOWS ? REAP_GRACE_MS : 100;
  const deadline = Date.now() + REAP_GRACE_MS * 2;
  let first = true;
  while (Date.now() < deadline) {
    await (first ? Promise.race([exited, wait(step)]) : wait(step));
    first = false;
    if (unitResidue(pid, confine, gated) === "gone") { confine?.dispose(); return; }
    killTree(pid, "SIGKILL");
  }

  const left = confine?.read();
  const who = left?.kind === "members" && left.members.length
    ? `：还剩 ${left.members.map((m) => m.pid).join("、")}`
    : "";
  console.warn(
    `[ash] ash MCP 预检的探测单元（根 pid=${pid}）收不干净${who}`
    + "；这次的执行单元身份**保留**着（没有 dispose），它是唯一还能查回去的线索"
    + "（这条探测不属于任何任务，停止任务找不回它）",
  );
}

/**
 * 开门之前就得放弃这次探测时，把门闩壳收掉。
 *
 * 壳从出生到这一刻**没有 fork 过任何东西**（它的代码只有「轮询 go 文件 + 启动 CLI」，
 * go 没写就永不启动）。所以「壳已经死了」⇒ 这个圈里没有活着的成员 ⇒ 这时 `dispose`
 * 是合法的，不违反「调用方已经判空」那条契约。
 */
async function discardShell(pid: number | undefined, confine: Confinement | null): Promise<void> {
  if (pid === undefined) { confine?.dispose(); return; }
  killTree(pid, "SIGKILL");
  for (let waited = 0; waited < SHELL_REAP_MS; waited += 50) {
    if (!isPidRunning(pid)) { confine?.dispose(); return; }
    await wait(50);
  }
  // 壳自己都收不掉（极少见）：按契约不撤身份，交给上面那段警告的同一条规矩。
  console.warn(
    `[ash] ash MCP 预检的门闩壳（pid=${pid}）没收掉；这次的执行单元身份保留着`,
  );
}

/**
 * 圈到底建成没有。**唯一算数的凭据是读到 `members`**（那说明 `OpenJobObject` 查得到这个
 * 名字，也就是守圈进程真的 `CreateJobObject` + `Assign` 成功了）；`enroll` 答 true 只表示
 * hold 请求写进了它的 stdin。
 *
 * **enroll 之后必须先把那次写等出去再问**，为什么见 `HOLD_FLUSH_MS`。真机实测（第 6 轮）：
 * 不等的话一个进程里第一次碰巧成功（管道刚建，写入走同步路径），之后每一次都是 `absent`,
 * 于是 Windows 上第二次及以后的预检全都退化成「不探测、直接放行」。
 */
async function confirmHeld(confine: Confinement, pid: number): Promise<boolean> {
  if (!confine.enroll(pid)) return false;
  for (let round = 0; round < 2; round++) {
    await wait(HOLD_FLUSH_MS);
    const read = confine.read();
    if (process.env.ASH_PROBE_DIAG) {
      console.warn(`[diag] id=${confine.id} round=${round} kind=${read.kind}`
        + (read.kind === "members" ? `:${read.members.length}` : `/${read.why}`));
    }
    if (read.kind === "members") return true;
  }
  return false;
}

/**
 * 跑一条只读 CLI 子命令。返回 null = **问不出来**（起不来、超时、被杀、归属建不起来），
 * 调用方一律放行。
 *
 * 两件事是踩过的：
 *  ① **必须走 `resolveLaunch`**，不能把 `resolveBin` 的结果直接交给 spawn。
 *     `bin-resolve.ts` 的文件头写得很清楚：那个函数「只回答在不在，不回答怎么起」——
 *     Windows 上 npm 装的 CLI 是 `.cmd` 垫片，直接起它拿到的是 `EINVAL`
 *     （第 2 位审查者 F2，真机实测 `…\codex.cmd` → EINVAL → 被当成「问不出来」放行）。
 *  ② **两个输出通道分开回**。codex 成功退出、stdout 是完整 JSON，stderr 却可能同时有
 *     一句无关警告（实测：创建 PATH 别名失败）。拼在一起再 `JSON.parse` 就把一份有效
 *     答案解析成了「看不懂」（第 2 位审查者 F3）。
 */
export async function probeCli(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string | undefined,
  timeoutMs: number,
): Promise<ProbeResult | null> {
  const plan = resolveLaunch(bin, args);
  if (!plan) return null;

  // Windows：先把归属铺好。**顺序是硬的** —— 圈开不出来 / 门闩铺不出来，就一条指令都不起。
  let confine: Confinement | null = null;
  let gate: Gate | null = null;
  if (IS_WINDOWS) {
    confine = openConfinement(`ash-mcp-probe-${randomUUID()}`);
    if (!confine) return null;                       // 这台机器没有归属设备 ⇒ 不做这次探测
    gate = prepareGate(plan);
    if (!gate) { confine.dispose(); return null; }   // 临时目录都写不了，圈里还没有人
  }
  const launch = gate?.plan ?? plan;

  let child: ChildProcess;
  try {
    child = spawn(launch.file, launch.args, {
      env,
      cwd,
      windowsHide: true,
      // POSIX：自成进程组，`killTree` 的 `process.kill(-pid)` 才打得到整组（垫片脚本
      // 起的孙进程正是靠这条收得回来）。Windows 走门闩 + Job，不需要也不能用 detached。
      detached: !IS_WINDOWS,
      stdio: ["ignore", "pipe", "pipe"],
      ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
  } catch {
    gate?.cleanup();
    confine?.dispose();                              // 一个进程都没起来，圈里必然是空的
    return null;                                     // cwd 不存在之类的同步失败
  }

  let stdout = "";
  let stderr = "";
  const take = (soFar: string, chunk: string): string =>
    soFar.length >= MAX_OUTPUT ? soFar : (soFar + chunk).slice(0, MAX_OUTPUT);
  // **按流设编码，不要对每个 Buffer 单独 `String(chunk)`**：UTF-8 字符正好跨在两个 data
  // 块边界上时，逐块解码会把它变成替换字符 —— 中文路径、中文停用原因都会糊掉
  // （第 4 轮审查 N2）。`setEncoding` 内部就是有状态的 StringDecoder，跨块是对的。
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (c: string) => { stdout = take(stdout, c); });
  child.stderr?.on("data", (c: string) => { stderr = take(stderr, c); });

  let spawnFailed = false;
  // **`exit` 是「它结束了」，`close` 是「管道都关了」** —— 后者会被攥着管道的后代无限推迟
  // （见 OUTPUT_DRAIN_MS 那段）。判据一律用前者。
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("error", () => { spawnFailed = true; resolve({ code: null, signal: null }); });
    child.once("exit", (code, signal) => { resolve({ code, signal }); });
  });
  const piped = new Promise<void>((resolve) => { child.once("close", () => { resolve(); }); });

  // ── 门闩：确认归属建成之后才开门 ─────────────────────────────────────────
  let gated = false;
  if (gate && confine) {
    const held = child.pid !== undefined && await confirmHeld(confine, child.pid);
    if (!held) {
      await discardShell(child.pid, confine);
      gate.cleanup();
      return null;                                   // 归属没建成 ⇒ CLI 一次都没起
    }
    gated = true;
    gate.open();
  }

  // 计时从**开门**算起：timeoutMs 是给 CLI 的，不该被确认归属那一步（起一次 PowerShell）吃掉。
  const raced = await Promise.race([
    exited.then((end) => ({ timedOut: false as const, end })),
    delay(timeoutMs).then(() => ({ timedOut: true as const, end: null })),
  ]);

  // 超时：**等收尾做完**才说「问不出来」。
  if (raced.timedOut) {
    await settleUnit(child, confine, gated, exited, "timeout");
    gate?.cleanup();
    return null;
  }

  // 进程已经结束，给输出一个短窗口到齐。close 来了就提前走，不来也不等（后代可能攥着管道）。
  await Promise.race([piped, wait(OUTPUT_DRAIN_MS)]);

  // 结束状态：门闩之下壳的退出码恒 0，CLI 的真实结果在盘上（见 ash-mcp-gate.ts 的说明）。
  // **被信号打断的不是一份答案**：上一版 `code ?? 0` 把「被杀」读成「成功退出 rc=0」，
  // claude 那边残缺输出会被当成「有登记」，codex 那边写了一半的 JSON 可能被当成「确实没有」
  // 而硬拒 —— 两个方向都错（第 4 轮审查 N1）。约定是「被杀 → 问不出来」。
  let code: number | null = null;
  if (gate) {
    const out = gate.outcome();
    if (out && !out.failed && !out.signal) code = out.status;
  } else if (!spawnFailed && !raced.end.signal) {
    code = raced.end.code;
  }

  // 其余每一条结束路径也都要收尾 —— 根进程走了不代表它的后代走了（第 5 轮审查实测）。
  // **不挡住返回**：Windows 那边圈的读数和下刀是同步 PowerShell，摆在派审请求的等待路径上
  // 会把主服务拖住（第 5 轮审查 N1）。放到后台只解决「不拖住这次请求」这一半；它仍然占着
  // 事件循环，彻底解决要挪进 worker（第 6 轮审查 N1 仍挂着，本轮没做）。
  void settleUnit(child, confine, gated, exited, "ended")
    .catch(() => { /* 收尾自己会喊 */ })
    .finally(() => { gate?.cleanup(); });

  return code === null ? null : { code, stdout, stderr };
}
