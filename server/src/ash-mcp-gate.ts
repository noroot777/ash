// **探测的门闩**:让归属在目标 CLI 的第一条指令之前就建成、并且**核得动**。
//
// ── 为什么非得加一层壳 ──────────────────────────────────────────────────────
//
// Windows 上归属只有一台设备:Job Object(没有进程组,`taskkill /T` 走父子树,根一死就断)。
// 而 `AssignProcessToJobObject` 只能在 `spawn` **之后**发生 —— Node 拿不到
// `CREATE_SUSPENDED`。于是 fork 到 assign 之间有一个窗口,`confine-job.ts` 的文件头把这一档
// 如实记成 `since-enroll`:窗口里出生又脱离父树的后代不在集合里。
//
// 第 6 轮审查在真机上把这个窗口打中了(192.168.1.187,冷启动首次预检):垫片用 `start /b`
// 起了查询就立刻退出,守圈进程还在起(~180 ms),等它来 assign 时根已经没了 ——
// `OpenProcess` 失败、刚建的空 Job 被关掉(`confine-job.ts` 的 `Hold`),圈从头到尾没建成:
//
//     COLD_TREE parent=24796 parentAlive=false child=25704 childAlive=true
//     readyMarkersSeen=[]
//
// 补刀补不回来:要查的那个集合压根不存在。所以**不能先 spawn 再想办法圈**。
//
// ── 门闩怎么把窗口关掉 ──────────────────────────────────────────────────────
//
// 被 spawn 的不再是 CLI,而是这一层壳。它只做一件事:**同步轮询一个 go 文件,等到了才启动
// CLI**。于是
//
//  · 它在整个 assign 期间**必然活着** —— `OpenProcess` 不会再撞上「根已经没了」,
//    守圈进程首次启动那 180 ms 由它干等掉(它不退出,等多久都赶得上);
//  · 它**一个后代都不生**(go 不出现就永不 `spawnSync`),所以窗口里没有任何能脱离的进程;
//  · CLI 是在父进程**确认圈建成之后**才出生的,它和它的后代继承这个 Job ——
//    对 CLI 这棵树而言覆盖是完整的(见 `ash-mcp-probe.ts` 的 `gated` 那段论证)。
//
// 「确认圈建成」不是看 `enroll` 的返回值:那个 true 只代表 hold 请求写进了守圈进程的 stdin。
// 真凭据是守圈进程 assign 成功之后写下的 `<凭据>.ready`,而 `Confinement.read()` 内部就会
// 等它(`settleHeld`)—— 所以读到 `members` 才算建成,`absent` 就是没建成。判据在 probe 那边。
//
// ── 结束状态走盘,不走退出码 ─────────────────────────────────────────────────
//
// 壳的退出码恒 0,CLI 的真实结束状态由它写进 `outcome.json`。不让壳透传退出码是因为那样就
// 得给壳自己的失败留几个保留码(「父没来开门」「CLI 起不来」),而任何保留码都可能跟 CLI
// 真实的退出码撞上 —— 撞上的后果是把一份错误读成一份答案,正是这条链上反复出现的那类错误。
// 盘上没有 outcome ⇒ 问不出来(放行),语义干净。
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 一次启动的样子 —— 跟 `resolveLaunch` 的返回同形。 */
export type LaunchPlan = {
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
};

/** 门闩壳最多等多久开门。父进程确认归属要起一次 PowerShell,给够。 */
const GATE_WAIT_MS = 60_000;

/** 每次探测的临时目录都建在这下面 —— 启动扫地(`sweepStaleGates`)认的就是这一层。 */
const GATE_ROOT = join(tmpdir(), "ash-mcp-gate");
/**
 * 多旧的门闩目录算没人要了。一次探测从建目录到收尾最多是「壳等开门 60 s + CLI 单问 15 s +
 * 收尾几秒」,十分钟远在那之外;另一个 ash 实例(预览实例共用 tmpdir)正用着的目录不会被碰到。
 */
const STALE_GATE_MS = 10 * 60_000;

export type GateOutcome = {
  /** CLI 的退出码。null = 没有正常退出(被信号打断 / 起不来)。 */
  status: number | null;
  /** 被信号打断时的信号名。 */
  signal: string | null;
  /** CLI 压根起不来时的 errno/消息。 */
  failed: string | null;
};

export type Gate = {
  /** 要 spawn 的是**这个**(门闩壳),不是 CLI 本身。 */
  readonly plan: LaunchPlan;
  /** 归属确认之后开门 —— CLI 这才开始执行。 */
  open(): void;
  /** CLI 的真实结束状态。null = 盘上没有 ⇒ 问不出来。 */
  outcome(): GateOutcome | null;
  /** 收掉临时目录。进程都结束之后再叫。 */
  cleanup(): void;
};

/**
 * 门闩壳的脚本。**同步**等 go 文件,所以它在等待期间不会被事件循环带着做任何别的事,
 * 也不会 fork —— 这正是「窗口里没有能脱离的进程」这句话的依据。
 *
 * `stdio: "inherit"` 让 CLI 的两个输出通道直接落在壳继承的那两个管道上,所以 probe 那边
 * 的 stdout/stderr 捕获一个字都不用改(两路分开也照旧,第 2 位审查者 F3)。
 */
const GATE_SCRIPT = `import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
const [goFile, outFile, verbatim, file, ...args] = process.argv.slice(2);
// 同步睡:不碰事件循环,也不需要别的进程。
const nap = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const deadline = Date.now() + ${GATE_WAIT_MS};
while (!existsSync(goFile)) {
  // 父进程没来开门(它判定归属建不起来,已经在收我了)=> 一条指令都不执行。
  if (Date.now() > deadline) process.exit(0);
  nap(25);
}
// windowsHide:壳自己是被 windowsHide 起的,可它再起的 CLI(.cmd 垫片走 cmd.exe)不继承这一项,
// 不带的话 Windows 上每次预检都可能闪一个控制台窗口(新链第 1 轮审查)。
const r = spawnSync(file, args, {
  stdio: "inherit",
  windowsHide: true,
  ...(verbatim === "1" ? { windowsVerbatimArguments: true } : {}),
});
try {
  writeFileSync(outFile, JSON.stringify({
    status: typeof r.status === "number" ? r.status : null,
    signal: r.signal ?? null,
    failed: r.error ? String(r.error.code ?? r.error.message) : null,
  }));
} catch {}
process.exit(0);
`;

/**
 * 把一次启动改写成「门闩壳 + 目标」。返回 null = 门闩自己都铺不出来(临时目录写不了),
 * 调用方据此放弃这次探测 —— **不退回直接起 CLI**:那正是审查点掉的那条路。
 */
export function prepareGate(target: LaunchPlan): Gate | null {
  const dir = join(GATE_ROOT, randomUUID());
  const script = join(dir, "gate.mjs");
  const go = join(dir, "go");
  const out = join(dir, "outcome.json");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(script, GATE_SCRIPT, "utf8");
  } catch {
    // 目录建出来了、脚本没写进去(配额/磁盘满/权限变化)时,这个目录就此没人管得到了 ——
    // 调用方这时拿不到 Gate,也就调不到下面那个 cleanup。反复失败会在 tmpdir 里积目录,
    // 所以在这里顺手收掉自己这一次的(第 1 轮审查 N2)。失败方向不变:照旧返回 null,
    // 不启动目标。
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* 收不掉就算了 */ }
    return null;
  }
  return {
    plan: {
      file: process.execPath,
      args: [
        script, go, out,
        target.windowsVerbatimArguments ? "1" : "0",
        target.file, ...target.args,
      ],
    },
    open(): void {
      // 开门失败 = CLI 永远不会被启动,壳自己到点退出。比「可能漏掉归属」安全。
      try { writeFileSync(go, "", "utf8"); } catch { /* 探测这一条就此作废 */ }
    },
    outcome(): GateOutcome | null {
      try {
        const raw = JSON.parse(readFileSync(out, "utf8")) as Partial<GateOutcome>;
        return {
          status: typeof raw.status === "number" ? raw.status : null,
          signal: typeof raw.signal === "string" ? raw.signal : null,
          failed: typeof raw.failed === "string" ? raw.failed : null,
        };
      } catch {
        return null;                                 // 没写成 / 没写完 ⇒ 问不出来
      }
    },
    cleanup(): void {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录,留着也无害 */ }
    },
  };
}

/**
 * 收掉上一个 ash 没来得及收的门闩目录(按 mtime,只收 `STALE_GATE_MS` 以前的)。返回收掉几个。
 *
 * 正常结束那条路的 `cleanup` 挂在**不被等待**的后台收尾后面(`ash-mcp-probe.ts`:等它跑完
 * 会把派审请求再拖几秒),进程在那段窗口里退出,那次的目录就没人管了 —— 新链第 2 轮审查在
 * 盘上找到了这样的残留。所以回收不能只靠那个 promise 跑完:`cleanup` 是快捷路径,兜底是
 * 启动时这一趟(`index.ts`)。best-effort,单个目录收不掉不影响别的。
 */
export function sweepStaleGates(now: number = Date.now(), root: string = GATE_ROOT): number {
  let names: string[];
  try { names = readdirSync(root); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    const dir = join(root, name);
    try {
      if (now - statSync(dir).mtimeMs < STALE_GATE_MS) continue;
      rmSync(dir, { recursive: true, force: true });
      removed++;
    } catch { /* 收不掉就留给下一次 */ }
  }
  return removed;
}
