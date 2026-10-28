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
// 所以超时自己管，而且判据是**执行单元**，不是根进程：
//
//  · POSIX：`detached` 让它自成进程组。进程组本来就不依赖组长活着 —— 根先退出，
//    `kill(-pgid)` 照样打得到剩下的成员，`kill(-pgid, 0)` 也照样答得出「还有没有人」。
//  · Windows：没有进程组这回事，`taskkill /T` 走的是**父子树**，根一死这棵树就断了。
//    第 4 轮审查在真机上造出了这个形状（包装用 `start /b` 起查询后自己退出）：两轮
//    `taskkill /T /F` 都按那个已死的 PID 发，查询进程活得好好的。所以这边接**内核圈定**
//    （`kernel-confine.ts` 的 Job Object，整台机器一个常驻守圈进程）—— 成员归属由内核
//    记着，不靠父子边。建不出圈时如实退回原路，并在收不回时喊出来。
//
// 「收干净了」的依据也跟着换成执行单元的读数（圈的成员集合 / 进程组还有没有人），不再
// 拿根进程的 `close` 当证据：后代不持有管道时 close 来得更早，持有时 close 根本不来 ——
// 两种偏差都是第 4 轮审查点出来的同一条（B2）。
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { IS_WINDOWS, isPidRunning, killTree } from "./platform.js";
import { resolveLaunch } from "./executors/bin-resolve.js";
import { openConfinement, type Confinement } from "./executors/kernel-confine.js";

export interface ProbeResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 单次探测最多收这么多输出。只读子命令的正常输出远小于此，超了说明问错了东西。 */
const MAX_OUTPUT = 8 * 1024 * 1024;
/** 下刀之后给它多久咽气。两轮都没咽就如实上报，不再干等。 */
const REAP_GRACE_MS = 3_000;

const delay = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms).unref?.(); });

/**
 * 这个执行单元此刻的残留读数。**`null` = 这几台设备都没给出结论**，不是「空」。
 *
 * 三档的解释**照抄既有消费者** `cleanup-result.ts` 的 `confinedResidue`，一个字不改：
 *  · `absent`      —— 圈压根没建起来（平台弃权、冷启动时根比守圈进程还短命）⇒ 这台设备
 *    **不说话**。上一版把它读成「已经回收」，于是 Windows 冷启动那次泄漏连警告都没打
 *    （第 5 轮审查实测 `readyMarkersSeen:[]`、`childAlive:true`、无警告）。
 *  · `unqueryable` —— 这一刻问不到 ⇒ 不说话（留着下一轮再问）。
 *  · `members`     —— 非空就是**还有残留**（僵尸不算，跟那边同一条判据）；空**只有在
 *    `whole-run` 档才构成证明**。`since-enroll` 是「spawn 之后才圈的」，窗口里出生又
 *    脱离的后代不在集合里 —— 而 **Windows 恒在这一档**，所以那边的空永远不算证明。
 *
 * 没有圈的 POSIX 退回进程组：它在 `spawn` 那一刻就建好了（`detached`），覆盖整次运行，
 * 所以这里的「空」(ESRCH) 算证明。
 */
export function unitResidue(pid: number, confine: Confinement | null): "remaining" | "gone" | null {
  if (confine) {
    const read = confine.read();
    if (read.kind === "members") {
      if (read.members.some((m) => isPidRunning(m.pid))) return "remaining";
      return read.coverage === "whole-run" ? "gone" : null;
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
 * `detached + stdio=ignore` 起出去、自己正常退出，3.6 秒就返回了结论，查询还活着
 * （`NORMAL_TREE childAlive:true`）。根进程的 close 从来不代表它的后代结束了。
 *
 * 判据分三层，强的先用：
 *  ① 能当场证空就什么都不用做（POSIX 常走这条：一次 `kill(-pgid, 0)` 而已）。
 *  ② **整圈刀**：`TerminateJobObject` / `cgroup.kill` 是内核级的「这个集合全部终止」，
 *     下成了就是确定结论，不必再读数证空 —— 这点很要紧，因为 Windows 恒在 since-enroll
 *     档，读数**永远**证不了空，只认读数的话那边就没有能走通的收尾路径了。
 *  ③ 都不成：退回 `killTree` + 读数/close，两轮。仍然证不了空就**披露，并且不撤销身份**
 *     （`dispose` 的契约是「调用方已经判空」，它自己只交还句柄、不杀成员；成员还在时撤掉
 *     身份等于把唯一还能查回去的线索丢了）。
 */
async function settleUnit(
  child: ChildProcess,
  confine: Confinement | null,
  closed: Promise<unknown>,
  why: "timeout" | "ended",
): Promise<void> {
  const pid = child.pid;
  if (!pid) { confine?.dispose(); return; }

  // ① 正常结束 + 能当场证空。只在 POSIX 走：Windows 的读数要起一次 PowerShell，比直接
  //    下刀还贵，而且那边读了也证不了空。
  if (why === "ended" && !IS_WINDOWS && unitResidue(pid, confine) === "gone") {
    confine?.dispose();
    return;
  }

  // ② 整圈刀（圈弃权/没建起来时 killTree 就是全部）。
  const cut = confine ? confine.killAll("SIGKILL") : -1;
  killTree(pid, "SIGKILL");
  if (cut >= 0) { confine?.dispose(); return; }       // 内核保证的整集合终止

  // ③ 退回原路：两轮。
  for (let round = 0; round < 2; round++) {
    const byClose = await Promise.race([
      closed.then(() => true),
      delay(REAP_GRACE_MS).then(() => false),
    ]);
    const residue = unitResidue(pid, confine);
    if (residue === "gone") { confine?.dispose(); return; }
    if (residue === null && byClose && !confine) return;  // 没有圈可问，根也确实走了：退回既有线索
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
 * 跑一条只读 CLI 子命令。返回 null = **问不出来**（起不来、超时、被杀），调用方一律放行。
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

  // **先开圈再 spawn**：Windows 那边开圈顺手预热常驻守圈进程（首次要 ~180ms 起 PowerShell），
  // 放在这里就跟 CLI 自己的启动并行跑掉了；enroll 必须紧跟 spawn，见下。
  const confine = openConfinement(`ash-mcp-probe-${randomUUID()}`);

  let child: ChildProcess;
  try {
    child = spawn(plan.file, plan.args, {
      env,
      cwd,
      windowsHide: true,
      // POSIX：自成进程组，killTree 的 `process.kill(-pid)` 才打得到整组（垫片脚本
      // 起的孙进程正是靠这条收得回来）。Windows 没有进程组这回事，taskkill /T 按
      // 父子树走，不需要也不能用 detached。
      detached: !IS_WINDOWS,
      stdio: ["ignore", "pipe", "pipe"],
      ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
  } catch {
    confine?.dispose();                              // 一个进程都没起来，圈里必然是空的
    return null;                                     // cwd 不存在之类的同步失败
  }
  // 圈定发生在 spawn **之后**，所以这一档是 `since-enroll`：此后它 fork 的一切都归这个
  // 圈，中间那个极短的窗口按 kernel-confine 的契约不算证明（那边写得很清楚）。
  //
  // `enroll` 答 true 只表示**请求发出去了**，不表示 assign 已经成功（Windows 上真正的
  // 凭据是守圈进程写的 ready 文件）。所以 true 这边不敢多想，false 这边则直接把这台设备
  // 放下 —— 省掉后面每次读数都去起一次 PowerShell，结论照旧由 `absent` 那一档兜着。
  let unit = confine;
  if (!child.pid || !unit?.enroll(child.pid)) {
    unit?.dispose();                                 // 没圈住，圈里必然没有我们的人
    unit = null;
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
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("error", () => { spawnFailed = true; resolve({ code: null, signal: null }); });
    child.once("close", (code, signal) => { resolve({ code, signal }); });
  });

  const raced = await Promise.race([
    closed.then((end) => ({ timedOut: false as const, end })),
    delay(timeoutMs).then(() => ({ timedOut: true as const, end: null })),
  ]);

  // 超时：**等收尾做完**才说「问不出来」。
  if (raced.timedOut) {
    await settleUnit(child, unit, closed, "timeout");
    return null;
  }
  // 其余每一条结束路径（正常 close / spawn 失败 / 被信号打断）也都要收尾 —— 根进程走了
  // 不代表它的后代走了（第 5 轮审查 B1 实测）。但**不挡住返回**：Windows 那边圈的读数和
  // 下刀是同步 PowerShell，摆在派审请求的等待路径上会把主服务拖住（第 5 轮审查 N1）。
  // 放到后台只解决「不拖住这次请求」这一半；它仍然占着事件循环，彻底解决要挪进 worker。
  void settleUnit(child, unit, closed, "ended").catch(() => { /* 收尾自己会喊 */ });

  try {
    if (spawnFailed) return null;
    // **被信号打断的不是一份答案**。上一版 `code ?? 0` 把「被杀」读成了「成功退出 rc=0」：
    // claude 那边任意残缺输出会被当成「有登记」，codex 那边一份写了一半的 JSON 可能被当成
    // 「确实没有」而硬拒 —— 两个方向都错（第 4 轮审查 N1）。约定是「被杀 → 问不出来」。
    if (raced.end.signal) return null;
    if (raced.end.code === null) return null;
    return { code: raced.end.code, stdout, stderr };
  } finally {
    // **这里不碰 confine**。撤销身份只能发生在确认收干净之后，那个判断在 settleUnit 里
    // （`dispose` 的实现只交还句柄、不杀成员，所以它的契约是「调用方已经判空」）。
    // 上一版在 finally 里无条件 dispose，等于成员还活着就把唯一能查回去的线索丢了。
  }
}
