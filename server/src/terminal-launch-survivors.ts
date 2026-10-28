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
// ── 这一层的全部边界,写在一处 ────────────────────────────────────────────────────
//
// 这条线索被实测推翻过四次,四次都是同一个错换一件外衣:拿一件**不是不可能性**的事当成
// 「它不是这次创造的」的证明。所以边界不再逐项补特判,而是在这里一次讲清,代码按这份划分
// 执行(`candidateBounds` / `candidateRoots`):
//
// **① 能把一个号排除在外的,只有不可能性,而且只有两条**:
//
//  · **属主**(`readProcessFacts` 的 uid)—— 子进程继承属主,普通用户起不出别人家的号;
//  · **出生时刻**(同上的 etime)—— 这次启动的记号是启动那一刻现生成的,比它更早出生的进程
//    无从把它塞进自己的环境,也就压根不是这次创造的。
//
// **② 这两条各自有前提,前提不成立时照样收窄、但这一趟不许封口**。收窄是为了把搜索控制在
// 读得动的范围内(不收窄就得给整张进程表读环境,`ps -E` 的输出能到几 MB,撞 execFile 的
// maxBuffer 之后这一问整条静默失灵);封口要的是证明,两件事不能互相顶替。前提分别是:
// ash 不是 root(root 的后代能 setuid 换掉属主),以及墙上钟在这段时间里没被改过。
//
// **③ 其余一切只能「辅助找人」,不能排除人**。记号没命中(`unmarked`)、环境读不出来
// (`unknown`)、工作目录对不上 —— 都只是没有证据,不是反证。**带着另一次启动记号
// (`stranger`)也在此列**:那串号码确实是 ash 生成的,可环境是**可复制**的 —— 启动脚本把
// 上一次启动时存下的环境原样拿来派工人,这个号就带着旧记号、却确凿是这次创造的(第 4 轮
// 自由审查用真实 API + 真实进程实测:存下第一次启动的 `ASH_LAUNCH_ID`、第二次启动用它派
// 工人,stop 报 `{"kind":"verified"}`、页面「已停止」,`WORKER_ALIVE_AFTER_STOP true`)。
// 工作目录同理,它可变(第 3 轮自由审查 F1:同一个工人只把 cwd 换成 `/`,停止就报停净)。
// 这一档现在只决定**先点谁的名**(`unansweredWhy`),不决定谁进不进候选集。
//
// **④ 候选集怎么枚举,前提同样要立得住**。带记号的进程,它的父进程也必然带记号(环境是继承
// 的),所以顺着链往上走,顶上那一个的父亲已经退了 —— 它被**重新收养**。早先这里写死「收养
// 的只会是 PID 1」,那在 Linux 上不成立:`PR_SET_CHILD_SUBREAPER` 的进程(systemd --user 就
// 是)会把孤儿收在自己名下,于是双 fork 出去的工人根本不在 `children.get(1)` 里,这一问会
// 干净地答「没有」。收养目标必定是**死掉那个进程的某个祖先**,而它是 ash 的后代,所以目标
// 必在 `{1} ∪ ash 的祖先链` 之内 —— 按这个集合枚举,前提就不依赖任何平台特性了
// (ash 自己不在其中:Node 不设 subreaper 标志,而 ash 还活着的直接子进程由会话自己的
// pid/进程组那条线索负责,不归这一问)。
//
// **只负责点出来,不扩大 kill 范围**:默认停法该杀到哪儿是另一个判断(service-ports.ts 文件头
// 明令禁止扩大 kill 范围),这里的产出是「谁还活着」这个事实,交给停止路径落账并如实告诉用户。
import { IS_WINDOWS } from "./platform.js";
import { realpathSync } from "node:fs";
import { readLineage, readProcessCwd, readProcessFacts } from "./service-ports-probe.js";
import { descendantsFromTable, processAlive, readProcessTable, type ProcessTable } from "./terminal-process-tree.js";

/** ash 自己这条进程树不进候选集:它的环境里没有任何一次启动的记号,但没必要白问一遍。 */
const SELF = process.pid;

/** ash 跑在哪个用户下。拿不到(理论上只有非 POSIX)就**不启用属主这道筛子** —— 少筛只会
 *  让这一趟更保守地判「没问全」,错筛会把真残留当陌生人跳过。 */
const SELF_UID: number | null = typeof process.getuid === "function" ? process.getuid() : null;

/** 比这次启动早出生多少以内的号仍算候选。`ps` 的 etime 只有秒级精度,进程真正起来的时刻
 *  跟 ash 记下的 `startedAt` 之间也有毫秒级先后 —— 宁可多收几个候选(多收只会让这一趟更
 *  保守),绝不能把真残留筛掉。 */
const BIRTH_GRACE_MS = 5_000;

/** 墙上钟被改动的容差。`process.uptime()` 是单调的,所以「现在换算出的 ash 起跑墙上时刻」
 *  只会随钟本身被改而漂 —— 两次换算差得超过这个数,就是钟在 ash 活着这段时间里动过。 */
const CLOCK_MOVED_TOLERANCE_MS = 2_000;

/** 按**当前**墙上钟换算出的「ash 这个进程起跑的时刻」。 */
const ashStartWall = () => Date.now() - Math.round(process.uptime() * 1000);
const ASH_START_WALL = ashStartWall();

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
 *                     候选里有号的环境没读出答案,或者两道收窄规则的前提这一趟立不住。
 *                     调用方必须据此拒绝宣称停净。
 *
 * **`unknown` 血缘属于 `incomplete`,这一点被实测纠正过。** 早先这里写着「这次启动起来的
 * 进程跟 ash 同一个用户,`ps -E` 一定打得出它的环境,读不到的必然是别人家的号」,于是
 * `unknown` 被直接跳过。自由审查用一个同用户、`env:{}` + setsid 的工人证伪了这句话:它
 * uid 跟 ash 相同、PPID=1,`ps -E` 一个变量都不打(macOS 分不出「环境是空的」和「环境不
 * 给看」),于是被当成陌生人跳过 —— 真实 HTTP、真实进程、真实页面都显示「已停止」,那个
 * 工人还在跑。
 *
 * 后来 `unmarked`(环境读出来了、一枚 ash 记号都没有)和 `stranger`(带着**另一次**启动的
 * 记号)也先后被实测并了进来,理由都写在文件头③:记号只提供**正面**归属,它的缺席、它指向
 * 别处,都不构成「这不是这次创造的」。
 *
 * **这一档会比直觉上更常出现,那是实话而不是缺陷。** 候选集只能按属主和出生时刻收窄(那两条
 * 是否证),而本机同属主、出生在最近一小时内的 PID-1 孤儿实测有 14 个(一天内 26 个),全都是
 * 「环境读出来了、一枚 ash 记号都没有」—— 跟一个现搭环境的真实后代长得一模一样。一次没打印
 * 端口、又可能双 fork 出后代的启动,**本来就不存在「停净了」的证明**:ash 能做的是点名它确凿
 * 认得的那些,并如实说出剩下那部分它证不出来。想把它变成可证明的,出路在措辞里给着 ——
 * 填一条停止命令(那条道由脚本自己负责收干净),或者显式放弃管理(terminal-abandon.ts)。
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
   *
   * 注意它**可以是空的而这一趟仍然 `incomplete`**:收窄规则的前提立不住时,漏的是谁都说不上来。
   */
  unanswered: number[];
  /** `incomplete` 的前因,进措辞;其余两档为 null。 */
  why: string | null;
};

/**
 * 两道收窄规则这一趟用不用得上。**前提不成立时照样收窄、但 `proven` 变成那句理由** ——
 * 收窄是为了把搜索控制住(见文件头②),封口要的是证明,两件事分开记。
 */
export type CandidateBounds = { uid: number | null; oldest: number; proven: true | string };

/** 导出只为让回归能**直接问这两条前提**:整趟扫描的结论受这台机器此刻还跑着什么影响,
 *  「前提立不住就不许封口」这条不变量不能靠那种现场去钉。 */
export function candidateBounds(launch: LaunchIdentity): CandidateBounds {
  const span = Date.now() - launch.startedAt;
  const unmet: string[] = [];
  // root 的后代一句 setuid 就换掉属主,那时「属主跟 ash 不同」不再是不可能性。
  if (SELF_UID === 0) unmet.push("ash 以 root 在跑，后代能 setuid 换掉属主");
  // 两端比的是两个钟:`startedAt` 是墙上钟记的,进程年龄是单调钟量的。钟被往回拨过,这次
  // 启动就会显得比实际年轻,于是真后代被当成「出生在启动之前」筛掉。
  if (Math.abs(ashStartWall() - ASH_START_WALL) > CLOCK_MOVED_TOLERANCE_MS) {
    unmet.push("墙上钟在 ash 这个进程活着期间被改过");
  }
  if (span < 0) unmet.push("这次启动的时刻记在未来");
  return {
    uid: SELF_UID, oldest: Math.max(span, 0) + BIRTH_GRACE_MS,
    proven: unmet.length ? `${unmet.join("，")}，候选集这一趟收窄得不可靠` : true,
  };
}

/**
 * 候选的**根**挂在哪几个号底下(文件头④)。孤儿被谁收养,取决于死掉那个进程最近的
 * subreaper 祖先;链上的每一环都是 ash 的后代或祖先,所以目标必在 `{1} ∪ ash 的祖先链` 里。
 * 走不动(表里没有 ash 这一行)就退回 `{1}` —— 少枚举只会让下面少几个候选,不会伪造结论。
 */
function reparentTargets(table: ProcessTable): number[] {
  const parentOf = new Map<number, number>();
  for (const [parent, kids] of table.children) for (const kid of kids) parentOf.set(kid, parent);
  const targets = new Set<number>([1]);
  const walked = new Set<number>([SELF]);
  let walker = parentOf.get(SELF);
  while (walker !== undefined && walker > 1 && !walked.has(walker)) {
    targets.add(walker);
    walked.add(walker);
    walker = parentOf.get(walker);
  }
  return [...targets];
}

function candidateRoots(table: ProcessTable): number[] {
  const roots = new Set<number>();
  for (const target of reparentTargets(table)) {
    for (const pid of table.children.get(target) ?? []) if (pid > 1 && pid !== SELF) roots.add(pid);
  }
  return [...roots];
}

/**
 * 按启动记号找出这次启动的存活进程。`token` 为空(交互会话、没有记号的旧记录)不是
 * 「问过了,没有」—— 它落 `unavailable`,由调用方按既有那几档判。
 *
 * `launch.startedAt` 是这次启动的时刻(`TerminalSessionInfo.startedAt`),`launch.cwd` 是它的
 * 工作目录。前者是收窄规则之一(前提见 `candidateBounds`),后者**不参与筛选**,只用来在
 * 「这几个号问不出归属」那句话里把最可疑的排在前面。
 */
export async function launchSurvivors(token: string | null, launch: LaunchIdentity): Promise<LaunchScan> {
  if (token === null || IS_WINDOWS) return { pids: [], unanswered: [], evidence: "unavailable", why: null };
  const table = await readProcessTable();
  if (!table) {
    return { pids: [], unanswered: [], evidence: "incomplete", why: "进程表读不出来，这次启动的记号没问出去" };
  }
  const roots = candidateRoots(table);
  const bounds = candidateBounds(launch);
  if (!roots.length) return sealable([], [], bounds, launch);
  const facts = await readProcessFacts(roots);
  if (!facts) {
    return {
      pids: [], unanswered: [], evidence: "incomplete",
      why: "候选进程的属主和出生时刻没问出来，这次启动的记号没法逐个核对",
    };
  }
  // 「这一问没答上来」的号。两种来源都得算没问全:属主/出生时刻那一问漏了它而它还活着,
  // 以及它进了候选集、环境那一问却没给出答案。
  const silent: number[] = [];
  const candidates: number[] = [];
  for (const root of roots) {
    const fact = facts.get(root);
    if (!fact) {
      if (processAlive(root)) silent.push(root);
      continue;
    }
    // **这两道是全部收窄规则,而且两道都是不可能性**(文件头①)。工作目录、记号指向别处
    // 都**不在这里** —— 前者可变、后者可复制,筛掉的可能正是真后代。
    if (bounds.uid !== null && fact.uid !== bounds.uid) continue;
    if (fact.ageMs > bounds.oldest) continue;
    candidates.push(root);
  }
  const lineage = await readLineage(candidates, token);
  const found = new Set<number>();
  for (const pid of candidates) {
    const relation = lineage.get(pid);
    if (relation === undefined) continue;    // 这个号已经退了(readLineage 的约定)
    // **没有一档归属能把它排除出去**:`ours` 点名,其余四档(unmarked / stranger / unknown /
    // unverified)一律算没答上来。`stranger` 曾被当成否证,第 4 轮自由审查用「复用上一次启动
    // 的环境派工人」实测推翻 —— 环境可复制,记号指向别处推不出它不是这次创造的(文件头③)。
    if (relation !== "ours") { silent.push(pid); continue; }
    found.add(pid);
    // 顶上那个确认是这次的,它底下整棵子树也是:子树里每一个都继承了同一份环境,再逐个
    // 读一遍环境只是把同一个答案问 N 遍。
    for (const heir of descendantsFromTable(table, pid).pids) found.add(heir);
  }
  const pids = [...found].filter(processAlive).sort((left, right) => left - right);
  return sealable(pids, silent.filter(processAlive), bounds, launch);
}

/**
 * 最后一道:**没人核不上**且**两道收窄规则的前提都立得住**,才算问全了。前提立不住那一档
 * 的 `unanswered` 可以是空的 —— 漏的是谁都说不上来,正因如此更不能封口。
 */
async function sealable(pids: number[], unanswered: number[], bounds: CandidateBounds,
  launch: LaunchIdentity): Promise<LaunchScan> {
  if (unanswered.length) {
    const why = await unansweredWhy(unanswered, launch);
    return { pids, unanswered, evidence: "incomplete", why: bounds.proven === true ? why : `${why}；另外，${bounds.proven}` };
  }
  if (bounds.proven !== true) {
    return { pids, unanswered: [], evidence: "incomplete", why: `${bounds.proven}，所以这一趟说不出有没有漏` };
  }
  return { pids, unanswered: [], evidence: "answered", why: null };
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
    + "（它们跟这次启动同属主、出生在这次启动之后，而环境里没有这次的记号——没有记号、或者"
    + "带着别次启动的记号，都不等于不是这次的：启动脚本给工人现搭一份环境，记号就不跟过去了；"
    + "把上次启动存下的环境原样拿来用，带过去的就是那一次的旧记号）"
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
