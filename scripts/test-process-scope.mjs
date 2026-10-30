// ── 测试执行域:一次 runTestProcess 创建的全部进程,以及「它们真的都停了」这个证明 ──────
//
// 这一层只回答两个问题,两个都不许靠猜:
//   ① **谁是我们创建的**(所有权)。
//   ② **它们是不是都停了**(退出证明)。扫不到 ≠ 停了 —— 把一次空扫描当成清场,正是
//      「测试显示成功、磁盘上还在写」那个形状的根子。
//
// ## 所有权:只认**来源可证明**的那几条线索
//
//   · **登记**(preload 写 `<pid>.*.json`):只覆盖 Node 进程。非 Node 程序自己 fork 出来
//     的后代不执行 preload,登记里没有它。
//   · **父子链**:后代 setsid + 原父退出之后在 POSIX 上被挂到 1 号进程,链断了。
//     (Windows 没有这套语义:ppid 字段在父进程死后仍然保留,链还在。)
//   · **进程组**:setsid 会换组,同样断;而且组号会被复用,所以**只在组长本身证明得出是我们的**
//     时候才认(见 `active`)。
//   · **边界描述符**(POSIX):每个 spawn 出来的进程都继承一个指向本域边界 inode 的 fd。
//     那个 inode **一建出来就 unlink 掉**,于是它在文件系统里没有名字 —— 想持有它只有一条路:
//     从本域继承(或者由本域经 unix socket 递过去,而这一层不做这件事)。判据是内核里的
//     (设备号, inode 号) 这对事实,不是文本,所以既伪造不了,也不随 exec / setsid / 重新挂父而丢。
//
//     **为什么非得 unlink**(第 2 轮审查第 4 条):上一版那个 boundary 是个普通的具名文件,
//     于是「谁打开着同一个路径」被当成了来源证明 —— 同用户的域外程序(看一眼这次检查的临时
//     文件的诊断工具就够了)自己 open 一下就会被 `owned.add` 收养,随后被 `stop()` 终止。
//     「继承了受监管资源」和「碰巧打开同一个文件」是两件事,而没有名字的 inode 只剩前一种。
//
// 上一版的第四条线索是**环境变量继承**(`ASH_TEST_PROCESS_SCOPE`),两处都塌了(第 4 轮审查
// F1/F2,都有实测):
//   · **它伪造得了**:判据是 `ps -E` 那一整行 `includes(标记)`,而那一行是「命令行 + 环境块」
//     拼起来的 —— 随便一个把这段文字当**普通 argv 参数**传进去的外部进程都会被认领,然后被
//     `stop()` 终止(探针实测:`adopted:true`、`outsiderAliveAfterScopeStop:false`)。
//   · **它丢得了,而且恰恰在它本来要覆盖的那一种上丢**:原生后代走 `execve(…, {})`,环境被
//     整个清空。实测那个 fork+setsid 的后代环境段里**一个标记都没有** —— 补这条线索当年声称
//     覆盖的就是这一种,实际上一次都没覆盖到。
// 所以这一版:环境这条线索留着,但判据改成「标记出现在**环境段**里」(`ps -E` 的输出等于
// `ps` 的输出再接环境块,实测前缀关系成立,于是两次快照一减就把环境段切出来了);而「不随
// exec 丢」这件事交给边界描述符。
//
// ## 支持形态,以及这一层到底证明了什么
//
// **先把话说准**:成功返回时这一层证明的是
//
//   「本域创建的进程里,**可观测**的那些都已经退出 —— 可观测 = 登记 / 父子链 / 进程组 /
//    环境段 / 边界 inode 这五条线索里还命中任意一条」,
//
// 不是「这一次绝对没有任何后代活着」。差别在于:一个后代可以**主动**把五条线索一条一条丢掉
// (关掉边界 fd、`execve(…, {})` 清环境、setsid 脱组、原父退出断链)。四条做完它就不在任何
// 一次枚举里了,而从普通 Node 进程能用的 POSIX 接口里**没有一个内核级的容器**(subreaper /
// cgroup / pidns / job object 都够不着),所以这种形态下「它不存在」这件事**谁也证明不出来**
// —— 既然证明不出来,就不许写成「清场成功」这四个字(第 2 轮审查第 1 条)。
//
// 于是这一层的规矩是:**限制支持形态 + 该失败的地方明确失败**。
//
//   · **不支持**主动丢弃监管资源的 daemon 形态(fork → setsid → 清环境 → 关掉继承的 fd)。
//     这不是「不许这么写测试」,而是「这么写的话本层答的只能是证明不了」。
//   · 查不动(ps/CIM/lsof/proc 任一条答不出来)⇒ `survey()` 走 `ok:false` 失败路径,
//     绝不退化成「没有活的」。**扫不到不算停了**这条不变量没有例外。
//   · **丢边界这件事只要落在我们看得见的地方,就当场失败**:我们自己 spawn 的那一层,fd 是
//     本层亲手交到它手里的 —— 它还活着却不再持有,就是它自己关掉了,它的后代本层从此监管不到。
//     这时 `survey()` 同样走失败路径并点名那几个号码,而不是接着往「都停了」上走
//     (见 `#escapees`)。孙子辈再往下关掉的那一种落在上面那条「不支持」里,只能靠形态约束。
//
// ## 实例身份:pid 不是身份,(pid, 出生时刻) 才是
//
// 号码会被复用。所以每一行快照都带 `born`,登记也带时刻:号码对上但出生时刻对不上的,
// 是**另一个进程**,既不认它是我们的,更不会去杀它。终止前还要再核一次(POSIX 用
// `ps -p` 重查,Windows 走句柄 + GetProcessTimes,见 stop)。
import { spawn, spawnSync, execFile } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { windowsTerminateScript } from "./windows-restart.mjs";

const execute = promisify(execFile);
const windows = process.platform === "win32";
const registerPath = fileURLToPath(new URL("test-process-register.cjs", import.meta.url));
const cleanupPath = fileURLToPath(new URL("test-process-cleanup.mjs", import.meta.url));
const scopes = new Set();
export const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

/** 进程表的时刻只精确到秒(ps 的 lstart、CIM 的 CreationDate),比较一律留这么多余量。 */
const CLOCK_SLACK_MS = 1_000;

/** FILETIME:1601 年起算的 100 纳秒数。Windows 核对进程代次用的就是这把尺子。 */
const fileTime = (milliseconds) => (BigInt(Math.floor(milliseconds)) + 11_644_473_600_000n) * 10_000n;

/**
 * 边界 inode 的三个文件名。
 *  · `BOUNDARY` —— 建它的时候短暂用一下这个名字,`open` 完立刻 unlink,之后这个名字就不存在了
 *    (见文件头:有名字 = 域外程序自己 open 一下就能被收养);
 *  · `BOUNDARY_ID` —— 那个 inode 的身份 (dev, ino)。清理助手是**另一个进程**、而 inode 已经
 *    没有名字可打开,所以它只能靠这份身份去认持有者;
 *  · `CREATOR` —— 创建者自己的号码。它一直握着那个 fd(不握就没人钉住这个 inode,号码一被
 *    回收,别人家的未链接 inode 就可能撞上同一个号),所以它必然出现在持有者里 —— 清理助手
 *    得认得出「这是创建者,不是后代」,否则会把它当域内进程一刀 SIGTERM 掉(本轮实测过这条:
 *    `test:restart` 整套 rc=143)。
 */
/**
 * 登记文件名的形状:`<被登记 pid>.<发布者 pid>.json`(协议见 `publishRecord` 与
 * test-process-register.cjs)。执行域目录里还有别的东西,所以读登记只认这个形状。
 */
const REGISTRATION = /^\d+\.\d+\.json$/;

const BOUNDARY = "boundary";
const BOUNDARY_ID = "boundary.id";
const CREATOR = "creator.id";

async function command(file, args, options = {}) {
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
async function boundaryHolders(identity, excluded) {
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

const powerShell = (script) =>
  command("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")], { timeout: 20_000 });

/**
 * 全表快照。每行 `{ pid, ppid, group, born, created, scoped }`:
 *  · `born` 是出生时刻(ms),实例身份的依据;
 *  · `created` 只有 Windows 有 —— 原始 FILETIME,句柄终止要拿它核对代次;
 *  · `scoped` 是「环境里带着某个执行域」的标记,POSIX 专有(见文件头)。
 */
async function processRows(scopeDirectory) {
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
      scoped: !!marker && environment !== null && environment.includes(marker),
    });
  }
  return rows;
}

/**
 * 发布一条登记。**每个发布者写自己的文件名**,两个发布者永远不会抢同一个目标 ——
 * 父进程的占位登记和子进程 preload 里的自登记原先都发布成 `<pid>.json`(一个用 link、
 * 一个用 rename),Windows 上替换一个别人刚建好/正被读取的文件会 EPERM,而那一下发生在
 * 用户代码跑起来之前,于是整套测试在启动阶段就中止(真机实测)。
 *
 * 名字里带发布者 pid 之后冲突从协议上消失;写临时文件再 rename 仍然保留,是为了让读取侧
 * 永远看不到半截 JSON。rename 的目标此刻必定不存在(或者就是本发布者自己上一次写的),
 * 所以 Windows 那条「替换别人的文件」的失败路径不再成立。
 */
export function publishRecord(directory, subjectPid, payload) {
  const target = join(directory, `${subjectPid}.${process.pid}.json`);
  const temporary = `${target}.pending`;
  writeFileSync(temporary, JSON.stringify(payload));
  try { renameSync(temporary, target); }
  finally { try { rmSync(temporary, { force: true }); } catch { /* rename 成功后它本来就没了 */ } }
}

export class TestProcessScope {
  constructor(directory) {
    // 自己建的目录,构造失败时要自己收走:调用方这时还没拿到 scope,它的 finally 够不着
    // 这个目录(实测:started 写失败会同时留下输出目录和执行域目录两个)。
    // **别人传进来的目录不碰** —— 清理助手就是拿已有目录重建 scope 的,把它删了等于把
    // 还没清场的那一域的登记一起抹掉。
    const mine = directory === undefined;
    this.directory = directory ?? mkdtempSync(join(tmpdir(), "ash-test-scope-"));
    try {
      this.started = Number(readFileSyncSafe(join(this.directory, "started"))) || Date.now();
      writeFileSync(join(this.directory, "started"), String(this.started));
    } catch (error) {
      if (mine) rmSync(this.directory, { recursive: true, force: true });
      throw error;
    }
    this.children = [];
    /** 终止时**没能核对实例身份**的那些号码 —— 宁可报出来,也不照着旧号码乱杀(F2)。 */
    this.unverified = [];
    // 边界 inode(见文件头)。POSIX 专有:Windows 那边 ppid 在父进程死后仍然保留,父子链本身
    // 就是完整的,不需要这一条;那边也没有「谁持有这个 inode」的查法。
    /** 创建者手里那个 fd:**它钉住这个 inode**,号码不会被回收,所以身份不会被别人撞上。 */
    this.boundary = null;
    /** `{ dev, ino }` —— 认持有者就靠这对号码(那个 inode 已经没有名字了)。 */
    this.boundaryId = null;
    /** 哪个进程是创建者(它必然持有边界,得认得出来,不能当成后代去杀)。 */
    this.creator = process.pid;
    if (!windows) {
      try { this.#prepareBoundary(); }
      catch (error) {
        if (mine) rmSync(this.directory, { recursive: true, force: true });
        throw error;
      }
    }
    scopes.add(this);
  }

  /**
   * 准备边界 inode。两种入口:
   *  · **新建域** —— 建出来、open、**立刻 unlink**。从这一刻起它在文件系统里没有名字,想持有
   *    只能从本域继承(第 2 轮审查第 4 条:具名文件会被「碰巧打开它的域外程序」冒领)。身份
   *    (dev, ino) 和创建者号码各写一份,给另一个进程用。
   *  · **清理助手拿已有目录重建** —— 那个 inode 早就没名字了,它只能读那份身份;而创建者此刻
   *    还活着并握着 fd(助手是从它的 exit 钩子里 spawnSync 出来的),所以 inode 不会被回收、
   *    号码也不会被别的未链接 inode 撞上。
   *
   * 读到的身份坏了(JSON 残缺)就**抛**:这一层宁可明确失败,也不要悄悄少一条线索(文件头)。
   */
  #prepareBoundary() {
    const idPath = join(this.directory, BOUNDARY_ID);
    const existing = readFileSyncSafe(idPath);
    if (existing) {
      const { dev, ino } = JSON.parse(existing);
      this.boundaryId = { dev, ino };
      const creator = readFileSyncSafe(join(this.directory, CREATOR));
      if (creator) this.creator = JSON.parse(creator).pid;
      return;
    }
    const path = join(this.directory, BOUNDARY);
    writeFileSync(path, "");
    this.boundary = openSync(path, "r");
    unlinkSync(path);
    const stats = fstatSync(this.boundary);
    this.boundaryId = { dev: stats.dev, ino: stats.ino };
    writeFileSync(idPath, JSON.stringify(this.boundaryId));
    writeFileSync(join(this.directory, CREATOR), JSON.stringify({ pid: process.pid, at: Date.now() }));
  }

  /** 认持有者时不算在内的那两个号码(本进程、创建者)。 */
  #outsiders() {
    return new Set([process.pid, this.creator]);
  }

  spawn(commandName, args, options = {}) {
    const environment = options.env ?? process.env;
    // 边界描述符挂在 fd 3 上。它跟着 fork、exec、setsid、重新挂父一路传下去,而
    // `execve(…, {})` 清掉的只是环境、带不走描述符 —— 这正是环境那条线索塌掉的那一种
    // (文件头)。调用方自己的 stdio 原样保留,只在后面续一位。
    const stdio = options.stdio ?? ["pipe", "pipe", "pipe"];
    // **这个 fd 全程留着**:它钉住那个 unlink 掉的 inode(号码不被回收 ⇒ 身份不会被别人撞上)。
    // 于是创建者自己必然在持有者里 —— 上一版正是为了躲开这件事才「开了就马上关」,因为清理助手
    // 是**另一个进程**、只排除得掉自己那个号码,会把创建者当域内进程一刀 SIGTERM 掉(实测
    // `test:restart` 整套 rc=143)。现在创建者的号码记在 CREATOR 里,按身份排除,不靠「谁都
    // 别持有」这种巧合(见 `#outsiders`)。
    const boundary = this.boundary;
    const child = spawn(commandName, args, {
      ...options, detached: !windows, windowsHide: true,
      stdio: boundary === null ? stdio
        : [...(Array.isArray(stdio) ? stdio : [stdio, stdio, stdio]), boundary],
      env: { ...environment, ASH_TEST_PROCESS_SCOPE: this.directory,
        NODE_OPTIONS: `--require ${JSON.stringify(registerPath)} ${environment.NODE_OPTIONS ?? ""}`.trim() },
    });
    child.on("error", () => {});
    this.children.push(child);
    if (child.pid) {
      publishRecord(this.directory, child.pid, { pid: child.pid, at: Date.now(), script: "" });
      writeFileSync(join(this.directory, `${child.pid}.root`), "");
    }
    return child;
  }

  /**
   * 登记,按 pid 归并。同一个 pid 可能有两条(父进程的占位 + 它自己的自登记):
   * `script`/`streams` 只有自登记有,`at` 取晚的那一个 —— 两条都晚于出生时刻,取晚的
   * 不会把一个真正属于我们的进程判出去。
   */
  records() {
    const byPid = new Map();
    for (const name of readdirSync(this.directory)) {
      // **只认登记协议那个形状**(`<被登记 pid>.<发布者 pid>.json`),不是「目录里所有 .json」。
      // 本轮实测过这条:边界身份和创建者号码原先也写成 `.json`,于是 `creator.json` 被读成一条
      // 「pid = 创建者」的登记 —— 创建者把自己认成域内进程,`stop()` 当场把自己 SIGTERM 掉
      // (整套测试 rc=143)。执行域目录里以后还会有别的元数据,判据按协议形状写才关得住这个口。
      if (!REGISTRATION.test(name)) continue;
      let parsed;
      // 读到一半的文件不该让整轮扫描崩掉(发布是 rename,理论上看不到半截,
      // 但这层是清场的最后一道,宁可跳过一条也不要抛)。
      try { parsed = JSON.parse(readFileSync(join(this.directory, name), "utf8")); } catch { continue; }
      const previous = byPid.get(parsed.pid);
      byPid.set(parsed.pid, previous
        ? { ...previous, ...parsed, at: Math.max(previous.at ?? 0, parsed.at ?? 0),
          script: parsed.script || previous.script, streams: parsed.streams?.length ? parsed.streams : previous.streams }
        : parsed);
    }
    return [...byPid.values()];
  }

  /** 这一行是不是「号码对上、但出生时刻对不上」的另一个进程。 */
  #impostor(row, notAfter) {
    if (row.born === null || notAfter === undefined) return false;
    return row.born > notAfter || row.born < this.started - CLOCK_SLACK_MS;
  }

  /**
   * 一次完整扫描:域内**还活着**的那些行,外加**形态违规**的那几个号码(见 `#escapees`)。
   * 两样一起返回而不是分两次查:持有者那一问在 macOS 上要起一个 lsof,不该为同一个结论问两遍。
   */
  async inspect() {
    const rows = await processRows(this.directory);
    const records = this.records();
    const owned = new Set();
    const groups = new Set(readdirSync(this.directory).filter((name) => name.endsWith(".root")).map(Number.parseFloat));
    for (const record of records) {
      const row = rows.find((entry) => entry.pid === record.pid);
      if (!row || this.#impostor(row, record.at)) continue;
      owned.add(record.pid);
    }
    // **边界 inode**:持有它的一定是我们这一次创建的 —— 它没有名字,外面的进程开不出这个 fd
    // (文件头)。查不动会抛,由 `survey()` 走失败路径,绝不退化成「没有活的」。
    let holders = null;
    if (this.boundaryId !== null) {
      holders = await boundaryHolders(this.boundaryId, this.#outsiders());
      for (const pid of holders) {
        const row = rows.find((entry) => entry.pid === pid);
        if (row && !this.#impostor(row, Date.now())) owned.add(pid);
      }
    }
    // 环境段里带着本执行域的。判据是**环境段**而不是整行,不然一个把这段文字当普通参数传进来
    // 的外部进程就会被认领、被终止(第 4 轮审查 F1 实测)。
    for (const row of rows) if (row.scoped && !this.#impostor(row, Date.now())) owned.add(row.pid);
    // **进程组只在组长本身证明得出是我们的时候才作数**。号码会被复用:光凭「组号在 .root 里」
    // 认领,等于拿一个早就退了的旧组号去收养别人新建的组 —— 而那个新组出生得比本域晚,现有的
    // 出生时刻检查一条都拦不住它(第 4 轮审查 F1 同类)。组长在不在、是不是我们的,这儿查得到:
    //  · 还握着句柄没回收的那个孩子 ⇒ 这个号码不可能被复用,组号作数;
    //  · 否则要求组长那一行还在表里、而且它自己已经被上面几条线索认下来了。
    if (!windows) {
      const held = new Set(this.children
        .filter((child) => child.pid && child.exitCode === null && child.signalCode === null)
        .map((child) => child.pid));
      const provable = new Set([...groups].filter((leader) =>
        held.has(leader) || (owned.has(leader) && rows.some((row) => row.pid === leader))));
      for (const row of rows) {
        if (!provable.has(row.group) || this.#impostor(row, Date.now())) continue;
        owned.add(row.pid);
      }
    }
    let changed = true;
    // 已经不在表里的登记 pid 仍然当祖先用:Windows 上父进程死后 ppid 字段还留着,
    // 那条边是它那边唯一完整的线索。
    const ancestors = new Map([
      ...[...owned].map((pid) => [pid, rows.find((row) => row.pid === pid)?.born ?? null]),
      ...records.filter((record) => !rows.some((row) => row.pid === record.pid)).map((record) => [record.pid, record.at]),
    ]);
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (!ancestors.has(row.ppid) || ancestors.has(row.pid)) continue;
        const parentBorn = ancestors.get(row.ppid);
        // 孩子不可能比父亲早出生:这条边核不过就不是这棵树上的(父号被复用了)。
        if (row.born !== null && parentBorn !== null && row.born < parentBorn - CLOCK_SLACK_MS) continue;
        if (this.#impostor(row, Date.now())) continue;
        ancestors.set(row.pid, row.born); owned.add(row.pid); changed = true;
      }
    }
    return {
      rows: rows.filter((row) => owned.has(row.pid)),
      escaped: holders === null ? [] : await this.#escapees(rows, holders),
    };
  }

  async active() {
    return (await this.inspect()).rows;
  }

  /**
   * **我们亲手交到它手里的那个边界,它丢了**。那个 fd 是本层塞进它 stdio 的,所以「它还活着、
   * 却不再持有」只有一种解释:它自己关掉了 —— 而从这一刻起,它再 fork 出来的后代本层一条线索
   * 都认不出来(文件头「支持形态」)。这时候要的是**明确失败**,不是接着往「都停了」上走。
   *
   * **只看自己 spawn 的那一层**。再往下的那些,fd 要么由被改过的 `child_process.spawn` 继续传
   * (见 test-process-register.cjs),要么是原生 fork/exec 自然继承 —— 但 `execFile`/`fork`/
   * `spawnSync` 这些入口走的是 Node 内部的那个引用、改不到,所以「孙子辈也必须持有」这条**不**
   * 成立,拿它当判据会把一堆正当形态误报成违规。孙子辈自己关掉的那一种这一层确实看不见,靠
   * 形态约束,不在这儿假装检测得到。
   *
   * 会**复核一次**:取进程表和取持有者之间它可能正好在退出(内核在进程收尾时把 fd 全关掉),
   * 那种「还活着」只是还没被收尸。所以要求再查一遍仍然不持有、而且实例身份还在。
   */
  async #escapees(rows, holders) {
    const suspects = this.children.filter((child) => child.pid && child.exitCode === null
      && child.signalCode === null && !holders.has(child.pid)
      && rows.some((row) => row.pid === child.pid));
    if (!suspects.length) return [];
    const again = await boundaryHolders(this.boundaryId, this.#outsiders());
    const confirmed = [];
    for (const child of suspects) {
      if (again.has(child.pid)) continue;
      const row = rows.find((entry) => entry.pid === child.pid);
      if (row && await this.#stillSame(row)) confirmed.push(child.pid);
    }
    return confirmed;
  }

  /**
   * 这一轮扫描**能不能作数**。两种都不许当成「没有活的」:
   *  · 扫描本身失败(ps/CIM/lsof/proc 查不动)—— 那正是「没扫描到」被当成清场的那一步;
   *  · **形态违规**(有进程把本层交给它的边界丢了)—— 它的后代本层监管不到,所以这一轮的
   *    「没有活的」证明不了任何事(文件头「支持形态」)。
   * 调用方据此决定是报失败还是接着等。
   */
  async survey() {
    try {
      const { rows, escaped } = await this.inspect();
      if (!escaped.length) return { ok: true, rows };
      return { ok: false, rows, error: new Error(`这些进程已经不持有本域的边界描述符，它们的后代本层监管不到（不支持的形态，见 scripts/test-process-scope.mjs 文件头）: ${escaped.join(",")}`) };
    } catch (error) { return { ok: false, rows: [], error }; }
  }

  /** 终止前再核一次实例身份:号码还在、出生时刻一致,才是当初那一个。 */
  async #stillSame(row) {
    if (windows) return row; // Windows 走句柄 + GetProcessTimes,核对在那边做(见 stop)
    try {
      const out = await command("ps", ["-p", String(row.pid), "-o", "lstart="], { env: { LC_ALL: "C" }, timeout: 4_000 });
      const born = Date.parse(out.trim());
      if (!Number.isFinite(born)) return null;
      return Math.abs(born - (row.born ?? born)) <= CLOCK_SLACK_MS ? row : null;
    } catch { return null; } // 查不到 = 已经没了,不必杀
  }

  async stop() {
    const errors = [];
    const attempt = async (operation) => {
      try { return await operation(); }
      catch (error) { errors.push(error); return []; }
    };
    const signal = (pid, name) => {
      try { process.kill(pid, name); }
      catch (error) { if (error.code !== "ESRCH") errors.push(error); }
    };
    /**
     * 按**实例**终止一批行:核对出生时刻之后才动手。返回**没能核对实例身份**的那些号码 ——
     * 由调用方决定是报出来(主路径,见文件尾的 `unverified`)还是不吭声(「先砍一刀」那一刀:
     * 号码既然换了主人就本来不是我们的,主路径的 `active()` 也不会去认领它)。
     */
    const terminateRows = async (rows, force) => {
      if (!windows) {
        for (const row of rows) {
          const same = await this.#stillSame(row);
          if (!same) continue; // 号码换了主人:不是我们的,绝不碰
          signal(row.pid, force ? "SIGKILL" : "SIGTERM");
        }
        return []; // POSIX 这边「核不出来」就是「已经没了」(见 #stillSame),没有待报的号码
      }
      // 句柄 + GetProcessTimes 代次核对,和生产重启同一套(scripts/windows-restart.mjs)。
      // 不用 `taskkill /T`:它在执行那一刻重新展开进程树,杀的可能是我们查完之后才挂上去
      // 的、别人的进程。
      //
      // **整批一次**,代次对不上的那几个由那段脚本自己跳过并报号码(`tolerant`)。两件事都要:
      // 起一个 powershell 要 ~400ms,一行一个串着跑,第一刀就落到 2s 开外,而被判死的后代多活
      // 一拍就多写一次文件(真机实测:`test-test-process` 从超时到那次写只留了不到 1s,串行
      // 那一版它写出来了);而默认那种「任一代次对不上就整批抛」,会让一个号码换了主人的旧行
      // 把其余真该停的一起拦下。
      const targets = rows.filter((row) => row.created);
      const unverified = rows.filter((row) => !row.created).map((row) => row.pid);
      if (targets.length) {
        try {
          const output = await powerShell(windowsTerminateScript(targets, { tolerant: true }));
          // 跳过的那些:这个号码在查到和动手之间换了主人,不是我们的那一个。不杀,记一笔。
          for (const line of output.split("\n")) {
            const skipped = /^ASH_RESTART_SKIPPED (\d+)/.exec(line.trim());
            if (skipped) unverified.push(Number(skipped[1]));
          }
        } catch (error) { errors.push(error); }
      }
      return unverified;
    };
    const terminate = async (rows, force) => {
      this.unverified.push(...await terminateRows(rows, force));
    };

    await attempt(() => writeFileSync(join(this.directory, "stopped"), ""));
    // ── 先砍一刀 ────────────────────────────────────────────────────────────────
    // 枚举全表是要花时间的(Windows 上起一个 powershell 查 WMI,实测 ~600ms),而**清场慢一拍,
    // 被判死的后代就多出一拍去写文件**。所以在枚举之前先用**不花钱的证据**砍一刀:
    //  · POSIX:整组发信号。句柄还没回收 ⇒ 这个号码不可能被复用,所以整组是安全的 ——
    //    也只有这一处敢按组号发。
    //  · Windows:
    //     - 我们自己 spawn 的那一层按**句柄**杀。`child.kill()` 用的是 spawn 时拿到的那个句柄,
    //       根本不经过号码,比按号码杀更硬;
    //     - 它们的后代按**登记**杀。号码来自本域的登记文件(本地读,零开销),实例身份当场
    //       核(`#impostor`:出生时刻必须落在「本域创建」到「它登记那一刻」之间,一个号码被
    //       复用的陌生进程落不进这个区间)。
    //
    // **Windows 这儿原先走 `taskkill /T /F`,已经去掉**(第 4 轮审查 F1 同类)。当时的理由是
    // 「句柄没回收 ⇒ 这个号码不会被复用 ⇒ 展开出来的那棵树一定是我们的」,可那只固定了**根**的
    // 身份:`/T` 在执行那一刻按 ppid 重新展开整棵树,而 Windows 的 ppid 在父进程死后仍然留着
    // 旧号码 —— 一个号码被复用的中间节点就能把别人的进程挂进这棵树。换成上面这两条之后,砍下去
    // 的每一个都是自己证明得出来的,「及时」和「不误杀」不必二选一。
    for (const child of this.children) {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
      if (!windows) { signal(-child.pid, "SIGTERM"); continue; }
      try { child.kill(); } catch (error) { errors.push(error); }
    }
    if (windows) {
      await attempt(() => terminateRows(this.records()
        .filter((record) => record.pid !== process.pid && Number.isFinite(record.at))
        // 代次核成**区间**:这正是 `#impostor` 那条判据,换成句柄那头看得懂的尺子交过去 ——
        // 于是不必先起一个 powershell 查一遍进程表拿代次,这一刀只花一次。跳过的号码不往
        // `unverified` 里记:号码换了主人就本来不是我们的,后面的 `active()` 也不会认领它。
        .map((record) => ({ pid: record.pid, created: `${fileTime(this.started - CLOCK_SLACK_MS)}-${fileTime(record.at + CLOCK_SLACK_MS)}` })), true));
    }
    // 下面这一段是**凭据**:前面那一刀只覆盖得到自己登记过的(非 Node 的后代不执行 preload),
    // 全表枚举才认得出靠父子链挂着的那些,而「还有没有活的」这个结论只能由它来下。
    let active = [];
    if (!windows) {
      // POSIX 先温和一轮:上面整组发的是 SIGTERM,这儿再按实例补一次,给它们机会自己收场。
      await terminate(await attempt(() => this.active()), false);
      await delay(100);
    }
    for (let round = 0; round < 3; round++) {
      try { active = await this.active(); }
      catch (error) { errors.push(error); break; }
      if (!active.length) break;
      await terminate(active, true);
      await delay(50);
    }
    // 最后这一次用 `inspect`:除了「还有没有活的」,**形态违规也要落在清理结论里** —— 一个把
    // 边界丢掉的进程若还活着,它的后代本层监管不到,这时候的「扫不到」证明不了清场(文件头)。
    const final = await attempt(() => this.inspect());
    active = Array.isArray(final) ? final : final.rows;
    if (active.length) errors.push(new Error(`测试进程未清场: ${active.map((row) => row.pid).join(",")}`));
    if (!Array.isArray(final) && final.escaped.length) {
      errors.push(new Error(`这些进程已经不持有本域的边界描述符，它们的后代本层监管不到: ${final.escaped.join(",")}`));
    }
    if (this.unverified.length) {
      errors.push(new Error(`无法核验实例身份,未终止: ${[...new Set(this.unverified)].join(",")}`));
    }
    if (errors.length) throw Object.assign(new AggregateError(errors, `测试执行域清理失败: ${this.directory}`), { directory: this.directory });
  }

  remove() {
    // 边界那个 fd 关在这儿:它一关,那个未链接的 inode 才真正释放 —— 在此之前它一直钉着,
    // 身份不会被别的未链接 inode 撞上(见 `#prepareBoundary`)。
    if (this.boundary !== null) {
      try { closeSync(this.boundary); } catch { /* 已经关了 */ }
      this.boundary = null;
    }
    rmSync(this.directory, { recursive: true, force: true });
    for (const scope of scopes) if (scope.directory === this.directory) scopes.delete(scope);
  }
}

function readFileSyncSafe(path) {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

export function spawnTestFixture(commandName, args, options) {
  const scope = new TestProcessScope();
  const child = scope.spawn(commandName, args, options);
  child.dispose = async () => { await scope.stop(); scope.remove(); };
  return child;
}

export function preservedPids(scope, scripts, capturedStreams) {
  return new Set(scope.records().filter((record) =>
    scripts.some((script) => record.script && resolve(record.script) === resolve(script))
    && record.streams?.length === 2 && record.streams.every((stream) => stream && !capturedStreams.includes(stream))
  ).map((record) => record.pid));
}

process.once("exit", () => {
  if (process.argv[1] && resolve(process.argv[1]) === cleanupPath) return;
  if (!scopes.size) return;
  const result = spawnSync(process.execPath, [cleanupPath, ...[...scopes].map((scope) => scope.directory)], {
    stdio: "inherit", timeout: 30_000, killSignal: "SIGKILL", windowsHide: true,
  });
  if (result.error || result.signal || result.status !== 0) process.exitCode = 1;
});
