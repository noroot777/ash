// **逃逸后代的枚举与下刀**:谁属于这一次运行、凭什么属于、每一刀之前怎么重核。
// 进程组击杀(kill -pid)只覆盖「还留在 agent 进程组里」的后代。但 codex/claude
// 的 exec 层会给命令另开进程组,命令再 nohup/& 一放、父进程一退,整条流水线就
// 变成 ppid=1、自成一组的孤儿 —— 组杀和树遍历都追不到(真实案例:暂停分组后
// TTS 流水线 run_youtube_pipeline.sh 一家五口继续后台跑)。
// 解法:spawn 时塞一个指向「本次运行专属追踪文件」的继承 fd(stdio[3])。所有
// 后代都会带着这个 fd(bash/nohup 不关高位 fd),无论怎么改组、被谁收养;停止
// 时 `lsof -t <file>` 反查持有者,再从每个持有者向下走 ppid 树补上被 python
// close_fds 掐断继承的孙进程。局限:双 fork 且中间
// 层已死、又恰好隔着一层 close_fds 的深孤儿仍可能漏(实践中极少)。
//
// **Windows 上这一层仍然比 POSIX 弱,但正常收尾那条路可以补。** 两个差异:
//  · 继承 fd 反查没有零依赖等价物(handle.exe 要单独装、要管理员),所以
//    Windows 上根本不开追踪文件,只剩 ppid 树遍历这一半。
//  · Windows 不做 reparent,孤儿的 ParentProcessId 保留着已死父进程的号 ——
//    CLI 活着时从它往下走得到;CLI 已死以后如果把它的 pid 一起忘了,就再也找不到入口。
//    RunHandle 因此在事件流收尾时调用 cleanupAfterRun:ChildProcess 还握在手里,哪怕根
//    进程刚退出,仍能拿它的旧 pid 走这棵保留下来的 ppid 树。server 重启后句柄丢了、
//    或 pid 已经被复用的深孤儿仍然无解,所以 Windows 依旧是尽力而为,不是等价保证。
//
// **那棵保留下来的 ppid 树不是白给的,它要两份证据才算数**,各住一个文件(第 17 轮审查):
//  · `root-life.ts` —— 我们那一代根的**存活区间**。「活着才取得到」,所以登记在**创建那一刻**
//    (清扫时再取就晚了:正常完成那条路跑在根 reap 之后),而且只有**确证退出**能封上界
//    (「这一轮读不到」不是反证);
//  · `lineage.ts`   —— 从拓扑生成可击杀目标时**逐边核父代**。裸父号证明不了「是当前这一代
//    生的」,所以每一条授权传播边都要自己拿得出证明,拿不出就不许变成可击杀成员。

import type { ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { isPidAlive, killOne } from "../platform.js";
import { processUnitEvidence, type UnitEvidence } from "../proc.js";
import { monitorUnitAnswerable } from "../monitor-unit-scan.js";
import {
  processTableSnapshot, stillSameGeneration,
  type ProcessGeneration, type ProcessMember, type ProcessTableSnapshot,
} from "../process-generation.js";
import {
  earliestStartMs, genResolutionMs, genStartedAtMs, subtreesOf, unresolvedTopology,
  type ProcessSubtree,
} from "../process-subtrees.js";
import { siftLineage, type LineageStand } from "./lineage.js";
import { observeRootLife, rootStand } from "./root-life.js";
import { windowsExecutionRoot } from "./windows-run-evidence.js";
import { joinOpen, unitOpen, type CleanupOpen } from "./cleanup-result.js";
import { runOutPathOf, unitTokenOf } from "./unit-token.js";
import {
  holderMayOwn, holderScanFault, holdersMayExist, noSuchFileProbe, probeFileHolders, trackPathOf,
} from "./track-evidence.js";

// ── 归属事实 + 同源代次:**一份身份事实,探活 / 扩树 / TERM / 补刀共用** ──────────
//
// 号码不是身份。以前这一层对后代只有「号码」一个抓手,于是两头都错:
//
//  · **漏杀** —— 补刀前重新取证,取不到就当「这个号已经换了主人」而放过。可一个还活着的
//    后代完全可以**自己把那个继承 fd 关掉**(收到 SIGTERM 时顺手 close 的程序不少),它于此
//    一刻从 lsof 名单里消失,却继续在用户的工作目录里写文件(第 3 轮审查 F1 用生产
//    `openResident` + 真后台 Node 实测:心跳从 17 涨到 156,`stopResult=false`);
//  · **误杀** —— 反过来,先读到裸号码、隔着一次 await 再去问进程表要启动时刻,那个号这期间
//    换了主人时,新进程的代次就被写到了旧事实上,TERM 和补刀照着它下刀。
//
// 两头的根因是同一个:**事实和它那一代没有绑在一起**。所以这一层照 process-generation.ts
// 的规矩来 ——
//
//  ① 取证那一次读数**自己把代次带出来**(`processTreeMembers`:Linux 一次 `/proc/<pid>/stat`
//     同时给出 ppid 和 starttime,其它 POSIX 是 `ps` 的同一行,Windows 的进程表行自带);
//  ② 认过的后代**记在账上**(`escapeeLedger`),它丢掉 fd 也不会从账上消失;
//  ③ **每一刀之前拿账上那个戳重问一遍这个号**(`stillSameGeneration`)——
//     对得上就照杀(fd 丢了也杀),换代了就一刀都不发(号换了主人不杀)。
//
// fd 持有者那一步还隔着一次 `lsof`(它给不出启动时刻),所以用**两次取证夹住中间那次代次
// 读数**:只有前后两次 lsof 都认的号才进账。中间换了主人的号进不来 —— 新主人要同时握着
// 这个运行专属的文件,除非它本来就是我们的后代。
const escapeeLedger = new WeakMap<ChildProcess, Map<number, ProcessGeneration>>();

function rememberEscapees(child: ChildProcess, members: readonly ProcessMember[]): void {
  let ledger = escapeeLedger.get(child);
  if (!ledger) escapeeLedger.set(child, (ledger = new Map()));
  // 同一个号的代次变了 = 原来那个退了、这个号现在是另一个进程:**用这一次取证的那一代覆盖**
  // (能取到证就说明它也是我们的后代),而不是守着旧戳。
  for (const member of members) ledger.set(member.pid, member.gen);
}

/**
 * 「本次运行开工之前它就在」这一条的容差。
 *
 * 跟父子边那一条**不是同一个尺度**,所以不共用一个常数:那边比的是同一张表上两个戳
 * (容差按各自精度算,见 `genResolutionMs`),这边的另一端 `runBeganAtMs` 可能来自秒级的
 * `ps -o lstart`、也可能来自文件创建时刻 —— 取两者里最粗的那一档,与 `process-subtrees.ts`
 * 的 `startedBefore` 同口径。
 */
const RUN_START_SKEW_MS = 1000;

/** 账上记过的 + 这一刻刚取到的,去重。丢了 fd 的那些就靠账上这一份留住。 */
function escapeeTargets(child: ChildProcess, fresh: readonly ProcessMember[]): ProcessMember[] {
  const merged = new Map<number, ProcessGeneration>(escapeeLedger.get(child) ?? []);
  for (const member of fresh) merged.set(member.pid, member.gen);
  return [...merged].map(([pid, gen]) => ({ pid, gen }));
}

/**
 * 发这一刀。**每个成员各自重核代次** —— 对不上的一刀都不发,也不从账上划掉(它可能只是
 * 这一刻问不出来;下一次复核会再试)。
 *
 * **这一核只防「已经授权过的目标换了代」,它不授予归属。** 归属自始至终来自树根(见
 * `collectEscapees` 的授权复核):根被反证之后,它的后代自己的代次照样相等 —— 拿这一核当
 * 归属用,等于把「这个号还是刚才那个进程」偷换成「这个进程属于本任务」(本轮审查 F1)。
 * 所以进到这里的名单必须**已经**过了根授权那一关。
 */
export function signalMembers(members: readonly ProcessMember[], sig: NodeJS.Signals): number[] {
  const hit: number[] = [];
  for (const member of members) {
    if (member.pid <= 1 || member.pid === process.pid) continue;
    if (!stillSameGeneration(member)) continue;
    killOne(member.pid, sig);
    hit.push(member.pid);
  }
  return hit;
}

// ── 一个根凭什么当树根:**授权依据跟着根走,而且要在快照之后重核** ───────────────
//
// 三类根各有各的证据,它们**不能互相顶替**:
//
//  | 依据         | 证明的是                                   |
//  |--------------|--------------------------------------------|
//  | `track-fd`   | 它握着这一次运行专属的那个继承 fd          |
//  | `unit`       | 它的环境里带着这一次运行独有的资源记号     |
//  | `handle`     | 它就是我们自己 spawn 的那个号(内核权威)  |
//
// 三档都要再过**同一道闸**:「快照里那个根实例,此刻还是它」(`stillSameGeneration`)。
//
// ── 读数的顺序本身就是不变量:**快照在前,归属线索在后** ───────────────────────────
//
// 上一版把 `treeRootUsable` 判在 `await` 之前,拿到的是一张过期的通行证;fd 那一路虽然复核
// 了,却只把结果用在根自己身上 —— 根被否定,它那一棵子树的孩子仍然无条件进了名单(本轮
// 审查 F1 实测:根被复查排除、根自己还活着,它的孩子被生产清理代码关掉)。
//
// 补上「根授权 ⇒ 整棵子树」这条连线之后,fd 那一路的复核手法本身的毛病就露了出来。原来的
// 办法是**两次 lsof 夹住**中间那次树读数,只有前后都认的号才算数。它要防的是「lsof 给的是
// 裸号码,隔着一次 await 再去读代次时,这个号已经换了主人」。可它**分不清**两件事,而这两
// 件事的正确处置相反:
//  · 号换了主人 ⇒ 一个都不许动(本轮 F1);
//  · 它自己把那个 fd 关掉了,人还在 ⇒ 照杀 —— 收到 TERM 顺手 close 的程序不少,而它继续在
//    用户目录里写文件(第 3 轮审查 F1 实测:心跳从 17 涨到 156)。
// 两种在 fd 这条线索上长得一模一样:第二次 lsof 都答「它不在名单里了」。上一版靠「后代无
// 条件进名单 + 账本」把后一种绕过去,所以按子树收口之后它就成了真漏洞。
//
// **换读数顺序能把这个窗口关掉,而且只要一次 lsof**:
//
//   ① 先取整张进程表的快照(父子关系与代次同源);
//   ② 再问归属线索(`lsof` / 记号 / 句柄);
//   ③ 线索认的那个号,**快照里那一代此刻还在** ⇒ 授权成立。
//
// 为什么这就够了:线索认它(此刻握着这个运行专属的文件 / 带着这次运行的记号)⇒ 它是我们的
// 后代;而③ 证明「从快照到此刻这个号没换过主人」⇒ 快照里那个号上的进程就是线索认的这一个
// ⇒ 快照里它名下那棵子树就是它的子树。顺序反过来(先 lsof 后快照)这一步就断了:快照读到
// 的可能已经是接手这个号的另一个进程,而它自己从那以后没换过代,③ 照样成立。
//
// 代价如实记下:快照之后才起来的后代这一轮看不见(它在快照里没有行),下一轮再收 —— 它握
// 着文件/带着记号,线索不会丢。这比「可能打到别人」的方向错得轻。
//
type RootAuthority = "track-fd" | "unit" | "handle" | "execution";
type RootSeed = {
  pid: number;
  authority: RootAuthority;
  stand?: LineageStand;
  /** `unit` 档:记号那次取证给出的那一代(与记号同源读出),要与快照里那一代对得上。 */
  gen?: ProcessGeneration;
};

/** 一轮取证的全部结论 —— 目标、问清楚了没有、以及记号那一问的结果(残留检测看它)。 */
export type EscapeeSweep = {
  /** 这一刻**根授权成立**、因而证明属于本次运行的成员,各自带着代次。 */
  targets: ProcessMember[];
  /** 这一轮的每一问都答出来了吗。`false` ⇒ 证据与清理责任都不许释放。 */
  answered: boolean;
  /** 没答出来的那几问,人话。进清理责任记录的 detail。 */
  faults: string[];
  /**
   * **这一轮点名了、却排除不掉的号**(`faults` 的机器可读那一半)。
   *
   * 两件事都要有:`faults` 是给人看的那句,这一份是**跨得过重启、后面逐个核得动**的名单 ——
   * 光有那句人话时,持久清扫手里另一套设备压根不知道有号要核,于是同一个故障一个字没恢复
   * 就把那一行销掉了(第 8 轮审查 F1-A)。
   */
  open: CleanupOpen[];
  /** 记号那一问的四档结论。`none` 是唯一能证明「这项资源空了」的那一档。 */
  unit: UnitEvidence;
};

/**
 * 这一刻能证明属于本次运行的后代,**各自带着代次**(见上面那段的①)。
 *
 * 证据有三种,都跟号码无关:继承了本次运行那个追踪 fd(文件对象)、环境里带着这一次运行
 * 独有的资源记号、或者挂在一个身份已确认的根下面(ppid 树)。根进程的号不是证据 ——
 * 只有它还是它(`treeRootUsable`)才能当树根,否则这棵「后代树」是别人的子进程。
 *
 * **记号这一路是本轮新接的**(F2):fd 那条线在 `node → node` 这一跳上结构性地断掉
 * (libuv 丢 ≥3 号 fd),而 agent 起的长跑程序恰好挂在那条链的末端 —— 根一死它被改挂到
 * 1 号名下,fd 也不在名单里,于是上一版的枚举对它**一个入口都没有**。记号跨得过 exec
 * 和根死亡,所以 `ours`(Linux `/proc/<pid>/environ` 的 exact 档)的成员既自带归属证明,
 * 又能当树根把被 `env -i` 洗掉记号的孙子捞回来。macOS 只给得出 `suspected`(`ps -E` 是
 * 展示文本,不是真实环境项),按那一层的规矩**不给落点** —— 它不进目标集合,只作为
 * 「还有残留」的事实进 `unit`,由清理责任那一层保留记录并披露。
 */
export async function collectEscapees(child: ChildProcess): Promise<EscapeeSweep> {
  const faults: string[] = [];
  const open: CleanupOpen[] = [];
  const trackPath = trackPathOf(child);
  const token = unitTokenOf(child);
  const unit = processUnitEvidence(token, { fresh: true });
  // `unprovable` 有两种,处置相反(第 3 轮审查 N2):**这一次**读失败 ⇒ 这一轮确实没问清楚;
  // 而这台机器**结构性读不到别的进程的环境块**(win32,`monitorUnitProofGrade()` 为 null)⇒
  // 重试一万次也是同一个答案,把它记成 fault 会让那个平台上每个正常收尾的回合都「没问清楚」,
  // 于是永远放不开证据、永远欠一笔追不动的债。那边本来只有 ppid 树这一半能力,如实按
  // 「这台机器没有这条线索」处理。
  if (token && unit.verdict === "unprovable" && monitorUnitAnswerable()) {
    faults.push("资源记号这一问没答出来(进程环境读不到)");
  }

  // ① **先取快照**(见上面那段:这个顺序本身是不变量)。
  const table = await processTableSnapshot();
  if (!table) {
    // 问不出来 ≠ 没有后代:不杀也不记账,而且这一轮**不算问清楚**(上一版把它吞掉,
    // 于是「进程表挂了」和「确实没有后代」一样走到释放证据那一句)。
    faults.push("进程树问不出来(ps / /proc 这一问失败)");
    // **记号这一台已经答出来的那几个成员照样交出去**(第 11 轮审查 F1):进程表那一问失败
    // 不会让它们消失,而它们自带 pid + 同源代次 —— 整条链上最硬的那种归属证明。上一版在
    // 这里返回空名单,于是「表挂了」这一下把一份已经到手的身份也一起丢了。
    return {
      targets: [], answered: false, faults,
      open: joinOpen(open, unitOpen(unit, "记号认下的本次运行成员")),
      unit,
    };
  }
  // 表读到了、可是其中几行连号都没认出来:那几行在表里等于不存在,而这条路靠「缺席」下
  // 结论 —— 所以这一轮不算问清楚。有号没代次的那一档在下面逐棵树报(`tree.unverified`),
  // 连号都没有的只能计数。(第 6 轮审查 F1 的同一完整性契约)
  if (table.unnamed) {
    faults.push(`进程表里有 ${table.unnamed} 行连号都没认出来(那几行等于没进表)`);
  }
  // **挂不到任何树上的号也要有人管**(第 7 轮审查 F1)。`subtreesOf` 只沿父子边走,没有边的
  // 号任何子树都遍历不到 —— 于是「这棵树里没看到它」被当成了「已经排除了它属于这次运行」。
  // 它既认不下来也否不掉,所以逐个走排除路(退了 / 已经算进去了 / 开工前就在),剩下的记一笔。
  const topologyGap = (accounted: Iterable<number>): void => {
    const began = runBeganAtMs();
    const gaps = unresolvedTopology(table, { accounted, runStartedAtMs: began });
    if (!gaps.length) return;
    // 这句话会进清理责任那一行的 detail 给人看,所以说清**是哪一条排除路走不通**。
    const why = gaps.some((g) => !g.gen) ? "连那一代也核验不了"
      : began === null ? "也问不出本次运行从哪一刻开始,没法按时间排除"
      : "而且是开工之后才出生的";
    faults.push(`${gaps.map((g) => g.pid).join(",")} 在进程表上,可是挂在谁下面问不出来,${why}`);
    // 同一笔也进结构化名单:持久清扫要靠它逐个核,不是靠读上面那句话(第 8 轮审查 F1-A)。
    for (const gap of gaps) open.push({ pid: gap.pid, gen: gap.gen, why: "挂在谁下面问不出来" });
  };

  /**
   * 「本次运行最早从哪一刻开始」的下界(毫秒)。**根已经退场时也得答得出来** —— 不然正常收尾
   * 那一刻(根刚被我们杀掉)就没有下界,于是表上任何一个挂不上树的活进程都排除不掉,每一次
   * 清理都会凭一条跟我们无关的线索压一笔债。
   *
   * 三个来源取最早的:根/种子此刻在表上的那一代,以及**这次运行专属的两个文件**的创建时刻
   * (它们在 spawn 之前就落地了,所以一定早于根,是个安全的下界;根退场之后它们还在)。
   */
  function runBeganAtMs(): number | null {
    const candidates = [
      earliestStartMs(table!, [child.pid ?? 0, ...seeds.map((s) => s.pid)]),
      fileBornAtMs(trackPath),
      fileBornAtMs(runOutPathOf(child)),
    ].filter((ms): ms is number => ms !== null);
    return candidates.length ? Math.min(...candidates) : null;
  }

  /**
   * **「号空着、可我们没有那一代的存活区间」那一档**(第 14 轮审查 F1 的另一半)。
   *
   * 这棵 ppid 树**认不下也否不掉**:父号对得上,可对得上的父号证明不了归属(见 `root-life.ts`)。
   * 不扩它(一刀不发),但同样**不许让它长成「没有后代」** —— 那正是整条链上反复出事的那个
   * 形状。所以如实记第三种答案:这一问没问清楚,成员进责任清单等下一轮再核。
   *
   * 这里是 Windows 上接回来的根(重启后)落的那一档:那边读不到别人的环境块,记号这份独立
   * 证据不存在,所以授权永远到不了手。**唯一还能用的排除路是时间**:后代只能出生在这次运行
   * 开工之后,明显更早的那些不可能是我们派生的(`runBeganAtMs`,与 `unresolvedTopology`
   * 同一条判据)。POSIX 上这一段天然是空的 —— 根一退出孩子就被重父到 1 号。
   */
  function reportUnattributableTree(rootPid: number): void {
    if (isPidAlive(rootPid)) return;              // 号还被占着:那棵树是占用者的,不是「问不清楚」
    const stray = subtreesOf(table!, [{ pid: rootPid }])[0];
    if (!stray) return;
    const began = runBeganAtMs();
    const suspects: CleanupOpen[] = [];
    for (const member of stray.descendants) {
      if (member.pid === child.pid) continue;
      const born = genStartedAtMs(member.gen);
      if (born !== null && began !== null && born < began - RUN_START_SKEW_MS) continue;  // 开工前就在
      suspects.push({ pid: member.pid, gen: member.gen, why: "挂在已退场的根号下,可那一代的存活区间我们没有" });
    }
    for (const pid of stray.unverified) {
      if (pid !== child.pid) suspects.push({ pid, gen: null, why: "挂在已退场的根号下,它那一代也核验不了" });
    }
    if (!suspects.length) return;
    faults.push(`${suspects.map((o) => o.pid).join(",")} 挂在 ${rootPid} 号(本次运行的根,已退场)下面,可这个号的归属证明不了 —— 不敢下刀,也不算问清楚`);
    open.push(...suspects);
  }

  // 这一张表能确证的东西全部记进根的生命周期(见 `root-life.ts`):第一次读到的那一代、
  // 以及**正面的**退出证据。下界早在创建那一刻就登记过了,这里只做加法。
  observeRootLife(child, table);

  // ② 再问归属线索。
  const probe = trackPath ? await probeFileHolders(trackPath) : noSuchFileProbe();
  // **没问全就算这一轮没问清楚**(第 5 轮审查 F1):上一版只在整问失败(`unknown`)时记故障,
  // 而「发现了两个、随后 lsof 退 2」那种半截回答当时长成 `held`,于是 `answered` 仍是 true ——
  // 调用方据此释放证据、销掉责任。已发现的那几个照样当正面线索用(下面的 `owners`)。
  const scanFault = holderScanFault(probe);
  if (scanFault) faults.push(`追踪文件持有者这一问没答全:${scanFault.fault}`);
  // **只读的持有者不配当树根**(第 3 轮审查 F1):追踪文件是以写模式打开再继承下去的,所以
  // 真后代一定是写模式;只读打开它的是别人(诊断工具、看客)。「打开过这个文件」证明不了
  // 归属,而这里授权的是**整棵子树**的击杀。
  const holders = probe.found;
  const owners = holders.filter(holderMayOwn);
  // 有持有者、却一个都答不出模式 ⇒ 这一问**没答全**:不授权,但也不许说这一轮问清楚了。
  if (holders.length && !owners.length && holders.every((h) => h.mode === "unknown")) {
    faults.push("追踪文件持有者的访问模式问不出来(没法把只读看客和真后代分开)");
  }
  const seeds: RootSeed[] = owners.map((h) => ({ pid: h.pid, authority: "track-fd" as const }));
  if (child.pid && treeRootUsable(child, table)) seeds.push({ pid: child.pid, authority: "handle" });
  else if (child.pid) reportUnattributableTree(child.pid);
  const execution = windowsExecutionRoot(child, table);
  if (execution.fault) faults.push(execution.fault);
  if (execution.root) seeds.push({ ...execution.root, authority: "execution" });
  // 记号那一问也挪到快照之后,判据于是与 fd 那一路同构。
  const freshUnit = token ? processUnitEvidence(token, { fresh: true }) : unit;
  if (freshUnit.verdict === "ours") {
    for (const m of freshUnit.members) seeds.push({ pid: m.pid, authority: "unit", gen: m.gen });
  }
  // **记号认下的成员自带归属证明,所以它入名单不取决于进程表上找不找得到它**
  // (第 11 轮审查 F1 的同一条边)。表那一刻没覆盖到它(快照之后才出生、或者那一行没解析
  // 出来)时,`subtreesOf` 给不出它的树、`rootStillAuthorized` 这一关压根走不到,于是它
  // 既不是 target 也不进名单 —— 一份到手的硬证据就这么没了。两次扫描都并进来:名单只增
  // 不减,确证退了的由 `dischargeOpen` 在消费侧核销(所以正常收尾不会押假债)。
  open.push(
    ...unitOpen(unit, "记号认下的本次运行成员"),
    ...unitOpen(freshUnit, "记号认下的本次运行成员"),
  );
  if (!seeds.length) {
    // 一条归属线索都没有时同样要答这一问:表的完整性跟「我们找到了几个落点」无关。
    topologyGap([child.pid ?? 0]);
    return { targets: [], answered: !faults.length, faults, open: joinOpen(open), unit: freshUnit };
  }

  const provenUnit = new Map<number, ProcessGeneration>(
    freshUnit.verdict === "ours" ? freshUnit.members.map((m) => [m.pid, m.gen] as const) : [],
  );
  // **按来源切树,不按下标回取**:依据随树带着走(见 `ProcessSubtree.source`)。上一版
  // 这里是 `subtreesOf(table, seeds.map(s => s.pid))` + `seeds[i]`,而那一层会按 pid 去重 ——
  // 同一个号同时是 fd 持有者、真句柄和记号成员时(单飞的常见形态),两边从第一个重复项起
  // 整体错位,后面的树拿的是别人的授权依据,独立的真实成员被静默过滤掉(第 2 轮审查 F3)。
  const trees = subtreesOf(table, seeds);

  const targets = new Map<number, ProcessMember>();
  for (const tree of trees) {
    const stand = rootStandOf(tree.source, tree, { child, table, provenUnit });
    if (!stand) {
      // **根自己在表上、却核验不了那一代**:既认不下来(不敢扩这棵树)也否不掉(它可能正是
      // 我们在找的那个)。如实记一笔「没问清楚」,别让它跟「这个号已经退场」同一个待遇
      // (第 6 轮审查 F1)。
      if (tree.unverified.includes(tree.seed.pid)) {
        faults.push(`${tree.seed.pid} 号在进程表上,但核验不了它那一代(${tree.source.authority} 这条线索)`);
        open.push({ pid: tree.seed.pid, gen: null, why: "归属线索认它、可核验不了它那一代" });
      }
      continue;
    }
    // **根授权只是起点,不是整棵树的通行证**(第 17 轮审查 F1):从这里往下的每一条父子边
    // 都要自己拿得出「指向当前这一代」的证明,逐边核(见 `lineage.ts`)。上一版只对**已退场
    // 的根的第一层**设闸,活根整树与任何深层边都是裸父号直接当归属用。
    const sifted = siftLineage(table, tree.seed.pid, stand);
    // 根自己只有在**我们那一代此刻就在这个号上**时才进名单:它已经退场的那一档,这个号上
    // 的行(如果有)是接手它的人,不是我们。
    if (stand.state === "live" && tree.root && tree.root.pid !== child.pid) {
      targets.set(tree.root.pid, tree.root);
    }
    for (const member of tree.descendants) {
      if (member.pid === child.pid) continue;     // CLI 本体走进程组信号,不在这里补刀
      // 只有「这条链一路核下来都算我们的」才下刀;另两档各自在下面交账。
      if (sifted.get(member.pid) !== "kin") continue;
      targets.set(member.pid, member);
    }
    // **根已经认下来了,它名下却有核验不了的号** ⇒ 这些是实打实的残留,只是不敢下刀。
    // 上一版它们在建树时就被整行丢掉,于是这一轮照样算「问清楚了、没有后代」—— 审查在
    // Windows 真机上实测到的正是这一下(活后代缺 CreationDate,结论 empty、一笔债都没落)。
    // **已证伪**的那几支不算这次运行的残留(它们本来就不是我们的事),其余照报。
    const unverified = tree.unverified.filter(
      (pid) => pid !== child.pid && sifted.get(pid) !== "foreign",
    );
    if (unverified.length) {
      faults.push(`${unverified.join(",")} 在这次运行的进程树上,但核验不了它们那一代(给不出下刀凭证)`);
      for (const pid of unverified) {
        open.push({ pid, gen: null, why: "在这次运行的进程树上,核验不了它那一代" });
      }
    }
    // 逐边核下来判成 `murky` 的成员(这条链上有一条边证不出来)⇒ **有代次也不敢认**:
    // 它的归属取决于那条证不出来的边。既不下刀,也不许当成「没有后代」(那正是第 6 轮
    // 那条边的形状),如实留债。读不出代次的那几个已经在上面那一句里报过了。
    const murky = tree.descendants.filter(
      (m) => m.pid !== child.pid && sifted.get(m.pid) === "murky" && !tree.unverified.includes(m.pid),
    );
    if (murky.length) {
      faults.push(`${murky.map((m) => m.pid).join(",")} 挂在一条核验不了的父子边下面(定不了它们是哪一代的孩子)`);
      for (const member of murky) {
        open.push({ pid: member.pid, gen: member.gen, why: "这条链上有一条父子边核验不了" });
      }
    }
  }
  // 已经算进去的那些不再另算:我们自己、各棵树的种子/根/成员,以及树上那些核验不了的号
  // (它们在上面那一句里已经各自报过了)。
  topologyGap([
    child.pid ?? 0,
    ...seeds.map((s) => s.pid),
    ...trees.flatMap((t) => [t.seed.pid, ...t.descendants.map((m) => m.pid), ...t.unverified]),
    ...targets.keys(),
  ]);
  // `open` 里可能有同一条身份的两个来源(记号 + 树上核验不了),`joinOpen` 按「号@代」去重。
  return {
    targets: [...targets.values()], answered: !faults.length, faults,
    open: joinOpen(open), unit: freshUnit,
  };
}

/** 这个文件是什么时候落地的(毫秒)。问不出来就 null —— 它只用来当「不可能更早」的下界。 */
function fileBornAtMs(path: string | null): number | null {
  if (!path) return null;
  try {
    const st = statSync(path);
    const born = st.birthtimeMs || st.ctimeMs || st.mtimeMs;
    return Number.isFinite(born) && born > 0 ? born : null;
  } catch {
    return null;
  }
}

/**
 * 这个根此刻还被它自己那份依据授权着吗 —— 成立的话,连**它那一代的落点**一起交出来
 * (那是整棵树逐边核的起点,见 `lineage.ts`)。`null` = 不成立,整棵来源子树丢掉。
 *
 * 两道闸都要过:**快照里那个根实例还在**(代次没换),以及**它的依据重核仍然成立**。
 * 把「授权」和「落点」做成同一个返回值是刻意的:上一版它们是两处判断(`rootStillAuthorized`
 * 一处、`tree.root ? null : closedRootWindow(child)` 另一处),于是「授权成立」与「这个号上
 * 此刻是不是我们那一代」会各自答各自的 —— 号被接手之后两句话第一次打架时,收下的就是
 * 接手者的整棵子树。
 */
function rootStandOf(
  seed: RootSeed, tree: ProcessSubtree<RootSeed>,
  ctx: {
    child: ChildProcess; table: ProcessTableSnapshot;
    provenUnit: Map<number, ProcessGeneration>;
  },
): LineageStand | null {
  // 快照那一刻它在表上,现在换代了 ⇒ 这个号已经是别人,它名下那棵树是人家的子进程。
  if (tree.root && !stillSameGeneration(tree.root)) return null;
  // 线索认下的那两档,根**一定在这一次读数里**(线索与快照同一刻复核过)⇒ 落点就是表上
  // 那一行:上界开着(它还活着,还能继续生孩子),下界是它那一代的启动时刻。
  const liveOnTable = (): LineageStand | null => tree.root
    ? { state: "live", from: genStartedAtMs(tree.root.gen), fromRes: genResolutionMs(tree.root.gen) }
    : null;
  switch (seed.authority) {
    case "track-fd":
      // 线索认它(此刻握着这个运行专属的文件)+ 上面那道闸(快照里那一代此刻还在)
      // ⇒ 快照里那个号上的进程就是它。**不需要第二次 lsof**(见上面那段)。
      return liveOnTable();
    case "unit":
      // 记号认它,**而且还是同一代**:记号那次读数与快照之间也可能换代,两张读数都认
      // 同一代才算同一个实例。
      return ctx.provenUnit.get(seed.pid) === tree.root?.gen ? liveOnTable() : null;
    case "handle": {
      // 句柄那一档同样在快照之后判(上一版判在 await 之前,拿到的是过期通行证)。
      const stand = rootStand(ctx.child, ctx.table);
      return stand.state === "unknown" ? null : stand;
    }
    case "execution":
      return seed.stand ?? null;
  }
}

/**
 * 这个根的号能不能当「后代树」的树根 —— **当且仅当我们说得出它那一代此刻在哪**。
 *
 * 三档的处置写在 `root-life.ts`:存活已确认 / 退出已确认都给得出落点;**这一轮未知**
 * 一个成员都不许按父号扩(调用方走 `reportUnattributableTree`:留债、不下刀)。
 *
 * POSIX 上这道闸不损失能力:根一退出,它的孩子立刻被重父到 init,以旧号为根的树本来就是
 * 空的。Windows 上它是唯一的防线 —— 那边退出后仍保留的 `ParentProcessId` 是找回孤儿的唯一
 * 手段(见本文件顶部),而父号没有代次,「这个号现在没人占」证明不了归属。
 */
export function treeRootUsable(child: ChildProcess, table: ProcessTableSnapshot): boolean {
  return rootStand(child, table).state !== "unknown";
}

/** 取证 + 记账 + 下刀。返回这一轮的结论(调用方要用 `answered` 决定能不能放手证据)。 */
export async function killEscapees(
  child: ChildProcess, sig: NodeJS.Signals,
): Promise<EscapeeSweep & { hit: number[] }> {
  const sweep = await collectEscapees(child);
  rememberEscapees(child, sweep.targets);
  return { ...sweep, hit: signalMembers(escapeeTargets(child, sweep.targets), sig) };
}

/** 账上这一刻还剩哪些(补刀与残留披露都看它)。 */
export const ledgerOf = (child: ChildProcess): ProcessMember[] => escapeeTargets(child, []);

/** 只想知道「fd 那一问是不是还可能有人握着」的地方(启动期清扫之外没有别的使用方)。 */
export { holdersMayExist };

/**
 * 记号那一问的结论,**写成给人看的一句话** —— 日志、清理责任的 detail、披露端点读的都是它,
 * 所以别塞判据缩写。住在这一层是因为它只认 `UnitEvidence`,不碰库也不碰句柄。
 */
export function describeEvidence(evidence: UnitEvidence): string {
  switch (evidence.verdict) {
    case "ours": return `确证还有 ${evidence.members.length} 个成员(${evidence.members.map((m) => m.pid).join(",")})`;
    case "suspected": return `检测到 ${evidence.pids.join(",")} 仍带着这次运行的记号,但这个平台给不出可下刀的落点`;
    case "none": return "确证没有成员了";
    case "unprovable": return "这一问没答出来(读不到进程环境)";
  }
}
