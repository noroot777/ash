// ── 观察这台机器:进程表、环境段、边界 inode 的持有者,以及「这还是当初那一个吗」 ────────
//
// 从 test-process-scope.mjs 拆出来(单文件 700 行的约定)。拆的是**两种问题**:
//   · 这边答「此刻系统里有些什么」—— 全表快照、谁持有那个 inode、某个号码上的实例还是不是
//     当初那一个。全是**观察**,一条所有权判据都不下。
//   · 那边答「其中哪些是本域创建的、它们是不是都停了」—— 所有权与清场的判据(见那边文件头)。
//
// 之所以值得单独一层:这些答案全是**外部命令的输出**(ps / lsof / CIM),它们的失败语义、
// 字段切分、时刻精度各有各的坑,而上面那层的推理全都压在它们身上。两件事混在一个文件里,
// 「这一步到底观察到了什么」和「据此认不认领」就会互相借力。
//
// 这一层的硬规矩:**查不动一律抛,绝不返回空集**。把一次查询失败说成「没有持有者 / 没有活
// 的」正是「测试显示成功、磁盘上还在写」那个事故形状的根子(见那边文件头 ②)。
import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { promisify } from "node:util";

const execute = promisify(execFile);
const windows = process.platform === "win32";
/**
 * Linux 有 `/proc`,于是进程表、环境段、出生时刻**都不必起外部进程**去问 —— 而且必须不问:
 * GNU ps 没有 macOS 那个 `-E`(第 5 轮审查 F3 在真 Linux 上实测:`unsupported SysV option`,
 * 整条探测连成功路径一起垮)。`existsSync` 这一下只在加载时做一次。
 */
const procfs = process.platform === "linux" && existsSync("/proc/self/stat");

/**
 * 两把**不同尺子**比较时留的余量:macOS 的 `ps lstart` 和 Windows 的 `CreationDate` 只精确到
 * 秒(Linux 走 `/proc`,到 10 ms),所以跟毫秒级的挂钟读数比的时候一律按最粗的那把留。
 * 同一把尺子的两次读数之间**没有余量**(见 `instanceVerdict`)。
 */
export const CLOCK_SLACK_MS = 1_000;

/** FILETIME:1601 年起算的 100 纳秒数。Windows 核对进程代次用的就是这把尺子。 */
export const fileTime = (milliseconds) => (BigInt(Math.floor(milliseconds)) + 11_644_473_600_000n) * 10_000n;
export async function command(file, args, options = {}) {
  const { timeout = 4_000, env } = options;
  return (await execute(file, args, {
    encoding: "utf8", timeout, killSignal: "SIGKILL", windowsHide: true,
    maxBuffer: 64 * 1024 * 1024, // -E 把环境块也打出来,默认 1 MB 的缓冲区装不下整张表
    env: env ? { ...process.env, ...env } : process.env,
  })).stdout;
}

/**
 * `/proc/<pid>/stat` 的那几列。进程名在第 2 列、裹在括号里、**可以带空格和括号**,所以从
 * **最后一个** `)` 之后切起;`fields[0]` 是第 3 列(state),于是第 N 列 = `fields[N - 3]`。
 *
 * 返回 `null` 只有一个含义:**这个号码此刻不在了**(ENOENT)。其余任何读不动的情形一律抛
 * (文件头:查不动绝不说成空集)。
 */
function procStat(pid) {
  let text;
  try { text = readFileSync(`/proc/${pid}/stat`, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return null;
    throw error;
  }
  const close = text.lastIndexOf(")");
  if (close < 0) throw new Error(`/proc/${pid}/stat 读不懂: ${text.slice(0, 120)}`);
  const fields = text.slice(close + 1).trim().split(/\s+/);
  const row = { state: fields[0] ?? "", ppid: Number(fields[1]), group: Number(fields[2]), ticks: Number(fields[19]) };
  if (!row.state || !Number.isFinite(row.ppid) || !Number.isFinite(row.group) || !Number.isFinite(row.ticks)) {
    throw new Error(`/proc/${pid}/stat 的字段切不出来: ${text.slice(0, 120)}`);
  }
  return row;
}

/** USER_HZ 的候选值。两两之间至少差 2.5 倍 —— 下面那个 ±25% 的窗口里最多落得下一个。 */
const TICK_CANDIDATES = [100, 250, 300, 1_000, 1_024];
let procClockCache = null;

/**
 * `/proc` 的时刻尺子。`starttime`(第 22 列)是**开机起算的 tick 数**,换成挂钟要两样东西:
 * 一拍多少秒(USER_HZ),以及零点在哪。
 *
 * **USER_HZ 从 Node 里问不到**(没有 `sysconf`),所以不假设它是 100:拿**本进程**当标尺 ——
 * `/proc/uptime` 给出开机至今的秒数(两位小数),`process.uptime()` 给出本进程跑了多久,
 * 两者一减就是「本进程出生距开机」的秒数,再除 `/proc/self/stat` 的 tick 数就把刻度解出来了。
 * 两个读数都不经挂钟,所以调过钟、btime 漂移都影响不到它。**解不出来就抛**(查不动一律抛):
 * 刻度猜错的后果是每一行的出生时刻都算错,于是 `instanceVerdict` 把域内进程全判成 `"other"`
 * —— 什么都不认领、什么都不报,正是这一层最不许犯的那个错。
 *
 * 零点取「本进程那一刻」反推而不取 `/proc/stat` 的 `btime`:btime 只到秒,会给每一行带上
 * 最多一秒的系统性偏差,而 `#impostor` 那条「出生时刻必须落在本域创建之后」的判据正好吃这个偏差。
 */
export function procClock() {
  if (procClockCache) return procClockCache;
  const self = procStat(process.pid);
  if (!self) throw new Error("/proc/self/stat 读不出本进程 —— /proc 的时刻尺子定不下来");
  const uptime = Number(readFileSync("/proc/uptime", "utf8").trim().split(/\s+/)[0]);
  const own = process.uptime();
  const bornAt = Date.now() - own * 1_000;
  const elapsed = uptime - own; // 本进程出生距开机的秒数
  const estimate = elapsed > 0 ? self.ticks / elapsed : NaN;
  const hz = TICK_CANDIDATES.find((candidate) => Math.abs(estimate / candidate - 1) <= 0.25);
  if (!hz) {
    throw new Error(`/proc 的 tick 刻度解不出来(${self.ticks} ticks / ${elapsed.toFixed(3)}s ≈ ${Number.isFinite(estimate) ? estimate.toFixed(1) : "NaN"} Hz)`);
  }
  procClockCache = { hz, epoch: bornAt - (self.ticks * 1_000) / hz };
  return procClockCache;
}

const procBirth = (ticks) => {
  const { hz, epoch } = procClock();
  return epoch + (ticks * 1_000) / hz;
};

/**
 * `/proc/<pid>/environ` 里**确实有这么一个变量等于这个值**吗。这一段是 **NUL 分隔**的,
 * 一个变量切得干干净净,判据就是严格相等 —— `environmentHasMarker` 那条「另一个变量的值里
 * 原样嵌着我们这一整段」的残留,在这条路上压根不成立。
 *
 * 读不着(EACCES:不是本用户的进程;ENOENT:刚退了)⇒ `false`。这不是把「查不动」当答案:
 * 环境这条线索的作用是**补覆盖面**(父子链和边界 fd 都断了的那种形态),而域内进程必与本进程
 * 同一个用户,所以读不着的那些本来就不可能是本域创建的。
 */
function procEnvironHas(pid, marker) {
  let text;
  try { text = readFileSync(`/proc/${pid}/environ`, "utf8"); }
  catch { return false; }
  return text.split("\0").includes(marker);
}

/**
 * **某个号码此刻的出生时刻**(ms),和 `processRows` 用的是同一把尺子 —— 这一点是硬要求:
 * 两把尺子一比,`instanceVerdict` 会把每一行都判成 `"other"`,于是什么都不杀、什么都不报。
 *   · Linux:`/proc/<pid>/stat` 的 starttime,刻度与零点见 `procClock`;
 *   · macOS:`ps -p <pid> -o lstart=`,与 `processRows` 读的是同一列(秒精度)。
 * `"gone"` = 查到了「它不在了」;**读不懂、查不动一律抛**(文件头)。
 *
 * **同步**,两个原因:① 调用方是「核完立刻发信号」那一步,中间多一次 await 就多一截窗口
 * (见 test-process-scope.mjs 的 `signalInstance`);② 退出钩子里的清理只能同步。
 */
export function birthOf(pid) {
  if (windows) throw new Error("Windows 不走出生时刻这条路:代次核对在句柄那头(windowsTerminateScript)");
  if (procfs) {
    const stat = procStat(pid);
    return stat ? procBirth(stat.ticks) : "gone";
  }
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
    encoding: "utf8", timeout: 4_000, killSignal: "SIGKILL", env: { ...process.env, LC_ALL: "C" },
  });
  if (result.error) throw result.error;
  // 号码不存在时 ps 退 1、什么都不吐 —— 那是「它不在了」这个**答案**。其余非零退出算答不出来。
  const text = (result.stdout ?? "").trim();
  if (result.status !== 0) {
    if (result.status === 1 && !text && !(result.stderr ?? "").trim()) return "gone";
    throw new Error(`ps -p ${pid} 退出码 ${result.status}: ${(result.stderr ?? "").trim()}`);
  }
  if (!text) return "gone";
  const born = Date.parse(text);
  if (!Number.isFinite(born)) throw new Error(`ps -p ${pid} 的 lstart 读不懂: ${text}`);
  return born;
}

/**
 * 还有谁持有那个边界 inode —— 返回 pid 的 Set。`identity` 是 `{ dev, ino }`,`excluded` 是
 * 不算在内的号码(本进程、以及本域的创建者:它一直握着 fd 用来钉住这个 inode)。
 *
 * **按 (dev, ino) 认,不按路径认**(第 2 轮审查第 4 条):那个 inode 已经 unlink 了,压根没有
 * 路径可以 open —— 这正是「继承了受监管资源」和「碰巧打开同一个文件」分得开的地方。两个平台
 * 都顺带要求 `nlink === 0`(未链接):一个还有名字的 inode 不可能是我们这个。
 *
 * **查不动一律抛**,绝不返回空集:这一层最要紧的不变量是「扫不到 ≠ 停了」,把一次查询失败
 * 说成「没有持有者」正是那个事故形状的根子。调用方经 `survey()` 把它走成失败路径。
 */
export async function boundaryHolders(identity, excluded) {
  const holders = new Set();
  // Linux 不必起外部进程:/proc 直接读得到每个 pid 开着哪些 fd。stat 那个 fd 入口会跟到真正的
  // 文件上(readlink 只会给出 "…/boundary (deleted)" 这种文本,unlink 之后不能再拿它比对)。
  if (existsSync("/proc/self/fd")) {
    for (const name of readdirSync("/proc")) {
      const pid = Number(name);
      if (!Number.isInteger(pid) || excluded.has(pid)) continue;
      let entries;
      try { entries = readdirSync(`/proc/${pid}/fd`); } catch { continue; } // 进程没了 / 不是我们的
      for (const entry of entries) {
        try {
          const stats = statSync(`/proc/${pid}/fd/${entry}`);
          if (stats.dev === identity.dev && stats.ino === identity.ino && stats.nlink === 0) {
            holders.add(pid);
            break;
          }
        } catch { /* fd 刚好关了 */ }
      }
    }
    return holders;
  }
  // macOS:`+L1` 只列「链接数 < 1」的打开文件,也就是未链接的那些 —— 本域这个 inode 必在其中,
  // 而全系统的具名文件一条都不进来。`-F pfDi` 的输出是逐行的字段:`p` 换 pid、`D` 设备号(十六
  // 进制)、`i` inode 号。
  let output;
  try { output = await command("lsof", ["+L1", "-F", "pfDi"], { timeout: 10_000 }); }
  catch (error) {
    // 全系统一个未链接的打开文件都没有时,lsof 退 1 且不吐东西 —— 那是「没有持有者」这个
    // **答案**,不是查询失败。其余任何情况(找不到 lsof、超时、有 stderr)都算答不出来,往上抛。
    if (error.code === 1 && !error.stdout?.trim() && !error.stderr?.trim()) return holders;
    throw error;
  }
  let pid = null;
  let device = null;
  for (const line of output.split("\n")) {
    const value = line.slice(1).trim();
    if (line.startsWith("p")) { pid = Number(value); device = null; continue; }
    if (line.startsWith("D")) { device = Number(value); continue; } // 0x… 形式,Number 认得
    if (!line.startsWith("i") || pid === null || excluded.has(pid)) continue;
    if (device === identity.dev && Number(value) === identity.ino) holders.add(pid);
  }
  return holders;
}

const powerShellArgs = (script) => ["-NoProfile", "-NonInteractive", "-EncodedCommand",
  Buffer.from(script, "utf16le").toString("base64")];

export const powerShell = (script) =>
  command("powershell.exe", powerShellArgs(script), { timeout: 20_000 });

/**
 * 同步版。只给「核完立刻终止」那一步用(见 `birthOf` 为什么同步),以及退出钩子里的清理 ——
 * 那两处都不许有 await。
 */
export function powerShellSync(script) {
  const result = spawnSync("powershell.exe", powerShellArgs(script), {
    encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL", windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`powershell 退出码 ${result.status}: ${(result.stderr ?? "").trim()}`);
  return result.stdout ?? "";
}

/**
 * 全表快照。每行 `{ pid, ppid, group, born, created, scoped }`:
 *  · `born` 是出生时刻(ms),实例身份的依据;
 *  · `created` 只有 Windows 有 —— 原始 FILETIME,句柄终止要拿它核对代次;
 *  · `scoped` 是「环境里带着某个执行域」的标记,POSIX 专有(见文件头)。
 */
export async function processRows(scopeDirectory) {
  if (windows) {
    const script = `$ErrorActionPreference='Stop'; $rows=@(Get-CimInstance Win32_Process | Where-Object { $_.CreationDate } | ForEach-Object {
      @{ pid=$_.ProcessId; ppid=$_.ParentProcessId; born=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(); created=$_.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString() }
    }); [Console]::Out.WriteLine((ConvertTo-Json -InputObject $rows -Compress))`;
    const parsed = JSON.parse(await powerShell(script));
    return (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({ ...row, group: null, scoped: false }));
  }
  // ── Linux:自己读 /proc ──────────────────────────────────────────────────────
  // 不起外部进程,也**不能**起:GNU ps 不认 `-E`(文件头 `procfs`),下面那两张快照一减的
  // 办法在这里压根走不通。而 `/proc` 这条路还更准 —— `/proc/<pid>/environ` 是 NUL 分隔的,
  // 一个变量切得出来,不必像 macOS 那样只能按空格两侧收口(见 `environmentHasMarker` 的残留)。
  if (procfs) {
    const scopeMarker = scopeDirectory ? `ASH_TEST_PROCESS_SCOPE=${scopeDirectory}` : null;
    const rows = [];
    for (const name of readdirSync("/proc")) {
      const pid = Number(name);
      if (!Number.isInteger(pid)) continue; // cpuinfo / self / net / …
      const stat = procStat(pid);
      if (!stat) continue; // 枚举到它和读它之间它退了
      if (stat.state.startsWith("Z")) continue; // 僵尸:已经死了,只是还没被收尸
      rows.push({
        pid, ppid: stat.ppid, group: stat.group, created: null, born: procBirth(stat.ticks),
        scoped: scopeMarker !== null && procEnvironHas(pid, scopeMarker),
      });
    }
    // **本进程必在表里**。一行都没有、或者没有自己,那是 /proc 没读动(挂载不在、hidepid
    // 挡住),不是「系统里没有进程」—— 这种时候要抛,绝不能让它一路走到「都停了」。
    if (!rows.some((row) => row.pid === process.pid)) {
      throw new Error("/proc 枚举里没有本进程 —— 进程表没读动(查不动不算空集)");
    }
    return rows;
  }
  // ── macOS:两张 ps 快照 ─────────────────────────────────────────────────────
  // `LC_ALL=C` 把 lstart 钉成固定的英文格式,否则中文 locale 下是「四 10月/22 ...」,
  // Date.parse 认不出来,整条实例身份就垮了。
  //
  // **两张快照,一张带 `-E` 一张不带**(第 4 轮审查 F1)。`-E` 把环境块接在命令行后面,中间
  // 没有任何分隔符 —— 于是上一版那句 `line.includes(标记)` 根本分不清标记是在**环境里**还是
  // 只是人家 argv 里的一个普通参数,一个外部进程就这么被认领、被终止(探针实测)。而
  // `ps -E` 的那一行等于 `ps` 的那一行再接环境块(实测前缀关系成立),所以减一下就把环境段
  // 切出来了:判据只看那一段。
  const columns = "pid=,ppid=,pgid=,stat=,lstart=,command=";
  const snapshot = async (extra) =>
    command("ps", ["-ww", ...extra, "-axo", columns], { env: { LC_ALL: "C" }, timeout: 10_000 });
  const [plain, withEnvironment] = await Promise.all([snapshot([]), snapshot(["-E"])]);
  const marker = scopeDirectory ? `ASH_TEST_PROCESS_SCOPE=${scopeDirectory}` : null;
  /** pid → 这一行去掉前面那几列之后的「命令行(+环境块)」。 */
  const tails = (text) => {
    const out = new Map();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      // 前五列固定:pid ppid pgid stat + lstart 的五段(Thu Oct 22 09:25:56 2026)。
      out.set(Number(parts[0]), { parts, tail: parts.slice(9).join(" ") });
    }
    return out;
  };
  const argvOnly = tails(plain);
  const rows = [];
  for (const [pid, { parts, tail }] of tails(withEnvironment)) {
    const [, ppid, group, state] = parts;
    if (state?.startsWith("Z")) continue; // 僵尸:已经死了,只是还没被收尸
    const born = Date.parse(parts.slice(4, 9).join(" "));
    // 环境段 = 带 `-E` 那一行减掉不带 `-E` 那一行。切不出来(两次快照之间 argv 变了、或者
    // 有一张里没有这个 pid)就**算读不出来**,不算「没有标记」—— 这条线索答不了的时候还有
    // 边界 fd 和父子链,不必在这儿猜。
    const argv = argvOnly.get(pid)?.tail;
    const environment = argv !== undefined && tail.startsWith(argv) ? tail.slice(argv.length) : null;
    rows.push({
      pid, ppid: Number(ppid), group: Number(group), created: null,
      born: Number.isFinite(born) ? born : null,
      scoped: marker !== null && environmentHasMarker(environment, marker),
    });
  }
  return rows;
}


/**
 * 环境段里**确实有这么一个变量等于这个值**吗(`KEY=VALUE` 整段两侧都要收口)。**macOS 专用**
 * —— Linux 走 `procEnvironHas`,那边是 NUL 分隔、严格相等,没有下面这条残留。
 *
 * 第 1 轮审查 F4 实测形状:上一版是裸 `segment.includes(marker)`,于是另一个执行域
 * `/tmp/check-ABC-other` 的真实环境 `ASH_TEST_PROCESS_SCOPE=/tmp/check-ABC-other` 把
 * `/tmp/check-ABC` 那一域的标记整段包住 —— 它被当成域内进程认领,`stop()` 随后对一个**别人
 * 家正在用的执行域**发终止信号。前缀关系在临时目录名里不是巧合:同一套测试并行跑、名字按
 * 用途加后缀,天然就会出现。
 *
 * 判据改成「两侧都是空格(或段首/段尾)」。`ps -E` 把环境块按空格拼成一行,而**变量值本身可以
 * 带空格**,所以这串文本在一般情况下切不出严格的 token —— 能做到的上界就是这个两侧收口:
 * 前缀/后缀碰撞(上面那一种)从此不成立,只剩「另一个变量的**值里**原样嵌着「空格 + 我们这
 * 一整段 + 空格」」这一种残留,那需要有人把本域的随机临时目录名专门拼进去。这条残留**只在
 * macOS 上**:那边拿不到逐变量的环境(`sysctl` 要原生代码),而 Linux 现在读的是
 * `/proc/<pid>/environ`,NUL 分隔、按整段严格相等(第 5 轮审查 F3 之后两个平台各走各的实现,
 * 不再为了「只有一套判据」把精确的那条路也降成文本匹配)。
 *
 * **这条线索证明的是「继承」,不是「创建」**(见那边文件头):能设环境变量的程序都能写出这串
 * 文本,所以它不是伪造不了的证据 —— 伪造不了的只有边界 inode。留着它的理由是覆盖面:默认
 * 的 `subprocess.Popen(close_fds=True)` 关掉继承的 fd、又换了会话,环境是这种形态下**唯一**
 * 还认得出它的线索,而那恰恰是最常见的真实泄漏形状。
 */
export function environmentHasMarker(segment, marker) {
  if (!segment || !marker) return false;
  for (let at = segment.indexOf(marker); at >= 0; at = segment.indexOf(marker, at + 1)) {
    const before = at === 0 ? " " : segment[at - 1];
    const after = at + marker.length >= segment.length ? " " : segment[at + marker.length];
    if (before === " " && after === " ") return true;
  }
  return false;
}

/**
 * **同一个号码上现在那一个,还是当初登记的那一个吗。** 三个答案不许合并(第 1 轮审查 F5):
 *
 *   · `"same"` —— 出生时刻**一模一样**。号码会被复用,所以这是唯一能动手的那一档;
 *   · `"other"` —— 出生时刻不同:号码换了主人,它本来就不是我们的,绝不碰;
 *   · `"unverifiable"` —— 有一侧读不出来(当初没解析出 lstart、或这一次读到的不是个时刻)。
 *     **按「不许动手」处理,并且要报出来** —— 把「我没核出来」算成「它已经没了」正是那个
 *     事故形状。
 *
 * 为什么**不留时间容差**(上一版是 `Math.abs(…) <= 1000`):同一个进程的两次 `ps lstart` 读数
 * 没有「早一秒/晚一秒的测量误差」—— 两次读的都是内核里同一个值、同样截到秒,相等就该是严格
 * 相等(Linux 两次读的是 `/proc` 的同一个 tick 数,换算也走同一把 `procClock`,同样严格相等)。
 *
 * **残留,如实记下来**:这把尺子的分辨率限着它能分开什么。macOS 的 `lstart` 只到**秒** ——
 * 同一秒里先后出生的两个实例读数一模一样,这一档这一层分不出来(号码要在同一秒内被回收并发给
 * 另一个进程才撞得上)。Linux 走 `/proc` 的 tick,是 10 ms,窄两个数量级;Windows 走句柄 +
 * GetProcessTimes,压根不用这把尺子。想在 macOS 上收窄只有原生接口(`proc_pidinfo` 的
 * `pbi_start_tvusec`)那一条路,普通 Node 进程够不着。留一秒容差换来的不是鲁棒性,而是「第一次枚举之后、下一秒出生的复用实例」照旧算同
 * 一个,然后对它发 TERM/KILL。(两边的时刻来自**不同**尺子时容差才有意义,那是另一处:
 * `#impostor` 把秒级的 `born` 和毫秒级的 `started` 比,见那边。)
 */
export function instanceVerdict(recorded, observed) {
  if (!Number.isFinite(recorded) || !Number.isFinite(observed)) return "unverifiable";
  return recorded === observed ? "same" : "other";
}
