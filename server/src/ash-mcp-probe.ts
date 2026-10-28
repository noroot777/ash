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
import { IS_WINDOWS, killTree } from "./platform.js";
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
 * 这个执行单元此刻还有成员吗。`null` = 这台机器上问不出来（调用方据此退回弱证据）。
 *
 * 两条线索都**不依赖根进程还活着**，这正是 B2 要的那一点：
 *  · 有圈：内核记着成员归属，`read()` 直接给集合。注意 `since-enroll` 这一档的「空」
 *    按 `kernel-confine.ts` 的契约不构成证明（spawn 到 enroll 之间有窗口），但「非空」
 *    一定算数 —— 用来回答「收干净没有」够了。
 *  · 没圈的 POSIX：`kill(-pgid, 0)` 问进程组还有没有人，ESRCH 就是空了。
 */
function unitMembersGone(pid: number, confine: Confinement | null): boolean | null {
  if (confine) {
    const read = confine.read();
    if (read.kind === "members") return read.members.length === 0;
    if (read.kind === "absent") return true;         // 圈已经撤掉 = 里面没人了
    return null;                                      // unqueryable
  }
  if (IS_WINDOWS) return null;                        // 没圈又没进程组，只能退回 close
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? true : null;
  }
}

/**
 * 杀掉整个执行单元并**确认它真的没了**。
 *
 * 两轮同样的刀：Windows 的 `taskkill` 是异步发出去的，第一轮返回时它可能还没落地；
 * POSIX 这边第一轮通常就够。两轮都没确认收干净才喊 —— 到这一步机器上确实可能还留着
 * 东西，瞒下来只会让下一个人从头查一遍。
 */
async function reapUnit(child: ChildProcess, confine: Confinement | null, closed: Promise<unknown>): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  // 一轮下刀 + 等一个宽限，然后按**执行单元**问收干净没有；问不出来才退回 close 事件。
  const round = async (): Promise<boolean> => {
    if (confine) confine.killAll("SIGKILL");
    killTree(pid, "SIGKILL");                        // 圈建不出来时这就是全部；建得出来也不多余
    const byClose = await Promise.race([
      closed.then(() => true),
      delay(REAP_GRACE_MS).then(() => false),
    ]);
    const gone = unitMembersGone(pid, confine);
    return gone ?? byClose;                          // 执行单元答得出就听它的，答不出才认 close
  };
  if (await round()) return;
  if (await round()) return;
  const left = confine?.read();
  const who = left?.kind === "members" && left.members.length
    ? `：还剩 ${left.members.map((m) => m.pid).join("、")}`
    : "";
  console.warn(
    `[ash] ash MCP 预检的探测单元（根 pid=${pid}）超时后两轮都没能确认回收${who}`
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
    confine?.dispose();
    return null;                                     // cwd 不存在之类的同步失败
  }
  // 圈定发生在 spawn **之后**，所以这一档是 `since-enroll`：此后它 fork 的一切都归这个
  // 圈，中间那个极短的窗口按 kernel-confine 的契约不算证明（那边写得很清楚）。
  if (child.pid) confine?.enroll(child.pid);

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

  try {
    if (raced.timedOut) {
      await reapUnit(child, confine, closed);        // 确认回收之后才说「问不出来」
      return null;
    }
    if (spawnFailed) return null;
    // **被信号打断的不是一份答案**。上一版 `code ?? 0` 把「被杀」读成了「成功退出 rc=0」：
    // claude 那边任意残缺输出会被当成「有登记」，codex 那边一份写了一半的 JSON 可能被当成
    // 「确实没有」而硬拒 —— 两个方向都错（第 4 轮审查 N1）。约定是「被杀 → 问不出来」。
    if (raced.end.signal) return null;
    if (raced.end.code === null) return null;
    return { code: raced.end.code, stdout, stderr };
  } finally {
    confine?.dispose();                              // 圈空了就撤掉；没空不撤（那边自己判）
  }
}
