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
// 这一摊的回归分在三条里(`server/CLAUDE.md` 的表里只列得下第一条),各自覆盖的范围:
//   test:process-identity   身份判据与三层击杀(「这个号此刻还是不是它」)
//   test:process-subtrees   快照形状、子树归属、持有者这一问的三档
//   test:cleanup-debt       清理结论的三档 + 责任落账/披露/重试/授权
//
// 老使用方照旧从 `spawn.js` / `kill.js` import:下面把各层的导出原样转出去。
import { execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { IS_WINDOWS, isPidAlive, killTree } from "../platform.js";
import { inspectProcess, type UnitEvidence } from "../proc.js";
import { processGroupMembersSync } from "../process-generation.js";
import { canShoot, killProvenUnit, reclaimState } from "../monitor-reclaim-evidence.js";
import { monitorUnitAnswerable } from "../monitor-unit-scan.js";
import { runOutPathOf, unitTokenOf } from "./unit-token.js";
import { adoptedIdentityOf, childKillAuthorized, childStillOurs } from "./child-identity.js";
import {
  fileHoldersAnswerable, probeFileHolders, releaseTrackEvidence, trackPathOf,
} from "./track-evidence.js";
import { collectEscapees, describeEvidence, killEscapees, signalMembers } from "./escapees.js";
import {
  describeOpen, judgeByClues, mergeClueAnswers, openOf, residueFromProbe,
  type CleanupOpen, type CleanupResult, type ClueAnswer,
} from "./cleanup-result.js";
// 只借类型:持久层是按需加载的(它拉起整个 db 层),不许在这里长出静态依赖。
import type { CleanupDebtInput } from "./cleanup-debt.js";

// 各层原样转出去:`import { childStillOurs } from "./kill.js"` 这类既有写法照旧能用。
export {
  childStillOurs, markAdoptedChild, pidRunStillAlive, shareChildIdentity,
} from "./child-identity.js";
export {
  openTrackFd, registerTrackFd, releaseTrackEvidence, shareTrackFdRegistration,
  sweepOrphanTrackFiles,
} from "./track-evidence.js";
export {
  cleanupDetail, cleanupRetriable, cleanupSettled, mergeCleanupResults, residueFromProbe,
  type CleanupResult,
} from "./cleanup-result.js";

// ── 清理责任那一层**按需加载,不静态 import** ─────────────────────────────────────
//
// 它要读写 `agent_cleanup_debts`,所以静态 import 会把整个 db 层拖进这条 import 链 ——
// 而这条链的上游是 `executors/spawn.ts`、`executors/detached.ts`,连「只想按 pid 接管一个
// 还活着的 agent」的最小路径都会因此先去初始化数据库。实测后果:接管脚本启动慢了足够多,
// 被接管的 agent 在那之前就自己跑完退出了,接管于是失败(test:detached 在本轮回归里挂掉,
// 基线通过)。按需加载之后那条链回到原样,责任落盘只在真的要落时才付这个钱。

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 本文件自己要读结论里那句人话时用它(转出的 `cleanupDetail` 只是给外面的)。 */
const cleanupResultDetail = (result: CleanupResult): string =>
  result.kind === "empty" ? "" : result.kind === "silent" ? result.why : result.detail;

async function waitForPidsGone(pids: readonly number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let alive = pids.filter(isPidAlive);
  while (alive.length && Date.now() < deadline) {
    await wait(50);
    alive = pids.filter(isPidAlive);
  }
  return alive;
}

// 清理结论的代数(四档答案、两个问、判空的不变量)住在 `cleanup-result.ts`:它有三个
// 互不相识的使用方(本文件的即时清理、cleanup-debt.ts 的跨重启清扫、codex-resident.ts 的
// 多轮合并),而第 4 轮审查 F1 实测的那一下正是「各出口各判一套」的后果。

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
  // 这台机器结构性答不了「谁握着这个文件」时**不问,而且如实说这一问没有证据来源**
  // (`silent`,见 cleanup-result.ts 顶部)。记成「这一次没答出来」会让那个平台每个回合都欠
  // 一笔追不动的债(第 3 轮审查 N2);可记成「没有残留」就是第 4 轮审查 F1 那一下 —— 缺的是
  // 设备,不是资源。两个文件压根不存在才是正面的「没有东西能被握着」。
  if (!fileHoldersAnswerable()) {
    return trackPath || outPath
      ? { kind: "silent", why: "这台机器答不了「谁还握着这次运行的文件」(没有 lsof 等价物)" }
      : { kind: "empty" };
  }
  const [track, out] = await Promise.all([
    trackPath ? probeFileHolders(trackPath) : Promise.resolve(null),
    outPath ? probeFileHolders(outPath) : Promise.resolve(null),
  ]);
  return mergeClueAnswers([
    residueFromProbe("追踪文件", track), residueFromProbe("输出文件", out),
  ], "运行专属文件");
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
  try {
    return await sweepAndJudge(child);
  } catch (error) {
    // **这一问自己抛了也不许把责任丢了**(第 3 轮审查 F2 点名的第三个出口):异常往上抛
    // 之后,调用方那边有的会再试一次(codex 常驻把 child 留在 `unfinalized`),有的那条路
    // 根本没有第二次 —— `runs.ts` 的 `discardStartingRun` 已经把句柄注销、还按幂等记了
    // 「放弃过」,再调一次直接返回。线索只在这里拿得到(句柄在手),所以责任也只能在这里
    // 交出去:先记一笔「这一轮没问出结果」,再把异常原样抛给调用方。
    await handOffCleanupDebt({
      ...rootClues(child),
      unitToken: unitTokenOf(child),
      trackPath: trackPathOf(child),
      outPath: runOutPathOf(child),
      state: "unknown",
      detail: `清理这一问自己抛了:${error instanceof Error ? error.message : String(error)}`,
      unitVerdict: "unprovable",
    });
    throw error;
  }
}

async function sweepAndJudge(child: ChildProcess): Promise<CleanupResult> {
  const sweep = await sweepAfterRun(child);
  const token = unitTokenOf(child);
  const result = judgeCleanup(sweep, token);
  if (result.kind === "empty") {
    releaseTrackEvidence(child);
    // 销账只在**真的欠过**的时候才需要动库(绝大多数回合一次都没欠过),所以这一句同样
    // 按需加载;加载失败不影响这一轮的结论 —— 账留着,下一次清扫会确证它已经空了。
    //
    // **交的是整套线索,不是光一个记号**(第 3 轮审查 N8):没有记号的那些运行,账记在
    // `no-unit:<运行专属文件路径>` 这个键上,只给记号(`null`)永远对不上那一行,于是它
    // 一旦欠过就再也销不掉。销账那边还会锁内自证一次,不白信这里这句「空了」。
    await import("./cleanup-debt.js")
      .then((m) => m.settleCleanupDebt({
        unitToken: token, trackPath: trackPathOf(child), outPath: runOutPathOf(child),
      }))
      .catch(() => { /* 下一轮清扫再说 */ });
    return result;
  }
  // 还没收干净:**责任在这里就落盘**,不依赖任何调用方记得记一笔(它们三个各有各的
  // 结算要做,而这件事必须活得比它们都久 —— 见 cleanup-debt.ts 顶部)。
  // **没有记号也要试着记**(升级前建的老会话行):键退回路径线索,见 `debtKey`。
  const noted = await handOffCleanupDebt({
    ...rootClues(child),
    unitToken: token,
    trackPath: trackPathOf(child),
    outPath: runOutPathOf(child),
    state: result.kind === "remaining" ? "remaining" : result.kind === "silent" ? "silent" : "unknown",
    detail: cleanupResultDetail(result), unitVerdict: sweep.unit.verdict,
    // **点名了的那几个号跟着这一笔落库**:持久清扫只认结构化名单(第 8 轮审查 F1-A)。
    open: openOf(result),
  });
  // **三档各说各的**(第 2 轮审查 F1 末条):上一版把「写库失败」也印成「没有可追的线索」,
  // 等于把一次真正的责任丢失说成了「本来就没什么可追的」。
  const tail = {
    noted: ";已记下清理责任,开机会再追一次",
    untrackable: ";**没有可追的线索**(记号与两个运行专属文件都没有),只剩这条日志",
    // 落库失败那一档不是「只剩日志」了:那一笔留在进程内的待投清单上接着扛,每次清扫
    // 开头补投一遍(第 3 轮审查 F2)。它仍然跨不过重启,所以这句话得把这一点说出来。
    failed: ";**责任没能落盘**(库写失败),已留在内存里等补投 —— 但它跨不过重启",
  }[noted];
  console.warn(
    `[ash] 这一次运行的后代还不能证明收干净(pid=${child.pid ?? "?"}):`
    + `${cleanupResultDetail(result)}${tail}`,
  );
  return result;
}

/**
 * 落账要记的**根身份**:号 + 这一刻查到的启动时刻。
 *
 * 只记号是不够的 —— 号会被复用,清扫侧拿它只能问出「这个号上有进程」,问不出「还是它」,
 * 于是那一问永远停在「核验不了」。第 4 轮审查 F1 在 Windows 真机上同时验了两头:生产落账
 * 当时只写号(行上 `rootStartedAt=null`),而就算把精确时刻补上,清扫侧也压根没读它。
 * 现在两头都接上:这里负责记下来,`judgeDebtRow` 负责把它当一台设备来问。
 */
/**
 * 落账时记下的**根这一代**。记错一代比记不下来更坏,所以这一问宁可答「不知道」。
 *
 * 上一版无条件现查 `inspectProcess(pid)`:这句跑在收尾那一刻,而根很可能已经退了 —— 号被
 * 系统分给用户的别的程序之后,现查到的是**那个陌生进程**的启动时刻,它会被原样写进账上的
 * 「根这一代」。后果不是少记一笔,是记歪一笔:下一次清扫拿它去核 `processIdentity`,陌生进程
 * 的代次当然「对得上」,于是那一行永远停在「根进程还活着」,既销不掉,还把别人的进程指成
 * 我们这次运行的残留。(第 6 轮审查 N10)
 *
 * 两档各有各的权威来源:
 *  · 接回来的号 —— 用接管时核下来的那一代(`adoptedIdentityOf`),这一刻不许再现查;
 *  · 自己 spawn 的孩子 —— 只有「这个号此刻还是它」(内核权威答案)时现查才算它的代次,
 *    已经 reap 掉就记 null,让下一次清扫如实走到「没记启动时刻、核验不了」那一档(弃权收档)。
 */
function rootClues(child: ChildProcess): { rootPid: number | null; rootStartedAt: string | null } {
  // 每一问都单独兜住:这个函数有一半调用点在 catch 里(异常往上抛之前先把责任交出去),
  // 它自己再抛一次,交接那一步就整个没了 —— 句柄读属性是会抛的(合成句柄、Proxy 包装),
  // 而「问不出来」在这里有现成的如实答法:留空。`test:cleanup-debt` 第 12 组钉的是这一点。
  const adopted = tryAsk(() => adoptedIdentityOf(child));
  if (adopted) return { rootPid: adopted.pid, rootStartedAt: adopted.startedAt };
  const pid = tryAsk(() => child.pid ?? null);
  if (!pid) return { rootPid: null, rootStartedAt: null };
  const stillOurs = tryAsk(() => childStillOurs(child));
  return { rootPid: pid, rootStartedAt: stillOurs ? inspectProcess(pid)?.startedAt ?? null : null };
}

/** 问不出来就答 null(含「这一问本身抛了」):落账用得上的线索从不值得为它丢掉一笔责任。 */
function tryAsk<T>(ask: () => T): T | null {
  try { return ask(); } catch { return null; }
}

/**
 * 把这一笔责任交给持久层。**连交接层自己都加载不起来时也得留个接手的**(第 3 轮审查 F2)。
 *
 * 上一版这里 `catch` 到就打一条日志、返回 `failed` 收场:那一笔既没进库,也不在任何人手上,
 * 后面哪一次清扫都不会再想起它。按需加载失败几乎只会是数据库初始化那一侧出了事,而那恰恰
 * 是「等一会儿再试就好了」的那种 —— 所以这里留一份进程内的待交清单,定时重试。
 * (落库本身失败那一档由 `cleanup-debt.ts` 自己的待投清单接着扛,两边各管自己那一段。)
 */
async function handOffCleanupDebt(
  input: CleanupDebtInput,
): Promise<"noted" | "untrackable" | "failed"> {
  try {
    const layer = await import("./cleanup-debt.js");
    return await layer.noteCleanupDebt(input);
  } catch (error) {
    console.error("[ash] 清理责任这一层加载失败,这一笔先留在内存里等重试:", error);
    keepUndelivered(input);
    scheduleRedelivery();
    return "failed";
  }
}

/**
 * 连持久层都没加载起来的那几笔,**按这一次运行去重**(第 4 轮审查 N3)。
 *
 * 上一版是个数组、一笔一笔 `push`:同一次运行反复交不出去时会在清单上堆好几份旧结论,
 * 补交按入列顺序一个个投,于是**旧的那一版最后落库、盖掉新的**。键按同一套线索算
 * (记号优先、退回运行专属文件路径,同 `debtKey`),所以同一次运行只会占一格、留最新那版。
 */
const undelivered = new Map<string, CleanupDebtInput>();
let redeliveryTimer: ReturnType<typeof setTimeout> | null = null;
const REDELIVERY_DELAY_MS = 30_000;

/** 只为去重算的键 —— 真正落库用哪个键由 `cleanup-debt.ts` 的 `debtKey` 说。 */
const undeliveredKey = (input: CleanupDebtInput): string =>
  input.unitToken || input.outPath || input.trackPath || "no-clue";

function keepUndelivered(input: CleanupDebtInput): void {
  undelivered.set(undeliveredKey(input), input);
}

function scheduleRedelivery(): void {
  if (redeliveryTimer || !undelivered.size) return;
  redeliveryTimer = setTimeout(() => {
    redeliveryTimer = null;
    const batch = [...undelivered.values()];
    undelivered.clear();
    void (async () => { for (const one of batch) await handOffCleanupDebt(one); })();
  }, REDELIVERY_DELAY_MS);
  // 不拿住事件循环:这件事不该让一个本来可以退出的进程多活着。
  (redeliveryTimer as { unref?: () => void }).unref?.();
}

/** 披露用:这一刻有几笔责任连持久层都还没交出去。 */
export const undeliveredCleanupDebtCount = (): number => undelivered.size;

type SweepOutcome = {
  /** 这一轮每一问都答出来了吗。 */
  answered: boolean;
  /** 没答出来的那几问,人话。 */
  faults: string[];
  /** 点名了、却排除不掉的号(见 `EscapeeSweep.open`):跟着责任落库,销账要逐个核过它们。 */
  open: CleanupOpen[];
  /** 记号那一问最后一次的结论。 */
  unit: UnitEvidence;
  /** 补刀之后仍然活着的号。 */
  survivors: number[];
  /**
   * **根这一问的答案**(判空的两个问之一,见 cleanup-result.ts 顶部)。
   *
   * 设备是内核权威的句柄状态 + 这一轮下过的刀:
   *  · 根出现在残存者名单里 ⇒ 正面证明还在;
   *  · 根还占着那个号、而我们又证不出它归谁(探活档说有、授权档不敢碰)⇒ 同样是**仍能
   *    检测到的残留**:我们一刀都没敢发,所以它不会出现在 `survivors` 里 —— 上一版于是把
   *    这一轮判成了「确证清空」,顺手释放证据、销掉责任(第 2 轮审查 F2 的核心场景);
   *  · 其余 ⇒ 正面证明它退了(内核已 reap / 号已换主,或者这一轮朝它开过刀、2 秒复查时
   *    那个号上已经没有它)。失败桩压根没有真实进程,那是「没有资源」⇒ 也算正面的空。
   *
   * 正常路径落在最后一档:根退场后探活档答 `gone`,所以每个回合不会平白欠一笔债。
   */
  rootProof: CleanupResult;
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
 * **根这一问的答案**(见 `SweepOutcome.rootProof`)。设备是内核权威的句柄状态 + 这一轮的刀。
 *
 * `lingers` 两档合起来才成立(见 child-identity.ts):探活档说「那个号上还有东西」,授权档说
 * 「不敢碰」—— 两句都成立时这一轮既杀不掉、也不许自称收干净。
 */
function rootProofOf(child: ChildProcess, survivors: readonly number[], lingers: boolean): CleanupResult {
  const pid = child.pid;
  // 压根没有真实进程(失败桩):缺的是**资源**不是设备 ⇒ 这一问正面答空(cleanup-result.ts 顶部)。
  if (!pid) return { kind: "empty" };
  if (survivors.includes(pid)) return { kind: "remaining", detail: `根进程 ${pid} 下过刀仍活着` };
  if (lingers) {
    return {
      kind: "remaining",
      detail: "根进程还在那个号上,但证不出它属于这一次运行(粗档 pid 不是排他凭证)",
    };
  }
  // 要么内核已经确认它退了(已 reap / 号已换主),要么这一轮朝它开过刀、2 秒复查时那个号上
  // 已经没有它 —— 两种都是正面的退出证明。
  return { kind: "empty" };
}

/**
 * 把这一轮的全部线索并成一个结论,**判据借 `judgeByClues`** —— 跟跨重启那条清扫路共用
 * 同一条判空不变量(第 4 轮审查 F1:「各出口同用一条能证明清空的不变量」)。
 *
 * **`empty` 的门槛是「根与后代两问都有正面答案」**,所以这里不再逐条 early return,而是
 * 每条线索各自表态、声明自己在答哪一问 —— 判空少问一条线索,就是第 2 轮审查 F1 的那个
 * 漏洞;而逐条 return 的写法让「少问一条」永远只差一次疏忽。
 *
 * 即时路径比清扫路径多一台后代设备:**逃逸扫描**(继承 fd + 记号 + ppid 树)。它答出来了
 * 且没有残存者,后代这一问就有了正面答案 —— 于是 Windows 上那两台结构性弃权的设备
 * (记号、运行专属文件)不会把每个正常收尾的回合都变成一笔追不动的债(第 3 轮审查 N2),
 * 而弃权本身仍然如实记在那一问里。
 */
function judgeCleanup(sweep: SweepOutcome, token: string | null): CleanupResult {
  const reasons = [...sweep.faults];
  const clues: ClueAnswer[] = [
    { subject: "root", answer: sweep.rootProof },
    // 两个运行专属文件的终态:这一条独立于记号(见 `SweepOutcome.residue`)。
    { subject: "descendants", answer: sweep.residue },
  ];
  // 记号那一问**有记号才有这台设备**:种失败的那些压根没这条线索。
  if (token) {
    if (sweep.unit.verdict === "ours" || sweep.unit.verdict === "suspected") {
      clues.push({ subject: "descendants", answer: { kind: "remaining", detail: describeEvidence(sweep.unit) } });
    } else if (sweep.unit.verdict === "none") {
      clues.push({ subject: "descendants", answer: { kind: "empty" } });
    } else if (monitorUnitAnswerable()) {
      // `unprovable` 有两种,处置相反(第 3 轮审查 N2):这一次查询失败 ⇒ 留着重试……
      reasons.push("资源记号这一问没答出来");
    } else {
      // ……而**这台机器结构性读不到别的进程的环境块**(win32)⇒ 重试一万次也是同一个答案。
      // 它不是「没有残留」(第 4 轮审查 F1),是这一问**没有证据来源**:如实弃权。
      clues.push({
        subject: "descendants",
        answer: { kind: "silent", why: "这台机器读不到别的进程的环境块,问不出带这次记号的进程" },
      });
    }
  }
  // 逃逸扫描这台设备:问全了才有发言权,残存者是最硬的那种残留证据。
  // 未排除的号挂在这一条上(它就是报上来的那一台设备):`empty` 那一档在类型上带不了它们,
  // 所以「手里还攥着号、却答空」在这里编译不过(见 cleanup-result.ts 的 `openGuard`)。
  const open = sweep.open;
  clues.push({
    subject: "descendants",
    answer: sweep.survivors.length
      ? { kind: "remaining", detail: `下过刀仍活着:${sweep.survivors.join(",")}`, open }
      : !sweep.answered || reasons.length
        ? { kind: "unknown", detail: reasons.join(";") || "有一问没答出来", open }
        : open.length
          ? { kind: "unknown", detail: `还有排除不掉的号:${describeOpen(open)}`, open }
          : { kind: "empty" },
  });
  return judgeByClues(clues);
}

/**
 * 实际的清扫:TERM → 等 2 秒 → KILL。返回**这一轮问清楚了多少**(见 `SweepOutcome`)。
 *
 * 上一版只把**最前面那一次** fd 查询的成败记进 `probed`,后面三问(进程树、第二次 fd 查询、
 * 最终残存者)失败一律吞掉 —— 于是「第一问答出来了」被当成「整轮都问清楚了」,照样走到
 * 释放证据那一句(本轮审查 F2 第 5 点)。现在每一问的失败都如实并进来。
 */
async function sweepAfterRun(child: ChildProcess): Promise<SweepOutcome> {
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
  const settle = async (answered: boolean, survivors: number[]): Promise<SweepOutcome> => {
    // **逃逸扫描也在收尾之后重新问一遍**(第 8 轮审查 F1-B)。上一版把**下刀之前**那次扫描的
    // `answered` 原样当成最终结论:那次读数拍在「还没给根发 TERM」的时刻,而要下的结论是
    // 「停止之后这次运行还有没有后代」—— 根在收到信号之后、退出之前起的后代,整个窗口没有
    // 任何一次读数覆盖得到。记号和两个文件早就在这里重问了(第 2 轮审查 N1),父子树这一台
    // 偏偏还用着旧读数,于是三台设备里最有能力看见「新出生的后代」的那台用的是最旧的事实。
    //
    // 平台边界如实记在这里:**这一问只覆盖「还留着三条线索中任意一条」的后代** —— 收尾窗口里
    // 新起、又同时 `env -i` 洗掉记号、close 掉继承 fd、`setsid` 脱离进程树的那种,在当前平台上
    // 跟一个陌生进程读不出任何差别(`closed_at` 那段注释说的就是这条边界)。
    const final = await collectEscapees(child);
    const live = final.targets.filter((m) => isPidAlive(m.pid));
    return {
      answered: answered && final.answered,
      faults: [...faults, ...final.faults.filter((f) => !faults.includes(f))],
      open: [...final.open, ...live.map((m) => ({
        pid: m.pid, gen: m.gen, why: "这次运行的后代,收尾之后仍活着",
      }))],
      // 残存者两份并起来:这一轮朝它开过刀还活着的,以及收尾之后这次扫描新认下来的活成员。
      survivors: [...new Set([...survivors, ...live.map((m) => m.pid)])],
      // 根那一问只看**朝它开过刀之后**还在不在,跟新扫到的后代无关,所以用原来那份名单。
      rootProof: rootProofOf(child, survivors, lingers()),
      unit: final.unit,
      residue: await finalResidue(child),
    };
  };
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
  const state = reclaimState(pid, startedAt ?? null, unit);
  if (canShoot(state)) {
    killProvenUnit(pid, startedAt ?? null, unit);
    return;
  }
  // ①' **明确的反证不许被后面任何一条弱证据洗掉**(第 3 轮审查 F1 实测)。
  //
  // 那七档不是一个梯度,是两类:`not-ours` 是**正面反证** —— ps 答出来了,这个号上现在是
  // 另一个进程(启动时刻确实对不上,locale 差异由 `processIdentity` 在同一份快照上兜住)。
  // 其余几档是「这一问没答出来」。上一版把两类一视同仁地落进下面那个后备分支,于是
  // 「已经证明它不是我们的」被一条「它打开过我们的输出文件」顶掉,`killTree` 往它那一组
  // 发了信号 —— 审查用真实只读查看器实测:记录指向旧代、这个号上已经是查看器,查看器收到
  // SIGTERM 死掉了。
  //
  // 为什么输出文件那条线索在这里不能当反驳:它最多证明「这个进程握着这个文件」,而我们要
  // 回答的是「这个号上的进程是不是当初那一个」—— 后者 ps 已经明确答了「不是」。一条更弱的
  // 证据推不翻一条更强的反证,何况下刀打的是**它那一组**。
  if (state === "not-ours") {
    console.warn(
      `[ash] pid=${pid} 这个号上现在是另一个进程(记录在案的启动时刻对不上),`
      + "按「证不出就不下刀」处理:没有发送任何信号 —— 握着输出文件也不改变这个结论",
    );
    return;
  }
  // ② 记号证不出来(最常见的是这一行建在记号上线之前,库里只有 pid)。POSIX 的秒级启动
  // 时刻是粗档,单凭它下刀就是在赌一次秒级碰撞 —— 那是明确实测过的误杀。
  //
  // 但 agent 这一侧还有一条哨兵没有的线索:这一次运行独有的输出文件。根进程的 stdout 就
  // 重定向在它上面,路径里带着 sessionId + 回合起点,别的运行不会碰它,而且它跟记号一样
  // 跨得过 server 重启(`sessions.agent_out_path`)。它读的是 `lsof` 的**真实 fd 表**,
  // 不是 macOS 上那种无边界的展示文本 ⇒ 精确可答,够当粗档要的那第二份独立证据。
  //
  // **但它只是「第二份证据」,不是「反证的解药」**:上面 ①' 已经把 `not-ours` 挡在外面了。
  // 这一档要的是「身份这一问没答出来」时的补充,不是「身份这一问答了不是」时的推翻。
  //
  // 而且判据收得很紧(`outPathProvesRoot`):**fd 1 且写模式**,也就是「这个进程的标准输出
  // 就是这个文件」。光「打开过这个文件」不算 —— 用户 tail 日志也打开过它(第 3 轮审查 F1)。
  // 它只证明得了**根**(fd 1 无条件继承,但 CLI 会把它自己子进程的 stdout 接成管道),
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
      //
      // ①' 那条反证在这里**一样压过输出文件**(第 3 轮审查 F1:首刀与补刀是两个对称消费点,
      // 不许只有一个认这条反证):这两秒里 ps 可能已经答得出「这个号上现在是另一个进程」,
      // 那一刻即便文件那一问还说得通,也只说明有人握着这个文件,不说明这个号还是当初那个。
      if (reclaimState(pid, startedAt ?? null, unit) === "not-ours") {
        console.warn(`[ash] pid=${pid} 在这两秒里换了主人(记录在案的启动时刻对不上),补刀取消`);
        signalMembers(held.filter((m) => m.pid !== pid), "SIGKILL");
        return;
      }
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
    `[ash] 没能证明 pid=${pid} 属于这一次运行(身份这一问停在 ${state}、`
    + `输出文件${proof?.outPath ? "上没有它的 stdout" : "未提供"}),`
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
    const out = execFileSync("lsof", ["-F", "pfan", "--", outPath], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000,
    });
    // **要的不是「它打开过这个文件」,是「它的 stdout 就是这个文件」**(第 3 轮审查 F1)。
    // 上一版只比号码,于是只读打开同一个日志的查看器也拿到了整组击杀的授权。fd 1 + 写模式
    // 才等价于「这个进程的标准输出重定向在这一次运行的输出文件上」—— 那正是根的形状,
    // 而看客拿到的是另一个 fd、只读。
    let cur = 0, fd: number | null = null;
    for (const raw of out.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      const tag = line[0], value = line.slice(1);
      if (tag === "p") { cur = Number(value) || 0; fd = null; continue; }
      if (tag === "f") { fd = Number.isInteger(Number(value)) ? Number(value) : null; continue; }
      if (tag === "a" && cur === pid && fd === 1 && /[wu]/.test(value)) return true;
    }
    return false;
  } catch {
    return false;                                 // 非零退出(无匹配)与查询失败都不算证明
  }
}
