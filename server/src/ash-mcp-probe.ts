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
// ── 这一层的规矩：不启动自己收不回来的查询 ──────────────────────────────────
//
// 探测不属于任何任务，UI 上看不见它，停止任务也找不到它 —— 所以泄漏会随着每次派审**静默
// 累积**。于是这一层只认**可验证的归属**：结束时能对「这次运行还有没有东西活着」给出正面
// 证据，而且证据不依赖后代的配合。拿不到这种归属就宁可不做这次探测，直接回「问不出来」
// 放行（判据层对 null 一律放行，见 `ash-mcp-reachability.ts` 的 `reachWith`）。
//
// 按这个门槛，基线手上有两台设备，这里**两台都接**：
//
//  · **内核圈定**（`kernel-confine.ts`）—— Linux 的 cgroup v2、Windows 的 Job Object。
//    成员归属由内核记着，`setsid` / `env -i` / close fd 一条都洗不掉。macOS 没有等价物，
//    那边这台设备如实弃权（`openConfinement()` 返回 null）。
//  · **追踪 fd**（`track-evidence.ts`）—— spawn 时把一个本次运行专属文件挂在 `stdio[3]`，
//    shell 起的后代（`bash` / `nohup` / `&`）不关高位 fd，所以换组、被收养都还能按文件名
//    `lsof` 反查得到。**但它只算半台设备**：`lsof` 答的「没人握着」在这里**不构成核销**，
//    因为 Node 的 `spawn` 对非 stdio fd 设 CLOEXEC —— 中间隔一层 Node 包装，这条线索当场
//    就断（本轮实测：wrapper 用 `spawn(detached, stdio:"ignore")` 起查询后，`lsof` 对追踪
//    文件返回空，而那个查询 PPID=1 活得好好的）。所以它在这一层只干两件事：**提供正面
//    证据**（发现活着的写手 ⇒ 确证还有残留）和**多一把刀**（按文件名反查到谁就收谁）。
//    Windows 上没有零依赖的反查手段（理由见 track-evidence.ts 顶部），那边这台不开。
//
// 于是**能核销的只有内核圈定这一台**，规矩随之变成：
//
//     拿不到内核圈定 ⇒ 这次探测不做，直接回「问不出来」放行。
//
// 代价如实写在这里：**macOS 上这条预检因此整个不工作**（那边没有等价物，基线如实弃权）。
// 这是拿「功能在那个平台上失效」换「绝不留下收不回来的后台查询」—— 方向由第 1 轮审查
// 定死：探测不属于任何任务、UI 上看不见、停止任务也找不到它，泄漏会随每次派审静默累积，
// 而漏放一次预检只是退回到没有这道闸之前的状态。
//
// ── 进程组**不是**归属设备（第 1 轮审查 B1，macOS 真机实测）──────────────────
//
// 上一版在 POSIX 上写的是「进程组在 spawn 那一刻由内核建立、覆盖这次运行的全程、不依赖
// 组长活着，对只读子命令这就是一份完整归属，所以这边不开圈」。**最后那半句是错的**：
// 进程组的成员关系不是不可逃离的 —— 后代一个 `setsid` 就换了组，而上一版把原组的 `ESRCH`
// 读成了「整次运行已经清理」。
//
// 审查者在 macOS 上造出了这个形状（包装用 `detached + stdio=ignore` 起查询、自己正常退出）：
//
//     wrapperAlive=false  wrapperGroupPresent=false          ← 原组整个没了
//     queryPid=38986 queryStillAlive=true  PPID=1 PGID=38986 ← 查询活着，自成一组
//
// 探测层那一刻答的是 `gone`、连一句警告都没打，最后是审查脚本拿自己记的 pid 收掉的。
// 所以**进程组从核销判据里整条撤掉**，只留它当下刀的一个目标集：`killTree` 的
// `kill(-pgid)` 能一次打到还留在组里的那些，这个能力照留，但它答的「空」不算证明。
//
// 这个形状**追踪 fd 也救不回来**（上面那段：那一层包装是 Node，fd3 被 CLOEXEC 切断），
// 所以 macOS 上剩不下任何能核销的设备 —— 那边的出路只能是「不启动」。基线
// `kernel-confine.ts` 顶部早写明了这一类（`close` 掉继承 fd + `setsid` 的后代）在没有
// 内核圈定的平台上无解，内核圈定要解的正是它。
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
// hold 请求写进了守圈进程的 stdin）。所以**有圈的平台**走门闩式启动（`ash-mcp-gate.ts`）：
//
//   spawn 的是一层壳 → 壳同步等 go 文件（期间必然活着、一个后代都不生）
//   → 父进程 enroll + **读到 `members` 才算圈建成**（`read()` 内部会等守圈进程的 ready 凭据）
//   → 开门 → CLI 这才出生，它和它的后代继承这个圈
//
// 于是 CLI 这棵树**整体**在圈内：窗口里没有能脱离的进程，`members` 的空因此构成证明
// （见 `unitResidue` 的 `gated`），`TerminateJobObject` 的成功也因此是整棵树的终止。
// **门闩只有在要给圈补窗口时才需要** —— 只有追踪 fd 的平台（macOS）不用它，因为那台设备
// 压根没有要补的窗口。
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, unlinkSync } from "node:fs";
import { IS_WINDOWS, isPidAlive, isPidRunning, killOne, killTree } from "./platform.js";
import { resolveLaunch } from "./executors/bin-resolve.js";
import { prepareGate } from "./ash-mcp-gate.js";
import { openConfinement, type Confinement } from "./executors/kernel-confine.js";
import { residueFromProbe } from "./executors/cleanup-result.js";
import {
  holderMayOwn, openTrackFd, probeFileHolders, registerTrackFd, releaseTrackEvidence, trackPathOf,
} from "./executors/track-evidence.js";

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
 * 这一次探测的**执行单元**：手上有哪几台归属设备，以及它们各自答得了什么。
 *
 * `confine` 和 `track` 至少有一个非空 —— 两个都拿不到时 `probeCli` 压根不启动目标
 * （见文件头「不启动自己收不回来的查询」）。
 */
export type ProbeUnit = {
  /** 内核圈定。`null` = 这台机器没有（macOS）或被显式关掉。 */
  confine: Confinement | null;
  /** 门闩确认过圈建成、且目标出生在圈内。只对 `confine` 有意义。 */
  gated: boolean;
  /** 追踪文件的路径。`null` = Windows，或者这次没开成。 */
  track: string | null;
};

/**
 * 这个执行单元此刻的残留读数。**`null` = 这几台设备都没给出结论**，不是「空」。
 *
 * **判据一个字都不在这里新造**：内核圈定那档的三种读数照抄既有消费者
 * `cleanup-result.ts` 的 `confinedResidue`，追踪 fd 那档接 `residueFromProbe`，但**只取
 * 它的正面证据**（见下面那段）—— 能答「空」的只有内核圈定这一台。
 *
 * 内核圈定那档：
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
 *
 * **进程组不在这里面**（第 1 轮审查 B1，理由见文件头）：它只覆盖「还留在原组里」的后代，
 * 一个 `setsid` 就能出圈，所以原组的 `ESRCH` 推不出整次运行干净。
 */
export async function unitResidue(unit: ProbeUnit): Promise<"remaining" | "gone" | null> {
  if (unit.confine) {
    const read = unit.confine.read();
    if (read.kind === "members") {
      if (read.members.some((m) => isPidRunning(m.pid))) return "remaining";
      if (unit.gated || read.coverage === "whole-run") return "gone";
    }
    // absent / unqueryable / `since-enroll` 的空：这台设备不说话，换下一台问。
  }
  if (unit.track) {
    // **只取它的正面证据那一半。** `residueFromProbe` 的「问全了、没人握着 ⇒ empty」在它
    // 自己那条多设备合议的链上是对的，但在这里单独拿来核销就错了：Node 的 `spawn` 会把
    // fd3 关掉，隔一层 Node 包装这条线索就断，而断了之后它答的正是「没人握着」。
    const verdict = residueFromProbe("探测单元的追踪文件", await probeFileHolders(unit.track));
    if (verdict.kind === "remaining") return "remaining";
  }
  return null;
}

/**
 * 给**逃出原进程组**的后代下刀：按追踪文件反查持有者，只杀写模式的那些。
 *
 * 门槛跟基线 `escapees.ts` 授权破坏性操作的那条同源（`holderMayOwn`：只认写模式）——
 * 追踪文件是以 `"w"` 打开的，后代继承到的是写端，只读打开同一路径的看客两条都不满足。
 *
 * **号复用那个窗口如实记下**：基线那边为此做了两次取证夹代次（`stillSameGeneration`），
 * 这里没有照搬 —— 探测是秒级的只读子命令、不进债表，而 `probeFileHolders` 返回到
 * `killOne` 之间没有 `await`，窗口只有几微秒。拿这个窗口换一整套代次账本不值，但它不是零。
 */
async function cutEscapees(unit: ProbeUnit): Promise<number> {
  if (!unit.track) return 0;
  const probe = await probeFileHolders(unit.track);
  const targets = probe.found.filter((h) => holderMayOwn(h) && isPidAlive(h.pid));
  for (const holder of targets) killOne(holder.pid, "SIGKILL");
  return targets.length;
}

/**
 * 判空之后把两台设备的证据交还。**只有在真的证明了空之后才能调** —— `dispose` 的契约是
 * 「调用方已经判空」，它自己只交还句柄、不杀成员；`releaseTrackEvidence` 同理（它排的那截
 * 尾巴到点还要再确认一次无人持有才真删文件）。
 */
function discharge(child: ChildProcess, unit: ProbeUnit): void {
  unit.confine?.dispose();
  releaseTrackEvidence(child);
}

/**
 * 收尾：把这次探测自己起的东西收干净，**每条结束路径都要走一遍**。
 *
 * 上一版只在超时分支收，正常 `close` 直接返回 —— 第 5 轮审查实测：包装把查询用
 * `detached + stdio=ignore` 起出去、自己正常退出，3.6 秒就返回了结论，查询还活着。
 * 根进程的 close 从来不代表它的后代结束了。
 *
 * 判据分三层，强的先用：
 *  ① 能当场证空就什么都不用做。
 *  ② **整圈刀 + 组刀 + 逃逸者刀**：`TerminateJobObject` 是内核级的「这个集合全部终止」，
 *     门闩之下 CLI 整棵树都在集合里，所以这一刀下成了就是整棵树的终止（这点很要紧，因为
 *     那边的读数要起 PowerShell，能少起一次就少起一次）。**没有门闩就不能这么推**，那时
 *     这一刀只是「尽力」，仍要回到读数上去证。`killTree` 打还在原组里的，`cutEscapees`
 *     打换了组、被 init 收养的 —— 后者正是第 1 轮审查 B1 那个形状。
 *  ③ 都不成：退回读数，等到预算用完。仍然证不了空就**披露，并且不交还证据**（身份和追踪
 *     文件都留着 —— 它们是唯一还能查回去的线索）。
 *
 * **`close` 不参与任何一条路**（第 6 轮审查第 4 点）：后代不持有管道时它来得更早，持有时它
 * 根本不来。这里连「提前醒来」都只认 `exit`（进程退出），close 一次都不问。
 */
async function settleUnit(
  child: ChildProcess,
  unit: ProbeUnit,
  exited: Promise<unknown>,
  why: "timeout" | "ended",
): Promise<void> {
  const pid = child.pid;
  if (!pid) { discharge(child, unit); return; }

  if (why === "ended" && await unitResidue(unit) === "gone") { discharge(child, unit); return; }

  const cut = unit.confine ? unit.confine.killAll("SIGKILL") : -1;
  killTree(pid, "SIGKILL");
  await cutEscapees(unit);
  if (cut >= 0 && unit.gated) { discharge(child, unit); return; }

  // ③ 退回读数：等到预算用完为止。
  //
  // **宽限必须真的等**。上一版写的是 `race([closed, delay(宽限)])` —— 根进程早就 close 了
  // 的时候（正常退出路径一律如此）那个 race 当场就 resolve，于是「两轮宽限」其实是两次
  // 零延迟空转：刚被 SIGKILL 的后代还没被 reap，读数对僵尸照旧成功，于是明明收干净了却
  // 喊出「收不干净」。`exited` 不参与判据（它什么都证明不了），只在根还没退出时用来提前
  // 醒来一次。
  //
  // 读数的代价分平台：POSIX 一次 `lsof`，Windows 每次要起一次同步 PowerShell，所以那边
  // 按整段宽限只读两次。
  const step = IS_WINDOWS ? REAP_GRACE_MS : 150;
  const deadline = Date.now() + REAP_GRACE_MS * 2;
  let first = true;
  while (Date.now() < deadline) {
    await (first ? Promise.race([exited, wait(step)]) : wait(step));
    first = false;
    if (await unitResidue(unit) === "gone") { discharge(child, unit); return; }
    killTree(pid, "SIGKILL");
    await cutEscapees(unit);
  }

  const left = unit.confine?.read();
  const who = left?.kind === "members" && left.members.length
    ? `：还剩 ${left.members.map((m) => m.pid).join("、")}`
    : "";
  console.warn(
    `[ash] ash MCP 预检的探测单元（根 pid=${pid}）收不干净${who}`
    + "；这次的执行单元身份和追踪文件**都保留**着（没有交还），它们是唯一还能查回去的线索"
    + "（这条探测不属于任何任务，停止任务找不回它）",
  );
}

/**
 * 开门之前就得放弃这次探测时，把门闩壳收掉。
 *
 * 壳从出生到这一刻**没有 fork 过任何东西**（它的代码只有「轮询 go 文件 + 启动 CLI」，
 * go 没写就永不启动）。所以「壳已经死了」⇒ 这个单元里没有活着的成员 ⇒ 这时交还证据
 * 是合法的，不违反「调用方已经判空」那条契约。
 */
async function discardShell(child: ChildProcess, unit: ProbeUnit): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) { discharge(child, unit); return; }
  killTree(pid, "SIGKILL");
  for (let waited = 0; waited < SHELL_REAP_MS; waited += 50) {
    if (!isPidRunning(pid)) { discharge(child, unit); return; }
    await wait(50);
  }
  // 壳自己都收不掉（极少见）：按契约不交还证据，交给上面那段警告的同一条规矩。
  console.warn(`[ash] ash MCP 预检的门闩壳（pid=${pid}）没收掉；这次的执行单元证据保留着`);
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

/** 追踪文件开出来了却没能交给任何子进程：fd 和文件都别留着。 */
function dropTrack(track: { fd: number | null; path: string | null }): void {
  if (track.fd !== null) { try { closeSync(track.fd); } catch { /* 已关 */ } }
  if (track.path) { try { unlinkSync(track.path); } catch { /* 没建成 */ } }
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
  /**
   * **只有测试会传这一项**，默认就是真实的内核圈定工厂。
   *
   * 为什么要留这个口子：这一层的结束路径（超时回收、包装先退出、后代攥管道、正常退出也
   * 要收尾）全是前后几轮审查在真机上逐个打出来的，而 macOS 上圈定如实弃权 ⇒ `probeCli`
   * 直接不启动 ⇒ 那几条路在开发机上一条都跑不了，只能等 Windows/Linux 真机 —— 前几轮正是
   * 这么漏掉问题的。所以测试拿它注入一台能在本机驱动那些路径的**替身**。
   *
   * 替身住在测试文件里，**生产代码里没有任何弱归属实现**：这个默认值是唯一的生产路径，
   * 它弃权就是弃权。
   */
  openUnit: (token: string) => Confinement | null = openConfinement,
): Promise<ProbeResult | null> {
  const plan = resolveLaunch(bin, args);
  if (!plan) return null;

  // 归属先铺好。**顺序是硬的**：一台设备都拿不到，或者该配的门闩配不出来，就一条指令都不起。
  // **能核销的只有内核圈定这一台**（文件头那段），所以拿不到它就一条指令都不起 ——
  // macOS 恒走这条。宁可这次预检不做（返回「问不出来」放行），也不留一个谁都查不回去的
  // 后台查询。
  const confine = openUnit(`ash-mcp-probe-${randomUUID()}`);
  if (!confine) return null;
  const track = openTrackFd();                       // Windows 上恒空（那边没有反查手段）
  // 门闩给圈补上 fork→enroll 那个空窗：壳先出生、圈建成核实之后目标才出生。
  const gate = prepareGate(plan);
  if (!gate) { confine.dispose(); dropTrack(track); return null; }
  const launch = gate.plan;

  let child: ChildProcess;
  try {
    child = spawn(launch.file, launch.args, {
      env,
      cwd,
      windowsHide: true,
      // POSIX：自成进程组，`killTree` 的 `process.kill(-pid)` 才打得到整组（垫片脚本起的
      // 孙进程里**还留在组里**的那些正是靠这条收回来的）。它只是一把刀，不是归属证明 ——
      // 核销判据里没有它（第 1 轮审查 B1）。Windows 走门闩 + Job，不需要也不能用 detached。
      detached: !IS_WINDOWS,
      // `stdio[3]` 就是追踪 fd（形状照 `executors/spawn.ts` 那条路）：后代继承它，收尾时
      // 按文件名 `lsof` 反查，换组和被收养都追得到。
      stdio: track.fd === null
        ? ["ignore", "pipe", "pipe"]
        : ["ignore", "pipe", "pipe", track.fd],
      ...(launch.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
  } catch {
    gate.cleanup();
    confine.dispose();                               // 一个进程都没起来，圈里必然是空的
    dropTrack(track);
    return null;                                     // cwd 不存在之类的同步失败
  }
  // 子进程已经持有副本，父进程这份由它关掉，并建立租约（到点还要确认无人持有才删文件）。
  registerTrackFd(child, track);
  const unit: ProbeUnit = { confine, gated: false, track: trackPathOf(child) };

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

  // **`exit` 是「它结束了」，`close` 是「管道都关了」** —— 后者会被攥着管道的后代无限推迟
  // （见 OUTPUT_DRAIN_MS 那段）。判据一律用前者。壳起不来（`error`）跟壳跑完一样收场：
  // 两种情况下盘上都没有一份合法的 outcome，于是答案是「问不出来」。
  const exited = new Promise<void>((resolve) => {
    child.once("error", () => { resolve(); });
    child.once("exit", () => { resolve(); });
  });
  const piped = new Promise<void>((resolve) => { child.once("close", () => { resolve(); }); });

  // ── 门闩：确认归属建成之后才开门 ─────────────────────────────────────────
  {
    const held = child.pid !== undefined && await confirmHeld(confine, child.pid);
    if (!held) {
      await discardShell(child, unit);
      gate.cleanup();
      return null;                                   // 归属没建成 ⇒ CLI 一次都没起
    }
    unit.gated = true;
    gate.open();
  }

  // 计时从**开门**算起：timeoutMs 是给 CLI 的，不该被确认归属那一步（起一次 PowerShell）吃掉。
  const timedOut = await Promise.race([
    exited.then(() => false),
    delay(timeoutMs).then(() => true),
  ]);

  // 超时：**等收尾做完**才说「问不出来」。
  if (timedOut) {
    await settleUnit(child, unit, exited, "timeout");
    gate.cleanup();
    return null;
  }

  // 进程已经结束，给输出一个短窗口到齐。close 来了就提前走，不来也不等（后代可能攥着管道）。
  await Promise.race([piped, wait(OUTPUT_DRAIN_MS)]);

  // 结束状态：门闩之下壳的退出码恒 0，CLI 的真实结果在盘上（见 ash-mcp-gate.ts 的说明）。
  // **被信号打断的不是一份答案**：上一版 `code ?? 0` 把「被杀」读成「成功退出 rc=0」，
  // claude 那边残缺输出会被当成「有登记」，codex 那边写了一半的 JSON 可能被当成「确实没有」
  // 而硬拒 —— 两个方向都错（第 4 轮审查 N1）。约定是「被杀 → 问不出来」。
  // 门闩恒在，所以真实退出码一律走盘；`spawnFailed` / 信号那两条由壳自己吸收。
  let code: number | null = null;
  const out = gate.outcome();
  if (out && !out.failed && !out.signal) code = out.status;

  // 其余每一条结束路径也都要收尾 —— 根进程走了不代表它的后代走了（第 5 轮审查实测）。
  // **不挡住返回**：圈的读数和下刀是同步 PowerShell，摆在派审请求的等待路径上会把主服务
  // 拖住（第 5 轮审查 N1）。放到后台只解决「不拖住这次请求」这一半；它仍然占着事件循环，
  // 彻底解决要挪进 worker（第 6 轮审查 N1 仍挂着，本轮没做）。
  void settleUnit(child, unit, exited, "ended")
    .catch(() => { /* 收尾自己会喊 */ })
    .finally(() => { gate.cleanup(); });

  return code === null ? null : { code, stdout, stderr };
}
