// **从一张进程表切出「谁是谁的后代」,以及这张表哪里还没有答案。**
//
// 从 `process-generation.ts` 搬出来只有一个理由:那个文件写到 650 行了,而这两摊的职责本来
// 就不同 —— 那边回答「这个号此刻是哪一代」(戳怎么取、怎么比),这边回答「从这张表上能不能
// 把它算成我们的后代」。依赖是单向的:这边用那边的戳,那边不认识这边。
//
// 这一摊的不变量只有一条,它是第 6、7 两轮审查 F1 的同一句话:
//
//   **「这棵树里没看到它」不等于「已经排除了它属于这次运行」。**
//
// 表上的节点有三种状态,处置各不相同:
//
//  · 能挂上树、代次也可核验 ⇒ 成员(可以下刀);
//  · 能挂上树、代次核验不了 ⇒ `ProcessSubtree.unverified`(不敢下刀,但要说出来);
//  · **压根挂不上树** ⇒ `unresolvedTopology`(连在哪棵树上都不知道,逐个走排除路)。
import { readFileSync } from "node:fs";
import { isPidAlive } from "./platform.js";
import {
  processTableSnapshot,
  type ProcessGeneration, type ProcessMember, type ProcessTableSnapshot,
} from "./process-generation.js";

// ── 「谁授权了它」必须跟着成员一起走 ───────────────────────────────────────────
//
// 后代的代次只回答一件事:**这个号此刻还是快照里那个进程吗**。它回答不了「它属于本任务
// 吗」—— 那份归属自始至终只来自**树根**:根被证明属于本次运行,它名下的后代才跟着属于。
//
// 上一版这个函数交出的是平铺的 `{ roots, descendants }`,两者之间没有任何连线。于是调用方
// 把根按「第二次取证是否仍认它」过滤掉之后,**那棵树的孩子仍然无条件进了击杀名单** ——
// 根已经被否定,后代自己的代次照样相等,错误授权照样成立(本轮审查 F1 实测:根被复查排除、
// 根自己还活着,它的孩子却被生产清理代码关掉)。
//
// 所以形状改成**按根分组**:拿不到「这个成员是哪个根带进来的」就拿不到成员。调用方要过滤
// 只能以子树为单位过滤,「根授权失效 ⇒ 整棵来源子树作废」成了类型上的必然,而不是某一个
// 上层入口记得加的一句判断。
//
// 同一个号能从两个根到达时(一个根本身是另一个根的后代)它会在两棵子树里各出现一次 ——
// 这是刻意的:它确实是两个根各自的后代,任一来源根的授权成立都足以授权它。逐根独立遍历
// 的代价只是在同一张快照表上多走几遍,表只读一次。

/** 这一次遍历的种子:号 + **快照那一刻**它是哪一代。`gen: null` = 它此刻不在进程表上。 */
export type ProcessTreeSeed = {
  pid: number;
  gen: ProcessGeneration | null;
};

/**
 * 一个种子名下的子树。成员的归属全部来自 `seed`,**复核 seed 是调用方的义务**。
 *
 * `source` 是调用方交进来的那一项**原物**(不是拷贝、不是下标)。它存在的唯一理由是
 * 把「这棵树是谁带出来的」钉成一条引用:第 2 轮审查 F3 实测的那个漏杀,根因就是这一层
 * 按 pid 去重、调用方却按原数组下标回取授权依据 —— 有重复项时两边从第一个重复开始整体
 * 错位,第二棵树拿着第一个种子的句柄授权、第三棵拿着它的记号代次去比对,独立的真实成员
 * 于是被静默过滤掉(`answered=true`、`faults=[]`,一声不响)。
 *
 * 所以这一层**不再去重也不再丢项**:进来几项就出去几项、一一对应,而且授权依据随树带着走。
 * 「同一个号来自两种依据」因此会各自成一棵树,各按自己那份依据判 —— 那本来就是正确语义
 * (任一依据成立都足以授权它),去重反而是在合并两个不同的问题。重复遍历的代价是同一张
 * 只读快照上多走几遍,而来源最多是「fd 持有者 + 句柄 + 记号成员」这几类。
 */
export type ProcessSubtree<S = ProcessTreeSeed> = {
  /** 调用方交进来的那一项原物:它自带这棵树凭什么算我们的。 */
  source: S;
  seed: ProcessTreeSeed;
  /** 种子自己(它此刻在表上才有)。`null` = 这个号已经退场(Windows 上残留树仍可用)。 */
  root: ProcessMember | null;
  /** 种子名下的全部后代,各自带着与父子关系同源的那一代。 */
  descendants: ProcessMember[];
  /**
   * 这棵树里**在进程表上、可是代次核验不了**的号(含种子自己)。
   *
   * 它们不进 `descendants` —— 没有代次就没有下刀凭证(见文件头「戳问不出来 ⇒ 不许发信号」)。
   * 但它们是实打实的残留事实,调用方据此答「这一问没问清楚」,而不是把它们当成不存在
   * (第 6 轮审查 F1)。
   */
  unverified: number[];
};

/**
 * 从一张快照里切出这些来源各自的子树。根的代次**来自快照本身**,所以授权与遍历同源。
 *
 * **一进一出,不去重也不丢项**(见 `ProcessSubtree.source`):调用方要按自己的依据复核每一棵
 * 树的根,而依据是跟着 `source` 走的,不是跟着下标走的。非法号(`<= 1`、非整数)照样占一项,
 * 只是交出一棵空树 —— 丢掉它同样会让「进来 N 项、出去 M 项」重新成为可能。
 */
export function subtreesOf<S extends { pid: number }>(
  table: ProcessTableSnapshot, sources: readonly S[],
): ProcessSubtree<S>[] {
  return sources.map((source) => {
    const pid = source.pid;
    // 1 号是 init:拿它当树根会把整台机器的进程走成「我们的后代」。
    const usable = Number.isInteger(pid) && pid > 1;
    const gen = usable ? table.gens.get(pid) ?? null : null;  // 根此刻不在表上 = 它已经退了
    const walk = usable ? walkDescendants(table, pid) : { members: [], unverified: [] };
    // **种子自己核验不了也要说出来**:`gen` 为空有两种,「它退了」与「它还在、只是这一代
    // 核验不了」处置相反,而上一版把两者都读成 `root: null`(第 6 轮审查 F1)。
    const seedUnverified = usable && !gen && table.unverified.has(pid);
    return {
      source,
      seed: { pid, gen },
      root: gen ? { pid, gen } : null,
      descendants: walk.members,
      unverified: seedUnverified ? [pid, ...walk.unverified] : walk.unverified,
    };
  });
}

/**
 * 一个种子名下的后代。**不跨子树去重** —— 两棵子树各自授权,共有的成员两边都要出现。
 *
 * **代次读不出来的那些号照样要穿过去**(第 6 轮审查 F1):上一版在它们身上 `continue`,于是
 * 它自己不算成员、**它下面整条分支也一起从遍历里消失了**。现在它进 `unverified`(不给下刀
 * 凭证),遍历接着往它的孩子走。
 */
function walkDescendants(
  table: ProcessTableSnapshot, seed: number,
): { members: ProcessMember[]; unverified: number[] } {
  const members: ProcessMember[] = [];
  const unverified: number[] = [];
  const seen = new Set<number>([seed]);           // 环形 ppid(不该有,但别据此死循环)
  const stack = [seed];
  while (stack.length) {
    const parent = stack.pop()!;
    for (const kid of table.kids.get(parent) ?? []) {
      if (seen.has(kid)) continue;
      seen.add(kid);
      const gen = table.gens.get(kid);
      if (gen) members.push({ pid: kid, gen });
      else unverified.push(kid);                  // 在表上、核验不了 ⇒ 不收但要报
      stack.push(kid);                            // 两种都接着往下走
    }
  }
  return { members, unverified };
}

/**
 * 一个**挂不到任何树上、又排除不掉**的号(见 `ProcessTableSnapshot.unlinked`)。
 *
 * `gen` 为空 = 连它那一代也核验不了 —— 这种最糟:既不能按时间把它排除在本次运行之外,
 * 也给不出下刀凭证。
 */
export type TopologyGap = { pid: number; gen: ProcessGeneration | null };

/**
 * 这张表里**还没有答案的拓扑空洞**:挂不上树,而且三条排除路都走不通。
 *
 * 三条排除路(有一条成立就不算空洞):
 *  · **已经算进去了** —— 它就是我们自己、或者已经在某棵子树里报过(那边另有说法);
 *  · **它已经退了** —— 快照之后再问一次号,没人占着 ⇒ 这是**正面的**退出证明;
 *  · **本次运行开工之前它就在** —— 后代只能出生在根之后,所以明显更早的那些不可能是我们派生的。
 *
 * 剩下的就得让这一轮答「没问清楚」:**「这棵树里没看到」不等于「已经排除了它属于这次运行」**
 * (第 7 轮审查 F1 实测:Linux 上一次 `stat` 读不到的活后代挂不到任何树上,生产枚举答
 * `answered=true`、清理宣布 empty、一笔债都没落,而它还在写文件)。
 *
 * 排除**不是**拿「它身上没有我们的记号」当依据:后代可以把环境洗掉(`env -i`),那条线索的
 * 负结果什么都证明不了。这里只用上面三条立得住的。
 */
export function unresolvedTopology(
  table: ProcessTableSnapshot,
  opts: { accounted: Iterable<number>; runStartedAtMs: number | null },
): TopologyGap[] {
  const accounted = new Set(opts.accounted);
  const gaps: TopologyGap[] = [];
  for (const pid of table.unlinked) {
    if (accounted.has(pid)) continue;
    if (!isPidAlive(pid)) continue;
    const gen = table.gens.get(pid) ?? null;
    if (gen && startedBefore(gen, opts.runStartedAtMs)) continue;
    gaps.push({ pid, gen });
  }
  return gaps;
}

/**
 * 这个戳换算成**墙上时钟毫秒**。拿不到就 null(⇒ 按时间排除不了它)。
 *
 * 两种问法都换得过来,所以「比谁更早」这件事不受标签限制(标签只约束**相等**判断,见文件头:
 * 两份读数来自不同问法时不许宣布同一代)。`j:` 那一档是**自开机以来的时钟节拍**,`/proc` 里
 * 这些字段的单位恒为 USER_HZ = 100,所以乘 10 就是毫秒,再加上开机时刻(`/proc/stat` 的
 * `btime`,秒)。
 */
export function genStartedAtMs(gen: ProcessGeneration): number | null {
  if (gen.startsWith("t:")) {
    const ms = Date.parse(gen.slice(2));
    return Number.isFinite(ms) ? ms : null;
  }
  if (gen.startsWith("j:")) {
    const jiffies = Number(gen.slice(2));
    const boot = bootTimeMs();
    return Number.isFinite(jiffies) && boot !== null ? boot + jiffies * 10 : null;
  }
  return null;
}

/**
 * 这个戳换算成墙上时钟之后**还剩多少不确定**(毫秒)。
 *
 * 比较两个时刻时的容差只能来自它 —— 凭感觉给一个常数就是在放水:上一版在归属窗口那一层
 * 写死 ±2 秒、理由写的是「两端读数都只到秒」,可真正靠时间判归属的只有 Windows,而那边的
 * `CreationDate` 走 `ToString('o')`(`platform.ts` 的 `ConvStart`)带 7 位小数 —— 2 秒的口子
 * 里塞得下一整个「号被复用」的窗口(第 17 轮审查 F1)。
 *
 *  · `t:` 文本里带小数 ⇒ 至少到毫秒(Windows 的 ISO 时刻)⇒ 1ms;
 *  · `t:` 不带小数 ⇒ POSIX `ps -o lstart` 只到秒 ⇒ 1000ms;
 *  · `j:` ⇒ 节拍本身 10ms,但换算要加上 `/proc/stat` 的 btime(只到秒)⇒ 1000ms。
 *    同一张表上两个 `j:` 戳的 btime 偏移相同、相减时会抵消,所以**相对**精度其实还是 10ms;
 *    这里给的是绝对值,当容差用只会更松 —— 而 Linux 上内核会重父,陈旧父号压根不存在
 *    (判据见 `executors/lineage.ts` 的 ①),松在那里不换来任何误杀。
 */
export function genResolutionMs(gen: ProcessGeneration): number {
  if (gen.startsWith("j:")) return 1000;
  return /\.\d/.test(gen) ? 1 : 1000;
}

let bootMs: number | null | undefined;
function bootTimeMs(): number | null {
  if (bootMs !== undefined) return bootMs;
  try {
    const m = /^btime\s+(\d+)$/m.exec(readFileSync("/proc/stat", "utf8"));
    bootMs = m ? Number(m[1]) * 1000 : null;
  } catch {
    bootMs = null;
  }
  return bootMs;
}

/**
 * 这个戳**明显早于**那一刻吗(早至少一秒)。
 *
 * 留一秒余量是因为 `t:` 那一档精度只有秒:同一秒里先后出生的父子,它分不出来谁先。
 * 拿不到任何一边就答 false —— 宁可多留一笔账,也不拿一个比不出来的时间去「排除」。
 */
function startedBefore(gen: ProcessGeneration, momentMs: number | null): boolean {
  if (momentMs === null) return false;
  const ms = genStartedAtMs(gen);
  return ms !== null && ms <= momentMs - 1000;
}

/**
 * 这几个号里**最早的那个启动时刻**(毫秒),当「本次运行从哪一刻开始」的下界。
 *
 * 取最早而不是取某一个:任一个根成立都足以授权它名下的后代,所以能排除掉的只有「比**所有**
 * 根都明显更早」的那些。一个都拿不到就给 null(不按时间排除任何东西)。
 */
export function earliestStartMs(table: ProcessTableSnapshot, pids: Iterable<number>): number | null {
  let earliest: number | null = null;
  for (const pid of pids) {
    const gen = table.gens.get(pid);
    const ms = gen ? genStartedAtMs(gen) : null;
    if (ms !== null && (earliest === null || ms < earliest)) earliest = ms;
  }
  return earliest;
}

/**
 * 这些根**自己 + 它们下面的全部后代**,每一个都带着代次。
 *
 * 为什么不是「先用 `listProcesses()` 拿 pid/ppid,再逐个问 `ps` 要启动时刻」:那正是本文件
 * 开头那条缝 —— 「它是谁的孩子」和「它是哪一代」成了两次读数,第一次读到的那个进程退掉、
 * 这个号被别人接手时,新进程的代次被写到了前一个事实上,随后的 TERM 和补刀都据此下刀。
 * 所以三个平台各走一条**单次读数**的路:
 *
 *  · Linux  —— 一次 `/proc/<pid>/stat` 同时给出 ppid(第 4 项)和 starttime(第 22 项);
 *  · 其它 POSIX —— `ps` 的同一行同时给出 pid / ppid / lstart;
 *  · Windows —— `listProcesses()` 的同一行就带着 `startedAt`(只有那一支填得上),所以
 *    那边**没有**这条缝,直接用它。
 *
 * 查不到返回 null,**不要读成「没有后代」**(ps/`/proc` 失败与真的没有后代是两件事)。
 *
 * 返回的是**按种子分组的子树**(见 `ProcessSubtree` 上面那段):每个成员都带得出「哪个根把
 * 它带进来的」,而那个根的授权要不要复核、怎么复核,由调用方在它自己的证据体系里决定。
 */
export async function processTreeMembers(
  roots: readonly number[],
): Promise<ProcessSubtree<{ pid: number }>[] | null> {
  const table = await processTableSnapshot();
  return table ? subtreesOf(table, roots.map((pid) => ({ pid }))) : null;
}
