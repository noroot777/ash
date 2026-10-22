// agent 进程的**生命周期收口**:三层击杀,以及「这一次运行收干净了没有」这个结论。
//
// 这一摊曾经把四件事挤在一个文件里(击杀、逃逸枚举、追踪证据的寿命、进程身份判据),
// 一路顶到 680 行。本轮按职责拆开,**依赖是单向的**:
//
//   child-identity.ts   「这个号此刻还是不是它」—— 无依赖,三方共用
//   track-evidence.ts   追踪 fd / 「谁还握着它」三档 / 租约 / 启动期清扫
//   escapees.ts         逃逸后代的枚举与下刀(根授权 → 整棵子树)
//   kernel-confine.ts   **内核圈定**:cgroup v2 / Job Object 维护的确定集合(+ confine-job.ts)
//   cleanup-debt.ts     「没收干净」这件事的持久化与重试
//   kill-by-pid.ts      只有 pid 时的击杀(重启后接管那条路)
//   kill.ts(本文件)   三层击杀 + 把上面几层的结论汇成一个清理结果
//
// 这一摊的回归分在四条里(`server/CLAUDE.md` 的表里只列得下第一条),各自覆盖的范围:
//   test:process-identity   身份判据与三层击杀(「这个号此刻还是不是它」)
//   test:process-subtrees   快照形状、子树归属、持有者这一问的三档
//   test:cleanup-debt       清理结论的三档 + 责任落账/披露/重试/授权
//   test:kernel-confine     内核圈定:确定集合的枚举/击杀,以及「答不出来就退回原路」
//
// 老使用方照旧从 `spawn.js` / `kill.js` import:下面把各层的导出原样转出去。
import type { ChildProcess } from "node:child_process";
import { isPidAlive, killTree } from "../platform.js";
import { inspectProcess, type UnitEvidence } from "../proc.js";
import { monitorUnitAnswerable } from "../monitor-unit-scan.js";
import { runOutPathOf, unitTokenOf } from "./unit-token.js";
import { adoptedIdentityOf, childKillAuthorized, childStillOurs } from "./child-identity.js";
import {
  fileHoldersAnswerable, probeFileHolders, releaseTrackEvidence, trackPathOf,
} from "./track-evidence.js";
import {
  collectEscapees, describeEvidence, killEscapees, ledgerOf,
} from "./escapees.js";
import {
  confinedResidue, judgeByClues, mergeClueAnswers, nothingToCollect, openLedger, openOf,
  residueFromProbe, sweptClean, unitOpen,
  type CleanupOpen, type CleanupResult, type ClueAnswer, type OpenLedger,
} from "./cleanup-result.js";
// 内核圈定那台设备(cgroup v2 / Job Object)。它只报读数,判定仍在 cleanup-result.ts。
import { confinementOf, type ConfineRead, type Confinement } from "./kernel-confine.js";
// 交接那一段路住在 cleanup-handoff.ts:它对持久层只借类型 + 按需加载(那一层会拉起整个 db
// 层),所以从这里过去也不长出静态依赖。
import { handOffCleanupDebt } from "./cleanup-handoff.js";

// 各层原样转出去:`import { childStillOurs } from "./kill.js"` 这类既有写法照旧能用。
export { killByPid } from "./kill-by-pid.js";
export {
  childStillOurs, markAdoptedChild, pidRunStillAlive, shareChildIdentity,
} from "./child-identity.js";
export {
  openTrackFd, registerTrackFd, releaseTrackEvidence, shareTrackFdRegistration,
  sweepOrphanTrackFiles,
} from "./track-evidence.js";
export {
  cleanupDetail, cleanupRetriable, cleanupSettled, mergeCleanupResults, nothingToCollect,
  residueFromProbe, sweptClean,
  type CleanupResult,
} from "./cleanup-result.js";
export {
  confineAbstention, confinementOf, openConfinement, registerConfinement, shareConfinement,
  type Confinement,
} from "./kernel-confine.js";

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
      ? {
        kind: "silent", why: "这台机器答不了「谁还握着这次运行的文件」(没有 lsof 等价物)",
        open: [],                                 // 这条线索压根没问,所以它没点过任何名
      }
      : nothingToCollect();                       // 两个文件都不存在 ⇒ 没有东西能被握着
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
 * **圈里这一刻的成员入账**(只增不减,同记号那一台的理由):确证属于这次运行的那一刻就是
 * 一份责任,直到有它的退出证据 —— 哪怕下一句就要朝它开刀。杀没杀成由后面那次读数说。
 *
 * 读不出来 / 没有圈 ⇒ 什么都不加,读数原样往上传(由 `confinedResidue` 分档)。
 */
function confineOwn(
  owed: OpenLedger, confine: Confinement | null, why: string,
): ConfineRead | null {
  if (!confine) return null;
  const read = confine.read();
  if (read.kind === "members") owed.own(read.members, why);
  return read;
}

/** 收尾之后那一次读数(判空就用这一份)。 */
const confineSettle = (owed: OpenLedger, confine: Confinement | null): ConfineRead | null =>
  confineOwn(owed, confine, "收尾之后内核圈定下仍在册的成员");

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
    // 圈也撤掉。**非空的圈撤不掉**(内核拒绝 rmdir / Windows 那边守圈进程自己还在守),
    // 所以这一句不会把一个还有成员的集合抹掉。
    confinementOf(child)?.dispose();
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
  /**
   * **内核圈定这台设备的读数**(见 kernel-confine.ts)。`null` = 这一次运行没有圈
   * (macOS 恒是这一档、建圈失败也是)⇒ 判定原样退回其它几台设备。
   *
   * 它跟上面那几条不是一个量级:那些都是事后推断,各自都有「这一刻问不出来」这一档;
   * 这一份的集合由内核维护。所以它答得出来时压过其它设备(`confinedResidue`),答不出来
   * 时一个字都不说 —— 这条「退回原路」由 `test:kernel-confine` 钉住。
   */
  confine: ConfineRead | null;
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
  if (!pid) return nothingToCollect();            // 失败桩:没有真实进程 ⇒ 资源缺,正面答空
  // 根这一问的责任由债表行上的 `rootPid` + 启动时刻那台设备跨重启地背着(见
  // cleanup-debt-judge.ts 的 `rootResidue`),所以这里不往后代名单里按号点名。
  if (survivors.includes(pid)) {
    return { kind: "remaining", detail: `根进程 ${pid} 下过刀仍活着`, open: [] };
  }
  if (lingers) {
    return {
      kind: "remaining",
      detail: "根进程还在那个号上,但证不出它属于这一次运行(粗档 pid 不是排他凭证)",
      open: [],                                   // 证不出归属的号不许点名(同上)
    };
  }
  // 要么内核已经确认它退了(已 reap / 号已换主),要么这一轮朝它开过刀、2 秒复查时那个号上
  // 已经没有它 —— 两种都是正面的退出证明。
  return sweptClean([]);                          // 内核确认它退了 / 下过刀复查时号上已没有它
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
  // **内核圈定答得出来就是它说了算**(判据与理由见 cleanup-result.ts 的 `confinedResidue`)。
  // 它答不出来(没圈、或者圈只罩住了「圈定之后」那一段而集合是空的)就一个字都不说,
  // 下面那套设备原样照跑 —— 新设备的存在不许放松任何既有判据。
  const confined = confinedResidue(sweep.confine, sweep.open);
  if (confined) return confined;
  const reasons = [...sweep.faults];
  const clues: ClueAnswer[] = [
    { subject: "root", answer: sweep.rootProof },
    // 两个运行专属文件的终态:这一条独立于记号(见 `SweepOutcome.residue`)。
    { subject: "descendants", answer: sweep.residue },
  ];
  // 记号那一问**有记号才有这台设备**:种失败的那些压根没这条线索。
  if (token) {
    if (sweep.unit.verdict === "ours" || sweep.unit.verdict === "suspected") {
      clues.push({
        subject: "descendants",
        answer: {
          kind: "remaining", detail: describeEvidence(sweep.unit),
          // **`ours` 的成员点名,`suspected` 不点**(判据见 cleanup-result.ts 的 `unitOpen`):
          // 前者是真实环境项读出来的 pid + 同源代次,后者只是 `ps -E` 的展示文本。这一档
          // 上一版一律给空名单,于是「这一刻确证还有成员」下一刻被 exec 洗成 none 就销了账
          // (第 11 轮审查 F1)。
          open: unitOpen(sweep.unit, "记号认下的本次运行成员"),
        },
      });
    } else if (sweep.unit.verdict === "none") {
      clues.push({ subject: "descendants", answer: nothingToCollect() });
    } else if (monitorUnitAnswerable()) {
      // `unprovable` 有两种,处置相反(第 3 轮审查 N2):这一次查询失败 ⇒ 留着重试……
      reasons.push("资源记号这一问没答出来");
    } else {
      // ……而**这台机器结构性读不到别的进程的环境块**(win32)⇒ 重试一万次也是同一个答案。
      // 它不是「没有残留」(第 4 轮审查 F1),是这一问**没有证据来源**:如实弃权。
      clues.push({
        subject: "descendants",
        answer: {
          kind: "silent", why: "这台机器读不到别的进程的环境块,问不出带这次记号的进程",
          open: [],
        },
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
        // 名单空了才答得出空来 —— 这一句不再是这里的 if,而是 `sweptClean` 的签名
        // (手上有名单就合不出 `empty`,见 cleanup-result.ts 的闸一)。
        : sweptClean(open),
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
  // 内核圈定那台设备:**在既有三层击杀之外另加一层**,先把圈里的成员认下来再下刀。
  // 它罩得住「三条线索全断」的那一类后代(`env -i` + close 掉继承 fd + `setsid`),
  // 而那正是其它几台设备结构性看不见的那一种。
  const confine = confinementOf(child);
  const first = await killEscapees(child, "SIGTERM");
  // 两档问的是两件事(见 child-identity.ts):探活档说「那个号上还有东西」,授权档说
  // 「敢不敢碰」。两句都成立时这一轮就既杀不掉、也不许自称收干净。
  const lingers = (): boolean => !!child.pid && childStillOurs(child) && !childKillAuthorized(child);
  const faults = [...first.faults];
  /**
   * **这一次清理「还欠谁」的那本账**(第 9 轮审查 F1-A、第 10 轮审查 F1-A)。
   *
   * 身份有五个来源,少并一个就漏一次责任,所以它们只在这一本账上汇总(见 `openLedger`):
   *  ① 三次扫描各自**点的名**(`.open`:父边问不出来、代次核验不了的那些);
   *  ② 每一次扫描**确认归属**的成员(`.targets`)—— 认下那一刻起就是责任;
   *  ③ 跨得过「丢了 fd」的那本后代账(`ledgerOf`)。
   *
   * 为什么②③也必须进:核验不了代次的成员会被**正确地**放过(不敢下刀),于是它既不是
   * 残存者、也不在那一轮的 `.open` 里;而收尾那次扫描又因为它已被重父到 1 号名下而看不见
   * 它 —— 上一版据此答 `empty`、债表 0 笔,而它还在写(第 10 轮审查实测,心跳 107→117)。
   *
   * 「这一次没看见」不是退出证明。要从账上消失只有一条路:`dischargeOpen` 给出的退出证据。
   */
  const owed = openLedger();
  owed.add(first.open);
  owed.own(first.targets, "本次运行已确认的后代,还没有它的退出证据");
  // 记号那一台**每一次**答 `ours` 都要入账(第 11 轮审查 F1):它跨不过 `exec`,所以
  // 「这一次确证过」是唯一的窗口,错过就再也问不出来了。
  owed.add(unitOpen(first.unit, "记号认下的本次运行成员"));
  // 圈里的成员**在下刀之前就入账**:认下那一刻起就是一份责任(同记号那一台的理由)。
  // 这里不因为「它马上要被杀掉」就省掉这一步 —— 杀没杀成由后面的读数说,不由这里猜。
  confineOwn(owed, confine, "下刀之前内核圈定认下的成员");
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
    // 收尾这次的三份身份一起入账(见 `owed` 那段的①②③)。`ledgerOf` 这一份是关键的那条:
    // 它记着**这一轮认过的全部后代**,所以「这一刻的视野里看不见了」不等于它退了。
    owed.add(final.open);
    owed.add(unitOpen(final.unit, "记号认下的本次运行成员"));
    owed.own(final.targets, "这次运行的后代,收尾之后仍活着");
    owed.own(ledgerOf(child), "本次运行认下过的后代,这一刻的视野里不一定看得见");
    // 账本自己核销一遍:确证退了的(号上没人 / 同一坐标系里换了代)就地消解 —— 所以正常
    // 收尾不会因为中途出现过一次瞬时空洞、或者某个后代正常退出过,而平白押一笔债。
    const left = owed.left();
    return {
      answered: answered && final.answered,
      faults: [...faults, ...final.faults.filter((f) => !faults.includes(f))],
      open: left,
      // 残存者两份并起来:这一轮朝它开过刀还活着的,以及收尾之后这次扫描新认下来的活成员。
      // **「不敢下刀」的那些不进这里**:这一档的说法是「下过刀仍活着」,把没下过刀的算进来
      // 等于让 detail 说假话。它们的责任由上面那本账背着(`open`),一个都不会少。
      survivors: [...new Set([...survivors, ...live.map((m) => m.pid)])],
      // 根那一问只看**朝它开过刀之后**还在不在,跟新扫到的后代无关,所以用原来那份名单。
      rootProof: rootProofOf(child, survivors, lingers()),
      unit: final.unit,
      residue: await finalResidue(child),
      // **收尾之后才读这个集合**(同 `finalResidue` 的理由):下刀之前那次读数说明不了
      // 下刀之后的事。读到的成员一并入账,它们是内核证明过归属的号。
      confine: confineSettle(owed, confine),
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
  // **整圈也挨这一刀**。归属已经由内核证明,所以这一刀不需要先过一遍身份判据 —— 那几台
  // 设备的判据是为「只有一个号、证不出归属」那种情形准备的。圈是空的就是空操作。
  confine?.killAll("SIGTERM");
  if (!targets.size && !confine) return settle(first.answered, []);

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
  // 整圈的 SIGKILL 走 `cgroup.kill`:一次写入原子地带走整棵子树,连「读到号 → 发信号」
  // 之间那条号被复用的缝都没有(Windows 那边是 `TerminateJobObject`,同样是整圈一次)。
  confine?.killAll("SIGKILL");
  const second = await killEscapees(child, "SIGKILL");
  faults.push(...second.faults.filter((f) => !faults.includes(f)));
  owed.add(second.open);                          // 第二次扫描点的名同样只增不减
  owed.add(unitOpen(second.unit, "记号认下的本次运行成员"));
  owed.own(second.targets, "本次运行已确认的后代,还没有它的退出证据");
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
  // 整圈一起:stop 的语义就是全家结束,而内核圈定是唯一一台「全家」答得准的设备。
  confinementOf(child)?.killAll("SIGTERM");
  const t = setTimeout(() => {
    signal("SIGKILL");
    // 无论 CLI 死没死透,逃逸者一律补 SIGKILL —— stop 的语义就是全家结束。
    void killEscapees(child, "SIGKILL").catch(() => {});
    confinementOf(child)?.killAll("SIGKILL");
  }, 2000);
  // Don't keep the event loop alive just for the fallback timer.
  (t as { unref?: () => void }).unref?.();
}
