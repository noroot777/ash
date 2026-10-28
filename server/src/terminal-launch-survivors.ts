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
 * 按启动记号找出这次启动的存活进程。`token` 为空(交互会话、没有记号的旧记录)返回空集 ——
 * 没有记号就没有这一问,**不是**「问过了,没有」。
 *
 * 进程表读不出来同样返回空集:这一问没答上话,它的沉默不构成「都停了」。调用方那一侧另有
 * 枚举完整性这档判据,不靠这里的空集下结论。
 */
export async function launchSurvivors(token: string | null): Promise<number[]> {
  if (token === null || IS_WINDOWS) return [];
  const table = await readProcessTable();
  if (!table) return [];
  const orphans = (table.children.get(1) ?? []).filter((pid) => pid > 1 && pid !== SELF);
  if (!orphans.length) return [];
  const lineage = await readLineage(orphans, token);
  const found = new Set<number>();
  for (const orphan of orphans) {
    if (lineage.get(orphan) !== "ours") continue;
    found.add(orphan);
    // 顶上那个确认是这次的,它底下整棵子树也是:子树里每一个都继承了同一份环境,再逐个
    // 读一遍环境只是把同一个答案问 N 遍。
    for (const pid of descendantsFromTable(table, orphan).pids) found.add(pid);
  }
  return [...found].filter(processAlive).sort((left, right) => left - right);
}
