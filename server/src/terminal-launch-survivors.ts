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
// **只负责点出来,不扩大 kill 范围**:默认停法该杀到哪儿是另一个判断(service-ports.ts 文件头
// 明令禁止扩大 kill 范围),这里的产出是「谁还活着」这个事实,交给停止路径落账并如实告诉用户。
import { IS_WINDOWS } from "./platform.js";
import { readLineage } from "./service-ports-probe.js";
import { descendantsFromTable, processAlive, readProcessTable } from "./terminal-process-tree.js";

/** ash 自己这条进程树不进候选集:它的环境里没有任何一次启动的记号,但没必要白问一遍。 */
const SELF = process.pid;

/**
 * 这一问的**结果**。空集有三种完全不同的成因,早先全折成 `[]`,于是「没答上来」被当成
 * 「问过了,没有」(第 1 轮审查发现 1 点的 :40/:46)。
 *
 *  · `answered`    —— 问全了,活着的带记号进程就是 `pids` 这些(可能为空);
 *  · `unavailable` —— 这条线索**在这次启动上不存在**:交互会话没有记号,Windows 读不到别人的
 *                     环境。不是「没答上来」,是没有这一问 —— 这一档照旧交给进程树/端口那几档
 *                     判(改它等于反转 Windows 的既有停止判定,而本轮没有 Windows 真机证据,
 *                     根 AGENTS.md 要求碰 win32 分支必须上真机跑);
 *  · `incomplete`  —— 问了,但**可能有漏**:进程表读不出来,或者候选里有号 ps 根本没答上话。
 *                     调用方必须据此拒绝宣称停净。
 *
 * `unknown` 血缘(ps 答上话了、那份环境不给看)**不进 incomplete**:这次启动起来的进程跟 ash
 * 同一个用户,`ps -E` 一定打得出它的环境,读不到的必然是别人家的号。只有 `unverified`
 * (ps 超时/起不来/压根没打出这一行而号还活着)才是真的「没问出来」。
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
 */
export async function launchSurvivors(token: string | null): Promise<LaunchScan> {
  if (token === null || IS_WINDOWS) return { pids: [], evidence: "unavailable", why: null };
  const table = await readProcessTable();
  if (!table) {
    return { pids: [], evidence: "incomplete", why: "进程表读不出来，这次启动的记号没问出去" };
  }
  const orphans = (table.children.get(1) ?? []).filter((pid) => pid > 1 && pid !== SELF);
  if (!orphans.length) return { pids: [], evidence: "answered", why: null };
  const lineage = await readLineage(orphans, token);
  const found = new Set<number>();
  // 「ps 没答上这个号」的那几个。它们可能正是逃出去的那一位,所以这一问就得算没问全。
  const silent: number[] = [];
  for (const orphan of orphans) {
    const relation = lineage.get(orphan);
    // `unknown`(环境不给看 = 别人家的号)不算没答上来,理由见上面的类型注释;
    // `unverified` 才是这一问本身失灵。
    if (relation === "unverified") { silent.push(orphan); continue; }
    if (relation !== "ours") continue;
    found.add(orphan);
    // 顶上那个确认是这次的,它底下整棵子树也是:子树里每一个都继承了同一份环境,再逐个
    // 读一遍环境只是把同一个答案问 N 遍。
    for (const pid of descendantsFromTable(table, orphan).pids) found.add(pid);
  }
  const pids = [...found].filter(processAlive).sort((left, right) => left - right);
  if (!silent.length) return { pids, evidence: "answered", why: null };
  const head = silent.slice(0, 3).map((pid) => `pid ${pid}`).join("、");
  return {
    pids,
    evidence: "incomplete",
    why: `孤儿进程 ${head}${silent.length > 3 ? ` 等 ${silent.length} 个` : ""} 的环境没问出答案`
      + "（ps 超时或没打出这一行，而它们还活着），所以记号这一趟可能有漏",
  };
}
