/**
 * 「这次启动停没停净」这笔**账**:怎么记、怎么合并、什么时候才算核销。
 *
 * 单独成文件的理由有两条。一是 terminal.ts 已经贴着 700 行上限;二是更要紧的 ——
 * **这笔账必须只有一套写法**。停止、重启、关 tab、删项目、关服、闲置回收、前端那颗按钮,
 * 六七个表面都要读「上一次停止留下了什么」,各自就地判一遍的结果是:端口这一档只被停止按钮
 * 认了,关 tab 和关服照旧把会话表连 launchToken 一起删掉 —— 真·守护化的服务于是彻底脱管
 * (第 3 轮审查发现 2);而「没能确认」这一档被 PID 列表兼任,空列表被下一次停止读成「干净」
 * (同轮发现 1)。所以合并规则、投影规则、端口收口全集中在这里,调用方只负责调。
 *
 * 判据(StopFact 的四档语义、为什么单调)写在 terminal-session-facts.ts 的类型上。
 */
import { handedOver } from "./launch-handover.js";
import { PORT_TIER_AVAILABLE, probeOwnedPorts, stopByPorts, stopByPortsSync } from "./service-ports.js";
import type { StopFact, StopResolution, TerminalSession } from "./terminal-session-facts.js";
import { processAlive } from "./terminal-process-tree.js";

/**
 * 把一次新的核验结论合进已有的账 —— **单调**:范围更窄的核验不许核销范围更宽的责任。
 *
 *  · 新结论是 `unresolved` → 跟旧账里**还活着**的那几个号取并集(上一次没核销的责任不会
 *    因为这一次换了句说法就消失);
 *  · 新结论是 `verified`:
 *      - 旧账挂着的号**逐个确认已经不在了** → 这笔责任真的核销了,落 `verified`;
 *      - 还有活着的 → 继续挂着,保留原来那句话;
 *      - 旧账是 `complete=false` 的 unresolved(端口超额等:证据本身不全)→ **永远**
 *        不能被核销。再跑一百次 lsof 也只是把「记下的那几个端口」问了一百遍,没记下的那些
 *        压根没被问过。它不卡生命周期(没有活号 ⇒ 不占「还在跑」),但这次启动到死都得带着
 *        「没能确认停净」这句话 —— 这正是发现 1 实测出来的那条路。
 */
export function mergeStop(prev: StopFact, next: StopResolution): StopFact {
  const carried = prev.kind === "unresolved" ? prev.pids.filter(processAlive) : [];
  const complete = (prev.kind !== "unresolved" || prev.complete) && (next.kind !== "unresolved" || next.complete);
  const pids = [...new Set([...carried, ...(next.kind === "unresolved" ? next.pids : [])])];
  if (next.kind === "verified" && complete && pids.length === 0) return { kind: "verified" };
  const memberReasons: Record<string, string> = {};
  const incompleteReasons: string[] = [];
  for (const fact of [prev, next]) {
    if (fact.kind !== "unresolved") continue;
    for (const pid of fact.pids) {
      if (pids.includes(pid)) memberReasons[pid] = fact.memberReasons?.[pid] ?? fact.why;
    }
    if (!fact.complete) incompleteReasons.push(...(fact.incompleteReasons ?? [fact.why]));
  }
  const missing = [...new Set(incompleteReasons)];
  return {
    kind: "unresolved", pids, complete, memberReasons, incompleteReasons: missing,
    why: [...new Set([...Object.values(memberReasons), ...missing])].join("\n"),
  };
}

/**
 * 落一次核验结论,并把缓存的端口事实一并收口。
 *
 * 调用方必须是**已经核实过端口不再属于这次启动**之后才来调(停止路径的 StopVerdict、
 * releaseLaunchPorts),所以这里直接把 portsAlive 落回 false:否则下一拍扫描之前,这条会话
 * 还会被当成「还在跑」,start 的幂等门会拒绝重新启动(第 2 轮审查发现 1)。
 *
 * 代次 +1:此刻可能有一次 lsof 探测正飞在路上(取样早于这次停止),它写回来会把 portsAlive
 * 复活成 true。观测层写之前核对代次,过期的那一拍整条丢掉。
 */
export function applyStop(session: TerminalSession, next: StopResolution): void {
  session.stop = mergeStop(session.stop, next);
  session.portsAlive = false;
  session.portUncertain = false;
  session.factsGeneration += 1;
}

/**
 * **发现即落账**:这一趟新发现的「没核销的责任」立刻并进账,不等这次动作成不成功。
 *
 * 为什么不能等到成功分支再落:停止这条路上,`stopByPorts` 枚举同组成员时就已经知道「这几个
 * 核不上归属、我没敢动」,但那之后还要回头核一遍端口,核不出来就提前返回 stuck —— 发现
 * 被原地丢掉。下一遍再点停止时监听者已经死了,同组那个工人**再也不会被发现**,于是端口一空
 * 就判成 verified,刚加的销毁保护也跟着被绕过(第 5 轮审查发现 1 实测:第一次停止 502、
 * 工人还活着、`stop` 仍是 none;第二次停止 200 verified,工人照旧活着)。
 *
 * 所以落账的时机是**发现的那一刻**,不是结论的那一刻。它只动账,不碰 portsAlive/代次 ——
 * 此刻端口可能还有人听,运行事实该由核验分支去改。`pids` 允许为空:那是「清单本身不全」
 * (进程表或 lsof 问不出来、端口超额),同样是一笔核销不掉的责任。
 */
export function oweLeftovers(session: { stop: StopFact }, pids: number[], why: string, complete = true): void {
  session.stop = mergeStop(session.stop, { kind: "unresolved", pids, why, complete });
}

/**
 * 「用户要求停止」—— 动手**之前**就落下,它不表示停净了(terminateSession 的 TERM/KILL
 * 后面每一轮都可能失败)。只覆盖 `none`:已经有核验结论的账不许被降级回「刚请求」。
 */
export function requestStop(session: { stop: StopFact }): void {
  if (session.stop.kind === "none") session.stop = { kind: "requested" };
}

/** 账上**此刻还活着**的号。后来自己退掉是常态,不过滤会把界面永久钉在「还没停完」。 */
export function liveLeftovers(stop: StopFact): number[] {
  return stop.kind === "unresolved" ? stop.pids.filter(processAlive) : [];
}

export function projectStop(stop: StopFact): StopFact {
  return stop.kind === "unresolved" ? mergeStop(stop, { kind: "verified" }) : stop;
}

/**
 * 删会话**之前**的最后一道门:这次启动的责任清完了吗。返回非 null = 没清完,调用方据此
 * **保留记录**、拒绝这次删除。
 *
 * 为什么非得有这一步:会话记录是这次启动**唯一**的把手 —— 那枚记号(launchToken)、那几个
 * 端口、那笔没核销的账全只活在这条记录里。记录一删,还在跑的东西就既核不上归属、也没人
 * 再去问它那个端口,变成**永久孤儿**(第 3 轮审查发现 2:关 tab、删项目都走这儿)。
 *
 * 判据是**完整责任集合**,不是只有端口那一档。第 3 轮只补了端口,于是第 4 轮审查发现 1
 * 实测到同一条路还开着:默认停止已经如实报了「还剩 1 个进程核不上归属」,紧接着删项目
 * 返回 ok、会话列表清空,那个采集 worker 还活着 —— 账本的单调性保住了对象,对象却被整个
 * 删掉了,单调性因此没有保护到生命周期。所以这里的顺序是:
 *
 *   ① 端口这一档先补刀(顺带把补刀新发现的责任记进账);
 *   ② 再看账上**此刻还活着**的号 —— 有一个都不许删。
 *
 * **唯一的例外**是「一个号都举不出来」的那种 unresolved(端口超额:证据本身不全)。它按
 * 设计永远核销不掉(terminal-session-facts.ts 的类型注释),拿它拦删除等于让这条 tab 永远
 * 关不掉、这个项目永远删不掉 —— 而且也没有任何把手可用,拦着并不能让用户多停掉一个进程。
 * 所以它不卡生命周期,只卡「能不能说停净了」。
 */
export async function releaseLaunchResponsibility(session: TerminalSession): Promise<string | null> {
  const stuck = await releaseLaunchPorts(session);
  if (stuck) return stuck;
  const owed = liveLeftovers(session.stop);
  if (!owed.length) return null;
  const why = session.stop.kind === "unresolved" ? `${session.stop.why}；` : "";
  return `这次启动还有 ${owed.length} 个进程在跑（pid ${owed.join("、")}）：${why}没敢把会话记录删掉（删了这笔账和停止入口就一起没了）`;
}

/**
 * 上面那道门的**端口**那一档:把这次启动起来的、还听着端口的东西收掉,收不掉就如实说。
 * 补刀过程中发现的「核不上归属所以一个字没动」的同组成员要**记进账**(`stopByPorts` 的
 * leftovers),否则这一趟新发现的责任会随着返回值一起被丢掉。
 *
 * 判「端口没收干净」只认归属(probeOwnedPorts):端口上坐着**别人**的服务不该拦着用户关
 * tab(第 3 轮审查发现 3)。
 */
async function releaseLaunchPorts(session: TerminalSession): Promise<string | null> {
  if (!PORT_TIER_AVAILABLE || session.commandId === null || session.launchPorts.size === 0) return null;
  if (session.portsTruncated) {
    oweLeftovers(session, [], "这次启动打印的本机端口超过了记录额度，多出来的端口没能核验", false);
  }
  const ports = [...session.launchPorts];
  const token = session.launchToken;
  if (token) {
    const outcome = await stopByPorts(ports, { launchToken: token });
    // 只动账,不碰 portsAlive/代次:此刻端口可能还有人听,运行事实由下面的 probe 作结论。
    if (outcome.leftovers.length) {
      oweLeftovers(
        session,
        outcome.leftovers.map((left) => left.pid),
        outcome.leftovers.map((left) => `pid ${left.pid} ${left.reason}`).join("；"),
      );
    }
    // **清单不全也是一笔账。** 早先这儿只吸收 leftovers,于是「同组成员没能枚举全」整档被
    // 漏掉,紧接着下面那句 applyStop(verified) 就把这次启动核销了 —— 它跟端口超额是同一种
    // 残缺(该问的没问全),同样落成 pids 为空的那种 unresolved:不卡删除(没有活号可举,
    // 拦着也多停不掉一个进程),但这次启动到死都带着「没能确认停净」(第 6 轮审查 F1)。
    if (outcome.membersIncomplete) {
      oweLeftovers(session, [], "这次没能把同组成员列全（进程表或端口查询没答上来）—— 跟它一起起来的还有谁，ash 这一趟没问到", false);
    }
  }
  const probe = await probeOwnedPorts(ports, token);
  const where = `端口 ${ports.join("、")}`;
  if (probe.state === "ours") {
    return `${where} 上还有这次启动起来的进程在听，TERM/KILL 都没让它停下来 —— 没敢把会话记录删掉（删了就再没有把手能停它）`;
  }
  // 「问不出来」不许当成「空了」(service-ports.ts 文件头):保留记录让用户能再试一次,
  // 比删掉凭据、让那个服务永久脱管强。
  if (probe.state === "unknown") return `${probe.why} —— 没法确认这次启动起来的东西都停了，所以没敢把会话记录删掉`;
  applyStop(session, { kind: "verified" });
  return null;
}

/**
 * 关服那一拍的端口收口。**同步** —— `process.once("exit")` 里没有 await 可用(信号处理器
 * 直接 process.exit,见 singleton.ts),所以整条关服清场都是同步的,端口这一档也必须是。
 * 判据与异步版一致(只动带记号的),区别只有「不等宽限」:TERM/KILL 连发,同
 * killAllSessionTrees。
 */
export function releaseLaunchPortsSync(sessions: Iterable<TerminalSession>): { killed: number; owed: string[] } {
  const owed: string[] = [];
  let killed = 0;
  for (const session of sessions) {
    if (session.commandId === null) continue;
    // 用户显式放弃过的这次启动:ash 关服时不再按它的端口和记号去收人,退出交代里也不再提它
    // (那正是放弃的解除范围里写明的一条,terminal-abandon.ts)。
    if (handedOver(session)) continue;
    if (PORT_TIER_AVAILABLE && session.launchToken && session.launchPorts.size > 0) {
      const swept = stopByPortsSync(session.launchPorts, session.launchToken);
      killed += swept.killed.length;
      // 这一拍**新发现**的也要先落账,否则下面那句交代只说得出账上原有的号 —— 从没点过停止
      // 就直接关服时,同组那个工人一个字都不会被提到(第 5 轮审查发现 1)。
      if (swept.leftovers.length) {
        oweLeftovers(session, swept.leftovers, "关服那一拍发现它们核不上归属,没敢动");
      }
      if (swept.membersIncomplete) {
        oweLeftovers(session, [], "关服那一拍问不出进程表,同组还有谁没能枚举全", false);
      }
    }
    // 补刀之后账上还活着的号:**没有一条路能把它停掉** —— 它们当初就是因为核不上归属才
    // 被放过的,关服这一拍不会突然多出凭据,扩大 kill 范围是明令禁止的(service-ports.ts
    // 文件头)。能做的是**别让这笔账无声无息地消失**:记录随进程一起没了,用户重启 ash
    // 之后既看不到提示、也没有把手,只有靠这行日志才知道机器上还留着什么(第 4 轮审查发现 1)。
    const left = liveLeftovers(session.stop);
    if (left.length) {
      const where = session.launchPorts.size ? `端口 ${[...session.launchPorts].join("、")}` : "没有记下端口";
      owed.push(`「${session.name}」pid ${left.join("、")}（${where}）`);
    }
  }
  return { killed, owed };
}
