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
 *      - 旧账是「一个号都举不出来」的那种 unresolved(端口超额:证据本身不全)→ **永远**
 *        不能被核销。再跑一百次 lsof 也只是把「记下的那几个端口」问了一百遍,没记下的那些
 *        压根没被问过。它不卡生命周期(没有活号 ⇒ 不占「还在跑」),但这次启动到死都得带着
 *        「没能确认停净」这句话 —— 这正是发现 1 实测出来的那条路。
 */
export function mergeStop(prev: StopFact, next: StopResolution): StopFact {
  const carried = prev.kind === "unresolved" ? prev.pids.filter(processAlive) : [];
  if (next.kind === "unresolved") {
    return { kind: "unresolved", pids: [...new Set([...carried, ...next.pids])], why: next.why };
  }
  if (prev.kind === "unresolved" && (carried.length > 0 || prev.pids.length === 0)) {
    return { kind: "unresolved", pids: carried, why: prev.why };
  }
  return { kind: "verified" };
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
  session.factsGeneration += 1;
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

/** 进 DTO 的投影:只报还活着的号。`pids` 空掉**不改 kind** —— 那句话仍然要说。 */
export function projectStop(stop: StopFact): StopFact {
  return stop.kind === "unresolved" ? { ...stop, pids: liveLeftovers(stop) } : stop;
}

/**
 * 删会话**之前**的端口收口:把这次启动起来的、还听着端口的东西收掉,收不掉就如实说。
 *
 * 为什么非得有这一步:会话记录是端口这一档**唯一**的把手 —— 这次启动的记号
 * (launchToken)只活在这条记录里,记录一删,那枚记号跟着没,真·守护化的服务从此既核不上
 * 归属也没人去问它那个端口。于是「关 tab」和「删项目」会把一个还在跑的服务变成**永久孤儿**
 * (第 3 轮审查发现 2)。返回非 null = 没收干净,调用方据此**保留记录**、拒绝这次删除。
 *
 * 判「没收干净」只认归属(probeOwnedPorts):端口上坐着别人的服务不该拦着用户关 tab。
 */
export async function releaseLaunchPorts(session: TerminalSession): Promise<string | null> {
  if (!PORT_TIER_AVAILABLE || session.commandId === null || session.launchPorts.size === 0) return null;
  const ports = [...session.launchPorts];
  const token = session.launchToken;
  if (token) await stopByPorts(ports, { launchToken: token });
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
export function releaseLaunchPortsSync(sessions: Iterable<TerminalSession>): number {
  if (!PORT_TIER_AVAILABLE) return 0;
  let killed = 0;
  for (const session of sessions) {
    if (session.commandId === null || !session.launchToken || session.launchPorts.size === 0) continue;
    killed += stopByPortsSync(session.launchPorts, session.launchToken).killed.length;
  }
  return killed;
}
