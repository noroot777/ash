// 「这次启动创造的进程,现在还有哪些活着」—— **按启动记号问,不按血缘问**。
//
// 为什么非得另开一条线索:进程树(ppid)、会话成员(ctty/sid ∪ fd 持有者)、存续期累积的
// pgid,三条全是**血缘**。双 fork 之后立刻 setsid 的守护进程把三条一次断干净 ——
// terminal-session-kill.ts 的文件头把这一类明文列为那套收尾方法的能力之外,说它「只能按它
// 自己打印过的端口来收」;可一条什么都不打印的启动命令连端口这条线索都没有,于是
// 「启动组现在探不到了」就被当成了「这次启动起来的东西都停了」(第 2 轮审查必须修 2,
// probe-group-death 实测:界面干净地显示「已停止」,工人还在跑,而且再也没有入口能停到它)。
//
// 记号跟血缘不一样,它是**继承**来的:spawn 出去的每一代都带着父进程那份环境,setsid 断掉
// 的是血缘,断不掉环境。service-ports-probe.ts 的 `readLineage` 里写着实测结论 —— macOS 的
// `ps -E` 打的是 exec 时那份环境,PPID=1、自成 sid 的进程照样带着记号;Linux 直接读
// `/proc/<pid>/environ`,更是精确比对。
//
// **候选集为什么可以有界**:带记号的进程,它的父进程也必然带记号(环境是继承的)。顺着这条
// 链往上走,顶上那一个的父亲已经退了(否则父亲也还活着、它才是顶上那个),于是它被 PID 1
// 收养 —— **ppid 恒为 1**。所以「孤儿表 + 逐个展开它的子树」必然盖住全部存活的带记号进程,
// 不必对整张进程表读环境(那样 `ps -E` 的输出能到几 MB,撞 execFile 的 maxBuffer 之后这一问
// 整条静默失灵)。
//
// 孤儿表还要再筛一道,但**只许用跟环境无关的事实筛**(属主、出生时刻,见
// service-ports-probe.ts 的 `readProcessFacts`):筛掉的那些是**证明**了不可能是这次的,
// 剩下的才去读环境,读不出来就必须算「没问全」。这一道的由来见下面 `LaunchScan` 的注释。
//
// **只负责点出来,不扩大 kill 范围**:默认停法该杀到哪儿是另一个判断(service-ports.ts 文件头
// 明令禁止扩大 kill 范围),这里的产出是「谁还活着」这个事实,交给停止路径落账并如实告诉用户。
import { IS_WINDOWS } from "./platform.js";
import { readLineage, readProcessFacts } from "./service-ports-probe.js";
import { descendantsFromTable, processAlive, readProcessTable } from "./terminal-process-tree.js";

/** ash 自己这条进程树不进候选集:它的环境里没有任何一次启动的记号,但没必要白问一遍。 */
const SELF = process.pid;

/** ash 跑在哪个用户下。拿不到(理论上只有非 POSIX)就**不启用属主这道筛子** —— 少筛只会
 *  让这一趟更保守地判「没问全」,错筛会把真残留当陌生人跳过。 */
const SELF_UID: number | null = typeof process.getuid === "function" ? process.getuid() : null;

/** 比这次启动早出生多少以内的号仍算候选。`ps` 的 etime 只有秒级精度,进程真正起来的时刻
 *  跟 ash 记下的 `startedAt` 之间也有毫秒级先后 —— 宁可多收几个候选(多收只会让这一趟更
 *  保守),绝不能把真残留筛掉。 */
const BIRTH_GRACE_MS = 5_000;

/**
 * 这一问的**结果**。空集有三种完全不同的成因,早先全折成 `[]`,于是「没答上来」被当成
 * 「问过了,没有」(第 1 轮审查发现 1 点的 :40/:46)。
 *
 *  · `answered`    —— 问全了,活着的带记号进程就是 `pids` 这些(可能为空);
 *  · `unavailable` —— 这条线索**在这次启动上不存在**:交互会话没有记号,Windows 读不到别人的
 *                     环境。不是「没答上来」,是没有这一问 —— 这一档照旧交给进程树/端口那几档
 *                     判(改它等于反转 Windows 的既有停止判定,而本轮没有 Windows 真机证据,
 *                     根 AGENTS.md 要求碰 win32 分支必须上真机跑);
 *  · `incomplete`  —— 问了,但**可能有漏**:进程表读不出来,属主/出生时刻那一问没答上来,
 *                     或者候选里有号的环境没读出答案。调用方必须据此拒绝宣称停净。
 *
 * **`unknown` 血缘属于 `incomplete`,这一点被实测纠正过。** 早先这里写着「这次启动起来的
 * 进程跟 ash 同一个用户,`ps -E` 一定打得出它的环境,读不到的必然是别人家的号」,于是
 * `unknown` 被直接跳过。自由审查用一个同用户、`env:{}` + setsid 的工人证伪了这句话:它
 * uid 跟 ash 相同、PPID=1,`ps -E` 一个变量都不打(macOS 分不出「环境是空的」和「环境不
 * 给看」),于是被当成陌生人跳过 —— 真实 HTTP、真实进程、真实页面都显示「已停止」,那个
 * 工人还在跑。
 *
 * 所以 `unknown` 和 `unverified` 一律算没答上来。为了不让这条判据把每一次停止都钉死在
 * 「没问全」(本机同用户孤儿四百多个,其中两个天生读不到环境),候选集先按属主与出生时刻
 * 筛过一道 —— 筛掉的是**证明**了不可能是这次的。
 */
export type LaunchScan = {
  pids: number[];
  evidence: "answered" | "unavailable" | "incomplete";
  /** `incomplete` 的前因,进措辞;其余两档为 null。 */
  why: string | null;
};

/**
 * 按启动记号找出这次启动的存活进程。`token` 为空(交互会话、没有记号的旧记录)不是
 * 「问过了,没有」—— 它落 `unavailable`,由调用方按既有那几档判。
 *
 * `startedAt` 是这次启动的时刻(`TerminalSessionInfo.startedAt`):比它更早出生的号带不上
 * 这次的记号 —— 那枚记号是启动时现生成的,一个已经在跑的进程无从把它塞进自己的环境。
 */
export async function launchSurvivors(token: string | null, startedAt: number): Promise<LaunchScan> {
  if (token === null || IS_WINDOWS) return { pids: [], evidence: "unavailable", why: null };
  const table = await readProcessTable();
  if (!table) {
    return { pids: [], evidence: "incomplete", why: "进程表读不出来，这次启动的记号没问出去" };
  }
  const orphans = (table.children.get(1) ?? []).filter((pid) => pid > 1 && pid !== SELF);
  if (!orphans.length) return { pids: [], evidence: "answered", why: null };
  const facts = await readProcessFacts(orphans);
  if (!facts) {
    return {
      pids: [], evidence: "incomplete",
      why: "孤儿进程的属主和出生时刻没问出来，这次启动的记号没法逐个核对",
    };
  }
  // 「这一问没答上来」的号。两种来源都得算没问全:属主/出生时刻那一问漏了它而它还活着,
  // 以及它进了候选集、环境那一问却没给出答案。
  const silent: number[] = [];
  const candidates: number[] = [];
  const oldest = Date.now() - startedAt + BIRTH_GRACE_MS;
  for (const orphan of orphans) {
    const fact = facts.get(orphan);
    if (!fact) {
      if (processAlive(orphan)) silent.push(orphan);
      continue;
    }
    // 筛掉的两种都是**否证**,不是「没问出来」:属主不同 = 子进程继承属主,它不可能是这次
    // 启动直接创造的;出生在这次启动之前 = 那会儿这枚记号还不存在。
    if (SELF_UID !== null && fact.uid !== SELF_UID) continue;
    if (fact.ageMs > oldest) continue;
    candidates.push(orphan);
  }
  const lineage = await readLineage(candidates, token);
  const found = new Set<number>();
  for (const pid of candidates) {
    const relation = lineage.get(pid);
    if (relation === undefined) continue;    // 这个号已经退了(readLineage 的约定)
    if (relation === "stranger") continue;   // 权威否证:环境读出来了,里面没有这次的记号
    if (relation !== "ours") { silent.push(pid); continue; }  // unknown / unverified
    found.add(pid);
    // 顶上那个确认是这次的,它底下整棵子树也是:子树里每一个都继承了同一份环境,再逐个
    // 读一遍环境只是把同一个答案问 N 遍。
    for (const heir of descendantsFromTable(table, pid).pids) found.add(heir);
  }
  const pids = [...found].filter(processAlive).sort((left, right) => left - right);
  if (!silent.length) return { pids, evidence: "answered", why: null };
  const head = silent.slice(0, 3).map((pid) => `pid ${pid}`).join("、");
  return {
    pids,
    evidence: "incomplete",
    why: `孤儿进程 ${head}${silent.length > 3 ? ` 等 ${silent.length} 个` : ""} 没问出答案`
      + "（属主、出生时刻、环境里的记号，有一样 ps 没给出来，而它还活着），所以记号这一趟可能有漏",
  };
}
