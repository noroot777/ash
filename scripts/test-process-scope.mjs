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
//   · **边界描述符**(POSIX):每个 spawn 出来的进程都继承一个指向 `<执行域>/boundary` 的
//     fd。`lsof` 读的是内核里「谁打开着这个文件」,不是文本 —— 外面的进程**拿不到**我们这个
//     fd,所以这条线索既伪造不了,也不随 exec / setsid / 重新挂父而丢。
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
// ## 可证明的执行模型:它的边界写在这儿,不靠「再补一条会消失的线索」
//
// 一个后代要想彻底跑出这一层的视野,得**同时**做到:关掉继承来的边界 fd、清空环境、脱离
// 父子链和进程组。前三条里任意一条没做到,它就还在 `active()` 里。而真要全做到了,这一层
// 答的就不是「清场了」而是「证明不了」—— `survey()` 的 `ok:false` 走的是失败路径,`stop()`
// 到最后仍有活的就报遗留。**扫不到不算停了**这条不变量没有例外。
//
// ## 实例身份:pid 不是身份,(pid, 出生时刻) 才是
//
// 号码会被复用。所以每一行快照都带 `born`,登记也带时刻:号码对上但出生时刻对不上的,
// 是**另一个进程**,既不认它是我们的,更不会去杀它。终止前还要再核一次(POSIX 用
// `ps -p` 重查,Windows 走句柄 + GetProcessTimes,见 stop)。
import { spawn, spawnSync, execFile } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

/**
 * 边界描述符那个文件的名字。每个 spawn 出来的进程都继承一个指向它的 fd —— 「谁打开着这个
 * 文件」是内核里的事实,外面的进程拿不到我们这个 fd,所以它既伪造不了也不随 exec 丢
 * (见文件头)。
 */
const BOUNDARY = "boundary";

async function command(file, args, options = {}) {
  const { timeout = 4_000, env } = options;
  return (await execute(file, args, {
    encoding: "utf8", timeout, killSignal: "SIGKILL", windowsHide: true,
    maxBuffer: 64 * 1024 * 1024, // -E 把环境块也打出来,默认 1 MB 的缓冲区装不下整张表
    env: env ? { ...process.env, ...env } : process.env,
  })).stdout;
}

/**
 * 还有谁打开着那个边界文件 —— 返回 pid 数组(不含本进程自己:读端是我们开的)。
 *
 * **查不动一律抛**,绝不返回空数组:这一层最要紧的不变量是「扫不到 ≠ 停了」,把一次查询失败
 * 说成「没有持有者」正是那个事故形状的根子。调用方经 `survey()` 把它走成失败路径。
 */
async function boundaryHolders(path) {
  // Linux 不必起外部进程:/proc 直接读得到每个 pid 开着哪些 fd。
  if (existsSync("/proc/self/fd")) {
    const holders = [];
    for (const name of readdirSync("/proc")) {
      const pid = Number(name);
      if (!Number.isInteger(pid) || pid === process.pid) continue;
      let entries;
      try { entries = readdirSync(`/proc/${pid}/fd`); } catch { continue; } // 进程没了 / 不是我们的
      for (const entry of entries) {
        try { if (readlinkSync(`/proc/${pid}/fd/${entry}`) === path) { holders.push(pid); break; } }
        catch { /* fd 刚好关了 */ }
      }
    }
    return holders;
  }
  let output;
  try { output = await command("lsof", ["-w", "-t", "--", path], { timeout: 10_000 }); }
  catch (error) {
    // lsof 查一个没人打开的文件时退 1 且不吐任何东西 —— 那是「没有持有者」这个**答案**,
    // 不是查询失败。其余任何情况(找不到 lsof、超时、有 stderr)都算答不出来,往上抛。
    if (error.code === 1 && !error.stdout?.trim() && !error.stderr?.trim()) return [];
    throw error;
  }
  return output.split("\n").map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid !== process.pid);
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
    // 边界描述符那个文件(见文件头)。POSIX 专有:Windows 那边 ppid 在父进程死后仍然保留,
    // 父子链本身就是完整的,不需要这一条;那边也没有 lsof / proc 这种「谁开着这个文件」的查法。
    // 清理助手拿已有目录重建 scope 时这个文件已经在了,所以用追加方式确保存在。
    this.boundaryPath = windows ? null : join(this.directory, BOUNDARY);
    if (this.boundaryPath) {
      try { writeFileSync(this.boundaryPath, "", { flag: "a" }); }
      catch (error) {
        if (mine) rmSync(this.directory, { recursive: true, force: true });
        throw error;
      }
    }
    scopes.add(this);
  }

  spawn(commandName, args, options = {}) {
    const environment = options.env ?? process.env;
    // 边界描述符挂在 fd 3 上。它跟着 fork、exec、setsid、重新挂父一路传下去,而
    // `execve(…, {})` 清掉的只是环境、带不走描述符 —— 这正是环境那条线索塌掉的那一种
    // (文件头)。调用方自己的 stdio 原样保留,只在后面续一位。
    const stdio = options.stdio ?? ["pipe", "pipe", "pipe"];
    // **开了就马上关**:`spawn` 在返回之前已经把它 dup 进子进程了,所以这一侧不必留着 ——
    // 留着的话「谁开着这个文件」里就永远有创建者自己,而清理助手是**另一个进程**、只排除得掉
    // 自己那个 pid,于是它会把创建者认成域内进程并一刀 SIGTERM 掉(本轮实测 `test:restart`
    // 整套 rc=143)。只在 spawn 那一瞬开着,持有者集合里就只剩真正的后代。
    const boundary = this.boundaryPath === null ? null : openSync(this.boundaryPath, "r");
    let child;
    try {
      child = spawn(commandName, args, {
        ...options, detached: !windows, windowsHide: true,
        stdio: boundary === null ? stdio
          : [...(Array.isArray(stdio) ? stdio : [stdio, stdio, stdio]), boundary],
        env: { ...environment, ASH_TEST_PROCESS_SCOPE: this.directory,
          NODE_OPTIONS: `--require ${JSON.stringify(registerPath)} ${environment.NODE_OPTIONS ?? ""}`.trim() },
      });
    } finally {
      if (boundary !== null) { try { closeSync(boundary); } catch { /* 已经关了 */ } }
    }
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
      if (!name.endsWith(".json")) continue;
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

  async active() {
    const rows = await processRows(this.directory);
    const records = this.records();
    const owned = new Set();
    const groups = new Set(readdirSync(this.directory).filter((name) => name.endsWith(".root")).map(Number.parseFloat));
    for (const record of records) {
      const row = rows.find((entry) => entry.pid === record.pid);
      if (!row || this.#impostor(row, record.at)) continue;
      owned.add(record.pid);
    }
    // **边界描述符**:开着我们那个文件的,一定是我们这一次创建的 —— 外面的进程拿不到这个
    // fd(文件头)。查不动会抛,由 `survey()` 走失败路径,绝不退化成「没有活的」。
    if (this.boundaryPath !== null) {
      for (const pid of await boundaryHolders(this.boundaryPath)) {
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
    return rows.filter((row) => owned.has(row.pid));
  }

  /**
   * 这一轮扫描**能不能作数**。扫描本身失败(ps/CIM 查不动)时绝不能当成「没有活的」——
   * 那正是「没扫描到」被当成清场的那一步。调用方据此决定是报失败还是接着等。
   */
  async survey() {
    try { return { ok: true, rows: await this.active() }; }
    catch (error) { return { ok: false, rows: [], error }; }
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
    /** 按**实例**终止一批行:核对出生时刻之后才动手。 */
    const terminate = async (rows, force) => {
      if (windows) {
        // 句柄 + GetProcessTimes 代次核对,和生产重启同一套(scripts/windows-restart.mjs)。
        // 不用 `taskkill /T`:它在执行那一刻重新展开进程树,杀的可能是我们查完之后才挂上去
        // 的、别人的进程。
        //
        // **一行一次**,不打包:那段脚本是先把整批句柄开完、任一代次对不上就整批抛,
        // 打包的话一个「号码换了主人」的旧行会把其余真该停的一起拦下。
        for (const row of rows) {
          if (!row.created) { this.unverified.push(row.pid); continue; }
          try { await powerShell(windowsTerminateScript([row])); }
          catch (error) {
            // 代次对不上 = 这个号码在查到和动手之间换了主人,不是我们的那一个:不杀,记一笔。
            if (/PID generation changed/.test(`${error.stderr ?? ""}${error.message ?? ""}`)) { this.unverified.push(row.pid); continue; }
            errors.push(error);
          }
        }
        return;
      }
      for (const row of rows) {
        const same = await this.#stillSame(row);
        if (!same) continue; // 号码换了主人:不是我们的,绝不碰
        signal(row.pid, force ? "SIGKILL" : "SIGTERM");
      }
    };

    await attempt(() => writeFileSync(join(this.directory, "stopped"), ""));
    // 我们自己 spawn 出来的那一层:句柄还没回收,这个号码就不可能被复用,所以整组发信号
    // 是安全的 —— 也只有这一处敢按组号发。
    //
    // **Windows 这儿原先走 `taskkill /T /F`,已经去掉**(第 4 轮审查 F1 同类)。当时的理由是
    // 「句柄没回收 ⇒ 这个号码不会被复用 ⇒ 展开出来的那棵树一定是我们的」,可那只固定了**根**的
    // 身份:`/T` 在执行那一刻按 ppid 重新展开整棵树,而 Windows 的 ppid 在父进程死后仍然留着
    // 旧号码 —— 一个号码被复用的中间节点就能把别人的进程挂进这棵树。那边改走跟下面同一条路:
    // `active()` 列出来(父子链在 Windows 上本来就完整)、一行一次按句柄 + GetProcessTimes
    // 核代次再终止。少掉的只是「先砍根」这一下,根自己照样在 `active()` 里。
    if (!windows) {
      for (const child of this.children) {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
        signal(-child.pid, "SIGTERM");
      }
    }
    let active = await attempt(() => this.active());
    if (!windows) {
      await terminate(active, false);
      await delay(100);
    }
    for (let round = 0; round < 3; round++) {
      try { active = await this.active(); }
      catch (error) { errors.push(error); break; }
      if (!active.length) break;
      await terminate(active, true);
      await delay(50);
    }
    active = await attempt(() => this.active());
    if (active.length) errors.push(new Error(`测试进程未清场: ${active.map((row) => row.pid).join(",")}`));
    if (this.unverified.length) {
      errors.push(new Error(`无法核验实例身份,未终止: ${[...new Set(this.unverified)].join(",")}`));
    }
    if (errors.length) throw Object.assign(new AggregateError(errors, `测试执行域清理失败: ${this.directory}`), { directory: this.directory });
  }

  remove() {
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
