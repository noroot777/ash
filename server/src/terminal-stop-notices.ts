// 一次停止动作的**终态判定与措辞**。
//
// 从 terminal-commands.ts 拆出来的原因有两条:那份文件贴着项目 700 行的上限;而这一段跟
// 路由、命令锁、占位符都没有耦合 —— 它只需要「这次启动的现场(TerminalSessionInfo)、
// 这一趟发现的号(LaunchMember)、terminate 那一趟的枚举完不完整」这几样事实。
//
// 账怎么记、怎么合并在 terminal-stop-facts.ts;这里只决定「这一次敢说到哪一步」。
import { PORT_TIER_AVAILABLE, type LaunchMember } from "./service-ports.js";
import type { LaunchScan } from "./terminal-launch-survivors.js";
import type { TerminalSessionInfo } from "./terminal-session-facts.js";

/**
 * 一次停止动作的**三种**终态。两种不够用:早先只有「停了」和「没停下来」,于是
 * 「这几个端口让出来了」被直接升级成「这次启动起来的东西都停了」(第 2 轮审查发现 2)。
 *
 *  · `stopped`    —— 核验过:端口全空,而且没留下没核销的号;
 *  · `unresolved` —— 监听确实停了,但同组还有**核不上归属所以一个字都没动**的号活着。
 *                    不杀它是对的(没有归属凭据),但也**不能顺手把它从账上划掉** ——
 *                    如实报给用户,并把这几个号留在会话事实里(刷新回来还看得见);
 *  · `stuck`      —— 端口还有人听,或者问不出来:不许宣称已停止,留着可重试的现场。
 */
/**
 * 收尾动作**立住了什么**。
 *
 *  · `complete`  —— 成员清单全不全(freezeAndEnumerate 的同名标记,两轮取与)。
 *                   **`null` = 这一趟 ash 没动手**:用户那条停止命令已经把它收掉了,所以
 *                   没有枚举可言 —— 跟「枚举过、没列全」严格分开,前者不该连坐。
 *  · `groupGone` —— 收尾动作之后再读一次会话事实:那个启动进程组确实探不到了。必须由调用方
 *                   在动手**之后**读,不能拿动手前的那张现场推。
 */
export type Enumeration = { complete: boolean | null; groupGone: boolean };

/**
 * **这一趟的启动闭包封住了吗** —— 整套停止结论共用的一条判据,四个调用点(端口那条道、
 * 无端口那条道、停止脚本核验、发现即落账时「这笔账核销得掉吗」)全走这里。
 *
 * 为什么必须是一处而不是四处各写一遍 `scan.evidence !== "incomplete"`:这一条的内容被实测
 * 改过两次。第一次是「空集不等于问全了」(第 1 轮审查发现 1),第二次是「读不到环境不等于
 * 不是这次的」—— 后者的实例落在扫描内部,但**判据本身**属于停止结论层:
 * **「记号一个都没命中」只说明这一路证据没命中,不证明不存在。** 只有扫描自己把候选集枚举
 * 得出来、而且每个候选的归属都问出了答案(`answered`),这一路才算封了口。
 *
 * `unavailable` 是**另一回事**,不走这道闸:那是「这台机器/这次启动上没有这一问」
 * (Windows 读不到别人的环境、交互会话与老记录没有记号),结论由进程树与端口那几档承担。
 * 它是一道已知边界而不是本轮回归 —— 把它也算成没封口,等于反转 Windows 的既有停止判定,
 * 而根 AGENTS.md 要求碰 win32 分支必须上真机跑,本轮没有那份证据。
 */
export function launchClosureSealed(scan: LaunchScan): boolean {
  return scan.evidence !== "incomplete";
}

export type StopVerdict =
  | { kind: "stopped" }
  | { kind: "unresolved"; notice: string; leftovers: number[]; complete: boolean }
  | { kind: "stuck"; reason: string };

/** 一串没核销的号 → 「pid 1、pid 2 等 5 个」。 */
function who(left: LaunchMember[]): string {
  const head = left.slice(0, 3).map((one) => `pid ${one.pid}`).join("、");
  return `${head}${left.length > 3 ? `等 ${left.length} 个` : ""}`;
}

/**
 * 账上这几个号 → 一句给用户看的话。**两种成因混在一起时要分开说**:核不上归属所以没敢动
 * 的,和核实是这次起来的、却怎么都杀不掉的 —— 后者早先压根进不了账(第 6 轮审查 F1),
 * 混成一句会把「ash 不敢动」说到一个它已经发过 KILL 的进程头上。
 */
export function leftoverNotice(where: string, left: LaunchMember[]): string {
  const stubborn = left.filter((one) => one.ours);
  const strangers = left.filter((one) => !one.ours);
  const parts = [`${where}的停止核验尚未完成：`];
  if (stubborn.length) {
    parts.push(`这次启动起来的 ${who(stubborn)} 发了 TERM 和 KILL 都没停下来`);
    if (strangers.length) parts.push("；");
  }
  if (strangers.length) {
    parts.push(`跟它同组的 ${who(strangers)} 还活着：${strangers[0].reason}`
      + ` —— 没有归属凭据，ash 不敢动它们`);
  }
  return `${parts.join("")}，所以没法说这次启动起来的东西都停了。`
    + (strangers.length ? `要连它们一起收，请在「管理常用命令」里给这个服务填一条停止命令。` : ``);
}

/**
 * 线索本身不全时那句话:这次启动打印的端口超过了记录额度,第 9 个起没进账。记下的都空了,但
 * 「自己 setsid 单开一组、只能从没记下的那个端口找到」的守护进程**压根没被问过**
 * (terminal.ts 的 recordPorts)。这种情况下不许把「端口都空了」说成「全停了」—— 它是一笔
 * 核销不掉的责任(StopFact 里 pids 为空的那种 unresolved),连下一次停止也核销不了它。
 */
export function truncatedNotice(open: TerminalSessionInfo, hasStopScript: boolean): string {
  return `这次启动记录了端口 ${open.ports.join("、")}，但打印的本机端口超过 ${open.ports.length} 个，`
    + `多出来的没能记下来 —— 如果还有服务只听那些端口，ash 没问过它们。`
    + (hasStopScript
      ? `这次启动没法确认停净，要确认请自己去看一眼那几个端口。`
      : `要确保停净，请在「管理常用命令」里给这个服务填一条停止命令。`);
}

/**
 * 成员清单没列全时那句话。跟端口超额(truncatedNotice)是同一种残缺:都是「该问的没问全」,
 * 所以同样落成 pids 为空的那种 unresolved —— 不卡生命周期,但这次启动到死都带着这句话。
 */
export function membersNotice(open: TerminalSessionInfo, hasStopScript: boolean): string {
  return `这次启动记录了端口 ${open.ports.join("、")}，但没能把同组成员列全（进程表或端口查询没答上来）`
    + ` —— 跟它一起起来的还有谁，ash 这一趟没问到，`
    + (hasStopScript ? `所以没法确认你那条停止命令收干净了。` : `所以没法说这次启动起来的东西都停了。`);
}

/**
 * 按启动记号点到名的那几个号 → 一句给用户看的话。这一档跟别的 unresolved 不是同一种:别的是
 * 「证据不全,说不出口」,这一档是**反证已经拿到手** —— 所以 `complete` 为真(它们死了之后
 * 下一次停止能把这笔账核销掉),而且话里必须给出 pid,用户才有下手的地方。
 */
function survivorNotice(pids: number[], hasStopScript: boolean): string {
  const head = pids.slice(0, 3).map((pid) => `pid ${pid}`).join("、");
  return `这次启动的进程组已经收掉了，但按这次启动的记号还点到 ${head}`
    + `${pids.length > 3 ? ` 等 ${pids.length} 个` : ""} 还活着 —— `
    + `它们双 fork 之后自己脱离了进程组和会话（ash 的进程树、会话成员、累积进程组三条线索都`
    + `点不到名），所以这次启动还没停净。`
    + (hasStopScript
      ? `你那条停止命令没收掉它们，要连它们一起收请在脚本里也收掉。`
      : `要停掉它们，请在「管理常用命令」里给这个服务填一条收得掉它们的停止命令。`);
}

/**
 * **没有端口线索**这条道上的终态。三档判据,顺序要紧:
 *
 * ① **按启动记号点到名的存活进程**(terminal-launch-survivors.ts)—— 直接反证,压倒一切。
 *    这一档是第 2 轮审查必须修 2 的落点:启动脚本留在前台、经中转进程双 fork 出一个自己
 *    setsid 的工人,中转随后退出,那个工人在 ppid 树、ctty/sid 会话成员、累积 pgid 三条线索
 *    上全都不在,于是「启动组现在探不到了」被当成了「这次启动起来的东西都停了」—— 界面干净
 *    地显示「已停止」,工人还在跑(probe-group-death 实测)。记号是继承来的,setsid 断血缘
 *    断不掉它,所以这一问能直接把它点出来并给出 pid。
 *
 * ② 正面判据:停止前启动组还活着、动手之后探不到了,**而且 terminate 那一趟的成员清单列全了**。
 *    枚举是在冻结态下跑到不动点的(freezeAndEnumerate),冻住的进程不能再 fork,所以清单齐全
 *    时「这一刻会话里还有谁」可信;进程表或会话成员那一问没答上话时,收掉的只是问出来的
 *    那些,这种时候宣称停净就是拿没问过的部分当证据。`killed === null`(启动脚本早就自己
 *    退了、没有活会话可杀)同样进不了这一档。
 *
 *    **单靠这一档关不住 ①**:完整性只说明 ps 这一趟答上了话,跟「有没有东西逃出这份账」是
 *    两件事 —— 只装这道闸、不扫记号时实测过同一个探针,照旧 `stopped:true`、工人照旧活着。
 *    两档都要,缺一不可。
 *
 * ③ 都不成立 → unresolved,`complete=false`:按设计不卡生命周期(没有活号可举,拦着也多停不掉
 *    一个进程),只卡「能不能说停净了」。前因分三种说法,结论那半句是固定措辞。
 */
/**
 * 按启动记号那一问**没答全**时那句话。跟 truncatedNotice / membersNotice 同一种残缺:
 * 该问的没问全,所以不许宣称停净。这一档此前被折进空集里(第 1 轮审查发现 1)。
 */
export function scanIncompleteNotice(scan: LaunchScan, scripted: boolean): string {
  return `${scan.why ?? "按这次启动的记号那一问没答全"} —— `
    + (scan.pids.length
      ? `点到名的 ${scan.pids.map((pid) => `pid ${pid}`).join("、")} 已经如实记下，但漏没漏别的说不了。`
      : "所以没法说这次启动起来的东西都停了。")
    + (scripted
      ? "停止命令已执行，但这不构成停净的证据；要确认请自己去看一眼。"
      : "请稍后再点一次停止，或者在「管理常用命令」里给这个服务填一条停止命令。");
}

/** ash 这一趟的成员清单没列全(`killed.complete === false`)时,端口那条道上那句话。 */
export function killedIncompleteNotice(open: TerminalSessionInfo, scripted: boolean): string {
  return `端口 ${open.ports.join("、")} 让出来了，但 ash 这一趟连成员清单都没列全`
    + `（进程表或端口查询没答上来），收掉的只是问出来的那些 —— `
    + (scripted ? "所以没法确认你那条停止命令收干净了。" : "所以没法说这次启动起来的东西都停了。");
}

/**
 * **端口那条道**的收口。此前这条道整个绕过记号扫描、也不看 `killed.complete`,于是
 * 「这几个端口空了」被直接升级成「这次启动起来的东西都停了」—— 第 1 轮审查发现 1 在真实
 * 页面上实测到:19442 的监听者退了、界面报「已停止」、刷新仍然如此,而那个双 fork 出去的
 * 工人(PPID=1、自成一组)还在跑。
 *
 * 顺序就是证据强度:**已知残留优先,任何必要证据未知都只能保留未知**,端口空只证明监听停了。
 */
export function portStopVerdict(
  open: TerminalSessionInfo, scripted: boolean, killed: Enumeration, scan: LaunchScan,
  /** 端口那一趟发现的号 */ found: LaunchMember[],
  /** 端口那一趟的线索全不全(成员清单 / 停止前那张相) */ portsComplete: boolean,
): StopVerdict {
  // 这一趟的全部必要证据有一条未知吗。端口那趟、ash 的收尾枚举、记号扫描,三条取与。
  const complete = portsComplete && !open.portsTruncated
    && killed.complete !== false && launchClosureSealed(scan);
  // ① 记号点到名的:直接反证,压倒端口那边的任何结论。
  if (scan.pids.length) {
    return { kind: "unresolved", leftovers: scan.pids, complete, notice: survivorNotice(scan.pids, scripted) };
  }
  // ② 端口那趟自己发现的号。
  if (found.length) {
    return { kind: "unresolved", leftovers: found.map((one) => one.pid), complete, notice: leftoverNotice(`端口 ${open.ports.join("、")}`, found) };
  }
  // ③ 没有活号可举,但证据不全 —— 不卡生命周期,只卡「能不能说停净」。
  if (open.portsTruncated) return { kind: "unresolved", leftovers: [], notice: truncatedNotice(open, scripted), complete: false };
  if (!portsComplete) return { kind: "unresolved", leftovers: [], notice: membersNotice(open, scripted), complete: false };
  if (killed.complete === false) return { kind: "unresolved", leftovers: [], notice: killedIncompleteNotice(open, scripted), complete: false };
  if (!launchClosureSealed(scan)) return { kind: "unresolved", leftovers: [], notice: scanIncompleteNotice(scan, scripted), complete: false };
  return { kind: "stopped" };
}

export function processStopVerdict(open: TerminalSessionInfo, scripted: boolean, killed: Enumeration,
  scan: LaunchScan): StopVerdict {
  if (open.portsTruncated) return { kind: "unresolved", leftovers: [], notice: truncatedNotice(open, scripted), complete: false };
  // 记号点到名的那些**压倒一切**:这是直接证据(它的环境里带着这次启动的记号),不是推论。
  if (scan.pids.length) {
    return {
      kind: "unresolved", leftovers: scan.pids, notice: survivorNotice(scan.pids, scripted),
      // 这一问没答全时,这笔账核销不掉:下一次停止看见这几个号死了,也不知道还漏没漏。
      complete: launchClosureSealed(scan),
    };
  }
  // 这一问没答全 = 可能有漏。**不许跟「组探不到了」组成停净的证明** —— 组那一趟成功
  // 证明不了记号扫描遗漏的部分(第 1 轮审查发现 1)。
  if (!launchClosureSealed(scan)) {
    return { kind: "unresolved", leftovers: [], complete: false, notice: scanIncompleteNotice(scan, scripted) };
  }
  // 正面判据:停止前组还活着、现在探不到了,**而且没有「枚举过但没列全」这回事**。
  // `complete === null`(ash 这一趟没动手、用户那条停止命令收的)不算不全 —— 它要是没收掉,
  // 组也不会空;真逃出去的那些另有 ① 那一问直接点名。
  if (open.groupAlive && killed.groupGone && killed.complete !== false) return { kind: "stopped" };
  const did = killed.complete === null
    ? "这次启动的进程早就自己退了（服务在 ash 的进程树之外），没有进程可杀"
    : killed.complete
      ? "ash 已经把这次启动的整个进程组、以及它见过的全部后代收干净了"
      : "ash 这一趟连成员清单都没列全（进程表或端口查询没答上来），收掉的只是问出来的那些";
  const why = PORT_TIER_AVAILABLE
    ? "可这次启动没留下任何本机端口线索：一个双 fork 之后自己 setsid 出去的后台进程，"
      + "在进程树、会话成员、累积进程组三条线索上都点不到名，ash 看不见它，也就证明不了它不存在"
    : "而当前平台无法核验本机端口，脱离了进程树的后台进程这里一条线索都没有";
  return {
    kind: "unresolved", leftovers: [], complete: false,
    // 「ash 没法确认是否停净」这半句是**固定措辞**:界面和回归都靠它认这一档,三条支路
    // 只换前因、不换这句结论。
    notice: `${did}，${why} —— 所以 ash 没法确认是否停净，不能说这次启动起来的东西都停了。`
      + (scripted
        ? "停止命令已执行，但退出码为零不代表服务已经停止；要确认请自己去看一眼。"
        : "请检查服务是否仍在运行，或者在「管理常用命令」里给这个服务填一条真正停得掉它的停止命令。"),
  };
}

/** 停止命令只收掉了监听者、停止前在跑的成员还活着时那句话。 */
export function scriptLeftoverNotice(left: LaunchMember[]): string {
  return `停止命令跑完了，但停止前在跑的 ${who(left)} 还活着：${left[0].reason}。`
    + (left.some((one) => one.ours)
      ? `它们是这次启动起来的，但 ash 不替你那条脚本强杀（你写它正是不想让 ash 直接 kill）——`
        + `要连它们一起收，请在脚本里也收掉它们。`
      : `没有归属凭据，ash 不敢动它们，所以没法说这次启动起来的东西都停了。`);
}

/**
 * 停止命令跑完之后的**终态核验**:它说自己成功了(exit 0)不等于服务真的停了 ——
 * 一条 `true` 也会 exit 0(第 1 轮审查 E2:填一条返回零但什么都不做的脚本,界面照样报
 * 「已停止」、停止按钮消失,服务还在听)。这里不替用户强杀(他写那段脚本正是不想让 ash
 * 直接 kill),只是**不许宣称已停止**:原地报失败、留着可重试的现场。
 */
