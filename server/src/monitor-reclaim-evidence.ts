// **一项哨兵资源此刻在哪一档、这一刀能打到谁** —— 资源证明与发信号的那份契约。
//
// 契约有两面,它们是同一个不变量的两个方向(第 13 轮审查 F1):**不许杀别人的东西**,
// 也**不许把自己的残留说成零**。所以这一层只做三件事,再往上的账本(monitor-reclaim-debts.ts)
// 和各个收尾入口都只能通过它拿到「可以动手」的授权:
//
//  ① 判档(`reclaimEvidence`):每一档只声称那一问真的答出来的东西;
//  ② 给落点(`shootProvenUnit`):只打**这一刻证明过**属于这一次创建的那几个进程;
//  ③ 说「追不下去了」(`isTracelessState` / `confirmTraceless`):它**不等于**「整项退出已证明」。
//
// ── 归属只认「这一次创建独有的那条记号」(第 12 轮审查 F1)─────────────────────────
//
// 组长死了不等于这一组空了(spawn.ts 的补刀注释说的是同一件事:外层 shell 老老实实退了,
// 它派生的那个忽略 TERM 的东西还留在组里)。但「组里还有人」证明不了**那些人是谁的** ——
// 组号就是当初那个 pid,它会被复用。前两版在这里先用「`pid_started_at` 非空」、再用「成员的
// 命令行包含记录的命令原文」当归属证据,两样都不是身份:同一条命令可以合法地创建两次,前缀
// 还会撞(记录 `sleep 1`、现存 `sleep 120` ⇒ 包含判断认作自己的后代,实测被杀的是审查自己起
// 的测试组)。
//
// 现在的凭证是 `ASH_MONITOR_UNIT=<记号>`:起进程之前就随意图行落库,并作为环境变量种进那个
// 壳 —— 环境随 exec 继承、后代各自带一份,所以它跨 exec、跨组长死亡、跨 server 重启都认得
// 回来(判定 `reclaimEvidence`,扫描 monitor-unit-scan.ts 的 `liveMonitorUnitsSync`)。两问一次答完:
//   · 带着记号的进程还在 ⇒ 归属已证明,**下刀只打这几个**;
//   · 一个都不在(POSIX 上还要加「组也空了」,防命令自己 `env -i` 清掉环境)⇒ **能追的线索
//     到此为止**(`traceless`)。注意它不是「整项退出已证明」—— 下一节说的就是这件事;
//   · 问不出来(win32 读不到别的进程的环境块、ps 失败、存量行没有记号)⇒ 退回根自己那一份
//     代次证据;根也退了就什么都不许声称 —— 记责任、留身份、不收档。
//

// ── 「证不出整项退出」要照实说(第 13 轮审查 F1-B)──────────────────────────────
//
// 上一版把「记号找不着 + 原进程组也空了」这一档叫 `gone`,并据此**把责任行删掉**。审查实测
// 那是假的:一条后代可以在同一刻甩掉两条线索 —— `spawn(..., {detached:true, env:{PATH}})`
// 之后它既不带记号(环境被换掉)也不在原组里(`setsid` 自建会话),而它好好地活着
// (`R1_RESOURCE_FALSE_GONE`:`rootAlive=false`、`oldGroupAlive=false`、`escapedAlive=true`、
// `debtRows=0`、`taskRows=0`)。
//
// 本轮把 POSIX 上所有能当「成员身份」的通道都量了一遍,想找一个**真正拥有整项资源的管理者**:
// 环境变量随 `spawn({env})` 甩掉;进程组/会话随 `detached` 甩掉;多继承一个 fd ——
// Node 起子进程时 libuv 会把 ≥3 号 fd 丢掉(`sh`→`node` 还留着,`node` 再起的孙子就没了);
// macOS 的 responsible-pid 要 root(`launchctl procinfo` 报 "requires root privileges");
// Linux cgroup 要委派;kqueue 的 `NOTE_TRACK` 要原生代码。**结论:这个平台上拿不到那个管理者**。
//
// 所以这一档改名叫 `traceless` —— 「能追的线索到此为止」,它只授权**收档**(`closed_at`),
// 不授权删行:留下的那一行是这次创建最后的可定位身份(命令、pid、记号、为什么追不下去)。
// 唯一真的证明过的那一档在别处:命令**从未开工**(放行闸没开),见 monitor-create.ts。
//
// ── 每一次信号都要有**当代**的证据(第 13 轮 F1-C、第 14 轮 F1、第 15 轮 F1)──────────
//
// 一次取证不是永久授权:闭包里存一个裸 pid、两秒后直接补刀,这两秒里那个进程可以退出、
// 号可以被别人接手。所以**发信号的入口自己取证**(`killProvenUnit`、`shootProvenUnitNow`):
// 取证和下刀在同一个同步段里完成,外面不许把一份 `ReclaimEvidence` 攒着跨 `await` 再传进来
// (上一版就是那样:fresh 取证 → await 落债 → 拿原快照下刀)。
//
// **但「刚取的证据」也不等于「这一刀打得对」**,这是第 15 轮审查 F1:取证本身就包含几次耗时
// 查询(两遍进程表、一次全表组成员),同步 JS 不冻结别的进程 —— 查完回来,刚才证明过的那个
// 号可能已经换了代。所以这一层的规矩统一成一条:
//
//   **每一刀之前,拿「读到那个事实时的代次戳」重问一遍这个号**(`stillSameGeneration`、
//   `rootStillProven`)—— 不分它是刚取的证据、跨了 `await` 的名单,还是组信号的根。
//
// 戳自己必须跟事实同源(读环境项那一次读数、枚举组成员那一次读数各自把代次带出来),
// 实现与理由在 process-generation.ts。这样「两秒里 pid 不会被复用」「同步代码不会被插队」
// 这类推断就完全不必出现在授权链里。
//
// ── 归属凭证分「真实环境项」和「展示文本」两档(第 14 轮审查 F1)────────────────────
//
// 记号这条线索在两个平台上**答得实不实不一样**(实测见 monitor-unit-scan.ts 的
// `MONITOR_UNIT_ENV`):Linux 的 `/proc/<pid>/environ` 是 NUL 分隔的真实环境项,精确可答;
// macOS 的 `ps -E` 只给无边界展示文本,**任何变量的值里都能包含 `ASH_MONITOR_UNIT=<记号>`
// 这段文字**,审查据此让一个毫不相干的诊断进程挨了刀。
//
// 所以这一层把两档分开:`ours`(真实环境项)签发下刀凭证;`suspected`(只看见文字)只授权
// 「不许说已经没了」。macOS 上因此**少了一项能力**:跨重启认回「甩掉进程组、但还带着记号的
// 后代」做不到了 —— 那一档照实落 `suspected`:留责任、留身份、如实说证不出,不下刀。
import { IS_WINDOWS, isPidAlive, isProcessGroupAlive, killOne, killTree } from "./platform.js";
import { processIdentity, processUnitEvidence } from "./proc.js";
import {
  processGenerationSync, processGroupMembersSync, type ProcessMember,
} from "./process-generation.js";

/**
 * 这一条此刻处在哪一档。**每一档只声称那一问真的答出来的东西。**
 *
 * **六档,每一档对应一个真的问出了结果的问题**(带记号的进程还有吗 / 根还在吗 / 这个号上是谁):
 * - `traceless` = 根已经退了,**而且每一条线索都答出来、都是空的**。它是能收档的那一档,但
 *   **不是「整项退出已证明」**:后代甩得掉记号也甩得掉进程组,所以这一档只销「追踪」,不销
 *   责任 —— 行留着、盖上追到此为止的戳(第 13 轮审查 F1-B,理由见 `isTracelessState`)。
 * - `ours-alive` = 还在,而且组长身份对得上 —— 可以接着杀。
 * - `ours-orphans` = **组长已经不在了,组里还有人**。那几个只可能是我们的后代:组长这个 pid
 *   现在是空的(`kill(pid,0)` 报 ESRCH),没有别人能当这一组的组长;而外人要加进来得
 *   `setpgid` 到同一个会话里去,那个会话的头正是这条哨兵自己。所以这一档**在刚刚还拥有它的
 *   那一层**可以放心杀(`finish`),隔了一次重启就不行了 —— 见 monitor-reclaim-debts.ts 的
 *   `reclaimMonitorProcess` 的 `fresh`。
 * - `not-ours` = 这个号现在是**另一个**进程(ps 答出来了,启动时刻**确实**对不上;locale 不同
 *   由 `processIdentity` 在同一份快照上的时间戳比较兜住,不会被误报成这一档)。不许杀 —— 那是别人的进程。
 *
 * 剩下这四档**都不许据此收档**(也都不许下刀):
 * - `suspected` = **进程表的展示文本里看得见这次创建的记号,但这个平台切不出真实环境项边界**
 *   (macOS 的 `ps -E`,见 monitor-unit-scan.ts 的实测)。那段文字可能来自某个变量的值、也可能
 *   来自 argv,所以它证不出「谁是我们的」——**但它足以推翻「已经没了」**。于是这一档是最保守
 *   的那一种:不下刀、不收档、责任留着、账上写明是哪一种不确定(第 14 轮审查 F1)。
 * - `unknown` = **身份这一问自己失败了**:`kill(pid,0)` 说它活着,ps 却什么都答不出来
 *   (`inspectProcess` 把「不存在」和「ps 不可用」都返回 null)。拿它当「已经退了」就是把
 *   最后那一份责任丢掉(第 4 轮审查 F1),拿它当「不是我们的」就是在界面上撒谎
 *   (第 6 轮审查 F1)。
 * - `unverifiable` = **当初没记下启动时刻**,所以这一问**无从比对**:能证明的只有「这个号
 *   上现在有进程」。这一档必须跟 `ours-alive` 分开 —— 第 9 轮审查 F3:存量行(或任何一条
 *   `pid_started_at` 为空的行)原来会走到 `same` → `ours-alive` → **发击杀信号**,而那条
 *   路上「看见一个进程活着」被当成了「已证明有权回收它」。原命令早已跑完、号被系统复用时,
 *   下刀打的就是别人的进程(接回、清扫、重复停止三条路都消费这一档)。
 * - `not-ours` 同样不许收档:我们能证明的只有「这个号上现在是别人」,证明不了**原来那个**
 *   已经退出 —— 它可能带着后代留在这一组里,只是组长的号被别人占了。三档的区别只在于
 *   **记下来的理由**和日志措辞,不在于要不要负责(`stateNote` 按档各说一句)。
 */
export type ReclaimState =
  | "traceless" | "ours-alive" | "ours-orphans"
  | "not-ours" | "suspected" | "unverifiable" | "unknown";

/**
 * 「线索都答出来了,而且都是空的」—— **这一档可以收档,但它不叫「整项退出已证明」**
 * (第 13 轮审查 F1-B)。
 *
 * 为什么只能到这一步:POSIX 上没有任何一条线索是后代**甩不掉**的 —— 环境可以 `env -i` 清掉
 * (本轮实测),进程组/会话可以 `setsid` 离开(本轮实测),额外的继承 fd 在 libuv 起子进程时
 * 就被关掉(本轮实测:`node` 起的孙子进程拿不到 fd 3),macOS 的 responsible-pid 要 root
 * (本轮实测 `launchctl procinfo` 拒绝),Linux 的 cgroup 要委派、kqueue 的 `NOTE_TRACK` 要
 * 原生扩展。所以「真正掌握整项资源的管理者」在当前平台能力下拿不到,而**缺少线索不等于
 * 没有后代**。
 *
 * 于是收档这件事按它的真实含义来做:责任行**不删**,只盖上「追到这里为止」的戳
 * (`closed_at`),措辞也只说我们查到的那些 —— 不再声称确认退出(见 `closeReclaimDebt`)。
 */
export const isTracelessState = (state: ReclaimState): boolean => state === "traceless";

/**
 * 身份这一问的三种答案 —— **判定本体不在这里,在 `proc.ts` 的 `processIdentity`**:
 * 一次 ps 快照、纯比较、三档结果。这一层只把它的三档换成这一摊的说法。
 *
 * **不许在这一层再问一次**。上一版这里是「原文不等就再调一次 `isSameProcess` 兼容
 * locale」:第一次查成功、第二次查失败时,那个 false 被读成确证的「是别人」,于是
 * `unqueryable` 这一档被悄悄吃掉 —— 一条还在跑的哨兵因此被接回判成 `lost`,随后被按债
 * 杀掉(第 7 轮审查 F1)。「问不出来」必须一路保留到调用方,消费者各补一次重试只会把
 * 同一个错换个地方犯。
 *
 * **只在 `kill(pid,0)` 已经说它活着时调**,所以 `unqueryable` 只剩一种解释:ps
 * (或 Windows 上那段 PowerShell)自己没答出来。
 *
 * `unverifiable`(当初没记启动时刻)**单独传上去**,不许折进 `ours`:见 `ReclaimState` 那一档。
 */
function identityOf(
  pid: number, recorded: string | null,
): "ours" | "theirs" | "unverifiable" | "unqueryable" {
  const verdict = processIdentity(pid, recorded);
  if (verdict === "same") return "ours";
  if (verdict === "different") return "theirs";
  return verdict === "unverifiable" ? "unverifiable" : "unqueryable";
}

/** 身份那一问的四档 → 这一摊的档位。**只有 `ours` 这一档敢下刀。** */
const stateOfIdentity = (who: ReturnType<typeof identityOf>): ReclaimState =>
  who === "ours" ? "ours-alive"
    : who === "theirs" ? "not-ours"
      : who === "unverifiable" ? "unverifiable" : "unknown";

/**
 * 判这一档要拿的东西:**这一次创建独有的资源记号**,外加命令原文(只用于日志和存量行的
 * 时间锚核对,**不作归属凭证** —— 第 12 轮审查 F1-A)。
 *
 * 整行(`monitors` 的行、债表的行)都满足这个形状,所以调用方直接把行传进来就行。
 */
export type MonitorUnit = {
  /**
   * **必填**(可以是 null:存量行就没有)。写成必填是刻意的:它是归属与整项退出的唯一凭证,
   * 可选的话,一个漏选这一列的 `select` 就会静悄悄把每一行都降级成「证不出」——
   * 查询少一列不该表现成「这些资源都收不掉了」,那种漏法通读发现不了(第 12 轮审查 F1)。
   */
  unitToken: string | null;
  /** 命令原文:只用于日志与存量行的时间锚核对,**不作归属凭证**。 */
  command?: string | null;
};

/** 判完这一档手里有的全部东西:档位,以及**已经证明属于这次创建的那几个成员(带代次)**。 */
export type ReclaimEvidence = {
  state: ReclaimState;
  /**
   * 下刀的落点。**只有「真实环境项里读到记号」那一档非空**(`ours-*`)—— 展示文本那一档
   * (`suspected`)一个落点都不给,存量行(没有记号)走到 `ours-alive` 时也是空的,那一档的
   * 归属由根自己的 pid + 启动时刻证明,落点是整组。
   *
   * 每个成员都带着**代次**,而且那个代次是**读到记号的同一次读数**给出的
   * (process-generation.ts)。**每一刀之前都要拿它再核一遍** —— 不只是跨过 `await` 的那一刀
   * (第 15 轮审查 F1:上一版的代次是并集定下来之后补问的,等于把后来那一代的身份写给了
   * 先前那个事实)。
   */
  members: ProcessMember[];
};

/**
 * **这一项资源此刻在哪一档** —— 归属只认那条记号,整项退出要全部线索都答出来。
 *
 * 判的顺序就是证据的强弱顺序:
 *
 * ① **记号这一问**(`processUnitEvidence`):真实环境项里读到了(`ours`)⇒ 归属已证明,
 *    `members` 就是那几个。根(记录的那个 pid)也在里面且活着就是 `ours-alive`(可以打整组,
 *    覆盖这一刻之后新派生的后代);根已经不在就是 `ours-orphans`,这一档**下刀只打证明过的
 *    那几个成员**:这个号此刻可能已经是别人的组长。
 *
 * ② **根自己那一代**:记号找不着、只看见文字、或者答不出来时,根还活着的话它的代次仍然可判
 *    (`processIdentity`:pid + 启动时刻)。这一档照旧可判、可下刀。
 *
 * ③ **根也已经退了** —— 这时才轮到「整项退出」这一问,而它要求**每条线索都答出来**:
 *    · 展示文本里看得见记号(`suspected`)⇒ 证不出谁是我们的,但足以推翻「已经没了」;
 *    · 记号这一问没答出来(win32 读不到别的进程的环境块、ps/`/proc` 失败、存量行没有记号
 *      且组里还有人)⇒ `unknown` / `unverifiable`:什么都不许声称;
 *    · 记号找不着、进程组也空了 ⇒ `traceless`。**注意它的含义**:是「线索追到这里为止」,
 *      不是「整项资源退出已证明」—— 后代可以同时清掉环境并自己建组(第 13 轮审查 F1-B 实测)。
 *      所以这一档只允许收档,不允许把责任行删掉(见 `isTracelessState`、`closeReclaimDebt`)。
 *
 * `fresh` = 这次取证要用来发信号:授权必须是当代的,不许来自 400ms 的旧快照
 * (第 13 轮审查 F1-C)。**要发信号的调用方不要自己拿这个函数的结果去发** —— 用
 * `killProvenUnit` / `shootProvenUnitNow`,它们自己取证,证据不出同步段。
 */
export function reclaimEvidence(
  pid: number, pidStartedAt: string | null, unit: MonitorUnit, opts: { fresh?: boolean } = {},
): ReclaimEvidence {
  const evidence = processUnitEvidence(unit.unitToken, opts);
  if (evidence.verdict === "ours") {
    const leaderHeld = isPidAlive(pid) && evidence.members.some((m) => m.pid === pid);
    return { state: leaderHeld ? "ours-alive" : "ours-orphans", members: evidence.members };
  }
  if (isPidAlive(pid)) return { state: stateOfIdentity(identityOf(pid, pidStartedAt)), members: [] };
  // 根已经不在了。
  if (evidence.verdict === "suspected") {
    // 文本里还看得见这次创建的记号。证不出是哪个进程(所以不下刀),但**也绝不许收档**。
    return { state: "suspected", members: [] };
  }
  if (evidence.verdict === "unprovable") {
    // 存量行(没有记号)在 POSIX 上还剩进程组这一条线索:组空了也只是「线索到此为止」。
    if (!unit.unitToken && !IS_WINDOWS) {
      return { state: isProcessGroupAlive(pid) ? "unverifiable" : "traceless", members: [] };
    }
    return { state: "unknown", members: [] };
  }
  if (!IS_WINDOWS && isProcessGroupAlive(pid)) return { state: "unverifiable", members: [] };
  return { state: "traceless", members: [] };
}

/** 只问档位的那些调用方(探活、过滤、日志)用这个投影;要下刀的用下面那两个入口。 */
export function reclaimState(pid: number, pidStartedAt: string | null, unit: MonitorUnit): ReclaimState {
  return reclaimEvidence(pid, pidStartedAt, unit).state;
}

/** 这一档敢不敢下刀。**只有归属已证明的那两档敢**,其余五档一刀都不发。 */
const canShoot = (state: ReclaimState): boolean => state === "ours-alive" || state === "ours-orphans";

/**
 * 下刀:**TERM,两秒后再确认一遍补 KILL** —— 两刀各自有自己的当代证据。
 *
 * · 第一刀前自己 `fresh` 取证(不接外面攒着的快照:上一版那条路是「取证 → await 落债 → 拿原
 *   快照下刀」,数据库等待期间成员可以退出、号可以被接手,第 14 轮审查 F1 指的就是这一下);
 * · 组长自己证明过、而且还活着 ⇒ 打整组(`killTree`:组信号覆盖「这一刻之后它又派生出来的」
 *   那些),同时把**这一组的成员连代次一起记下来**(`processGroupMembersSync`);
 * · 根已经不在(孤儿后代)⇒ **逐个打证明过的成员本身**,绝不打组:成员的 pgid 是那个已经死掉
 *   的根的号,`kill(-member)` 打的是「组号恰好等于这个成员 pid」的另一组(第 12 轮审查 F1-A
 *   实测被杀掉的就是那种组);
 * · 两秒后那一刀:**先重新取证**(覆盖这两秒里新派生的),再把第一刀那会儿记下的成员名单
 *   拿代次核一遍补上 —— 外层壳被 TERM 收走之后,组里那个忽略 TERM 的后代正是这样收掉的
 *   (`executors/spawn.ts` 的补刀注释说的是同一件事)。**代次对不上就一刀都不发**。
 *
 * **成员名单那一问自己就是一次耗时查询**(`processGroupMembersSync` 要扫全表):同步 JS 不会
 * 冻结别的进程,所以查完回来根可能已经退了、这个号可能已经被接手。所以组信号在
 * `shootProvenUnit` 里**重新核一遍根**(第 15 轮审查 F1),而不是沿用查询之前那一份授权。
 *
 * 也因此这一层不借用 `executors/spawn.ts` 的 `killByPid`:它的 +2 秒那一刀是无条件的。
 */
export function killProvenUnit(pid: number, pidStartedAt: string | null, unit: MonitorUnit): void {
  const first = reclaimEvidence(pid, pidStartedAt, unit, { fresh: true });
  if (!canShoot(first.state)) return;
  // 名单要留给两秒后那一刀,所以这里拿的必须是**已证明归属**的那一份,不是「组里恰好有这几个
  // 号」的候选快照(见 `provenGroupMembers`)。
  const held = provenGroupMembers(pid, pidStartedAt, first);
  shootProvenUnit(pid, pidStartedAt, first, "SIGTERM");
  const t = setTimeout(() => {
    // 重新取证:这两秒里谁退了、号被谁接手了、又新派生了谁,只有现在问才算数。
    const again = reclaimEvidence(pid, pidStartedAt, unit, { fresh: true });
    if (canShoot(again.state)) shootProvenUnit(pid, pidStartedAt, again, "SIGKILL");
    // 再补上第一刀那会儿的成员:它们的归属在那一刻证明过,**代次没变才打**。
    // **这里不要求原根现在还活着** —— 第一刀就是来结束它的,而它名下那个忽略 TERM 的后代
    // 正是靠这一下收掉的(`test-monitor-unit-proof.ts` ⑬-3 钉的就是这条)。
    const done = new Set(again.members.map((m) => m.pid));
    if (again.state === "ours-alive") done.add(pid);
    shootMembers({ ...held, members: held.members.filter((m) => !done.has(m.pid)) }, "SIGKILL");
  }, 2_000);
  (t as { unref?: () => void }).unref?.();
}

/**
 * **候选名单 → 已证明归属的成员**:组枚举自己就是一次全表查询,查完必须重核授权它的那个根。
 *
 * 第 16 轮审查 F1-A 实测的那一刀:上一版把 `processGroupMembersSync` 的返回值直接当成
 * 「第一刀那一刻证明过归属的成员」留给两秒后那一下。但那份名单的归属凭证**只有一个** ——
 * 「组号就是还活着的原根的 pid」。查询期间原根退出并换代时,拿回来的名单可以整份属于**另一组**
 * (新的那个同号进程的组)。那一轮第一刀是安全的(`rootStillProven` 发现根换了代,没打整组),
 * 可两秒后 `shootMembers` 只核「它还是不是名单里那一代」—— 陌生进程从查询到补刀一直稳定在
 * 自己那一代,于是核对通过、挨了真实的 SIGKILL(`held-generation.log`:
 * `aliveAfterFirstShot=true`、`aliveAfterDelayedShot=false`、`exitSignal=SIGKILL`)。
 *
 * 所以这里把两件事分开:
 *  · **候选事实** = 「这几个号此刻的 pgid 等于它」—— 它本身不是归属;
 *  · **已证明归属** = 候选 + 「查询前后原根都还是授权这一档的那一代」。查询之后重核不过就
 *    **整份丢掉候选**,只留真实环境项独立证明过的那几个(`evidence.members`)。
 */
function provenGroupMembers(
  pid: number, pidStartedAt: string | null, evidence: ReclaimEvidence,
): ProvenMembers {
  if (evidence.state !== "ours-alive") {
    // 孤儿那一档没有「活着的原根」这个凭证,落点只能是记号独立证明过的那几个。
    return { authorizedBy: "unit-mark", members: evidence.members };
  }
  const candidates = processGroupMembersSync(pid);
  if (!candidates || !rootStillProven(pid, pidStartedAt, evidence)) {
    return { authorizedBy: "unit-mark", members: evidence.members };
  }
  return { authorizedBy: "group-of-proven-root", members: candidates };
}

/**
 * 只发一刀,**自己取证**。给「第一刀早就发过了、现在只想补一把 SIGKILL」的那条路用
 * (债务重收:见 monitor-reclaim-debts.ts 的 `settleDebt`)。返回这一刀有没有发出去。
 *
 * 为什么不让调用方传证据进来:那条路上取证和下刀之间隔着 `completeIdentity` 等几次 `await`
 * (第 14 轮审查 F1)。取证留在这个函数里,就没有「可跨等待复用的裸 pid」这种东西了。
 */
export function shootProvenUnitNow(
  pid: number, pidStartedAt: string | null, unit: MonitorUnit, sig: NodeJS.Signals,
): boolean {
  const evidence = reclaimEvidence(pid, pidStartedAt, unit, { fresh: true });
  if (!canShoot(evidence.state)) return false;
  shootProvenUnit(pid, pidStartedAt, evidence, sig);
  return true;
}

/**
 * **这一刻这个号上还是不是记下它时那一代** —— 每一刀之前都要过这一问(第 15 轮审查 F1)。
 *
 * 核的是扫描那一刻跟记号同源读到的那个戳(process-generation.ts),所以这一问真的在问
 * 「我证明过的那一个还在不在」,而不是「这个号上现在有没有人」。核不出来(进程没了、
 * 两种问法都失败、或者这一刻走了另一种问法)一律按「不是」处理:宁可漏收,也不碰一个
 * 证不出代次的号。
 */
const stillSameGeneration = (member: ProcessMember): boolean =>
  processGenerationSync(member.pid) === member.gen;

/**
 * 根此刻还是不是**授权这一档时**那一个 —— 组信号(`killTree`)之前必须重问一遍。
 *
 * 两条授权路各自用自己的凭证重核,不许混用:
 *  · 记号那一条 ⇒ 根在成员名单里,核它的代次戳;
 *  · 存量行那一条(没有记号,`members` 为空)⇒ 核记录在案的 pid + 启动时刻。
 */
function rootStillProven(
  pid: number, pidStartedAt: string | null, evidence: ReclaimEvidence,
): boolean {
  const member = evidence.members.find((m) => m.pid === pid);
  if (member) return stillSameGeneration(member);
  if (evidence.members.length) return false;      // 记号答出来了、根却不在名单里 ⇒ 不是它
  return processIdentity(pid, pidStartedAt) === "same";
}

/**
 * 发这一刀。**只许拿同一个同步段里刚取到的证据调**(所以不导出):组信号只在「根此刻重核
 * 过、而且还活着」时发,否则只打证明过的成员本身 —— 而每个成员也各自重核代次。
 */
function shootProvenUnit(
  pid: number, pidStartedAt: string | null, evidence: ReclaimEvidence, sig: NodeJS.Signals,
): void {
  if (evidence.state === "ours-alive" && rootStillProven(pid, pidStartedAt, evidence)) {
    killTree(pid, sig);
    return;
  }
  // 这几个各自在真实环境项里被证明过,归属不依赖那个已经换代的根。
  shootMembers({ authorizedBy: "unit-mark", members: evidence.members }, sig);
}

/**
 * **可以当落点的那一份名单** —— 类型上就跟「候选快照」分开(第 16 轮审查 F1-A)。
 *
 * 构造它的只有 `provenGroupMembers` 一条路,所以「组里恰好有这几个号」永远到不了
 * `shootMembers`。`authorizedBy` 记的是这份名单的归属凭证是哪一条:
 *  · `unit-mark` —— 每个成员各自在真实环境项里被证明过;
 *  · `group-of-proven-root` —— 组号属于「查询前后都还是那一代」的原根。
 */
type ProvenMembers = {
  authorizedBy: "unit-mark" | "group-of-proven-root";
  members: ProcessMember[];
};

/**
 * 发给**证明过的那几个成员**:每一个都先拿代次核过才打。
 *
 * 这是唯一允许的下刀形状(第 14、15、16 三轮审查 F1):归属在证明它的那一刻成立(`ProvenMembers`
 * 的 `authorizedBy`),而代次戳相等说明这个号上还是同一代那个进程。**两个条件都要**:
 * 只核代次不问归属,就是第 16 轮 F1-A 那一刀(陌生进程的代次当然一直稳定);只问归属不核代次,
 * 就是第 15 轮 F1 那一刀。跨不跨 `await` 都走这一条。
 */
function shootMembers(proven: ProvenMembers, sig: NodeJS.Signals): void {
  for (const member of proven.members) {
    if (!stillSameGeneration(member)) continue;
    killOne(member.pid, sig);
  }
}

/**
 * 有界地等**线索都空掉**。补刀在 +2 秒,所以默认等到 3 秒 —— 覆盖「优雅退出 + 补刀生效」,
 * 又不会把任务结算无限期吊在这里。
 *
 * 返回 false 不是失败,是「这一刻还收不了档」:责任已经落盘,接着由梯子和启动期清扫推。
 * 返回 true 也**不是**「整项退出已证明」(见 `isTracelessState`):是「能追的线索都追空了」。
 */
export async function confirmTraceless(
  pid: number, pidStartedAt: string | null, deadlineMs: number, unit: MonitorUnit,
): Promise<boolean> {
  const until = Date.now() + deadlineMs;
  for (;;) {
    if (isTracelessState(reclaimState(pid, pidStartedAt, unit))) return true;
    if (Date.now() >= until) return false;
    // **这一发不能 unref**:我们正在 await 它。unref 掉的话,当它是事件循环里唯一的待办时
    // 进程会直接退出 —— 等待本身就没了(实测:测试进程报 unsettled top-level await)。
    // 梯子那一侧相反,那是后台重试,必须 unref。
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 落在账本上的那句「为什么还没收掉」。按档说清楚,别让人事后分不出是哪一种不确定。 */
export function stateNote(state: ReclaimState): string {
  if (state === "traceless")
    return "根已退出，记号与原进程组都已空 —— 能追的线索到此为止（整项退出本平台证不出，见 isTracelessState）";
  if (state === "ours-alive") return "还活着";
  if (state === "ours-orphans") return "起它的那个进程已退、这次创建的后代还在(记号认得出来)";
  if (state === "not-ours") return "这个号现在是另一个进程，原进程退出无法确认";
  if (state === "suspected")
    return "进程表里还看得见这次创建的资源记号，但这台机器上只拿得到无边界的展示文本（ps -E 把 argv 和环境拼在一起），"
      + "证不出它在哪个进程的真实环境里 —— 所以不敢下刀，也绝不当成已经退出（见 monitor-unit-scan.ts 的 UnitProofGrade）";
  if (state === "unverifiable")
    return "这个号上/这一组里还有进程，但证不出它属于这一次创建（没有资源记号或当初没记下启动时刻，不敢下刀）";
  return "资源记号这一问答不出来（Windows 读不到别的进程的环境块，或 ps 不可用），判不出归属，也证不出整项退出";
}
