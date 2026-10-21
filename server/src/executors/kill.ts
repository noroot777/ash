// agent 进程的**生命周期收口**:三层击杀,以及「这一次运行收干净了没有」这个结论。
//
// 这一摊曾经把四件事挤在一个文件里(击杀、逃逸枚举、追踪证据的寿命、进程身份判据),
// 一路顶到 680 行。本轮按职责拆开,**依赖是单向的**:
//
//   child-identity.ts   「这个号此刻还是不是它」—— 无依赖,三方共用
//   track-evidence.ts   追踪 fd / 「谁还握着它」三档 / 租约 / 启动期清扫
//   escapees.ts         逃逸后代的枚举与下刀(根授权 → 整棵子树)
//   cleanup-debt.ts     「没收干净」这件事的持久化与重试
//   kill.ts(本文件)   三层击杀 + 把上面几层的结论汇成一个清理结果
//
// 回归分三条,**改这一摊要跑全三条**(`server/CLAUDE.md` 的表里只列得下第一条):
//   test:process-identity   身份判据与三层击杀(「这个号此刻还是不是它」)
//   test:process-subtrees   快照形状、子树归属、持有者这一问的三档
//   test:cleanup-debt       清理结论的三档 + 责任落账/披露/重试/授权
//
// 老使用方照旧从 `spawn.js` / `kill.js` import:下面把各层的导出原样转出去。
import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { IS_WINDOWS, isPidAlive, killTree } from "../platform.js";
import { processUnitEvidence, type UnitEvidence } from "../proc.js";
import { processGroupMembersSync } from "../process-generation.js";
import { canShoot, killProvenUnit, reclaimState } from "../monitor-reclaim-evidence.js";
import { runOutPathOf, unitTokenOf } from "./unit-token.js";
import { childKillAuthorized, childStillOurs } from "./child-identity.js";
import {
  probeFileHolders, releaseTrackEvidence, trackPathOf, type HolderProbe,
} from "./track-evidence.js";
import { describeEvidence, killEscapees, signalMembers } from "./escapees.js";

// 各层原样转出去:`import { childStillOurs } from "./kill.js"` 这类既有写法照旧能用。
export {
  childStillOurs, markAdoptedChild, pidRunStillAlive, shareChildIdentity,
} from "./child-identity.js";
export {
  openTrackFd, registerTrackFd, releaseTrackEvidence, shareTrackFdRegistration,
  sweepOrphanTrackFiles,
} from "./track-evidence.js";

// ── 清理责任那一层**按需加载,不静态 import** ─────────────────────────────────────
//
// 它要读写 `agent_cleanup_debts`,所以静态 import 会把整个 db 层拖进这条 import 链 ——
// 而这条链的上游是 `executors/spawn.ts`、`executors/detached.ts`,连「只想按 pid 接管一个
// 还活着的 agent」的最小路径都会因此先去初始化数据库。实测后果:接管脚本启动慢了足够多,
// 被接管的 agent 在那之前就自己跑完退出了,接管于是失败(test:detached 在本轮回归里挂掉,
// 基线通过)。按需加载之后那条链回到原样,责任落盘只在真的要落时才付这个钱。

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForPidsGone(pids: readonly number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let alive = pids.filter(isPidAlive);
  while (alive.length && Date.now() < deadline) {
    await wait(50);
    alive = pids.filter(isPidAlive);
  }
  return alive;
}

// ── 清理的结论:**三档,不是 `Promise<void>`** ─────────────────────────────────
//
// 上一版这个函数返回 `Promise<void>`,于是「收干净了」「还有残留」「这一轮问不清楚」三种
// 结局对调用方长得一模一样 —— resolve 就是成功。后果是实测出来的(本轮审查 F2):macOS 上
// 记号前后都明确指出那个孤儿还在写文件,清理照样 resolve,于是待收册划掉它、追踪文件被删、
// 再点一次停止也停不住,重启后更没人认领。
//
// 三档各自的处置,**责任在这一层就落下来**,不指望每个调用方记得做:
//  · `empty`     —— 确证清空:释放追踪证据、销账。
//  · `remaining` —— 确证还有成员(可能根本杀不掉,比如 macOS 只给得出 `suspected`):
//                   证据留着、责任落库、日志如实说。
//  · `unknown`   —— 这一轮有问题没答出来:同上。「问不出来」不是「没有」。
//
// 调用方要的是「我能不能从待收册上把它划掉」,所以读 `cleanupSettled(result)` 就够了。
export type CleanupResult =
  | { kind: "empty" }
  | { kind: "remaining"; detail: string }
  | { kind: "unknown"; detail: string };

/** 这一轮能不能放手(从待收册划掉、不再重试)。**只有确证清空算。** */
export const cleanupSettled = (result: CleanupResult): boolean => result.kind === "empty";

/** 给人看的那一句(`empty` 那档没有细节,返回空串)。 */
export const cleanupDetail = (result: CleanupResult): string =>
  result.kind === "empty" ? "" : result.detail;

/**
 * 几份结论合成一份:**取最保守的那一档**(`remaining` > `unknown` > `empty`)。
 *
 * 用在「一个句柄起过好几轮」的地方(codex 的会话级常驻):任何一轮还没收干净,这个句柄
 * 就不算收干净 —— 取最乐观的那一档等于让干净的那几轮把脏的那一轮洗白。
 */
export function mergeCleanupResults(results: readonly CleanupResult[]): CleanupResult {
  const remaining = results.filter((r) => r.kind === "remaining");
  if (remaining.length) {
    return { kind: "remaining", detail: remaining.map((r) => r.detail).join(" | ") };
  }
  const unknown = results.filter((r) => r.kind === "unknown");
  if (unknown.length) {
    return { kind: "unknown", detail: unknown.map((r) => r.detail).join(" | ") };
  }
  return { kind: "empty" };
}

/**
 * **一条路径线索的终态,写成同一种三档结论** —— 判空的时候要把它跟记号那一问并起来。
 *
 * 为什么必须有这一步(第 2 轮审查 F1 实测):上一版判空只问了记号、追踪 fd 和句柄树,
 * 而**这一次运行的输出文件从头到尾没人问**。真实现场是:后代把环境洗掉(记号 `none`)、
 * 顺手丢掉高位 fd(追踪文件没有持有者)、根已经退出(句柄树是空的)—— 三问全答「没有」,
 * 可它的 stdout 还接在这次运行的输出文件上,继续往用户目录里写。于是局部的空被当成了
 * 整项资源的空:结论 `empty`、证据释放、一笔债都没留下。
 *
 * 判据与记号那一层同源:
 *  · `held` 且确实还有活着的号 ⇒ `remaining`(这是最硬的那种残留证据);
 *  · `held` 但那几个号都已经没了 ⇒ 这条线索这一刻证明不了残留 ⇒ `empty`;
 *  · `empty` ⇒ 确证没人握着;
 *  · `unknown` ⇒ **「问不出来」不是「没有」**,照 `unknown` 往上传,由调用方保留责任与证据。
 *
 * `null` = 这条线索这一次运行根本没有(非 detached 的运行没有输出文件、Windows 不开追踪
 * 文件)。那是**没有意见**,合并时当单位元,不是一张「已经空了」的证书。
 *
 * 代价如实记下:输出文件是 `data/runs/` 下的真实日志,用户自己 `tail -f` 它也会被算成持有者,
 * 于是落一笔假债。方向是对的那一边(宁可多留一笔可重试的记录,也不要把活着的后代宣布成
 * 收干净),而且它只用于**残留检测、不用于下刀**(同 cleanup-debt.ts 里那段)。
 */
export function residueFromProbe(label: string, probe: HolderProbe | null): CleanupResult {
  if (!probe) return { kind: "empty" };
  if (probe.kind === "held") {
    const alive = probe.pids.filter(isPidAlive);
    return alive.length
      ? { kind: "remaining", detail: `${label}仍被 ${alive.join(",")} 握着` }
      : { kind: "empty" };
  }
  if (probe.kind === "empty") return { kind: "empty" };
  return { kind: "unknown", detail: `${label}这一问没答出来:${probe.reason}` };
}

/**
 * 这一次运行的**两个运行专属文件**此刻的终态。
 *
 * 刻意放在清扫**做完之后**才问(第 2 轮审查 N1 的同一条判据):下刀之前那次读数说明不了
 * 下刀之后的事,拿它当最终结论既可能把已经收掉的说成还在(假债),也可能把下刀期间新
 * 逃出来的漏掉。
 */
async function finalResidue(child: ChildProcess): Promise<CleanupResult> {
  const trackPath = trackPathOf(child);
  const outPath = runOutPathOf(child);
  const [track, out] = await Promise.all([
    trackPath ? probeFileHolders(trackPath) : Promise.resolve(null),
    outPath ? probeFileHolders(outPath) : Promise.resolve(null),
  ]);
  return mergeCleanupResults([
    residueFromProbe("追踪文件", track), residueFromProbe("输出文件", out),
  ]);
}

/**
 * 一次性 agent 的事件流已经收完:CLI 本体按理已经退出,但它用 `&` / `start /b`
 * 甩出去的后台后代可能还活着。此刻 ChildProcess 还在手里,是 Windows 上利用已死
 * ParentProcessId 找回它们的最后窗口;再往后只剩一个 worktree 路径,已经无法可靠
 * 区分「agent 遗留」和「用户自己开的终端」。
 *
 * 先给 SIGTERM/Windows taskkill,最多等 2 秒;残存者再补 SIGKILL。正常没有逃逸者时
 * 只做一次进程表快照,不会给每个回合平白加等待。
 *
 * **扫完了才放手证据,抛错不放手**(第 3 轮审查 F2):清理失败的那条路上调用方会再试一次
 * (codex 常驻把这个 child 留在 `unfinalized` 等下一轮 cleanup),那时还得靠同一个追踪文件
 * 取证。以前这一句挂在 `finally` 上,等于「失败也按成功放手」。
 */
export async function cleanupAfterRun(child: ChildProcess): Promise<CleanupResult> {
  const sweep = await sweepAfterRun(child);
  const token = unitTokenOf(child);
  const result = judgeCleanup(sweep, token);
  if (result.kind === "empty") {
    releaseTrackEvidence(child);
    // 销账只在**真的欠过**的时候才需要动库(绝大多数回合一次都没欠过),所以这一句同样
    // 按需加载;加载失败不影响这一轮的结论 —— 账留着,下一次清扫会确证它已经空了。
    await import("./cleanup-debt.js")
      .then((m) => m.settleCleanupDebt(token))
      .catch(() => { /* 下一轮清扫再说 */ });
    return result;
  }
  // 还没收干净:**责任在这里就落盘**,不依赖任何调用方记得记一笔(它们三个各有各的
  // 结算要做,而这件事必须活得比它们都久 —— 见 cleanup-debt.ts 顶部)。
  // **没有记号也要试着记**(升级前建的老会话行):键退回路径线索,见 `debtKey`。
  const noted = await import("./cleanup-debt.js").then((m) => m.noteCleanupDebt({
    unitToken: token,
    rootPid: child.pid ?? null,
    trackPath: trackPathOf(child),
    outPath: runOutPathOf(child),
    state: result.kind === "remaining" ? "remaining" : "unknown",
    detail: result.detail, unitVerdict: sweep.unit.verdict,
  })).catch((error) => {
    console.error("[ash] 清理责任这一层加载失败,这一笔没能落盘:", error);
    return "failed" as const;
  });
  // **三档各说各的**(第 2 轮审查 F1 末条):上一版把「写库失败」也印成「没有可追的线索」,
  // 等于把一次真正的责任丢失说成了「本来就没什么可追的」。
  const tail = {
    noted: ";已记下清理责任,开机会再追一次",
    untrackable: ";**没有可追的线索**(记号与两个运行专属文件都没有),只剩这条日志",
    failed: ";**责任没能落盘**(库写失败),这一笔跨不过重启 —— 只剩这条日志",
  }[noted];
  console.warn(
    `[ash] 这一次运行的后代还不能证明收干净(pid=${child.pid ?? "?"}):${result.detail}${tail}`,
  );
  return result;
}

type SweepOutcome = {
  /** 这一轮每一问都答出来了吗。 */
  answered: boolean;
  /** 没答出来的那几问,人话。 */
  faults: string[];
  /** 记号那一问最后一次的结论。 */
  unit: UnitEvidence;
  /** 补刀之后仍然活着的号。 */
  survivors: number[];
  /**
   * **清扫做完之后,这个根还占着那个号、而我们又证不出它归谁。**
   *
   * 这一档是 F2 的核心场景,而它跟「有残存者」不是同一件事:我们一刀都没敢发(授权档
   * 证不出),所以它不会出现在 `survivors` 里 —— 上一版于是把这一轮判成了「确证清空」,
   * 顺手释放证据、销掉责任。可探活档明明还说得出「那个号上有东西」:那是**仍能检测到的
   * 残留**,不许宣布成清理完成。
   *
   * 正常路径不会落到这一档:根退场后探活档答 `gone`(真句柄看内核状态,接回的句柄看
   * pid + 启动时刻),所以每个回合不会平白欠一笔债。
   */
  rootLingers: boolean;
  /**
   * 清扫**做完之后**两个运行专属文件的终态(见 `finalResidue`)。
   *
   * 它跟 `unit` 是**两条互不替代的线索**:记号能被 `env -i` 洗掉,文件 fd 洗不掉;反过来
   * 文件可以被后代自己 close,记号还在。所以判空要两条都答「没有」—— 第 2 轮审查 F1 就是
   * 只问了记号那一侧,把局部的空当成了整项资源的空。
   */
  residue: CleanupResult;
};

/**
 * 把这一轮的全部线索并成一个结论。
 *
 * **`empty` 的门槛是「每一问都答出来、而且都答没有」**,所以这里不再逐条 early return,
 * 而是把每条线索各自的三档结论交给 `mergeCleanupResults` 取最保守的那一档 —— 判空少问
 * 一条线索,就是第 2 轮审查 F1 的那个漏洞;而逐条 return 的写法让「少问一条」永远只差
 * 一次疏忽。
 */
function judgeCleanup(sweep: SweepOutcome, token: string | null): CleanupResult {
  const reasons = [...sweep.faults];
  // 两个运行专属文件的终态:这一条独立于记号(见 `SweepOutcome.residue`)。
  const clues: CleanupResult[] = [sweep.residue];
  if (sweep.survivors.length) {
    clues.push({ kind: "remaining", detail: `下过刀仍活着:${sweep.survivors.join(",")}` });
  }
  // 根还占着那个号、归属又证不出 ⇒ **确有残留,只是不敢碰**(见 `rootLingers`)。
  if (sweep.rootLingers) {
    clues.push({
      kind: "remaining",
      detail: "根进程还在那个号上,但证不出它属于这一次运行(粗档 pid 不是排他凭证)",
    });
  }
  // 记号那一问**只在有记号时参与**:老会话行、Windows、种失败的那些本来就问不出意见,
  // 让它们永久挂着责任只会把真正的残留淹掉。
  if (token) {
    if (sweep.unit.verdict === "ours" || sweep.unit.verdict === "suspected") {
      clues.push({ kind: "remaining", detail: describeEvidence(sweep.unit) });
    }
    if (sweep.unit.verdict === "unprovable") {
      reasons.push("资源记号这一问没答出来");
    }
  }
  if (!sweep.answered || reasons.length) {
    clues.push({ kind: "unknown", detail: reasons.join(";") || "有一问没答出来" });
  }
  return mergeCleanupResults(clues);
}

/**
 * 实际的清扫:TERM → 等 2 秒 → KILL。返回**这一轮问清楚了多少**(见 `SweepOutcome`)。
 *
 * 上一版只把**最前面那一次** fd 查询的成败记进 `probed`,后面三问(进程树、第二次 fd 查询、
 * 最终残存者)失败一律吞掉 —— 于是「第一问答出来了」被当成「整轮都问清楚了」,照样走到
 * 释放证据那一句(本轮审查 F2 第 5 点)。现在每一问的失败都如实并进来。
 */
async function sweepAfterRun(child: ChildProcess): Promise<SweepOutcome> {
  const token = unitTokenOf(child);
  const first = await killEscapees(child, "SIGTERM");
  // 两档问的是两件事(见 child-identity.ts):探活档说「那个号上还有东西」,授权档说
  // 「敢不敢碰」。两句都成立时这一轮就既杀不掉、也不许自称收干净。
  const lingers = (): boolean => !!child.pid && childStillOurs(child) && !childKillAuthorized(child);
  const faults = [...first.faults];
  /**
   * 三条出路共用的收尾读数。**记号与两个运行专属文件都在这里重新问一次** ——
   * 上一版把 `first.unit` / `second.unit`(下刀**之前**那次取证)当成最终结论往上传,于是
   * 「清扫开始时还带着记号、随后确实已经退出」的根会留下一笔假债,要等下一轮清扫才收敛
   * (第 2 轮审查 N1);路径那两条线索则压根没问(同轮 F1)。
   */
  const settle = async (answered: boolean, survivors: number[]): Promise<SweepOutcome> => ({
    answered, faults, survivors, rootLingers: lingers(),
    unit: processUnitEvidence(token, { fresh: true }),
    residue: await finalResidue(child),
  });
  const targets = new Set(first.hit);
  // 判据与 killChild 同一条:以前这里问的是 `isPidAlive`,那只能证明「有人占着这个号」——
  // 根进程先退出、号被复用之后,它指向的已经是别人(第 1 轮审查 F2)。根进程已退出就只扫
  // 后代,一刀都不往那个号上发。
  if (child.pid && childKillAuthorized(child)) {
    targets.add(child.pid);
    killTree(child.pid, "SIGTERM");
  }
  if (!targets.size) return settle(first.answered, []);

  const stubborn = await waitForPidsGone([...targets], 2000);
  if (!stubborn.length) return settle(first.answered, []);
  const killed: number[] = [];
  // 等的这 2 秒里根进程可能自己退了,号随时会被复用 —— 补刀前按同一判据再确认一次。
  if (child.pid && stubborn.includes(child.pid) && childKillAuthorized(child)) {
    killTree(child.pid, "SIGKILL");
    killed.push(child.pid);
  }
  // 后代的补刀**按账上那份身份事实**:这 2 秒里它们正被 SIGTERM 催着退出,有的会顺手把
  // 继承 fd 关掉 —— 以前这里要求「此刻仍能取到证据」,于是那种进程被当成「号已换主」放过,
  // 活着继续写文件(第 3 轮审查 F1)。现在是「账上记过 + 代次仍对得上」⇒ 照杀;代次变了
  // ⇒ 号换了主人,一刀不发。
  const second = await killEscapees(child, "SIGKILL");
  faults.push(...second.faults.filter((f) => !faults.includes(f)));
  killed.push(...second.hit);
  // **最终残存者如实往上传**(上一版把这份名单丢掉了):它正是「还没收干净」最硬的那种证据。
  const survivors = await waitForPidsGone(killed, 2000);
  return settle(first.answered && second.answered, survivors);
}


// Terminate a running agent subprocess (manual stop). SIGTERM first so the CLI
// can wind down; a short fallback SIGKILL guarantees the process — and thus our
// output stream — actually ends even if the CLI ignores SIGTERM. Safe to call on
// the pre-flight failedChild stub (it has no real pid) and after exit.
// 三层击杀:①信号发给整个进程组(-pid,spawn 时 detached 使 child 为组长);
// ②killEscapees 按继承 fd / 已确认的根反查逃出进程组的后代(nohup 孤儿等),各自按代次
// 复核后处理;③2s 后对残存者(含期间新逃逸的、以及中途把 fd 关掉的)统一补 SIGKILL。
//
// **Windows 上第①层换成 `taskkill /T /F`,而且没有「优雅」这一档。** Windows 只有
// GUI 窗口收得到 WM_CLOSE,控制台程序不吃;Ctrl+C 只能发给同一个控制台组,而 agent
// 是 DETACHED_PROCESS 起的(没有控制台)。所以第一发就是强杀,CLI 没有落盘/收尾的
// 机会 —— 这是平台限制,如实记在这里。第②层退化成纯 ppid 树遍历(见 killEscapees),
// 第③层仍在(确认死透)。
export function killChild(child: ChildProcess): void {
  if (typeof child.kill !== "function") return;
  const signal = (sig: NodeJS.Signals) => {
    // 身份先于信号:已经 reap 过的号可能已经是别人的了(判据见 childKillAuthorized)。
    if (!childKillAuthorized(child)) return;
    if (child.pid) {
      killTree(child.pid, sig);
      return;
    }
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  };
  signal("SIGTERM");
  void killEscapees(child, "SIGTERM").catch(() => {});
  const t = setTimeout(() => {
    signal("SIGKILL");
    // 无论 CLI 死没死透,逃逸者一律补 SIGKILL —— stop 的语义就是全家结束。
    void killEscapees(child, "SIGKILL").catch(() => {});
  }, 2000);
  // Don't keep the event loop alive just for the fallback timer.
  (t as { unref?: () => void }).unref?.();
}

// 只有 pid 时的击杀(重启后接管的 agent 走这条 —— ChildProcess 句柄随上一个
// server 进程一起没了,追踪 fd 的 WeakMap 也没了)。
// 只剩三层里的第①③层:进程组信号 + 2s 后补 SIGKILL。第②层(继承 fd 反查逃逸者)
// 做不到,因为那份映射是内存态的。代价:重启前就已经逃出进程组的孤儿杀不到 ——
// 如实记在这里,别让以后的人以为这条路和 killChild 等价。
export function killByPid(
  pid: number,
  startedAt?: string | null,
  proof?: { unitToken?: string | null; outPath?: string | null },
): void {
  if (!Number.isInteger(pid) || pid <= 1) return;
  const unit = { unitToken: proof?.unitToken ?? null };
  // ① 记号那一问。判档这一次只为分流;**下刀本身不吃这份快照** —— killProvenUnit 自己
  // `fresh` 取证,授权不跨出它那个同步段(理由见那边第 13/14 轮审查那几段注释)。
  if (canShoot(reclaimState(pid, startedAt ?? null, unit))) {
    killProvenUnit(pid, startedAt ?? null, unit);
    return;
  }
  // ② 记号证不出来(最常见的是这一行建在记号上线之前,库里只有 pid)。POSIX 的秒级启动
  // 时刻是粗档,单凭它下刀就是在赌一次秒级碰撞 —— 那是明确实测过的误杀。
  //
  // 但 agent 这一侧还有一条哨兵没有的线索,而且它比记号**更硬**:这一次运行独有的输出文件。
  // 根进程的 stdout 就重定向在它上面,所以「谁还握着它」问的正是「这一次运行的根还在不在」;
  // 路径里带着 sessionId + 回合起点,别的运行不会碰它,而且它跟记号一样跨得过 server 重启
  // (`sessions.agent_out_path`)。关键区别:这是 `lsof` 的**真实 fd 表**,不是 macOS 上
  // 那种无边界的展示文本 ⇒ 精确可答,够当粗档要的那第二份独立证据。
  //
  // 注意它只证明得了**根**(fd 1 无条件继承,但 CLI 会把它自己子进程的 stdout 接成管道),
  // 而这条路要的恰好就是根:下刀打的是根的进程组。
  if (outPathProvesRoot(pid, proof?.outPath ?? null)) {
    // **第一刀之前把组成员连代次一起记下来** —— 就在根仍被证明着的这一刻。少了这一步,
    // 「外层壳吃了 TERM 老实退场、它派生的那个忽略 TERM 的东西还留在原组里」这个现场就
    // 收不干净:根一死,组号成了空号,两秒后那一刀打在空组上(ESRCH),而那个进程还在写文件。
    // 结构跟 killProvenUnit 一致(它对记号那一档做的是同一件事)。
    const held = processGroupMembersSync(pid) ?? [];
    killTree(pid, "SIGTERM");
    const t = setTimeout(() => {
      // 补刀前**重新取一次同一份证据**:这两秒里根可能已经退了、号可能被接手。
      // 以前这一刀是无条件的 —— 哨兵那边的注释早就点过这个毛病。
      if (outPathProvesRoot(pid, proof?.outPath ?? null)) killTree(pid, "SIGKILL");
      // 再把第一刀那会儿记下的成员补上:**代次没变才打**(变了就是号换了主人)。
      // 这一下不要求根现在还活着 —— 第一刀本来就是来结束它的。
      signalMembers(held.filter((m) => m.pid !== pid), "SIGKILL");
    }, 2000);
    (t as { unref?: () => void }).unref?.();
    return;
  }
  // ③ 两条线索都证不出来:不下刀,但要留下痕迹 —— 根约定「停止/暂停必须留下持久可见的
  // 状态」,静默失败会让用户只能得出「按钮坏了」。
  console.warn(
    `[ash] 没能证明 pid=${pid} 属于这一次运行(记号${unit.unitToken ? "对不上" : "缺失"}、`
    + `输出文件${proof?.outPath ? "也问不出持有者" : "未提供"}),`
    + "按「证不出就不下刀」处理:没有发送任何信号",
  );
}

/**
 * **这个号此刻还握着这一次运行的输出文件吗** —— 粗档 pid 要的那第二份独立证据。
 *
 * 同步实现是刻意的:取证与下刀必须在同一个同步段里完成,中间隔一次 `await`,这个号就可能
 * 已经退出并被别人接手(那是哨兵第 13/14 轮审查反复实测的同一条缝)。单文件 `lsof` 比那边
 * 的全表 `ps` 便宜得多。
 *
 * 三档里只有「确证握着」返回 true:问不出来(lsof 不在、报错)一律当证不出 —— 这一问是用来
 * **授权破坏性操作**的,不许让一次失败的查询变成放行票。
 */
function outPathProvesRoot(pid: number, outPath: string | null): boolean {
  if (!outPath || IS_WINDOWS) return false;       // win32 没有 lsof;那边 pid 时刻本来就是排他档
  try {
    const out = execFileSync("lsof", ["-t", "--", outPath], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000,
    });
    for (const line of out.split("\n")) {
      if (Number(line.trim()) === pid) return true;
    }
    return false;
  } catch {
    return false;                                 // 非零退出(无匹配)与查询失败都不算证明
  }
}
