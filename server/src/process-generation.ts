// **代次:「这个号上现在还是不是我说的那一个进程」** —— 归属证据、成员名单、下刀授权共用的
// 那一个戳,实现只许有这一份。
//
// 为什么要把它单独拎出来(第 15 轮审查 F1):pid 会被复用,所以**任何一条跨时刻的断言都得
// 连着「哪一代」说**。上一版在哨兵那一摊里是这样取证的 ——
//
//   ① 读两遍进程表的环境,把两遍的**裸 pid** 取并集;
//   ② 并集定下来之后,再对每个 pid 问一次 `ps` 要启动时刻,拼成「成员(pid + 代次)」。
//
// ②里那次问话发生在①全部读完之后,于是**第一遍读到记号的那一代**和**后来问到的那一代**
// 根本不是同一次读数:第一遍那个进程退掉、这个号被别人接手时,新进程的真实启动时刻被写到了
// 前一个进程的归属证明上,首次信号和两秒后的补刀都据此下刀。审查用显式注入 `/proc` 读取边界
// 复现了这一刀(`generation.log`:`actualDiagnosticEnvironmentHasUnitKey=false`、
// `diagnosticAliveAfterProductionKill=false`)。
//
// 所以代次不是「再加一个时间戳字段」,是一条形状上的规矩:
//
//  · **事实和它那一代必须同源** —— 读环境项、枚举组成员的那一次读数自己把代次带出来,
//    不许事后补问(本文件的 `processGroupMembersSync` 在 Linux 上就是一次 `stat` 里同时
//    拿到 pgrp 和 starttime);
//  · **发信号之前再核一遍** —— 证据可以攒着跨 `await`,但每一刀之前都要拿这个戳重问一次
//    (monitor-reclaim-evidence.ts 的 `stillSameGeneration`);
//  · **戳问不出来 ⇒ 不许发信号** —— 宁可漏收,也不碰一个证不出代次的号。
//
// 两个平台能拿到的戳不一样,所以戳自己带标签,**跨标签一律不相等**(于是「两份读数来自
// 不同的问法」只会导致拒绝下刀,不会导致误判成同一代):
//
//  · `j:<starttime>` —— Linux `/proc/<pid>/stat` 第 22 项,单位是时钟节拍(通常 10ms),
//    由内核在 `fork` 时写死。这是这台机器上最接近「内核实例编号」的东西;
//  · `t:<lstart>` —— `ps -o lstart` 的启动时刻文本,**精度只有秒**。同一秒内退出又被复用
//    的号它分不出来 —— 这是平台边界,如实记在这里:macOS 上记号那一问本来就只给
//    `suspected`(不签发下刀凭证,见 monitor-unit-scan.ts 的 `UnitProofGrade`),所以这个
//    戳在 macOS 上的作用是**让「还是同一代」这句话有个依据**,不是把它升格成精确身份。
import { execFile, execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { IS_WINDOWS, inspectProcessSync, isPidAlive, listProcessesComplete } from "./platform.js";
import type { ProcessTableRead } from "./platform.js";

/** 一个号上这一代的戳(带问法标签,见文件头)。**只做相等比较,不要解析它的内容。** */
export type ProcessGeneration = string;

/** 一个已经证明过的进程:号 + **读到那个事实时它是哪一代**。 */
export type ProcessMember = {
  pid: number;
  gen: ProcessGeneration;
};

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
 * `/proc/<pid>/stat` 右括号之后的那串字段。
 *
 * 为什么从 `lastIndexOf(")")` 切:第 2 项是 `comm`,它被括号包着而且**允许含空格**
 * (`(Web Content)`),直接 `split(" ")` 会把后面所有字段错位。右括号之后的第一项是
 * `state`(第 3 项),所以「第 N 项」= 这里的下标 `N - 3`。
 */
function procStatFields(pid: number): string[] | null {
  const read = readProcStat(pid);
  return typeof read === "string" ? null : read;
}

/**
 * 同上,但**分得清「这个号已经退了」和「这一行读不出来」**(第 6 轮审查 F1)。
 *
 * 建树那一侧非得分开:退掉的进程跳过是对的(它确实不在了),而**还在、只是这一行读失败**的
 * 那个号跳过就等于把它宣布成不存在。`ENOENT`/`ESRCH` 是前者(`readdir` 与这次读之间它退了),
 * 其余(权限、格式不认)是后者。
 */
function readProcStat(pid: number): string[] | "gone" | "unreadable" {
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    return code === "ENOENT" || code === "ESRCH" ? "gone" : "unreadable";
  }
  const close = raw.lastIndexOf(")");
  if (close < 0) return "unreadable";
  // `trim()` 是为了行尾那个换行:真实的 stat 有 52 项,末尾的换行只黏在最后一项上,但别让
  // 「我们要的那一项恰好是最后一项」这种情况(裁过的 stat、将来变短的格式)把数字读成非数字。
  const fields = raw.slice(close + 2).trim().split(" ");
  return fields.length > 19 ? fields : "unreadable";
}

/** 第 22 项 `starttime`:内核在 `fork` 时写死的节拍数 —— 同一个号换代必变。 */
function procStarttime(fields: string[]): string | null {
  const raw = fields[19];
  return raw && /^\d+$/.test(raw) ? raw : null;
}

/** 第 5 项 `pgrp`:**跟 starttime 来自同一次读**,所以成员与代次天然同源。 */
function procPgrp(fields: string[]): number | null {
  const raw = fields[2];
  return raw && /^\d+$/.test(raw) ? Number(raw) : null;
}

/**
 * **这个号上现在这一代的戳** —— `null` = 问不出来(进程没了,或者这台机器两种问法都失败)。
 *
 * 先问 `/proc`(节拍精度),没有 `/proc` 才退回 `ps -o lstart`(秒精度)。两种答案带不同
 * 标签:同一个号在两次读数里走了不同的问法时,比较结果是「不相等」⇒ 拒绝下刀。那正是想要的
 * 方向 —— 问法不稳定本身就说明这一刻证不出代次。
 */
export function processGenerationSync(pid: number): ProcessGeneration | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const fields = procStatFields(pid);
  const jiffies = fields ? procStarttime(fields) : null;
  if (jiffies) return `j:${jiffies}`;
  const startedAt = inspectProcessSync(pid)?.startedAt?.trim();
  return startedAt ? `t:${startedAt}` : null;
}

/**
 * 换算这一问的三种答案。**「问不出来」和「已经换代」必须分开**(第 16 轮审查 F1-B)。
 *
 * 上一版这里只返回 `string | null`,于是调用方把 `null` 一律读成「这次没拿到值」,接着退回
 * 时间邻近 + 命令包含那条弱判据 —— 而 `null` 的其中一种含义恰恰是**「已经证明这个号换代了」**。
 * 实测后果:强凭证明确拒绝之后,新进程被弱判据重新授信,它真实的启动时刻被写成旧哨兵的身份,
 * 随后按这条身份被关掉(`identity-fallback.log`:`explicitConversionResult=null`、
 * `persistedStartedAt` 等于新进程的真实启动时刻、`diagnosticAliveAfter=false`)。
 *
 * 所以这一问答三档,调用方必须分别处理:
 *  · `proven` —— 同一代,启动时刻可以落库;
 *  · `changed` —— **反证**:这个号已经不是那一代了(或者那一代已经不在了)。
 *    **不许再退回任何弱判据** —— 反证不能被「有个时间锚点」洗掉;
 *  · `unqueryable` —— 这一刻问不出来(ps 不可用,或者两次读数走了不同问法所以比不出来)。
 *    既不是证明也不是反证:调用方可以照旧走它原来的后备路,恢复之后再问。
 */
export type GenerationStartedAt =
  | { outcome: "proven"; startedAt: string }
  | { outcome: "changed" }
  | { outcome: "unqueryable" };

/** 戳的问法标签(`j:` / `t:`):不同问法之间比不出相等,那是「问不出来」,不是「换代了」。 */
const generationTag = (gen: ProcessGeneration): string => gen.slice(0, gen.indexOf(":") + 1);

/**
 * 把「这一代」换算成**可落库的启动时刻文本**:读 `ps` 之前之后各核一次代次戳。
 *
 * 为什么要夹:数据库里那一列(`monitors.pid_started_at`)存的是 `ps` 的 lstart 文本,而
 * Linux 上代次戳是节拍数 —— 这是**两份读数**。中间换了代就等于把别人那一代的启动时刻写成
 * 这个号的身份,后面所有「还是不是它」的判断都会跟着错(第 15 轮审查 F1 的同类消费点)。
 *
 * 拒绝的**理由**一起交出去(见 `GenerationStartedAt`):调用方据此决定「还能不能退回别的
 * 判据」—— 这正是第 16 轮审查 F1-B 的那条缝。
 */
export function startedAtOfGeneration(pid: number, gen: ProcessGeneration): GenerationStartedAt {
  const before = currentGeneration(pid, gen);
  if (before.outcome !== "proven") return before;
  const startedAt = inspectProcessSync(pid)?.startedAt?.trim() || null;
  if (!startedAt) return { outcome: "unqueryable" };
  const after = currentGeneration(pid, gen);
  return after.outcome === "proven" ? { outcome: "proven", startedAt } : after;
}

/** 这一刻这个号上是不是 `gen` 那一代 —— 三档,理由分开(见 `GenerationStartedAt`)。 */
function currentGeneration(
  pid: number, gen: ProcessGeneration,
): { outcome: "proven" } | { outcome: "changed" } | { outcome: "unqueryable" } {
  const current = processGenerationSync(pid);
  // 问不出来有两种:那一代已经不在这个号上了(进程没了)是**反证**;它还活着、只是这一刻
  // 读不出代次(ps 不可用)只能算「问不出来」。
  if (current === null) return isPidAlive(pid) ? { outcome: "unqueryable" } : { outcome: "changed" };
  if (current === gen) return { outcome: "proven" };
  // 两份读数走了不同问法(`/proc` 这一刻读不到、退回了 `ps`)⇒ 比不出来,不是反证。
  return generationTag(current) === generationTag(gen)
    ? { outcome: "changed" }
    : { outcome: "unqueryable" };
}

/**
 * 这一组里现在有哪些成员,**各自带着代次**。
 *
 * 只在「组长此刻证明过、而且还活着」时问得有意义:那时这一组的成员只可能是它的后代 ——
 * 组号就是组长的 pid(它活着,这个号不可能同时是别人的),而外人要加进来得 `setpgid` 到同一个
 * 会话里去,那个会话的头正是这条哨兵自己。所以这一份名单就是「整项资源此刻的成员」。
 *
 * 为什么要连代次一起拿:名单是要**留到下一刀**用的(TERM 之后两秒那一下,组长可能已经退了)。
 * 两秒里一个成员可以退出、它的号可以被别人接手 —— 发信号之前拿代次再核一遍,就不必靠
 * 「pid 不会这么快被复用」这种推断。而且代次必须**跟「它在这一组里」同源**:Linux 上一次
 * `stat` 同时给出 pgrp 和 starttime,macOS 上 `ps` 的同一行同时给出 pgid 和 lstart ——
 * 两件事读成两次就又出现「把后来那一代的戳补给先前那个事实」的缝(第 15 轮审查 F1)。
 *
 * 查不到(ps 不可用 / Windows 没有进程组)返回 null,**不要读成「这一组空了」**。
 */
export function processGroupMembersSync(pgid: number): ProcessMember[] | null {
  if (IS_WINDOWS || !Number.isInteger(pgid) || pgid <= 1) return null;
  return groupViaProc(pgid) ?? groupViaPs(pgid);
}

/** Linux:一次 `stat` 读里同时拿到 pgrp 与 starttime ⇒ 成员关系和代次同源。 */
function groupViaProc(pgid: number): ProcessMember[] | null {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return null;
  }
  const members: ProcessMember[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const fields = procStatFields(Number(entry));
    if (!fields || procPgrp(fields) !== pgid) continue;
    const jiffies = procStarttime(fields);
    if (!jiffies) continue;                       // 代次读不出 ⇒ 不收这个成员(宁可漏收)
    members.push({ pid: Number(entry), gen: `j:${jiffies}` });
  }
  return members;
}

/** 没有 `/proc` 的平台:`ps` 的同一行同时给出 pgid 和 lstart ⇒ 同源,精度到秒。 */
function groupViaPs(pgid: number): ProcessMember[] | null {
  let out: string;
  try {
    out = execFileSync("ps", ["-A", "-o", "pid=", "-o", "pgid=", "-o", "lstart=", "-ww"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  const members: ProcessMember[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m || Number(m[2]) !== pgid) continue;
    const startedAt = m[3]!.trim();
    if (!startedAt) continue;                     // 代次读不出 ⇒ 不收这个成员
    members.push({ pid: Number(m[1]), gen: `t:${startedAt}` });
  }
  return members;
}

/** 这个号此刻还是不是记下那个事实时的那一代 —— **每一刀之前都要问这一句**。 */
export const stillSameGeneration = (member: ProcessMember): boolean =>
  processGenerationSync(member.pid) === member.gen;

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

/**
 * 整张进程表的**一次**快照(父子关系与代次同源,见上面那段)。
 *
 * 拆成「先拿快照、再切子树」两段是为了让调用方**先取快照、后取归属线索** —— 这个顺序本身
 * 就是一道不变量,理由见 `executors/escapees.ts` 里 fd 那一路的注释:快照在前时,
 * 「快照里这个号的那一代此刻还在」就足以证明「归属线索认的那个进程正是快照里那个进程」;
 * 顺序反过来就证不出,得另外补一次查询去夹,而那种夹法分不清「它换了主人」和「它自己
 * 松开了线索」—— 两者的正确处置相反。
 */
export async function processTableSnapshot(): Promise<ProcessTableSnapshot | null> {
  return IS_WINDOWS ? await treeViaProcessList() : treeViaProc() ?? (await treeViaPs());
}

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
  opts: { accounted: Iterable<number>; runStartedAt: ProcessGeneration | null },
): TopologyGap[] {
  const accounted = new Set(opts.accounted);
  const gaps: TopologyGap[] = [];
  for (const pid of table.unlinked) {
    if (accounted.has(pid)) continue;
    if (!isPidAlive(pid)) continue;
    const gen = table.gens.get(pid) ?? null;
    if (gen && opts.runStartedAt && startedEarlier(gen, opts.runStartedAt)) continue;
    gaps.push({ pid, gen });
  }
  return gaps;
}

/**
 * 这几个号里**最早的那一代**,当「本次运行从哪一刻开始」的下界。拿不到就给 null(不排除)。
 *
 * 取最早而不是取某一个:任一个根成立都足以授权它名下的后代,所以能排除掉的只有「比**所有**
 * 根都明显更早」的那些。
 */
export function earliestGen(table: ProcessTableSnapshot, pids: Iterable<number>): ProcessGeneration | null {
  let earliest: ProcessGeneration | null = null;
  for (const pid of pids) {
    const gen = table.gens.get(pid);
    if (!gen) continue;
    if (!earliest || startedEarlier(gen, earliest)) earliest = gen;
  }
  return earliest;
}

/**
 * 同一张快照里的两个戳:`a` **明显**早于 `b` 吗。比不出来一律 false(宁可多留一笔账)。
 *
 * 跨问法不可比(见文件头:标签不同一律不相等),所以只在同标签之间比。`t:` 那一档精度只有
 * 秒,所以要留一秒余量 —— 同一秒里先后出生的父子,它分不出来谁先。
 */
function startedEarlier(a: ProcessGeneration, b: ProcessGeneration): boolean {
  if (a.startsWith("j:") && b.startsWith("j:")) {
    const [x, y] = [Number(a.slice(2)), Number(b.slice(2))];
    return Number.isFinite(x) && Number.isFinite(y) && x < y;
  }
  if (a.startsWith("t:") && b.startsWith("t:")) {
    const [x, y] = [Date.parse(a.slice(2)), Date.parse(b.slice(2))];
    return Number.isFinite(x) && Number.isFinite(y) && x <= y - 1000;
  }
  return false;
}

/**
 * 一个种子名下的后代。**不跨子树去重** —— 两棵子树各自授权,共有的成员两边都要出现。
 *
 * **代次读不出来的那些号照样要穿过去**(第 6 轮审查 F1):上一版在它们身上 `continue`,于是
 * 它自己不算成员、**它下面整条分支也一起从遍历里消失了**。现在它进 `unverified`(不给下刀
 * 凭证),遍历接着往它的孩子走。
 */
function walkDescendants(
  table: ProcessTree, seed: number,
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
 * 一次读数里同时拿到的父子关系与代次。**两者同源**是这整个文件的前提(见文件头)。
 *
 * 这一问的两档写在返回类型上:`ProcessTableSnapshot` = 问全了的一张表,`null` = 这一问没答
 * 出来。**所以这里没有「半截表」这一档** —— 消费方(`escapees.ts`)把缺席读作「不在树上」,
 * 而半截表里的缺席什么都证明不了;三个构造函数因此在任何读数故障上都答 `null`,不拿已经
 * 拿到的那部分拼一张表出来(第 5 轮审查 F1 在 `treeViaPs` 上实测了相反做法的后果)。
 */
export type ProcessTableSnapshot = {
  kids: Map<number, number[]>;
  gens: Map<number, ProcessGeneration>;
  /**
   * **在表上、可是这一代核验不了的号**(第 6 轮审查 F1 的修复落点)。
   *
   * 「存在」「这一代可核验」「不存在」是三件事,上一版只有两档:读不出代次的行**整行丢掉**,
   * 连它那条父子关系一起丢 —— 于是遍历时它既不是成员、也不在树上,「核验不了」被读成了
   * 「没有后代」。审查在 Windows 真机上实测:活后代的 `CreationDate` 取不到,生产清理答
   * `empty`、一笔责任都没落,那个后代心跳 25→37 还在写。
   *
   * 这一档的处置:**不敢下刀**(代次是下刀的唯一凭证,见文件头),但它是实打实的残留事实 ——
   * 遍历要穿过它继续往下走,收口处要据它答「这一问没问清楚」。
   */
  unverified: Set<number>;
  /**
   * 这张表里**连号都没认出来**的行数(见 platform.ts 的 `ProcessTableRead`)。
   *
   * 跟 `unverified` 的区别:那一档知道是哪个号,这一档连名字都没有,所以只能计数。收口处据它
   * 答「这一问没问清楚」—— 不然那几行在表里就等于不存在,而缺席在这条路上会被读成「不在树上」。
   */
  unnamed: number;
  /**
   * **在表上、可是「它挂在谁下面」问不出来的号**(第 7 轮审查 F1 的修复落点)。
   *
   * 跟 `unverified` 是两件事,别合:那一档知道它在树上的位置、只是不敢下刀;这一档**压根
   * 挂不到任何树上** —— `subtreesOf` 只沿边走,没有边的号任何子树都遍历不到,于是「这棵树里
   * 没看到它」被读成了「已经排除了它属于这次运行」。审查实测:Linux 上一次 `stat` 读不到
   * (EACCES)的活后代,生产枚举答 `targets=[] / answered=true`,清理宣布 empty、一笔债都没落,
   * 那个后代心跳 8→22 还在写。
   *
   * 处置:它既认不下来也否不掉,所以**由收口处逐个排除**(见 `unresolvedTopology`):确实已经
   * 退了、已经算在某棵树上、或者在本次运行开工之前就在 —— 这三种能排除;剩下的必须让这一轮
   * 答「没问清楚」。
   */
  unlinked: Set<number>;
};
type ProcessTree = ProcessTableSnapshot;

/**
 * 记一条父子边。**父号 `null` = 这一行说不出它挂在谁下面** ⇒ 进 `unlinked`,不是「没有父进程」。
 *
 * 0 号是另一回事:内核那一层本来就没有父进程,它不是未知(Windows 的 0 号在解析那一层就被
 * 跳过了,见 platform.ts 的 `readWindowsRows`)。父号等于自己同样算问不出来 —— 这条边指不到
 * 任何别的节点,留着它只会让这个号看起来「已经挂上了」。
 */
const linkKid = (tree: ProcessTree, ppid: number | null, pid: number): void => {
  if (ppid === null || ppid === pid) { tree.unlinked.add(pid); return; }
  if (!ppid) return;
  const kids = tree.kids.get(ppid);
  if (kids) kids.push(pid);
  else tree.kids.set(ppid, [pid]);
};

/** Linux:一次 `stat` 里同时读到 ppid 与 starttime ⇒ 父子关系和代次同源。 */
function treeViaProc(): ProcessTree | null {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return null;
  }
  const reads: [number, ProcStatRead][] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    reads.push([pid, readProcStat(pid)]);
  }
  return tableFromProcStats(reads);
}

/** 一次 `/proc` 读数的三档结果(见 `readProcStat`)。 */
export type ProcStatRead = string[] | "gone" | "unreadable";

/**
 * `treeViaProc` 的纯核:**只认读数,不碰文件系统**,所以这段判据能在任何平台上被钉住
 * (`test:process-subtrees`)—— 它判错的后果只在 Linux 上出现,而那是本机跑不到的分支。
 */
export function tableFromProcStats(reads: Iterable<readonly [number, ProcStatRead]>): ProcessTableSnapshot {
  const tree: ProcessTree = { kids: new Map(), gens: new Map(), unverified: new Set(), unnamed: 0, unlinked: new Set() };
  for (const [pid, read] of reads) {
    // 它在 `readdir` 与这次读之间退掉了 ⇒ 确实不在了,跳过是对的。
    if (read === "gone") continue;
    // 还在、只是这一行读不出来 ⇒ 记成「核验不了」而不是丢掉(连 ppid 也读不到,所以它挂不
    // 到任何树上 —— 这一档只保证它不会被当成「已经证明不存在」)。
    // 还在、只是这一行读不出来 ⇒ 代次核验不了,**而且连它挂在谁下面都不知道**:两档都要记,
    // 不然它挂不到任何树上、又没人替它说话,等于被宣布成不存在(第 7 轮审查 F1 实测的那一下)。
    if (read === "unreadable") { tree.unverified.add(pid); tree.unlinked.add(pid); continue; }
    const ppid = read[1];
    // **父子关系照记**:代次读不出来不影响它在树上的位置,而丢掉这条边会让它下面整条分支
    // 从遍历里消失(第 6 轮审查 F1)。父号这一项不是合法数字时如实当「问不出来」。
    linkKid(tree, ppid && /^\d+$/.test(ppid) ? Number(ppid) : null, pid);
    const jiffies = procStarttime(read);
    if (jiffies) tree.gens.set(pid, `j:${jiffies}`);
    else tree.unverified.add(pid);
  }
  return tree;
}

/** 没有 `/proc` 的 POSIX:`ps` 的同一行给出 pid / ppid / lstart,精度到秒。 */
async function treeViaPs(): Promise<ProcessTree | null> {
  const out = await new Promise<string | null>((resolve) => {
    execFile(
      "ps",
      ["-A", "-o", "pid=", "-o", "ppid=", "-o", "lstart=", "-ww"],
      // **带时限**(第 4 轮审查 N4):挂死的 ps 会把进程树这一问、以及等着它的清理一起拖住。
      // 被掐掉时 stdout 多半是空的 ⇒ 这一问答 `null`(没问出来),调用方据此留着重试。
      { maxBuffer: 16 * 1024 * 1024, timeout: 10_000, env: { ...process.env, LC_ALL: "C", LANG: "C" } },
      // **出了错就整问作废,哪怕 stdout 里已经有东西**(第 5 轮审查 F1)。上一版只拒超时和
      // 信号,于是「退 2 + 一行输出」照样被解析成一棵树 —— 而缺席在这棵树里读作「不在树上」,
      // 没扫到的后代于是被当成不存在。`ps -A` 跑成功就是退 0,非零只能说明这一问没答全,
      // 半截表不是一棵进程树。判据与 `track-evidence.ts` 的 `heldNames` 同源:**宁可整问重来**。
      (error, stdout) => resolve(error ? null : stdout || ""),
    );
  });
  if (out === null) return null;
  const tree: ProcessTree = { kids: new Map(), gens: new Map(), unverified: new Set(), unnamed: 0, unlinked: new Set() };
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) {
      // 开头像个号、整行却没认出来 ⇒ 这一行在表里等于不存在,如实计数(见 `unnamed`)。
      if (/^\s*\d/.test(line)) tree.unnamed += 1;
      continue;
    }
    const startedAt = m[3]!.trim();
    const pid = Number(m[1]);
    linkKid(tree, Number(m[2]), pid);               // 边照记(见 treeViaProc 里那段)
    if (startedAt) tree.gens.set(pid, `t:${startedAt}`);
    else tree.unverified.add(pid);                  // 在表上、核验不了这一代
  }
  return tree;
}

/** Windows:进程表那一行自带 `startedAt`(见 platform.ts),所以这里本来就是单次读数。 */
async function treeViaProcessList(): Promise<ProcessTree | null> {
  // **要问全了的那一支**(第 5 轮审查 F1 的同类出口):`listProcesses` 把读数故障吞成「就这些
  // 行」,而这里的缺席会被读成「这个进程不在树上」。半截表在这条路上不是少点信息,是错答案。
  const read = await listProcessesComplete();
  if (!read?.rows.length) return null;
  return tableFromRows(read);
}

/**
 * Windows 那一路的纯核:**只认一次读数**(同 `tableFromProcStats` 的理由)。
 */
export function tableFromRows(read: ProcessTableRead): ProcessTableSnapshot {
  const tree: ProcessTree = { kids: new Map(), gens: new Map(), unverified: new Set(), unnamed: 0, unlinked: new Set() };
  for (const row of read.rows) {
    // `ConvStart` 合法地给得出空串、`parseRows` 合法地给得出 null —— 那是「这一代核验不了」,
    // 不是「这个号不在」(第 6 轮审查 F1 在真机上实测了把它当缺席的后果)。
    const startedAt = row.startedAt?.trim();
    if (startedAt) tree.gens.set(row.pid, `t:${startedAt}`);
    else tree.unverified.add(row.pid);
    // 父号为 null = 这一行说不出它挂在谁下面(`ParentProcessId` 读不到),进 `unlinked`。
    // 上一版它在解析那一层就被规范化成 0,于是这里安静地不记边、也没人知道少了一条
    // (第 7 轮审查 F1)。
    linkKid(tree, row.ppid, row.pid);
  }
  tree.unnamed = read.unnamed;
  return tree;
}
