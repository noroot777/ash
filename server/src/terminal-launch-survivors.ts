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
// ash 不是 root(root 的后代能 setuid 换掉属主),以及这次启动留下了**单调**的起跑时刻。
//
// 后一条曾经写成「墙上钟此刻的偏移跟 ash 起跑那一刻一样」。第 5 轮自由审查实测那不成立:
// 启动那一刻把钟前拨 10 秒、记完 `startedAt` 立刻校准回来 —— 两个端点的偏移都是 0、
// `span` 也已转正,前提于是判「立得住」,而年龄上界比真工人的年龄小了 10 秒,那个**带着这次
// 记号**的工人连 readLineage 都没走到就被筛掉了,stop 报 `{"kind":"verified"}`、页面
// 「已停止」、`WORKER_ALIVE_AFTER_STOP true`。**两个端点一样推不出中间没变过。**
//
// 所以年龄这条收窄不再碰墙上钟:启动那一刻在会话表里记一份 `process.uptime()`
// (terminal-session-facts.ts 的 `startedUptimeMs`),上界 = 现在的 uptime − 那一份。它跟候选
// 的进程年龄是同一种量(「跑了多久」),中间怎么拨钟都不影响这个差。拿不到那份参照(身份不
// 从会话表取)就是**证不出来**,照旧收窄、但不许封口。
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
// pid/进程组那条线索负责,不归这一问)。**这条链走不到头,或者进程表自己就漏了行,同样是
// 「枚举证不全」**,一并进②那道闸 —— 漏掉的那一行可能正好是收养了真后代的那个祖先。
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

/**
 * 这次启动的身份:记号 + 两条收窄规则各自的参照。**只能从会话表取**
 * (`TerminalSessionManager.launchIdentityOf`)—— 从 DTO 上拼得出 `startedAt`,而那是墙上钟,
 * 拿它当年龄上界正是第 5 轮自由审查实测到的那个错(见文件头②)。
 *
 *  · `token`           —— 这次启动的记号;`null` = 这条线索在这次启动上不存在(交互会话);
 *  · `startedUptimeMs` —— 起跑那一刻的 `process.uptime()` 毫秒数;`null` = 没留下单调参照,
 *                         年龄这条收窄这一趟**证不出来**;
 *  · `cwd`             —— 启动目录。**不参与筛选**,只用来把最可疑的号排在措辞前面。
 */
export type LaunchIdentity = { token: string | null; startedUptimeMs: number | null; cwd: string };

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
  const unmet: string[] = [];
  // root 的后代一句 setuid 就换掉属主,那时「属主跟 ash 不同」不再是不可能性。
  if (SELF_UID === 0) unmet.push("ash 以 root 在跑，后代能 setuid 换掉属主");
  // 年龄上界只认单调参照:它跟候选的进程年龄是同一种量。墙上钟一个字都不参与 —— 它在启动
  // 那一刻是不是准的,事后无从查证(文件头②)。
  if (launch.startedUptimeMs === null) unmet.push("这次启动没留下单调的起跑时刻");
  const elapsed = launch.startedUptimeMs === null ? 0
    : Math.max(Math.round(process.uptime() * 1000) - launch.startedUptimeMs, 0);
  return {
    uid: SELF_UID, oldest: elapsed + BIRTH_GRACE_MS,
    proven: unmet.length ? `${unmet.join("，")}，候选集这一趟收窄得不可靠` : true,
  };
}

/**
 * 候选的**根**挂在哪几个号底下(文件头④)。孤儿被谁收养,取决于死掉那个进程最近的
 * subreaper 祖先;链上的每一环都是 ash 的后代或祖先,所以目标必在 `{1} ∪ ash 的祖先链` 里。
 * 走不动(表里没有 ash 这一行)就退回 `{1}` —— 少枚举只会让下面少几个候选,不会伪造结论。
 */
function reparentTargets(table: ProcessTable): { targets: number[]; complete: boolean } {
  const parentOf = new Map<number, number>();
  for (const [parent, kids] of table.children) for (const kid of kids) parentOf.set(kid, parent);
  const targets = new Set<number>([1]);
  const walked = new Set<number>([SELF]);
  let walker = parentOf.get(SELF);
  // 走到 PID 1 才算这条链看全了。**中途断掉就是没看全**:断点以上那些祖先没能进收养目标集,
  // 而真后代可能正挂在其中一个底下(漏了还照样封口,就是把「我没看见」答成「没有」)。
  while (walker !== undefined && walker > 1 && !walked.has(walker)) {
    targets.add(walker);
    walked.add(walker);
    walker = parentOf.get(walker);
  }
  return { targets: [...targets], complete: walker === 1 };
}

/** 导出只为让回归能**直接问枚举的完整性**:祖先链断在半路、进程表自己漏了活着的行,
 *  这两种都没法在这台机器上现造,只能给合成的表。 */
export function candidateRoots(table: ProcessTable): { roots: number[]; complete: boolean } {
  const walk = reparentTargets(table);
  const roots = new Set<number>();
  for (const target of walk.targets) {
    for (const pid of table.children.get(target) ?? []) if (pid > 1 && pid !== SELF) roots.add(pid);
  }
  return { roots: [...roots], complete: walk.complete && table.complete };
}

/**
 * 按启动记号找出这次启动的存活进程。身份整个为 `null`(会话已经不在了)或者它的 `token` 为空
 * (交互会话)都不是「问过了,没有」—— 它落 `unavailable`,由调用方按既有那几档判。
 */
export async function launchSurvivors(launch: LaunchIdentity | null): Promise<LaunchScan> {
  if (launch === null || launch.token === null || IS_WINDOWS) {
    return { pids: [], unanswered: [], evidence: "unavailable", why: null };
  }
  const token = launch.token;
  const table = await readProcessTable();
  if (!table) {
    return { pids: [], unanswered: [], evidence: "incomplete", why: "进程表读不出来，这次启动的记号没问出去" };
  }
  const enumeration = candidateRoots(table);
  const roots = enumeration.roots;
  const bounds = candidateBounds(launch);
  // 枚举没看全跟收窄前提没立住是同一类:都只能说「这一趟证不出完整」,不能改成「没有」。
  if (!enumeration.complete) {
    bounds.proven = `${bounds.proven === true ? "" : `${bounds.proven}；另外，`}`
      + "进程表或 ash 的祖先链这一趟没看全，收养目标可能漏了";
  }
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
