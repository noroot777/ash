// **记号扫描:现在活着的进程里,带着哪些「资源单位」记号 —— 以及这一问**答得有多实**。
//
// 从 platform.ts 分出来的只有这一摊:读整张进程表、按记号归堆,外加一份短命备忘。那边留下的
// 是「怎么问操作系统」的那些单问(存活、进程组、成员、杀、端口)。
//
// 这一层的全部判据是一句话:**答案要带着它自己的证据等级**。两个平台能拿到的东西不一样,
// 上层据此签发的权限也必须不一样(第 14 轮审查 F1):
//
//  · Linux:`/proc/<pid>/environ` 是 **NUL 分隔的真实环境项**,所以「有没有 `KEY=VALUE` 这一项」
//    是精确可答的 ⇒ `exact`,可以当归属凭证(下刀);
//  · macOS:`ps -E` 把 argv 和环境**无分隔地拼成一行展示文本**,任何变量的值里都可以包含
//    `ASH_MONITOR_UNIT=<记号>` 这段文字(实测见下),所以这一问**只能答「看见了这段文字」**
//    ⇒ `ambiguous`:够用来拒绝说「已经没了」,**不够用来签发杀进程的凭证**;
//  · win32:读别的进程的环境块要 ReadProcessMemory 那一套,零依赖拿不到 ⇒ 整问失败。
//
// 判完之后「这算不算我们的、能不能下刀、够不够收档」在 monitor-reclaim-evidence.ts;
// 「这一问答出了什么」的四档投影在 proc.ts 的 `processUnitEvidence`。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { IS_WINDOWS } from "./platform.js";
import { processGenerationSync, type ProcessGeneration, type ProcessMember } from "./process-generation.js";

/**
 * 环境变量名:**这一次哨兵创建独有的资源记号**。
 *
 * 为什么是「环境里的一条记号」而不是命令原文(第 12 轮审查 F1-A):命令是要干的活,不是凭证。
 * 同一条命令可以合法地被创建两次,前缀还会撞 —— 记录的是 `sleep 1`、现存的是 `sleep 120`,
 * 包含判断照样认作自己的后代(实测:一条写着 2001 年启动时刻的历史行据此杀掉了审查自己起的
 * 测试组)。换成全串相等也不够,因为两次创建可以合法地跑完全一样的命令。
 *
 * 记号这一份满足「资源身份」该有的三条:
 *  · **每次创建独有** —— 随机生成,撞不上别人;
 *  · **跟着整项资源走** —— 环境随 `exec` 继承,后代各自带一份,所以组长死了之后还留在后台的
 *    那些仍然自证身份(而它们的 argv 早就换成别的程序了);
 *  · **跨重启可恢复** —— 起进程之前就随意图行落库(`monitors.unit_token`),债表上也留一份。
 *
 * **但「读得到这段文字」不等于「这个进程真有这一项」** —— 这是第 13、14 两轮审查接着量出来的
 * 同一个洞。第 13 轮:`ps -E` 把 argv 和环境拼成一行,整行正则会让**参数里**带着这段文字的
 * 陌生进程挨刀。第 13 轮的修法是「两次快照相减切出环境段」,第 14 轮实测它仍然不够:
 *
 * ```
 * $ env -i PATH=… AAA="x BBB=2 y" ASH_MONITOR_UNIT=realtok CCC="pre ASH_MONITOR_UNIT=faketok post" sleep 40
 * $ ps -p <pid> -E -ww -o command=
 * sleep 40 PATH=… AAA=x BBB=2 y ASH_MONITOR_UNIT=realtok CCC=pre ASH_MONITOR_UNIT=faketok post
 * ```
 *
 * 环境段自己也**没有边界**:`AAA` 的值里那个 `BBB=2` 和真正的 `BBB=2` 长得一模一样,`CCC` 的
 * 值里那个假记号和真记号也一样。审查据此让一个只在别的变量值里写了这段文字的诊断进程挨了刀
 * (`risk.log:1`:`actualUnitVariablePresent=false`、`evidence={"verdict":"ours"}`、
 * `diagnosticAliveAfter=false`)。反方向同理:假记号可以排在真记号前面。
 *
 * 所以这一层不再假装能从展示文本里切出环境项,而是**把证据等级一起交上去**(`UnitProofGrade`)。
 * 文本匹配只有一个方向是可靠的:**真实环境项必然出现在文本里**,所以「文本里一个都没有」⇒
 * 「真的没有这一项」;反过来不成立。于是 `ambiguous` 档只授权「不许说没了」,不授权下刀。
 *
 * 它的边界也要如实说:命令自己把环境清掉(`env -i`)、或者后代自己 `setsid` 跑掉,记号与进程组
 * 就都问不到了 —— 那一刻只能落「证不出」,**不许当成整项退出已证明**(见 proc.ts、
 * monitor-reclaim-evidence.ts 的 `traceless`)。
 */
export const MONITOR_UNIT_ENV = "ASH_MONITOR_UNIT";

/**
 * 这一问**答得有多实**:
 * - `exact` = 读到的是真实环境项(NUL 分隔),「有没有这一项」精确可答 ⇒ 可作归属凭证;
 * - `ambiguous` = 只拿到无边界的展示文本,「看见这段文字」里混着别的变量的值 ⇒ **不可作凭证**。
 *
 * 两档的差别不在准不准,在**能不能据此发信号**。消费它的是 proc.ts 的 `processUnitEvidence`:
 * `exact` 命中 ⇒ `ours`(下刀落点),`ambiguous` 命中 ⇒ `suspected`(只拒绝收档)。
 */
export type UnitProofGrade = "exact" | "ambiguous";

/** 一项资源此刻被证明着的成员,以及**这一遍问全了没有**。 */
export type MonitorUnitScan = {
  /**
   * 记号 → 这一遍在它名下读到的成员,**每个都带着「读到这一项时它是哪一代」**
   * (`grade` 决定这算凭证还是只算可疑)。
   *
   * 代次跟记号同源是硬要求(第 15 轮审查 F1):上一版这里是 `number[]`,代次留给调用方在
   * 并集定下来**之后**补问一次 `ps` —— 那一问读到的是「现在这个号上是谁」,而不是「读到
   * 记号的那一代」。号被接手时,新进程的启动时刻就被写成了前一个进程的归属证明。
   */
  marks: Map<string, ProcessMember[]>;
  /**
   * **看见了这个记号、却证不出它在哪一代**的那些记号(同一代的两次读数对不上,见
   * `scanMonitorUnits`)。对这几个记号不许答「一个都没有」——我们确实看见过它。
   *
   * 为什么这一项**按记号单列、不并进 `complete`**:它说的是一个**具体记号**的不确定,
   * 而 `complete` 说的是「有活着的进程整个判不了」(那种进程可以持有任何记号)。
   * 混成一个布尔的代价实测得到过:macOS 上进程表只给展示文本,一个进程 `exec` 换掉 argv、
   * 或者刚退成僵尸(`ps` 那一行变成 `(node)`、环境段整段消失)都会让它这一代的两次读数对不上
   * —— 于是**别人家记号的一次文本变化**会把这一遍整体判成「没问全」,所有在收尾的哨兵都答
   * 「证不出」、收不了档(`test-monitors.ts` ⑪ 实测:那条行应判 `lost`,却被接回成 `unknown`)。
   */
  unattributed: Set<string>;
  /** 这一遍的证据等级(见 `UnitProofGrade`)。 */
  grade: UnitProofGrade;
  /**
   * `false` = 至少有一个活着的进程**整个没能判定**:同 uid 的环境读不出来,或者这份环境是
   * 哪一代读到的证不出来。那种进程可以持有**任何**记号,所以「这个记号一个成员都没找到」
   * 这句话对谁都不成立,调用方只能答「证不出」(见 proc.ts 的 `processUnitEvidence`)。
   * 已经找到的那些不受影响:每一个都是实打实的读数。
   *
   * 「看见了某个记号但证不出代次」是**另一件事**,按记号记在 `unattributed` 里。
   */
  complete: boolean;
};

/**
 * **这台机器上记号这一问答得有多实** —— `null` = 整问不可用(win32 读不到别的进程的环境块)。
 *
 * 导出它是因为「能不能据此下刀」是**平台事实**,不是运行期偶然:日志、回归台子都要照它分档说话
 * (不然就只能把一条平台边界写成「这次恰好没证出来」)。
 */
export function monitorUnitProofGrade(): UnitProofGrade | null {
  if (IS_WINDOWS) return null;
  return existsSync("/proc/self/environ") ? "exact" : "ambiguous";
}

/**
 * 一遍扫描里的一个进程。
 * · `marks` 为 null = 它活着,但环境读不出来;
 * · `gen` 为 null = **这份环境是哪一代读到的证不出来**(代次问不出,或者读的前后换了代)
 *   ⇒ 这一行作不了凭证,而且这一遍不算问全。
 */
type PassRow = { pid: number; gen: ProcessGeneration | null; marks: string[] | null };

/** 进程表这一问的事实精度:同一瞬间问两遍没有意义,所以一次扫描在这个窗口里复用。 */
const UNIT_SCAN_TTL_MS = 400;
let unitScan: { at: number; scan: MonitorUnitScan | null } | null = null;

/**
 * **起了新进程就把上一次扫描作废。**
 *
 * 缓存只会朝一个方向出错,而那个方向是致命的:一次**比某项资源还老**的扫描里当然没有它的
 * 记号,于是「线索已追空」被当场判成立 ⇒ 收档、还一刀都不发(实测:正常停止那一档因此
 * 返回时进程还活着)。反方向(扫描比现实旧、还把已经退掉的算活着)只会多等一轮,安全。
 *
 * 唯一能产出「资源存在但扫描里没有」的动作就是起进程,所以作废点只有一个 ——
 * `spawnMonitor` 拿到 pid 之后。**下刀之前另说**:那一刻必须 `fresh` 重新取证(见下)。
 */
export function invalidateMonitorUnitScan(): void {
  unitScan = null;
}

/**
 * **现在活着的进程里带着记号的那些**:`记号 → pid[]`,外加这一问的证据等级。
 *
 * `null` = **这一问自己答不出来**(win32 读不到别的进程的环境块;POSIX 上 ps / `/proc` 失败)。
 * 它跟空 Map 是两件事:空 Map 只说明「带着这些记号的进程一个都没找到」,而**那也不等于整项
 * 资源退出已证明**(后代可以清掉环境、自己建组)。调用方必须把 `null` 当「证不出」——
 * 不许据此收档,也不许据此下刀(第 12/13 轮审查 F1)。
 *
 * **一次扫全表、所有记号一起带回来**:回收那一圈会对一批行各问一次,按行各扫一次就是 N 次
 * 全表 ps(本机一次约 90ms / 2.5MB)。结果在 `UNIT_SCAN_TTL_MS` 内复用,所以
 * `confirmTraceless` 那个 50ms 的轮询也只会落到几次真实扫描上。
 *
 * `fresh` = **这一次要用来发信号**:授权不许来自旧快照(第 13 轮审查 F1-C)。400ms 内一个成员
 * 可以退出、号可以被别人接手,而旧列表里它还在 —— 每一刀(含晚两秒那一刀、债务重收那一刀)
 * 都必须自己重新取证。
 */
export function liveMonitorUnitsSync(opts: { fresh?: boolean } = {}): MonitorUnitScan | null {
  const at = Date.now();
  if (!opts.fresh && unitScan && at - unitScan.at < UNIT_SCAN_TTL_MS) return unitScan.scan;
  const scan = scanMonitorUnits();
  unitScan = { at, scan };
  return scan;
}

/** 展示文本里**所有**出现过的 `记号=值`。全局匹配是刻意的:只取第一个就会被假记号遮住。 */
const UNIT_MARK = new RegExp(`(?:^|\\s)${MONITOR_UNIT_ENV}=(\\S+)`, "g");

/** 一行展示文本里看得见的记号(可能来自 argv、也可能来自别的变量的值 ⇒ `ambiguous`)。 */
function marksInText(text: string): string[] {
  const found: string[] = [];
  UNIT_MARK.lastIndex = 0;
  for (let hit = UNIT_MARK.exec(text); hit; hit = UNIT_MARK.exec(text)) found.push(hit[1]!);
  return found;
}

/**
 * **一次扫描读两遍,按「同一个号的同一代」归堆** —— 两件事各由一条规矩管:
 *
 * ── 为什么读两遍:「这一刻没有任何带记号的活进程」这句话要站得住 ──────────────────
 *
 * `ps`/`readdir` 都不是原子快照。一个带记号的成员可以在遍历还没走到它的槽位时派生一个另建组的
 * 后代(后代的槽位已经被走过了),然后自己退出 —— 两个都没进这一遍的名单。读第二遍把这种
 * 「刚好错过」的常见交错挡掉:记号只能从一个活着的带记号进程继承下来(唯一的凭空来源是
 * `spawnMonitor`,它起完就作废备忘),而一个在整遍遍历期间都活着的进程一定会被列出来。
 *
 * **但两遍不是不变量**(第 15 轮审查 F1 指出的):第一遍漏过的那个后代可以在第二遍里再派生
 * 下一代然后自己退出,最终的存活者不必从第二遍开始就存在。所以这个论证只是把窗口收窄,
 * **不作为发信号证据的时效保证** —— 时效由代次绑定管(见下、以及 process-generation.ts)。
 * 而「一个都没找到」这一档本来也只声称「线索追到这里为止」,不声称整项资源已经退出
 * (`traceless`,见 monitor-reclaim-evidence.ts),所以这里不再为它加一道阻塞。
 *
 * ── 为什么按「号 + 代次」归堆,而不是把裸 pid 取并集 ───────────────────────────────
 *
 * 上一版的并集只合并数字 pid:第一遍在这个号上读到记号、第二遍这个号已经是另一代了,并集
 * 照样留着它,于是下刀落到了接手这个号的陌生进程上(审查实测)。现在每一行自己带着
 * 「这份环境是哪一代读到的」,归堆的键是 `pid:gen`,所以:
 *
 *  · 两遍读到**同一代**的同一个记号 ⇒ 这是一个成员(带代次交出去,信号前再核一遍);
 *  · 第一遍有、第二遍这个号已换代 ⇒ 是**两堆**,旧那一堆的代次在发信号前核不过 ⇒ 不下刀;
 *  · **同一代**两遍读出的环境项不一致 ⇒ 这两次读数里至少有一次不是这一代的(或者它中途
 *    `exec` 换了环境:`exec` 不改 pid 也不改 starttime)。两种都证不出「这一项真在它环境里」,
 *    所以这个记号在这一代上一律不算凭证,而且这一遍不算问全(审查注入的就是这一种:同一代、
 *    一遍有一遍没有)。
 *
 * 代价是每次真实扫描两遍进程表(macOS 上 2×90ms,备忘让它在 400ms 内只发生一次)。
 */
function scanMonitorUnits(): MonitorUnitScan | null {
  // win32:读另一个进程的环境块要 ReadProcessMemory 那一套,没有零依赖等价物(`wmic`/
  // `Get-CimInstance` 只给命令行)。所以这一侧一律「问不出来」——
  // **不在 macOS 上替 Windows 编一个结论**(约定见根 AGENTS.md)。
  const grade = monitorUnitProofGrade();
  if (!grade) return null;
  const readPass = grade === "exact" ? passViaProc : passViaPs;
  const first = readPass();
  const second = readPass();
  if (!first || !second) return null;
  let complete = true;
  // 键是 `pid:gen` —— **同一个号的不同代是不同的堆**。
  const perGeneration = new Map<string, { pid: number; gen: ProcessGeneration; reads: string[][] }>();
  for (const row of [...first, ...second]) {
    // 环境读不出来(同 uid 还活着)、或者这份环境证不出是哪一代 ⇒ 这一遍没问全。
    if (row.marks === null || row.gen === null) { complete = false; continue; }
    const key = `${row.pid}:${row.gen}`;
    const seen = perGeneration.get(key);
    if (seen) seen.reads.push(row.marks);
    else perGeneration.set(key, { pid: row.pid, gen: row.gen, reads: [row.marks] });
  }
  const marks = new Map<string, ProcessMember[]>();
  const unattributed = new Set<string>();
  for (const { pid, gen, reads } of perGeneration.values()) {
    const union = new Set(reads.flat().filter(Boolean));
    for (const token of union) {
      // **同一代的几次读数必须一致**:有一次没读到这一项,这一项就不算这一代的凭证 ——
      // 但它仍然是「看见过」,所以按记号记下来,不许对它答「一个都没有」。
      if (!reads.every((read) => read.includes(token))) { unattributed.add(token); continue; }
      const list = marks.get(token);
      if (!list) marks.set(token, [{ pid, gen }]);
      else if (!list.some((m) => m.pid === pid && m.gen === gen)) list.push({ pid, gen });
    }
  }
  return { marks, unattributed, grade, complete };
}

/**
 * Linux:`/proc/<pid>/environ` 是 **NUL 分隔的真实环境项** —— 逐项取精确的键,所以这一问
 * 「有没有 `ASH_MONITOR_UNIT=X` 这一项」是精确可答的(`exact`)。
 *
 * **上一版在这里把 NUL 换成空格再跑那条正则,等于主动把唯一的真实边界丢掉**(第 14 轮审查
 * F1 指出的同类退化)。边界在手就必须用:按 `\0` 切项、`item.startsWith("KEY=")`,别的变量的
 * 值里写什么都到不了这里。重复键一起收(execve 允许重复,`getenv` 取第一个,我们宁可多收)。
 *
 * **读不到要分两种**(第 13 轮审查 F1-B):进程已经退了(ENOENT)可以跳过 —— 它不是活着的
 * 成员,也不可能在那之后再派生带记号的后代;而一个**同 uid 还活着**的进程读不出环境,就是
 * 「这一问没答全」,这一遍必须降级成「证不出」。别人 uid 的进程照旧跳过:哨兵的后代一定同
 * uid(命令自己 setuid 的那一档只会让我们更保守)。
 */
function passViaProc(): PassRow[] | null {
  let entries: string[];
  try { entries = readdirSync("/proc"); } catch { return null; }
  const self = typeof process.getuid === "function" ? process.getuid() : null;
  const rows: PassRow[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    // **把这一次环境读夹在两次代次读之间**(第 15 轮审查 F1):读到的这份环境是哪一代的,
    // 只有这一次读数自己答得出来。前后两次戳相等 ⇒ 这份环境就是这一代的;不相等(或者有
    // 一次问不出来)⇒ 这一行作不了凭证,而且这一遍不算问全 —— 事后再补问一次 `ps` 得到的是
    // 「现在这个号上是谁」,那正是上一版把别人那一代的身份写进归属证明的那条缝。
    const before = processGenerationSync(pid);
    let raw: string;
    try {
      raw = readFileSync(`/proc/${entry}/environ`, "utf8");
    } catch {
      let owner: number | null = null;
      try { owner = statSync(`/proc/${entry}`).uid; } catch { continue; }   // 已经退了 ⇒ 不是成员
      if (self !== null && owner !== self) continue;                        // 别人家的,管不着
      rows.push({ pid, gen: before, marks: null });                         // 自己的、还活着、读不出来
      continue;
    }
    const after = processGenerationSync(pid);
    const prefix = `${MONITOR_UNIT_ENV}=`;
    const marks = raw.split("\0").filter((item) => item.startsWith(prefix))
      .map((item) => item.slice(prefix.length));
    rows.push({ pid, gen: before && before === after ? before : null, marks });
  }
  return rows;
}

/**
 * macOS:`ps -E` 给的是**无边界的展示文本**(argv 和环境拼在一起,环境各项之间也只有空格),
 * 所以这一遍的证据等级只能是 `ambiguous`。
 *
 * 既然切不出真实环境项,就**不再假装切**:整行一起搜,argv 里的文字、别的变量值里的文字一律
 * 算「看见了」。这个方向是安全的 —— 真实环境项必然出现在文本里,所以**文本里没有 ⇒ 真的
 * 没有这一项**;看见了只说明「可能还有残留」,不签发任何下刀凭证(见 `MONITOR_UNIT_ENV`
 * 那段实测,以及 proc.ts 的 `suspected` 档)。
 *
 * 顺带甩掉了上一版那一堆只为「切开两段」而存在的毛病:两次快照之间的成员代次交错、退成僵尸
 * 的 argv(`(sleep)`)导致前缀对不上、为对不上的号单独重问一次 —— 都随着「不切」一起没了。
 */
function passViaPs(): PassRow[] | null {
  let out: string;
  try {
    // **maxBuffer 必须给够**:全表带环境在本机就是 2.5MB,默认 1MB 会让这一问变成「失败」。
    // `lstart` 跟展示文本**取在同一行**:代次和记号必须同源(第 15 轮审查 F1)。
    out = execFileSync("ps", ["-A", "-E", "-ww", "-o", "pid=", "-o", "lstart=", "-o", "command="], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
  const rows: PassRow[] = [];
  for (const line of out.split("\n")) {
    // `-o lstart=` 是定宽 24 字符的 C locale 文本(`Sat Oct 17 06:20:45 2026`),后面才是
    // 命令 + 环境那一大段展示文本。
    const m = /^\s*(\d+)\s(.{24})\s+(.*)$/.exec(line);
    if (!m) continue;
    const startedAt = m[2]!.trim();
    rows.push({
      pid: Number(m[1]),
      gen: startedAt ? `t:${startedAt}` : null,
      marks: marksInText(m[3]!),
    });
  }
  return rows;
}
