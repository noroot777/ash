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

import type { ChildProcess } from "node:child_process";
import { IS_WINDOWS, isPidAlive, killOne } from "../platform.js";
import { processUnitEvidence, type UnitEvidence } from "../proc.js";
import {
  processTableSnapshot, stillSameGeneration, subtreesOf,
  type ProcessGeneration, type ProcessMember, type ProcessSubtree,
} from "../process-generation.js";
import { childKillAuthorized } from "./child-identity.js";
import { unitTokenOf } from "./unit-token.js";
import { holdersMayExist, probeFileHolders, trackPathOf, type HolderProbe } from "./track-evidence.js";

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
type RootAuthority = "track-fd" | "unit" | "handle";
type RootSeed = {
  pid: number;
  authority: RootAuthority;
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
  const trackPath = trackPathOf(child);
  const token = unitTokenOf(child);
  const unit = processUnitEvidence(token, { fresh: true });
  if (token && unit.verdict === "unprovable") faults.push("资源记号这一问没答出来(进程环境读不到)");

  // ① **先取快照**(见上面那段:这个顺序本身是不变量)。
  const table = await processTableSnapshot();
  if (!table) {
    // 问不出来 ≠ 没有后代:不杀也不记账,而且这一轮**不算问清楚**(上一版把它吞掉,
    // 于是「进程表挂了」和「确实没有后代」一样走到释放证据那一句)。
    faults.push("进程树问不出来(ps / /proc 这一问失败)");
    return { targets: [], answered: false, faults, unit };
  }

  // ② 再问归属线索。
  const probe = trackPath ? await probeFileHolders(trackPath) : emptyProbe;
  if (probe.kind === "unknown") faults.push(`追踪文件持有者问不出来:${probe.reason}`);
  const holders = probe.kind === "held" ? probe.pids : [];
  const seeds: RootSeed[] = holders.map((pid) => ({ pid, authority: "track-fd" as const }));
  if (child.pid && treeRootUsable(child)) seeds.push({ pid: child.pid, authority: "handle" });
  // 记号那一问也挪到快照之后,判据于是与 fd 那一路同构。
  const freshUnit = token ? processUnitEvidence(token, { fresh: true }) : unit;
  if (freshUnit.verdict === "ours") {
    for (const m of freshUnit.members) seeds.push({ pid: m.pid, authority: "unit", gen: m.gen });
  }
  if (!seeds.length) return { targets: [], answered: !faults.length, faults, unit: freshUnit };

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
    if (!rootStillAuthorized(tree.source, tree, { child, provenUnit })) continue;
    // 根授权成立 ⇒ **整棵来源子树**都属于本次运行。反过来不成立就一个都不收(连根带子树)。
    if (tree.root && tree.root.pid !== child.pid) targets.set(tree.root.pid, tree.root);
    for (const member of tree.descendants) {
      if (member.pid === child.pid) continue;     // CLI 本体走进程组信号,不在这里补刀
      targets.set(member.pid, member);
    }
  }
  return { targets: [...targets.values()], answered: !faults.length, faults, unit: freshUnit };
}

const emptyProbe: HolderProbe = { kind: "empty" };

/**
 * 这个根此刻还被它自己那份依据授权着吗(见上面那张表)。
 *
 * 两道闸都要过:**快照里那个根实例还在**(代次没换),以及**它的依据重核仍然成立**。
 * 任一不成立 ⇒ 调用方把整棵来源子树丢掉。
 */
function rootStillAuthorized(
  seed: RootSeed, tree: ProcessSubtree<RootSeed>,
  ctx: { child: ChildProcess; provenUnit: Map<number, ProcessGeneration> },
): boolean {
  // 快照那一刻它在表上,现在换代了 ⇒ 这个号已经是别人,它名下那棵树是人家的子进程。
  if (tree.root && !stillSameGeneration(tree.root)) return false;
  switch (seed.authority) {
    case "track-fd":
      // 线索认它(此刻握着这个运行专属的文件)+ 上面那道闸(快照里那一代此刻还在)
      // ⇒ 快照里那个号上的进程就是它。**不需要第二次 lsof**(见上面那段)。
      return !!tree.root;
    case "unit":
      // 记号认它,**而且还是同一代**:记号那次读数与快照之间也可能换代,两张读数都认
      // 同一代才算同一个实例。
      return !!tree.root && ctx.provenUnit.get(seed.pid) === tree.root.gen;
    case "handle":
      // 句柄那一档同样在快照之后判(上一版判在 await 之前,拿到的是过期通行证)。
      return treeRootUsable(ctx.child);
  }
}

/**
 * 这个根的号能不能当「后代树」的树根。
 *
 * POSIX:只有身份对得上才行(根一退出,它的孩子立刻被重父到 init,以旧号为根的树本来就是
 * 空的,所以这一道闸不损失能力)。
 *
 * **Windows 分两档**,不能一句 `IS_WINDOWS` 全放过(第 3 轮审查 F1):那边退出后仍保留的
 * `ParentProcessId` 是唯一的找回手段(见本文件顶部),所以**号空着**时照旧走这棵残留的树;
 * 可**号被别人占着**时那棵树是人家的子进程,一个都不许扩。
 */
export function treeRootUsable(child: ChildProcess): boolean {
  if (childKillAuthorized(child)) return true;
  return IS_WINDOWS && !!child.pid && !isPidAlive(child.pid);
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
