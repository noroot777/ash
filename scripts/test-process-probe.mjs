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
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { promisify } from "node:util";

const execute = promisify(execFile);
const windows = process.platform === "win32";

/** 进程表的时刻只精确到秒(ps 的 lstart、CIM 的 CreationDate),比较一律留这么多余量。 */
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

export const powerShell = (script) =>
  command("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")], { timeout: 20_000 });

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
 * 环境段里**确实有这么一个变量等于这个值**吗(`KEY=VALUE` 整段两侧都要收口)。
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
 * 一整段 + 空格」」这一种残留,那需要有人把本域的随机临时目录名专门拼进去。Linux 的
 * `/proc/<pid>/environ` 是 NUL 分隔、切得开,但 macOS 没有这条路(sysctl 要原生代码),
 * 为了两个平台只有一套判据、不留一条在本机验不了的分支,这一层统一按文本收口。
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
 * 相等。留一秒容差换来的不是鲁棒性,而是「第一次枚举之后、下一秒出生的复用实例」照旧算同
 * 一个,然后对它发 TERM/KILL。(两边的时刻来自**不同**尺子时容差才有意义,那是另一处:
 * `#impostor` 把秒级的 `born` 和毫秒级的 `started` 比,见那边。)
 */
export function instanceVerdict(recorded, observed) {
  if (!Number.isFinite(recorded) || !Number.isFinite(observed)) return "unverifiable";
  return recorded === observed ? "same" : "other";
}
