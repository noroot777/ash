// **记号扫描:现在活着的进程里,带着哪些「资源单位」记号。**
//
// 从 platform.ts 分出来的只有这一摊:读整张进程表、把 argv 和环境切开、按记号归堆,外加一份
// 短命备忘。那边留下的是「怎么问操作系统」的那些单问(存活、进程组、杀、端口)——两件事住在
// 一起会让 platform.ts 一直长,而这一摊的判据(切不开就不许猜、问不全就不许说「没有」)需要
// 自己的篇幅讲清楚。
//
// 判完之后「这算不算我们的、能不能下刀、够不够收档」在 monitor-reclaim-evidence.ts;
// 「这一问答出了什么」的三档投影在 proc.ts 的 `processUnitEvidence`。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { IS_WINDOWS } from "./platform.js";

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
 * **它必须在环境里被读到,不是在命令行里**(第 13 轮审查 F1-A 实测):`ps -E` 把 argv 和环境
 * 拼成一行,只做整行正则时,**参数里带着这段文字的陌生进程会被认成我们的后代并挨刀**(审查
 * 起的一个诊断进程,环境里只有 PATH,就因为参数里写了 `ASH_MONITOR_UNIT=<记号>` 被杀);反向
 * 也成立 —— argv 里先出现一段同名文字会遮住后面真正的环境记号,让自己的后代认不出来。所以
 * 这里**两次快照相减**切出环境段(见 `scanMonitorUnits`),argv 段里的文字一个字都不算证据。
 *
 * 它的边界也要如实说:命令自己把环境清掉(`env -i`)、或者后代自己 `setsid` 跑掉,记号与进程组
 * 就都问不到了 —— 那一刻只能落「证不出」,**不许当成整项退出已证明**(见 proc.ts、
 * monitor-reclaim-evidence.ts 的 `traceless`)。
 */
export const MONITOR_UNIT_ENV = "ASH_MONITOR_UNIT";

/** 一项资源此刻被证明着的成员,以及**这一遍问全了没有**。 */
export type MonitorUnitScan = {
  /** 记号 → 这一刻证明得出来的成员 pid。 */
  units: Map<string, number[]>;
  /**
   * `false` = 至少有一个活着的进程**没能判定**(同 uid 的环境读不出来、argv 与环境切不开)。
   * 那时「这个记号一个成员都没找到」这句话**不成立**,调用方只能答「证不出」(见
   * proc.ts 的 `processUnitEvidence`)。已经找到的那些不受影响:每一个都是实打实的证据。
   *
   * 为什么不像上一版那样整次作废(`return null`):实测一次全表扫描里几乎总有一两个号在两次
   * 快照之间退成僵尸(argv 那份只剩 `(sleep)`),整次作废等于**每次取证都变成「证不出」**——
   * 于是晚两秒那一刀永远发不出去,带记号的后代反而留了下来(本轮实测 ⑩-8 因此失败)。
   */
  complete: boolean;
};

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
 * **现在活着的进程里带着记号的那些**:`记号 → pid[]`。
 *
 * `null` = **这一问自己答不出来**(win32 读不到别的进程的环境块;POSIX 上 ps / `/proc` 失败;
 * 或者有一个同 uid 的活进程的环境读不出来)。它跟空 Map 是两件事:空 Map 只说明「带着这些
 * 记号的进程一个都没找到」,而**那也不等于整项资源退出已证明**(后代可以清掉环境、自己建组)。
 * 调用方必须把 `null` 当「证不出」—— 不许据此收档,也不许据此下刀(第 12/13 轮审查 F1)。
 *
 * **一次扫全表、所有记号一起带回来**:回收那一圈会对一批行各问一次,按行各扫一次就是 N 次
 * 全表 ps(本机一次约 90ms / 2.5MB)。结果在 `UNIT_SCAN_TTL_MS` 内复用,所以
 * `confirmReclaimed` 那个 50ms 的轮询也只会落到几次真实扫描上。
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

/** 环境段里取 `记号=值`:**只在环境段上跑**,所以 argv 里的同名文字到不了这里。 */
const UNIT_MARK = new RegExp(`(?:^|\\s)${MONITOR_UNIT_ENV}=(\\S+)`);

function scanMonitorUnits(): MonitorUnitScan | null {
  // win32:读另一个进程的环境块要 ReadProcessMemory 那一套,没有零依赖等价物(`wmic`/
  // `Get-CimInstance` 只给命令行)。所以这一侧一律「问不出来」——
  // **不在 macOS 上替 Windows 编一个结论**(约定见根 AGENTS.md)。
  if (IS_WINDOWS) return null;
  const units = new Map<string, number[]>();
  const add = (token: string, pid: number) => {
    if (!token || !Number.isInteger(pid) || pid <= 0) return;
    const list = units.get(token);
    if (list) list.push(pid);
    else units.set(token, [pid]);
  };
  if (existsSync("/proc/self/environ")) return scanViaProc(units, add);
  return scanViaPs(units, add);
}

/**
 * Linux:`/proc/<pid>/environ` 本身就只有环境,没有 argv 混进来的问题。
 *
 * **读不到要分两种**(第 13 轮审查 F1-B):进程已经退了(ENOENT)可以跳过 —— 它不是活着的
 * 成员;而一个**同 uid 还活着**的进程读不出环境,就是「这一问没答全」,整次扫描必须降级成
 * 「证不出」。上一版把两种都当跳过,于是遗漏的成员会被读成「不存在」。别人 uid 的进程照旧
 * 跳过:哨兵的后代一定同 uid(命令自己 setuid 的那一档只会让我们更保守)。
 */
function scanViaProc(
  units: Map<string, number[]>, add: (token: string, pid: number) => void,
): MonitorUnitScan | null {
  let entries: string[];
  try { entries = readdirSync("/proc"); } catch { return null; }
  const self = typeof process.getuid === "function" ? process.getuid() : null;
  let complete = true;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let raw: string;
    try {
      raw = readFileSync(`/proc/${entry}/environ`, "utf8");
    } catch {
      let owner: number | null = null;
      try { owner = statSync(`/proc/${entry}`).uid; } catch { continue; }   // 已经退了 ⇒ 不是成员
      if (self !== null && owner !== self) continue;                        // 别人家的,管不着
      complete = false;                       // 自己的、还活着、读不出来 ⇒ 这一遍没问全
      continue;
    }
    const hit = UNIT_MARK.exec(` ${raw.split("\0").join(" ")}`);
    if (hit) add(hit[1]!, Number(entry));
  }
  return { units, complete };
}

/**
 * macOS:`ps -E` 没有分隔符地把环境接在 argv 后面,所以**两次快照相减**才切得出环境段。
 *
 * 顺序是刻意的:先取带环境的那份,再取只有 argv 的那份。只在前者里出现的 pid = 两次之间退了
 * (不是活着的成员,跳过);只在后者里出现的 = 两次之间刚起来的,它要么是 `spawnMonitor` 起的
 * (那一侧会作废备忘),要么是某个成员派生的 —— 而那种情况下这个成员本来就在前一份里,
 * 结论不会变成空。
 *
 * argv 段**必须逐字对得上**才敢相减,绝不猜哪一段是环境。对不上时**只重问这一个号**
 * (`splitOne`)—— 最常见的原因是它在两次之间退成了僵尸(argv 那份只剩 `(sleep)`),重问一遍
 * 两边就都是那个壳子、环境段为空,结论干净地落在「不是成员」。重问之后还对不上(比如它真的
 * 在反复改写自己的 argv)才把这一个号记成「没判定」,整次扫描只降级 `complete`,不整次作废:
 * 整次作废会让每一次取证都变成「证不出」,于是该发的刀一刀都发不出去(本轮实测)。
 */
function scanViaPs(
  units: Map<string, number[]>, add: (token: string, pid: number) => void,
): MonitorUnitScan | null {
  const psOut = (args: string[]): string | null => {
    try {
      // **maxBuffer 必须给够**:全表带环境在本机就是 2.5MB,默认 1MB 会让这一问变成「失败」。
      return execFileSync("ps", args, {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, LC_ALL: "C", LANG: "C" },
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      return null;
    }
  };
  const withEnv = psOut(["-A", "-E", "-ww", "-o", "pid=", "-o", "command="]);
  const argvOnly = psOut(["-A", "-ww", "-o", "pid=", "-o", "command="]);
  if (withEnv === null || argvOnly === null) return null;
  const parse = (out: string): Map<number, string> => {
    const rows = new Map<number, string>();
    for (const line of out.split("\n")) {
      const m = /^\s*(\d+)\s(.*)$/.exec(line);
      if (m) rows.set(Number(m[1]), m[2]!);
    }
    return rows;
  };
  /** 只问一个号:两份都现取,所以它们之间的时差只有两次 `ps -p` 那么大。 */
  const splitOne = (pid: number): string | null | "unsplittable" => {
    const one = psOut(["-p", String(pid), "-E", "-ww", "-o", "command="])?.trim();
    const bare = psOut(["-p", String(pid), "-ww", "-o", "command="])?.trim();
    if (!one || !bare) return null;                 // 现在问不到它了 ⇒ 已经退了,不是成员
    return one.startsWith(bare) ? one.slice(bare.length) : "unsplittable";
  };
  const argv = parse(argvOnly);
  let complete = true;
  for (const [pid, text] of parse(withEnv)) {
    const bare = argv.get(pid);
    if (bare === undefined) continue;               // 第二次快照里已经没了 ⇒ 不是活着的成员
    let envSegment: string;
    if (text.startsWith(bare)) {
      envSegment = text.slice(bare.length);
    } else {
      const again = splitOne(pid);
      if (again === null) continue;                 // 已经退了
      if (again === "unsplittable") { complete = false; continue; }
      envSegment = again;
    }
    const hit = UNIT_MARK.exec(envSegment);
    if (hit) add(hit[1]!, pid);
  }
  return { units, complete };
}
