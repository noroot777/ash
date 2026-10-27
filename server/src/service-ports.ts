/**
 * 「停止命令留空 = 杀掉启动命令起来的东西」这句承诺的**最后一档**。
 *
 * 前三档按进程归属走(terminal-session-kill.ts 的 terminateSession:ppid 树 ∪ ctty/fd
 * 会话成员 ∪ 存续期累积 pgid),覆盖前台常驻、`cmd &`、nohup、disown。但**真·守护化**的
 * 服务把这三条线索全切了:双 fork 让 PPID 变成 1、setsid 自成会话与进程组、stdio 重定向
 * 进日志文件 —— 从内核角度它跟那次启动再无瓜葛,macOS 又没有 cgroup/Job Object 这种
 * 「整次启动」的容器(executors/kernel-confine.ts 在这台机器上直接弃权),按归属**查不到
 * 也就杀不到**(实测 knowledge-base 的 kb.sh daemonize():pid 66464 / PPID 66462 / 自成
 * sid,启动脚本早退了它还听着 8787)。
 *
 * 于是换一条线索:**这次启动自己打印出来的本机端口**。服务起来都会打一句
 * `http://127.0.0.1:8787`,那是它自报家门,比任何启发式都准。
 *
 * ── 端口只是「上哪儿找」,不是「可以杀」 ─────────────────────────────────────────
 *
 * 这一点第 1 轮自由审查用实测钉死过(E1):只凭「cwd 在项目里 + 启动时间不比这次早」就
 * 授权终止,等于把「最近在同一个目录里跑过」当成血缘 —— 探针在同一目录另起一个无关服务
 * 占住那个端口,点停止就把它杀了。端口会被复用、会被另一个终端抢去、同项目可以同时跑两个
 * 服务,这三种都落在那个窗口里,而杀错进程不可逆。
 *
 * 所以归属证据换成**环境继承**:启动命令会话的 env 里带一枚这次启动独有的随机记号
 * (`ASH_LAUNCH_ID`,terminal.ts 注入),凡是这次启动 fork 出来的进程都带着它,**双 fork +
 * setsid 也洗不掉**(实测:PPID=1、自成 sid 的守护进程,`ps -E` 里那枚记号照旧在)。于是
 * 「它是不是这次起来的」有了一条**可核验**的判据,而不是时间窗口的推断:
 *
 *   · 记号对得上      → 这就是这次启动的后代,可以动手(连同它同组的、同样带记号的工人);
 *   · 环境里没有记号  → 不是这次起来的,**一根汗毛都不许动**,原样报给用户;
 *   · 环境读不出来    → 核不上(多半不是当前用户的进程),同样不动。
 *
 * 这条判据的已知空洞也写明:后代自己 `env -i` 洗掉环境再 exec,记号就断了 —— 那种进程我们
 * 认不出来,于是**停不掉**(报给用户让他配一条停止命令),而不是扩大授权去猜。
 * `executors/kernel-confine.ts` 顶部那张表列的就是这几类线索各自的断点。
 *
 * 另外两道硬闸不变:ash 自己的进程/进程组永不碰;低位端口(<1024)一律不碰 —— 那一档住的
 * 是 22/80/443 这类系统服务,而开发服务几乎不会落在那里。Windows 没有 lsof,这一档整个不
 * 启用(行为与改动前一致)。
 *
 * ── 「查不到」不等于「没人听」 ───────────────────────────────────────────────────
 *
 * lsof 查无此人(退 1、空输出)和 lsof 自己坏了/超时是两件事,早先全被 catch 成空数组,
 * 于是「工具失灵」会被读成「端口空了 = 已经停净」(第 1 轮审查 E2)。所以探测一律三态:
 * `listening` / `free` / `unknown`,**unknown 不许当 free 用** —— 调用方据此拒绝宣称已停止。
 *
 * ── 这个文件只装「动手」 ─────────────────────────────────────────────────────────
 *
 * 「怎么问」(lsof / ps / `/proc`、三态探测、归属解析)在 `service-ports-probe.ts`,两边加
 * 起来早超了单文件上限。判据仍以这篇文件头为准。
 */
import { IS_WINDOWS } from "./platform.js";
import { processAlive, readProcessTableSync } from "./terminal-process-tree.js";
import {
  groupMembers, inspectPid, LAUNCH_ID_ENV, listeningPids, listeningPidsSync,
  membersOfGroup, PORT_TIER_AVAILABLE, readLineage, readLineageSync, refusal,
} from "./service-ports-probe.js";
import type { Lineage, PortHolder } from "./service-ports-probe.js";
// 认端口那一段(整条文本 + 流式)拆去 service-ports-scan.ts 了,调用点照旧从这儿引。
export { createPortScanner, portsFromOutput } from "./service-ports-scan.js";
// 「怎么问」那一半同理:调用点一律从这个文件引,不必知道它分了几个文件。
export {
  inspectPid, LAUNCH_ID_ENV, listeningPids, PORT_TIER_AVAILABLE, probeOwnedPorts, probePorts,
} from "./service-ports-probe.js";
export type {
  OwnedPortProbe, OwnedPortState, PortHolder, PortProbe, PortState,
} from "./service-ports-probe.js";
import { MIN_PORT } from "./service-ports-scan.js";

const TERM_GRACE_MS = 3_000;
const POLL_MS = 100;
/** 一次 stopByPorts 的总时限:端口是逐个问 lsof 的,不能让一次停止无上限地拖着那把命令锁。 */
const STOP_DEADLINE_MS = 30_000;
/**
 * 「动手 → 重新收集」最多转几圈。
 *
 * 要有上限,因为**对面可以比我们快**:一个被杀就重生的看护进程(supervisor)能让这个循环
 * 永远收不到不动点,而我们握着那把命令锁。转满还在冒新号就停手,如实记一笔「没能收到
 * 不动点」—— 那是**没核销的责任**,不是成功。
 */
const MAX_CLOSE_ROUNDS = 3;

export type PortStopOutcome = {
  killed: PortHolder[];
  /** 没动的住户 + 为什么。要如实回给用户,不能悄悄跳过。 */
  spared: { holder: PortHolder; reason: string }[];
  /** 探测没答上来的端口:既不能说它空了,也没人可杀。 */
  unknown: number[];
  /**
   * 同组成员**枚举全了没有**。进程表问不出来、或者动手之后那一组还在冒新号(转满
   * `MAX_CLOSE_ROUNDS` 也没收住),都说明「这次启动还有谁」这份清单不全 —— 跟端口超额是
   * 同一种残缺,得向上交接,不能让「端口空了」替它作结论(第 5 轮审查发现 1)。
   */
  membersIncomplete: boolean;
  /**
   * 动过手之后**还活着、而这次启动的责任没核销**的那些号。两种成因,各自带着自己那句话:
   *
   *  · `ours=false` —— 核不上归属,所以一个字都没动。早先这些号是被 `filter` 静默丢掉的,
   *    于是「这几个端口让出来了」被升级成「这次启动起来的东西都停了」(第 2 轮审查发现 2
   *    实测:监听者被收掉、端口 free、界面显示已停止,而同组那个 `env -i` 洗掉环境的采集
   *    worker 还在跑)。不杀它是对的 —— 没有归属凭据;**但不能顺手把它从账上划掉**。
   *  · `ours=true`  —— 核实了是这次起来的,但 TERM 和 KILL 都没让它停下来。早先只有监听者
   *    那一个号会进 `spared`,同组其它杀不掉的成员既不在 `killed` 也不在 `spared`,**从账上
   *    整个消失了**(第 6 轮审查 F1)。
   */
  leftovers: LaunchMember[];
};

/** 成员清单里的一个号。`ours` = 核实了是这次启动起来的。 */
export type LaunchMember = { pid: number; ours: boolean; reason: string };

/** 一次成员闭合的结果。 */
type GroupClose = {
  /** 这一组收干净了吗(所有带记号的成员都退了,而且不再冒新的)。 */
  cleared: boolean;
  /** 核不上归属、一个字没动的号 → 那句话。 */
  strangers: Map<number, string>;
  /** 是这次起来的,但 TERM+KILL 都没停下来的号。 */
  stuckOurs: number[];
  /** 这一问本身答不全(进程表失灵),或者转满了圈还在冒新号。 */
  incomplete: boolean;
};

/**
 * 动手 → **重新收集** → 再动手,收到不动点。这是「停」这一侧的核心:
 *
 * 一张相不够用。TERM 是可捕获信号,它的 handler 可以在收尾时**现 fork 一个新工人**;那个号
 * 出生在我们照相之后,只认第一张相的话它一辈子不会进账 —— 第 6 轮审查 E2 实测:服务的 TERM
 * handler 新建同组工人再退出监听,端口随即空了,于是落 `verified`、界面退回启动按钮,工人
 * 还在跑(ppid=1、pgid 仍是原来那个组、带着这次启动的记号)。
 *
 * 这跟 `terminal-session-kill.ts` 的 `terminateSession` 是**同一条判据**:那边 TERM 轮和
 * KILL 轮各自重新冻结、重新枚举到不动点,理由逐字相同(第 7 轮审查实锤)。端口这一档早先
 * 没有等价的闭合保证,现在补上 —— 区别只有「没有冻结」:端口这条路上我们不是 pty 的主人,
 * 拿不到 SIGSTOP 那种确定性窗口,所以靠**多转一圈**代替冻结。
 *
 * 两条硬闸一寸不让:
 *  · 新收集到的号**照样要核归属**,只收带记号的 —— 进程组不是血缘证据,同组陌生进程一根
 *    汗毛都不许动(文件头);
 *  · 转数有上限(`MAX_CLOSE_ROUNDS`),收不住就如实说「没收到不动点」,不许无限转下去。
 */
async function closeGroup(
  /** 第一轮已经枚举并核过归属的成员。 */
  first: { members: number[]; lineage: Map<number, Lineage> },
  pgid: number,
  token: string,
  selfPgid: number | null,
  graceMs: number,
  /** 还剩多少总预算(毫秒)。 */
  left: () => number,
): Promise<GroupClose> {
  const targets = new Set<number>();
  const strangers = new Map<number, string>();
  const judged = new Set<number>(first.members);
  for (const member of first.members) {
    const who = first.lineage.get(member);
    if (who === undefined) continue; // 它已经退了
    if (who === "ours") targets.add(member);
    else strangers.set(member, refusal(who));
  }
  let incomplete = false;
  let unsettled = false;
  for (let round = 1; ; round++) {
    const alive = [...targets].filter(processAlive);
    if (alive.length) await killPids(alive, Math.max(0, Math.min(graceMs, left())));
    // 重新收集。注意**组长这会儿多半已经死了**,所以按组号直接问进程表,不能再 inspectPid
    // 回去问它(membersOfGroup 的注释)。
    const again = membersOfGroup(pgid, selfPgid);
    if (!again.complete) incomplete = true;
    const fresh = again.members.filter((pid) => pid !== process.pid && !judged.has(pid));
    if (!fresh.length) break; // 不动点:组里没有新面孔了
    // 预算或轮数见底:新面孔**没来得及核归属**,那就按「核不上」记进账 —— 有号可举总比
    // 只留一句「清单不全」强,用户至少知道去看哪几个。
    if (round >= MAX_CLOSE_ROUNDS || left() <= 0) {
      for (const pid of fresh) {
        if (processAlive(pid)) strangers.set(pid, "停止的总时限用完了，没来得及核它是不是这次启动起来的");
      }
      unsettled = true;
      break;
    }
    const lineage = await readLineage(fresh, token, left());
    let added = false;
    for (const pid of fresh) {
      const who = lineage.get(pid);
      if (who === undefined) continue; // 它已经退了
      judged.add(pid);
      if (who === "ours") { targets.add(pid); added = true; }
      else strangers.set(pid, refusal(who));
    }
    // 新面孔全是外人(或者都已经退了):不是我们的事,收手 —— 再转一圈也只会把同一批
    // 陌生进程重新核一遍。
    if (!added) break;
  }
  const stuckOurs = [...targets].filter(processAlive);
  return { cleared: !unsettled && stuckOurs.length === 0, strangers, stuckOurs, incomplete: incomplete || unsettled };
}

/**
 * 停掉占着这些端口、**且带着这次启动记号**的进程。记号核不上的一律不动,原样回给调用方
 * 去告诉用户 —— 宁可停不掉,也不许杀错。
 *
 * 「收干净了」的判据是 `closeGroup` 的不动点,不是「我发过几发信号」。
 */
export async function stopByPorts(
  ports: Iterable<number>,
  options: { launchToken: string; graceMs?: number },
): Promise<PortStopOutcome> {
  const outcome: PortStopOutcome = { killed: [], spared: [], unknown: [], leftovers: [], membersIncomplete: false };
  if (IS_WINDOWS || !PORT_TIER_AVAILABLE) return outcome;
  const selfPgid = readProcessTableSync()?.pgidOf.get(process.pid) ?? null;
  // **整个动作共用一份预算**:逐端口、每个住户的 inspect/readLineage、TERM/KILL 的等待
  // 全从这里扣,连那几个外部命令自己的 timeout 也从这儿取(budgeted)。只在外层逐端口时
  // 看一眼的话,一个端口上坐着十个住户就能把标称总时限翻十倍(第 2、6 轮审查的非阻塞项)。
  const deadline = Date.now() + STOP_DEADLINE_MS;
  const left = () => deadline - Date.now();
  const seen = new Set<number>();
  const owed = new Map<number, LaunchMember>();
  for (const port of ports) {
    if (left() <= 0) { outcome.unknown.push(port); continue; }
    const found = await listeningPids(port, undefined, left());
    if (!found.ok) { outcome.unknown.push(port); continue; }
    for (const pid of found.pids) {
      if (seen.has(pid)) continue;
      seen.add(pid);
      if (pid === process.pid) continue; // 那是 ash 自己
      if (left() <= 0) { outcome.unknown.push(port); break; }
      const anchor = (await readLineage([pid], options.launchToken, left())).get(pid);
      if (anchor === undefined) continue;
      const inspected = await inspectPid(pid, left());
      if (inspected.state === "gone") continue;
      if (inspected.state === "unknown") {
        if (anchor === "stranger") continue;
        outcome.unknown.push(port);
        outcome.membersIncomplete = true;
        owed.set(pid, { pid, ours: anchor === "ours", reason: inspected.why });
        continue;
      }
      const holder = inspected.holder;
      if (selfPgid !== null && holder.pgid === selfPgid) {
        outcome.spared.push({ holder, reason: "那是 ash 自己所在的进程组" });
        continue;
      }
      if (anchor !== "ours") {
        outcome.spared.push({ holder, reason: refusal(anchor) });
        if (anchor !== "stranger") outcome.membersIncomplete = true;
        continue;
      }
      const group = groupMembers(holder.pid, holder.pgid, selfPgid);
      if (!group.complete) outcome.membersIncomplete = true;
      const lineage = await readLineage(group.members, options.launchToken, left());
      // 带记号的同组成员一起收:守护进程常带着自己 fork 的工人(kb-web 里跑着采集器和
      // 向量编码子进程),只杀监听者会留下一地孤儿。**没记号的同组成员不动** ——
      // 进程组不是血缘证据,它只是调度单位(第 1 轮审查)。
      const closed = await closeGroup(
        { members: group.members, lineage },
        holder.pgid, options.launchToken, selfPgid, options.graceMs ?? TERM_GRACE_MS, left,
      );
      if (closed.incomplete) outcome.membersIncomplete = true;
      if (closed.cleared) outcome.killed.push(holder);
      else {
        outcome.spared.push({
          holder,
          reason: closed.stuckOurs.includes(holder.pid)
            ? "发了 TERM 和 KILL 都没停下来"
            : "它那一组在停止期间还在冒出新进程，没能收到不动点",
        });
      }
      // **没核销的责任要留在账上**,两种都要:核不上归属所以没敢动的,以及核实是这次起来
      // 的、却怎么都杀不掉的。把它们静默丢掉,等于拿「端口空了」核销了「这次启动起来的
      // 东西都停了」(第 2 轮审查发现 2、第 6 轮 F1)。
      for (const [member, reason] of closed.strangers) {
        if (member === holder.pid || !processAlive(member)) continue;
        owed.set(member, { pid: member, ours: false, reason });
      }
      for (const member of closed.stuckOurs) {
        if (member === holder.pid) continue; // 它已经进 spared 了
        owed.set(member, { pid: member, ours: true, reason: "它是这次启动起来的，但发了 TERM 和 KILL 都没停下来" });
      }
    }
  }
  outcome.leftovers.push(...owed.values());
  return outcome;
}

/**
 * 动手**之前**把「这次启动此刻都有谁」照一张相:这些端口上的住户 + 它们同组的成员,逐个
 * 带着归属结论和一句给用户看的话,另外记下**涉及哪几个进程组**(`groups`)。
 *
 * 只有**配了停止命令**的那条路需要它。默认停止是我们自己动手的,`stopByPorts` 连杀带闭合
 * 一趟做完;而用户那段脚本我们不插手,跑完只能回头问 —— 端口一空就判停净,于是「脚本只收掉
 * 了监听者、它 fork 的工人还在跑」这种从来没进过账(第 5 轮审查发现 1)。
 *
 * `groups` 是给**停止之后重新收集**用的(survivingMembers):用户脚本 kill 监听者时,那个
 * handler 同样会现 fork 一个新工人 —— 它不在这张相里,只能靠组号找回来(第 6 轮审查 E2 在
 * 脚本路径上的同形)。
 *
 * `complete=false` = 这张相本身没照全(lsof/进程表问不出来、或者这条会话压根没有启动记号),
 * 那就不许拿它的「没人剩下」当证据。
 */
export async function launchMembers(
  ports: Iterable<number>,
  token: string | null,
  inspect: typeof inspectPid = inspectPid,
): Promise<LaunchSnapshot> {
  const members: LaunchMember[] = [];
  const groups = new Set<number>();
  if (IS_WINDOWS || !PORT_TIER_AVAILABLE || !token) return { members, groups: [], complete: false };
  const selfPgid = readProcessTableSync()?.pgidOf.get(process.pid) ?? null;
  const seen = new Set<number>();
  let complete = true;
  for (const port of ports) {
    const found = await listeningPids(port);
    if (!found.ok) { complete = false; continue; }
    for (const pid of found.pids) {
      if (pid === process.pid || seen.has(pid)) continue;
      const anchor = (await readLineage([pid], token)).get(pid);
      if (anchor === undefined || anchor === "stranger") { seen.add(pid); continue; }
      if (anchor !== "ours") {
        seen.add(pid);
        members.push({ pid, ours: false, reason: refusal(anchor) });
        complete = false;
        continue;
      }
      const inspected = await inspect(pid);
      if (inspected.state === "gone") { seen.add(pid); continue; }
      if (inspected.state === "unknown") {
        seen.add(pid);
        members.push({ pid, ours: true, reason: inspected.why });
        complete = false;
        continue;
      }
      const holder = inspected.holder;
      if (selfPgid !== null && holder.pgid === selfPgid) { seen.add(pid); continue; } // 那是 ash 自己
      groups.add(holder.pgid);
      const group = groupMembers(holder.pid, holder.pgid, selfPgid);
      if (!group.complete) complete = false;
      const lineage = await readLineage(group.members, token);
      for (const member of group.members) {
        if (seen.has(member)) continue;
        seen.add(member);
        const who = lineage.get(member);
        if (who === undefined) continue; // 它已经退了
        members.push(who === "ours"
          ? { pid: member, ours: true, reason: `它带着这次启动的记号（${LAUNCH_ID_ENV}），是这次起来的` }
          : { pid: member, ours: false, reason: refusal(who) });
      }
    }
  }
  return { members, groups: [...groups], complete };
}

/** 停止**之前**照的那张相。`groups` 留着给停止之后的重新收集用。 */
export type LaunchSnapshot = { members: LaunchMember[]; groups: number[]; complete: boolean };

/**
 * 用户那条停止脚本跑完之后,**谁还活着**。
 *
 * 两份并集,少一份都不行:
 *  · 停止前那张相里**还活着**的 —— 脚本常常只 kill 掉监听者,它 fork 的工人原样留着;
 *  · 停止前记下的那几个组里**新冒出来的** —— 脚本 kill 监听者时,handler 可以现 fork 一个
 *    工人,那个号出生在照相之后(第 6 轮审查 E2 的脚本路径同形)。新号照样要核归属才敢往
 *    「是这次起来的」里记,核不上的也要记,只是说法不同。
 *
 * 这里**一个 kill 都不发**:用户写那段脚本正是不想让 ash 直接动手。只负责把事实说清楚。
 */
export async function survivingMembers(snapshot: LaunchSnapshot, token: string | null): Promise<{ members: LaunchMember[]; complete: boolean }> {
  const left = snapshot.members.filter((one) => processAlive(one.pid));
  if (IS_WINDOWS || !PORT_TIER_AVAILABLE || !token) return { members: left, complete: snapshot.complete };
  const selfPgid = readProcessTableSync()?.pgidOf.get(process.pid) ?? null;
  const known = new Set(snapshot.members.map((one) => one.pid));
  let complete = snapshot.complete;
  const fresh: number[] = [];
  for (const pgid of snapshot.groups) {
    const again = membersOfGroup(pgid, selfPgid);
    if (!again.complete) complete = false;
    for (const pid of again.members) {
      if (pid === process.pid || known.has(pid)) continue;
      known.add(pid);
      fresh.push(pid);
    }
  }
  if (!fresh.length) return { members: left, complete };
  const lineage = await readLineage(fresh, token);
  for (const pid of fresh) {
    const who = lineage.get(pid);
    if (who === undefined) continue; // 它已经退了
    left.push(who === "ours"
      ? { pid, ours: true, reason: `它带着这次启动的记号（${LAUNCH_ID_ENV}），是停止期间新起来的` }
      : { pid, ours: false, reason: refusal(who) });
  }
  return { members: left, complete };
}

/** TERM → 等 → KILL → 等。逐个号发,不打整组 —— 组里可能坐着与这次启动无关的进程。 */
async function killPids(pids: number[], graceMs: number): Promise<boolean> {
  const alive = () => pids.some((pid) => processAlive(pid));
  const signal = (sig: "SIGTERM" | "SIGKILL") => {
    for (const pid of pids) {
      try { process.kill(pid, sig); } catch { /* 已经走了 */ }
    }
  };
  if (!alive()) return true;
  signal("SIGTERM");
  if (await waitGone(alive, graceMs)) return true;
  signal("SIGKILL");
  return await waitGone(alive, graceMs);
}

async function waitGone(alive: () => boolean, graceMs: number): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  for (;;) {
    if (!alive()) return true;
    if (Date.now() >= deadline) return !alive();
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * 端口这一档的**同步**收口:只给 server 退出那一拍用。
 *
 * `process.once("exit")` 里不能 await(信号处理器直接 `process.exit()`,见 singleton.ts
 * 的 installCleanup),所以关服清场整条是同步的 —— `killAllSessionTrees` 同步连发
 * TERM+KILL 就是这个缘故。端口这一档被漏在外面时,关服会把会话表连 launchToken 一起丢掉,
 * 而真·守护化的服务只认这一条线索:ash 再起来,它还听着那个端口、却**再没有任何把手能停
 * 它**(第 3 轮审查发现 2)。
 *
 * 判据与异步版逐字一致(带记号的才动,没记号/核不上的一根汗毛都不碰),区别有两处:同步问
 * lsof/ps,以及**不等宽限** —— 退出那一拍没有「等 3 秒」这种预算,TERM 与 KILL 连发(同
 * killAllSessionTrees)。闭合也照做,只是**只转一圈**:连发之后立刻重新枚举一次,把 handler
 * 刚 fork 出来的号纳管(异步版靠 MAX_CLOSE_ROUNDS 转到不动点,这里没有等待的余地)。
 */
export function stopByPortsSync(
  ports: Iterable<number>,
  token: string,
): { killed: number[]; spared: number[]; leftovers: number[]; membersIncomplete: boolean } {
  const result = { killed: [] as number[], spared: [] as number[], leftovers: [] as number[], membersIncomplete: false };
  if (IS_WINDOWS || !PORT_TIER_AVAILABLE || !token) return result;
  const table = readProcessTableSync();
  const selfPgid = table?.pgidOf.get(process.pid) ?? null;
  const seen = new Set<number>();
  const owed = new Set<number>();
  for (const port of ports) {
    if (port < MIN_PORT) continue;
    for (const pid of listeningPidsSync(port)) {
      if (seen.has(pid) || pid === process.pid) continue;
      seen.add(pid);
      if (readLineageSync([pid], token).get(pid) !== "ours") { result.spared.push(pid); continue; }
      if (!table || !table.pgidOf.has(pid)) result.membersIncomplete = true;
      const pgid = table?.pgidOf.get(pid) ?? 0;
      if (selfPgid !== null && pgid === selfPgid) { result.spared.push(pid); continue; }
      const group = groupMembers(pid, pgid, selfPgid);
      if (!group.complete) result.membersIncomplete = true;
      const lineage = readLineageSync(group.members, token);
      // 同组里核不上归属的那几个,这一拍**也是新发现的责任**。同步版早先只回 killed/spared,
      // 于是关服那句交代只看得见账上原有的号,从没点过停止就直接关服时一个字都不会提
      // (第 5 轮审查发现 1)。
      for (const member of group.members) {
        if (lineage.get(member) === "ours" || !processAlive(member)) continue;
        owed.add(member);
      }
      const targets = group.members.filter((member) => lineage.get(member) === "ours");
      if (!targets.length) { result.spared.push(pid); continue; }
      killSync(targets);
      result.killed.push(...targets);
      // 只转一圈的闭合:连发之后组里新冒出来的号(TERM handler 的手笔)照样要核归属 ——
      // 带记号的连发收掉,核不上的记进账。不转这一圈,关服就会把它们彻底丢掉。
      const again = membersOfGroup(pgid, selfPgid);
      if (!again.complete) result.membersIncomplete = true;
      const fresh = again.members.filter((member) => member !== process.pid && !group.members.includes(member));
      if (!fresh.length) continue;
      const freshLineage = readLineageSync(fresh, token);
      const freshOurs: number[] = [];
      for (const member of fresh) {
        const who = freshLineage.get(member);
        if (who === undefined) continue; // 它已经退了
        if (who === "ours") freshOurs.push(member);
        else if (processAlive(member)) owed.add(member);
      }
      if (freshOurs.length) {
        killSync(freshOurs);
        result.killed.push(...freshOurs);
      }
    }
  }
  // 连发之后仍然活着的才算遗留 —— 刚被收掉的不该出现在账上。
  for (const member of owed) if (processAlive(member)) result.leftovers.push(member);
  return result;
}

/** 关服那一拍的连发:没有宽限可等,TERM 与 KILL 一起下去(同 killAllSessionTrees)。 */
function killSync(pids: number[]): void {
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch { /* 已经走了 */ }
    try { process.kill(pid, "SIGKILL"); } catch { /* 已经走了 */ }
  }
}
