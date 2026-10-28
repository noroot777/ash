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
// 孤儿表还要再筛一道,而**筛掉一个号必须是否证,不能只是「不像」**。只有两件事够这个份量,
// 因为它们说的是「这不可能是这次启动创造的」:
//
//  · **属主**(`readProcessFacts` 的 uid)—— 子进程继承属主,ash 这个用户起不出别人家的号;
//  · **出生时刻**(同上的 etime)—— 这次启动的记号是启动那一刻现生成的,比它更早出生的进程
//    无从把它塞进自己的环境,也就压根不是这次创造的。
//
// 剩下的一律去读环境。**记号本身只提供正面归属**:读出来带着这次的记号 = 是这次的;没有记号
// **不等于**不是这次的 —— 启动脚本给自己 fork 出去的工人现搭一份环境,记号就不跟过去了
// (第 2 轮自由审查 F2 真实复现:页面「已停止」、刷新仍然如此,工人还在跑)。唯一的例外是
// 环境里带着**另一次** ash 启动的记号:那枚号码是 ash 自己生成的,别人编不出来,所以它确凿
// 属于另一次启动(`stranger`)。
//
// **工作目录不在筛子之列,它只用来「辅助找人」**(`readProcessCwd`)。第 2 轮修复曾拿它当第三
// 道筛子:目录跟启动目录不一样就在读环境之前直接跳过,于是剩下的候选问全了就报「问全了」。
// 第 3 轮自由审查用同一个工人、只把它的 cwd 换成 `/` 实测:stop 200、`stop={"kind":"verified"}`、
// 页面干净地显示「已停止」,`WORKER_ALIVE_AFTER_STOP true`。cwd 是**可变**的(后代一句 chdir
// 就改掉,现搭环境的工人更是连记号都不带),拿一个可变属性筛掉候选、再把剩下那些的答案当成
// 整次启动的完整性证明,跟上一轮「记号没命中就当陌生人」是同一个错,只换了属性。所以它现在
// 只决定**先点谁的名**(目录跟启动目录一致的最可疑),不决定谁进不进候选集。
//
// **只负责点出来,不扩大 kill 范围**:默认停法该杀到哪儿是另一个判断(service-ports.ts 文件头
// 明令禁止扩大 kill 范围),这里的产出是「谁还活着」这个事实,交给停止路径落账并如实告诉用户。
import { IS_WINDOWS } from "./platform.js";
import { realpathSync } from "node:fs";
import { readLineage, readProcessCwd, readProcessFacts } from "./service-ports-probe.js";
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

/** 这次启动的身份:记号 + 两件跟记号无关的继承事实。 */
export type LaunchIdentity = { startedAt: number; cwd: string };

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
 * 所以 `unknown` 和 `unverified` 一律算没答上来。**第 2 轮自由审查又把 `unmarked`(环境
 * 读出来了、一枚 ash 记号都没有)并了进来**:启动脚本可以给工人现搭环境,那个号是这次
 * 启动创造的,只是记号没跟过去 —— 当时它被当成陌生人跳过,停止于是报了「已停止」。
 *
 * **这一档会比直觉上更常出现,那是实话而不是缺陷。** 候选集只能按属主和出生时刻收窄(那两条
 * 是否证),而本机同属主、出生在最近一小时内的 PID-1 孤儿实测有 14 个(一天内 26 个),全都是
 * 「环境读出来了、一枚 ash 记号都没有」—— 跟一个现搭环境的真实后代长得一模一样。一次没打印
 * 端口、又可能双 fork 出后代的启动,**本来就不存在「停净了」的证明**:ash 能做的是点名它确凿
 * 认得的那些,并如实说出剩下那部分它证不出来。想把它变成可证明的,出路在措辞里给着 ——
 * 填一条停止命令(那条道由脚本自己负责收干净),或者显式放弃管理(terminal-abandon.ts)。
 *
 * 第 2 轮曾拿「工作目录不一致就跳过」把这个数压下去,第 3 轮审查实测那是在拿可变属性伪造
 * 完整性证明(见文件头)。少报一个真实残留的代价,比多一句「这次我证不出来」大得多。
 */
export type LaunchScan = {
  /** **点到名的**:环境里带着这次启动的记号,确凿是这次的。只有这一档能进停止账的 pid 列表。 */
  pids: number[];
  evidence: "answered" | "unavailable" | "incomplete";
  /**
   * **问不出归属的**(`incomplete` 的成因逐号列出;其余两档为空)。
   *
   * 跟 `pids` 严格分开,**绝不能合进账里**:它们只是「ash 证不出它不是这次的」,拿它当残留
   * 报给用户就是把系统自己的守护进程说成这次启动的遗留。它在这里单独列出来只为两件事:
   * 一是措辞按它生成,二是让调用方/回归能直接问「那个号被算进没答上来的集合了吗」,
   * 不必去解析那句人话。
   */
  unanswered: number[];
  /** `incomplete` 的前因,进措辞;其余两档为 null。 */
  why: string | null;
};

/**
 * 按启动记号找出这次启动的存活进程。`token` 为空(交互会话、没有记号的旧记录)不是
 * 「问过了,没有」—— 它落 `unavailable`,由调用方按既有那几档判。
 *
 * `launch.startedAt` 是这次启动的时刻(`TerminalSessionInfo.startedAt`):比它更早出生的号
 * 带不上这次的记号 —— 那枚记号是启动时现生成的,一个已经在跑的进程无从把它塞进自己的环境。
 * `launch.cwd` 是这次启动的工作目录。它**不参与筛选**,只用来在「这几个号问不出归属」那句话里
 * 把最可疑的排在前面:cwd 跟环境是两条独立的继承线,记号被现搭的环境冲掉时它可能还在,所以它
 * 是一条有用的线索 —— 但它可变(后代一句 chdir 就改掉),所以既不能拿它点名,更不能拿它筛人
 * (第 3 轮自由审查 F1 实测:筛了之后 stop 报 verified,工人还活着)。
 */
export async function launchSurvivors(token: string | null, launch: LaunchIdentity): Promise<LaunchScan> {
  if (token === null || IS_WINDOWS) return { pids: [], unanswered: [], evidence: "unavailable", why: null };
  const table = await readProcessTable();
  if (!table) {
    return { pids: [], unanswered: [], evidence: "incomplete", why: "进程表读不出来，这次启动的记号没问出去" };
  }
  const orphans = (table.children.get(1) ?? []).filter((pid) => pid > 1 && pid !== SELF);
  if (!orphans.length) return { pids: [], unanswered: [], evidence: "answered", why: null };
  const facts = await readProcessFacts(orphans);
  if (!facts) {
    return {
      pids: [], unanswered: [], evidence: "incomplete",
      why: "孤儿进程的属主和出生时刻没问出来，这次启动的记号没法逐个核对",
    };
  }
  // 「这一问没答上来」的号。两种来源都得算没问全:属主/出生时刻那一问漏了它而它还活着,
  // 以及它进了候选集、环境那一问却没给出答案。
  const silent: number[] = [];
  const candidates: number[] = [];
  const oldest = Date.now() - launch.startedAt + BIRTH_GRACE_MS;
  for (const orphan of orphans) {
    const fact = facts.get(orphan);
    if (!fact) {
      if (processAlive(orphan)) silent.push(orphan);
      continue;
    }
    // **这两道是全部筛子,而且两道都是否证**,不是「没问出来」:属主不同 = 子进程继承属主,
    // 它不可能是这次启动直接创造的;出生在这次启动之前 = 那会儿这枚记号还不存在。
    // 工作目录**不在这里** —— 它可变,筛掉的可能正是真后代(文件头第 3 轮 F1 实测)。
    if (SELF_UID !== null && fact.uid !== SELF_UID) continue;
    if (fact.ageMs > oldest) continue;
    candidates.push(orphan);
  }
  const lineage = await readLineage(candidates, token);
  const found = new Set<number>();
  for (const pid of candidates) {
    const relation = lineage.get(pid);
    if (relation === undefined) continue;    // 这个号已经退了(readLineage 的约定)
    // **唯一的否证**:它的环境里带着另一次 ash 启动的记号。那串号码是 ash 现生成的,
    // 没有别的来路。「一枚记号都没有」(unmarked)不在此列 —— 见文件头。
    if (relation === "stranger") continue;
    if (relation !== "ours") { silent.push(pid); continue; }  // unmarked / unknown / unverified
    found.add(pid);
    // 顶上那个确认是这次的,它底下整棵子树也是:子树里每一个都继承了同一份环境,再逐个
    // 读一遍环境只是把同一个答案问 N 遍。
    for (const heir of descendantsFromTable(table, pid).pids) found.add(heir);
  }
  const pids = [...found].filter(processAlive).sort((left, right) => left - right);
  if (!silent.length) return { pids, unanswered: [], evidence: "answered", why: null };
  const unanswered = silent.filter(processAlive);
  if (!unanswered.length) return { pids, unanswered: [], evidence: "answered", why: null };
  return { pids, unanswered, evidence: "incomplete", why: await unansweredWhy(unanswered, launch) };
}

/**
 * 「这几个号问不出归属」那句话。**工作目录在这里、而且只在这里出场**:它可变,所以筛不得人,
 * 但它是一条真线索 —— 跟启动目录一致的那几个最该被先点出来让用户看一眼。问不出 cwd 的
 * (`readProcessCwd` 返回 null,或者单个号读不到)不降级也不升级,按原序排在后面。
 */
async function unansweredWhy(silent: number[], launch: LaunchIdentity): Promise<string> {
  const home = launchCwd(launch.cwd);
  const cwds = home === null ? null : await readProcessCwd(silent);
  const nearest = silent.filter((pid) => cwds?.get(pid) === home);
  const ranked = [...nearest, ...silent.filter((pid) => !nearest.includes(pid))];
  const head = ranked.slice(0, 3).map((pid) => `pid ${pid}`).join("、");
  return `孤儿进程 ${head}${ranked.length > 3 ? ` 等 ${ranked.length} 个` : ""} 核不上`
    + "（它们跟这次启动同属主、出生在这次启动之后，而环境里既没有这次的记号、也没有别次启动的"
    + "记号——没有记号不等于不是这次的：启动脚本给工人现搭一份环境，记号就不跟过去了）"
    + (nearest.length
      ? `；其中 ${nearest.length} 个的工作目录跟这次启动一致，最该先看它们`
      : "；没有一个的工作目录跟这次启动一致，但工作目录改得动，所以这也不算证明")
    + "，所以这一趟可能有漏";
}

/**
 * 启动目录的比较形态。cwd 那一问给的是内核解析过的真实路径,而会话行里存的是用户当初填的
 * 那一串(可能经过软链,比如 macOS 上的 `/tmp` → `/private/tmp`),不先拉平就会**每个号都
 * 对不上**。解析不了(目录已经不在了)返回 null = 这条线索这一趟没有。
 */
function launchCwd(cwd: string): string | null {
  try { return realpathSync(cwd); } catch { return null; }
}
