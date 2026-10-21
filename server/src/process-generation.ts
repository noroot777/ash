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
import { IS_WINDOWS, inspectProcessSync, isPidAlive, listProcesses } from "./platform.js";

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

/** 一个种子名下的子树。成员的归属全部来自 `seed`,**复核 seed 是调用方的义务**。 */
export type ProcessSubtree = {
  seed: ProcessTreeSeed;
  /** 种子自己(它此刻在表上才有)。`null` = 这个号已经退场(Windows 上残留树仍可用)。 */
  root: ProcessMember | null;
  /** 种子名下的全部后代,各自带着与父子关系同源的那一代。 */
  descendants: ProcessMember[];
};

/**
 * `/proc/<pid>/stat` 右括号之后的那串字段。
 *
 * 为什么从 `lastIndexOf(")")` 切:第 2 项是 `comm`,它被括号包着而且**允许含空格**
 * (`(Web Content)`),直接 `split(" ")` 会把后面所有字段错位。右括号之后的第一项是
 * `state`(第 3 项),所以「第 N 项」= 这里的下标 `N - 3`。
 */
function procStatFields(pid: number): string[] | null {
  let raw: string;
  try {
    raw = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const close = raw.lastIndexOf(")");
  if (close < 0) return null;
  // `trim()` 是为了行尾那个换行:真实的 stat 有 52 项,末尾的换行只黏在最后一项上,但别让
  // 「我们要的那一项恰好是最后一项」这种情况(裁过的 stat、将来变短的格式)把数字读成非数字。
  const fields = raw.slice(close + 2).trim().split(" ");
  return fields.length > 19 ? fields : null;
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
): Promise<ProcessSubtree[] | null> {
  const table = await processTableSnapshot();
  return table ? subtreesOf(table, roots) : null;
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

/** 从一张快照里切出这些根的子树。根的代次**来自快照本身**,所以授权与遍历同源。 */
export function subtreesOf(
  table: ProcessTableSnapshot, roots: readonly number[],
): ProcessSubtree[] {
  const seeds = [...new Set(roots)].filter((pid) => Number.isInteger(pid) && pid > 1);
  return seeds.map((pid) => {
    const gen = table.gens.get(pid) ?? null;      // 根此刻不在表上 = 它已经退了
    return {
      seed: { pid, gen },
      root: gen ? { pid, gen } : null,
      descendants: walkDescendants(table, pid),
    };
  });
}

/** 一个种子名下的后代。**不跨子树去重** —— 两棵子树各自授权,共有的成员两边都要出现。 */
function walkDescendants(table: ProcessTree, seed: number): ProcessMember[] {
  const out: ProcessMember[] = [];
  const seen = new Set<number>([seed]);           // 环形 ppid(不该有,但别据此死循环)
  const stack = [seed];
  while (stack.length) {
    const parent = stack.pop()!;
    for (const kid of table.kids.get(parent) ?? []) {
      if (seen.has(kid)) continue;
      seen.add(kid);
      const gen = table.gens.get(kid);
      if (!gen) continue;                         // 代次读不出 ⇒ 不收这个成员(宁可漏收)
      out.push({ pid: kid, gen });
      stack.push(kid);
    }
  }
  return out;
}

/** 一次读数里同时拿到的父子关系与代次。**两者同源**是这整个文件的前提(见文件头)。 */
export type ProcessTableSnapshot = {
  kids: Map<number, number[]>;
  gens: Map<number, ProcessGeneration>;
};
type ProcessTree = ProcessTableSnapshot;

const addKid = (tree: ProcessTree, ppid: number, pid: number): void => {
  if (!ppid || ppid === pid) return;
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
  const tree: ProcessTree = { kids: new Map(), gens: new Map() };
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    const fields = procStatFields(pid);
    if (!fields) continue;
    const jiffies = procStarttime(fields);
    if (!jiffies) continue;
    tree.gens.set(pid, `j:${jiffies}`);
    const ppid = fields[1];
    if (ppid && /^\d+$/.test(ppid)) addKid(tree, Number(ppid), pid);
  }
  return tree;
}

/** 没有 `/proc` 的 POSIX:`ps` 的同一行给出 pid / ppid / lstart,精度到秒。 */
async function treeViaPs(): Promise<ProcessTree | null> {
  const out = await new Promise<string | null>((resolve) => {
    execFile(
      "ps",
      ["-A", "-o", "pid=", "-o", "ppid=", "-o", "lstart=", "-ww"],
      { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: "C", LANG: "C" } },
      (error, stdout) => resolve(error && !stdout ? null : stdout || ""),
    );
  });
  if (out === null) return null;
  const tree: ProcessTree = { kids: new Map(), gens: new Map() };
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const startedAt = m[3]!.trim();
    if (!startedAt) continue;
    const pid = Number(m[1]);
    tree.gens.set(pid, `t:${startedAt}`);
    addKid(tree, Number(m[2]), pid);
  }
  return tree;
}

/** Windows:进程表那一行自带 `startedAt`(见 platform.ts),所以这里本来就是单次读数。 */
async function treeViaProcessList(): Promise<ProcessTree | null> {
  const rows = await listProcesses();
  if (!rows.length) return null;
  const tree: ProcessTree = { kids: new Map(), gens: new Map() };
  for (const row of rows) {
    const startedAt = row.startedAt?.trim();
    if (startedAt) tree.gens.set(row.pid, `t:${startedAt}`);
    addKid(tree, row.ppid, row.pid);
  }
  return tree;
}
