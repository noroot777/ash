// ── 测试执行域:一次 runTestProcess 创建的全部进程,以及「它们真的都停了」这个证明 ──────
//
// 这一层只回答两个问题,两个都不许靠猜:
//   ① **谁是我们创建的**(所有权)。
//   ② **它们是不是都停了**(退出证明)。扫不到 ≠ 停了 —— 把一次空扫描当成清场,正是
//      「测试显示成功、磁盘上还在写」那个形状的根子。
//
// ## 所有权的三条线索,以及它们各自的盲区
//
//   · **登记**(preload 写 `<pid>.*.json`):只覆盖 Node 进程。非 Node 程序自己 fork 出来
//     的后代不执行 preload,登记里没有它。
//   · **父子链**:后代 setsid + 原父退出之后在 POSIX 上被挂到 1 号进程,链断了。
//     (Windows 没有这套语义:ppid 字段在父进程死后仍然保留,链还在。)
//   · **进程组**:setsid 会换组,同样断。
//
// 于是 POSIX 上三条全断的那一种真实存在(原生 fork+setsid,实测:父进程正常退出和超时
// 两种模式下后代都活着、helper 都正常返回)。补第四条线索:**环境变量继承**。
// `ASH_TEST_PROCESS_SCOPE` 在 fork 和 exec 之间都会传下去,setsid 和重新挂父都带不走它,
// 而 `ps -E` 读得到自己这个用户的进程环境 —— 这条线索不依赖父子关系,因此不怕重新挂父。
// Windows 读不到别的进程的环境块,但那边也没有「重新挂父」这件事:ppid 在父进程死后仍然
// 指向原父,父子链本身就是完整的。所以两个平台各有一条**不依赖易变关系**的证明路径,
// 哪条都不是「扫不到就算没有」。
//
// ## 实例身份:pid 不是身份,(pid, 出生时刻) 才是
//
// 号码会被复用。所以每一行快照都带 `born`,登记也带时刻:号码对上但出生时刻对不上的,
// 是**另一个进程**,既不认它是我们的,更不会去杀它。终止前还要再核一次(POSIX 用
// `ps -p` 重查,Windows 走句柄 + GetProcessTimes,见 stop)。
import { spawn, spawnSync, execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

async function command(file, args, options = {}) {
  const { timeout = 4_000, env } = options;
  return (await execute(file, args, {
    encoding: "utf8", timeout, killSignal: "SIGKILL", windowsHide: true,
    maxBuffer: 64 * 1024 * 1024, // -E 把环境块也打出来,默认 1 MB 的缓冲区装不下整张表
    env: env ? { ...process.env, ...env } : process.env,
  })).stdout;
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
  // `-E` 让环境块跟在命令行后面(只对自己这个用户的进程有效,正好是我们唯一要认的范围);
  // `LC_ALL=C` 把 lstart 钉成固定的英文格式,否则中文 locale 下是「四 10月/22 ...」,
  // Date.parse 认不出来,整条实例身份就垮了。
  const output = await command("ps", ["-ww", "-E", "-axo", "pid=,ppid=,pgid=,stat=,lstart=,command="],
    { env: { LC_ALL: "C" }, timeout: 10_000 });
  const marker = scopeDirectory ? `ASH_TEST_PROCESS_SCOPE=${scopeDirectory}` : null;
  const rows = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.trim().split(/\s+/);
    const [pid, ppid, group, state, ...rest] = parts;
    if (state?.startsWith("Z")) continue; // 僵尸:已经死了,只是还没被收尸
    // lstart 固定五段(Thu Oct 22 09:25:56 2026),后面全是命令行 + 环境块。
    const born = Date.parse(rest.slice(0, 5).join(" "));
    rows.push({
      pid: Number(pid), ppid: Number(ppid), group: Number(group), created: null,
      born: Number.isFinite(born) ? born : null,
      scoped: !!marker && line.includes(marker),
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
    scopes.add(this);
  }

  spawn(commandName, args, options = {}) {
    const environment = options.env ?? process.env;
    const child = spawn(commandName, args, {
      ...options, detached: !windows, windowsHide: true,
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
    // 环境块里带着本执行域的:不问父子、不问进程组,它一定是我们这一次创建的(文件头)。
    for (const row of rows) if (row.scoped && !this.#impostor(row, Date.now())) owned.add(row.pid);
    // 进程组只在**组长还是我们的**时候作数:号码会被复用,光凭组号认领等于按旧号码收养。
    if (!windows) for (const row of rows) if (groups.has(row.group) && !this.#impostor(row, Date.now())) owned.add(row.pid);
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
    for (const child of this.children) {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
      if (windows) {
        // 这一处 `/T` 是安全的:句柄还没回收,这个号码就不会被复用,所以展开出来的那棵树
        // 一定是我们这个孩子的后代。别处的 /T 没有这个前提,所以走句柄终止。
        try { await command("taskkill", ["/PID", String(child.pid), "/T", "/F"]); }
        catch (error) { if (!Number.isInteger(error.code)) errors.push(error); }
      } else {
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
