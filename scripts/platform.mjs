// 脚本侧的平台差异**单点**。server 那边另有一份 `server/src/platform.ts`，两份不能
// 合并：这些脚本要在**构建之前**跑（setup 的头两件事就是装依赖、构建，那时
// `server/dist` 还不存在，`src` 又只有 TypeScript），所以只能按同样的口径在这里
// 复刻用得到的那几条。改动时两边一起看。
//
// 口径与 platform.ts 一致：**探测失败一律返回空**（空串 / 空数组 / null），系统探测
// 拿不到不该拖垮调用方。
import { execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { request } from "node:http";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { windowsRestartPlan, windowsTerminateScript } from "./windows-restart.mjs";

export const IS_WINDOWS = process.platform === "win32";

/** 跑一条命令拿 stdout；失败（含命令根本不存在）一律空串。 */
export function capture(file, args, opts = {}) {
  try {
    return execFileSync(file, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      ...opts,
    });
  } catch {
    return "";
  }
}

function candidates(cmd) {
  if (!IS_WINDOWS || /\.[a-z0-9]+$/i.test(cmd)) return [cmd];
  // Windows 上 `npm` 这种名字实际是 `npm.cmd`，不展开 PATHEXT 就一个都找不到。
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  return [cmd, ...exts.map((ext) => cmd + ext.toLowerCase())];
}

/**
 * CLI 常见安装目录。**与 `server/src/executors/bin-resolve.ts` 的 `extraPaths` 必须
 * 一字不差**（那边是真相,理由和事故经过都写在它头上;两份由
 * `server/scripts/test-win-launch.ts` 最后一节钉住）。
 *
 * `env` / `home` 可注入只为让那条回归翻转着比两份实现,生产路径一律用默认值。
 */
export function extraPaths(env = process.env, home = homedir()) {
  if (!IS_WINDOWS) {
    return [
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      `${home}/.local/bin`,
      `${home}/.bun/bin`,
      `${home}/.deno/bin`,
      join(env.KIMI_INSTALL_DIR || join(home, ".kimi-code"), "bin"),
    ];
  }
  const { APPDATA, LOCALAPPDATA, ProgramFiles, ChocolateyInstall } = env;
  const programFiles = [ProgramFiles, env["ProgramFiles(x86)"], env["ProgramFiles(Arm)"]];
  return [
    APPDATA && join(APPDATA, "npm"),
    LOCALAPPDATA && join(LOCALAPPDATA, "pnpm"),
    LOCALAPPDATA && join(LOCALAPPDATA, "Microsoft", "WindowsApps"),
    join(home, ".bun", "bin"),
    join(home, ".deno", "bin"),
    join(home, ".local", "bin"),
    join(home, "scoop", "shims"),
    ...programFiles.map((dir) => dir && join(dir, "nodejs")),
    ChocolateyInstall ? join(ChocolateyInstall, "bin") : "C:\\ProgramData\\chocolatey\\bin",
  ].filter(Boolean);
}

/**
 * `command -v` 的跨平台版本：找不到返回 null。
 *
 * **扫 PATH 之后接着扫 `extraPaths()`** —— 跟 ash 自己派活时用的 `resolveBin` 同一套
 * 候选目录。少了这一截,装机脚本会把「装了、只是不在这个 shell 的 PATH 里」判成
 * 「没装」:`setup.mjs` 据此跳过 MCP 注册,而 ash 照样派得出任务,结果是每个任务都
 * 交不了卷(见 bin-resolve.ts 的 extraPaths 头部)。
 */
export function which(cmd) {
  if (cmd.includes("/") || cmd.includes("\\")) return executable(cmd) ? cmd : null;
  for (const dir of [...(process.env.PATH ?? "").split(delimiter), ...extraPaths()]) {
    if (!dir) continue;
    for (const name of candidates(cmd)) {
      const full = join(dir, name);
      if (executable(full)) return full;
    }
  }
  return null;
}

function executable(full) {
  try {
    if (!statSync(full).isFile()) return false;
    // Windows 没有执行位（X_OK 恒真），靠上面的 PATHEXT 判定；POSIX 上必须查，
    // 否则 PATH 靠前目录里一个同名的普通文件就会把真正的命令挡住。
    if (!IS_WINDOWS) accessSync(full, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 跑一段 PowerShell 拿 stdout（非 Windows 直接空串）。编码传参绕开引号雷区。 */
export function powerShell(script) {
  if (!IS_WINDOWS) return "";
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  for (const exe of ["pwsh.exe", "powershell.exe"]) {
    const out = capture(exe, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]);
    if (out.trim()) return out;
  }
  return "";
}

/**
 * Windows 长路径的两个开关(非 Windows 返回 null —— 那边没有 MAX_PATH 这回事)。
 * 两个缺一不可，理由见 `server/src/platform.ts` 的「Windows 长路径」一节：
 * 系统开关管 Win32 API，`core.longpaths` 管 Git for Windows 自带的 msys 运行时。
 */
export function windowsLongPaths() {
  if (!IS_WINDOWS) return null;
  const value = powerShell(`$ErrorActionPreference = 'SilentlyContinue'
$v = (Get-ItemProperty -LiteralPath 'Registry::HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\FileSystem' -Name LongPathsEnabled).LongPathsEnabled
[Console]::Out.WriteLine([string]$v)`);
  // `git config --get` 在没配过时退出码非 0，capture 会吞成空串 —— 空串 = 没开。
  return {
    registry: value.trim() === "1",
    git: /^true$/i.test(capture("git", ["config", "--get", "core.longpaths"]).trim()),
  };
}

function uniquePids(text) {
  return [...new Set(text.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

/**
 * 谁在监听这个端口。查不到（命令不可用 / 竞态）返回空数组。
 *
 * POSIX 上要依次退好几条：**`lsof` 是 macOS 自带、Linux 精简镜像普遍不装**。
 * 2026-08-21 踩到的实例是一台 Rocky 容器里的 ash —— `lsof` 不在，这里返回空，
 * restart.mjs 于是「没找到旧进程」直接放过，新进程撞单实例锁退出，而 `/api/health`
 * 由**老进程**照常回 200，脚本打印「已就绪」。用户完全有理由以为重启成功了，实际
 * 跑了三个多小时的旧代码。所以 lsof → ss(iproute2) → fuser(psmisc) 挨个试。
 * `/usr/sbin` 常常不在非交互 shell 的 PATH 里，which 找不到就直接按绝对路径打。
 */
export function listenerPids(port) {
  if (IS_WINDOWS) {
    return uniquePids(powerShell(`$ErrorActionPreference='SilentlyContinue'
try { (Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop).OwningProcess }
catch { netstat -ano | Select-String ':${port}\\s' | Select-String 'LISTENING' | ForEach-Object { ($_ -split '\\s+')[-1] } }`));
  }
  const lsof = uniquePids(capture("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]));
  if (lsof.length) return lsof;
  // ss 的进程栏长这样：`users:(("node",pid=1751,fd=23))`。`-H` 去表头是新版才有的
  // 选项，老版会多吐一行标题——照样不含 `pid=`，正则天然免疫。
  const ss = capture(which("ss") ?? "/usr/sbin/ss", ["-lntpH", `sport = :${port}`]);
  const fromSs = [...new Set([...ss.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])))]
    .filter((n) => Number.isInteger(n) && n > 0);
  if (fromSs.length) return fromSs;
  // fuser 把 pid 打在 stdout、其余说明打在 stderr（capture 只收 stdout）。
  return uniquePids(capture(which("fuser") ?? "/usr/sbin/fuser", ["-n", "tcp", String(port)]));
}

/**
 * 全进程表的 `{ pid, ppid, command }`。查不到返回空数组。
 *
 * `ppid` 是给「杀旧 server 但保住活得过重启的 agent」那条路用的(见 killServerProcess):
 * Windows 上没有信号,整树击杀只能自己按父子关系算。拿不到父号的行给 `null` ——
 * 规范化成 0 等于把「问不出来」说成「它没有父进程」,而这里缺一条边就等于漏掉一棵子树。
 */
export function listProcesses() {
  const rows = [];
  if (IS_WINDOWS) {
    const out = powerShell(`$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
$rows=@(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object {
  $born = if ($null -ne $_.CreationDate) { $_.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString() } else { '' }
  [pscustomobject]@{pid=$_.ProcessId;ppid=$_.ParentProcessId;created=$born;command=$_.CommandLine}
})
[Console]::Out.WriteLine((ConvertTo-Json -InputObject $rows -Compress -Depth 3))`);
    try {
      const parsed = JSON.parse(out);
      if (!Array.isArray(parsed)) return [];
      for (const row of parsed) {
        if (!Number.isInteger(row.pid) || row.pid < 0 || typeof row.created !== "string") return [];
        if (row.pid === 0) continue;
        rows.push({
          pid: row.pid,
          ppid: Number.isInteger(row.ppid) && row.ppid >= 0 ? row.ppid : null,
          created: row.created,
          command: typeof row.command === "string" ? row.command : "",
        });
      }
      return rows;
    } catch { return []; }
  }
  for (const line of capture("ps", ["-ww", "-axo", "pid=,ppid=,command="]).split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3] });
  }
  return rows;
}

/**
 * 「这是一个活得过 ash 的 agent 壳」的记号。跟
 * `server/src/executors/detached-win-wrap.ts` 的 `WINDOWS_WRAP_SUFFIX` **必须一字不差**
 * —— 那边按这个后缀生成壳脚本的文件名,这边按它在进程表的命令行里把壳认出来。
 *
 * 两份不能合并(这些脚本要在 build 之前就能跑,见本文件顶部),所以拿回归把它们钉在
 * 一起:`server/scripts/test-win-launch.ts` 最后一节会比对这两个常量。
 */
export const WINDOWS_AGENT_WRAP_SUFFIX = ".ash-agent-wrap.cjs";

/**
 * 进程表里哪些行是 agent 壳。**按命令行里的记号认,不靠外部名单** —— 这是
 * killServerProcess 那条不变量的全部依据,理由写在那边。
 */
export function agentWrapPids(rows) {
  const want = WINDOWS_AGENT_WRAP_SUFFIX.toLowerCase();
  return rows
    .filter((row) => typeof row.command === "string" && row.command.toLowerCase().includes(want))
    .map((row) => row.pid);
}

/**
 * 停掉旧 server 进程。
 *
 * POSIX:就是一发 SIGTERM。信号不级联 —— 它的子进程(输出已落盘的 agent、终端会话、
 * 预览服务)一个都不会被带走,所以「活得过重启」这件事在那边自动成立。
 *
 * Windows:没有信号,原先这一刀是 `taskkill /PID <server> /T /F`,而 `/T` **按父子关系把
 * 整棵树一起杀** —— 输出已经落盘、本该活得过重启的 agent 也被它带走。这才是「Windows 上
 * 重启必断」的真正原因(不是落盘那一层做不到,见 server/src/executors/detached-win.ts)。
 * 所以那边改成自己算:整棵后代**减去**要保住的子树,逐个 `/F`;保住的那几棵一刀不发。
 *
 * ── 要保住谁:**认记号,不认名单**(第 1 轮审查 F2)─────────────────────────────
 *
 * `protect` 是控制面在**上一时刻**给的答案(`/api/restart-impact` 的 survives)。拿它当
 * 「该保住的全集」是错的:问完到下刀之间,队列推进、别的页面、别的客户端都还能起新 agent,
 * 那个新壳不在名单里,于是被明确地 taskkill 掉 —— 审查实测过,确定性复现。缩短窗口、
 * 多问一次都不是不变量。
 *
 * 所以这边反过来:**凡是在同一份进程表快照里认得出记号的壳,一律不下刀**(`protect` 退化
 * 成一个额外输入,名单漏了也不至于误杀)。记号就是壳脚本的文件名后缀,它写在命令行里 ——
 * 跟「名单」不同,它和 doomed 集合读的是同一份快照,中间没有时间差。
 *
 * 快照之后才出生的进程压根不在 doomed 里,也就一刀都挨不着:它要么是个新壳(该活),要么
 * 是 ash 非 detached 起的子进程 —— 后者会被 libuv 那个 `KILL_ON_JOB_CLOSE` 的全局 Job 在
 * server 一死时连带收掉(机制见 detached-win.ts 顶部),不需要这里补刀。
 *
 */
export function killServerProcess(pid, protect = [], { force = false } = {}) {
  return killServerProcesses([pid], protect, { force });
}

export function killServerProcesses(pids, protect = [], { force = false } = {}) {
  const rootsToStop = pids.filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid);
  if (!rootsToStop.length) return "skipped";
  if (!IS_WINDOWS) {
    for (const pid of rootsToStop) killPid(pid);
    return "signal";
  }
  const rows = listProcesses();
  if (!rows.length) {
    if (!force) throw new Error("Windows 进程表查询失败");
    for (const pid of rootsToStop) capture("taskkill", ["/PID", String(pid), "/T", "/F"]);
    return "tree";
  }
  const roots = [...new Set([...protect, ...agentWrapPids(rows)])];
  const plan = windowsRestartPlan(rows, rootsToStop, roots);
  if (plan.preservedPids.length) {
    console.warn(`  ⚠ 保留命令行不可读的后代及其子树(PID: ${plan.preservedPids.join(", ")});未对它们强杀,后续清理由所属任务负责。`);
  }
  const doomed = plan.targets.filter((row) => row.pid !== process.pid);
  if (!doomed.length) return "gone";
  const result = powerShell(windowsTerminateScript(doomed));
  if (!result.includes("ASH_RESTART_KILLED")) throw new Error("Windows 进程实例核验或终止失败");
  return "selective";
}

/**
 * 命令行**以这个路径结尾**的进程。锚在末尾是有意的：`node …/mcp/dist/index.js` 该
 * 命中，而把同一个路径写在 `--mcp-config` 里的 claude/codex 父进程绝不能被误杀。
 */
export function pidsRunningScript(scriptPath) {
  const want = IS_WINDOWS ? scriptPath.toLowerCase() : scriptPath;
  return listProcesses()
    .filter(({ pid, command }) => {
      if (pid === process.pid) return false;
      const cmd = IS_WINDOWS ? command.toLowerCase() : command;
      return cmd.endsWith(want) || cmd.endsWith(`${want}"`);
    })
    .map((row) => row.pid);
}

/**
 * 杀掉一个进程（连同后代）。
 * POSIX 发 SIGTERM 让它自己收摊；Windows 没有信号，`taskkill /T /F` 是强杀 —— 那边
 * 拿不到优雅退出这一档，调用方该在提示里说清楚。
 */
export function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  if (IS_WINDOWS) {
    capture("taskkill", ["/PID", String(pid), "/T", "/F"]);
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* 已经没了 */
  }
}

/** 这个 pid 还活着吗（EPERM = 在，只是看不着）。 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * 打本机 `:port` 的一个 GET，返回解析后的 JSON；任何失败（连不上、非 2xx、不是
 * JSON）一律 null。
 *
 * 走 `node:http` 而不是 fetch 是**故意**的：本机控制面请求绝不能跟着 HTTP_PROXY /
 * ALL_PROXY 绕去代理。这个环境常驻代理却没设 NO_PROXY，服务重启的几秒空窗里代理
 * 会记住一次上游失败，于是 server 已经同秒监听、这里仍连续拿到失败并误报「没起来」。
 * `node:http` 不读任何代理环境变量，这条路是确定的（fetch 在 Node 24 起可以被
 * `NODE_USE_ENV_PROXY` 打开，不确定）。
 */
export function localJson(port, path, timeoutMs = 2000, headers = undefined) {
  return localGet(port, path, timeoutMs, headers).then((r) => r.json);
}

/**
 * 同一条请求，但**把「连不上」和「被拒」分开**回给调用方。
 *
 * `localJson` 把两者一律压成 null，调用方只能按「查不到 → 当 0 处理」继续 —— 对探活
 * 是对的，对**安全闸**是致命的：多人模式下 `/api/restart-impact` 会 401，重启脚本于是
 * 把「会被打断的任务数」算成 0，不加 FORCE 也照样杀（第 1 轮审查 P1）。要 fail closed
 * 的地方用这个，看 `status`：null = 连不上，数字 = 服务端真的答了。
 *
 * 第三档也得分开:**「端口上没人在听」和「有人在听但没按时答」不是一回事**
 * (第 1 轮审查 F1)。两者的 `status` 都是 null,可前者意味着「本来就没有任务会被打断」,
 * 后者只意味着「问不出来」—— 把后者当前者处理,安全闸就会在 ash 响应慢的时候静默失效。
 * 所以再带一个 `error`:`null` = 答了,`"timeout"` = 超时,其余是 errno(`ECONNREFUSED`
 * 这类),由 `isNotListening` 判。
 */
export function localGet(port, path, timeoutMs = 2000, headers = undefined) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; resolve(value); } };
    let timedOut = false;
    const req = request(
      { host: "127.0.0.1", port, path, timeout: timeoutMs, ...(headers ? { headers } : {}) },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          const status = res.statusCode ?? null;
          if (!status || status >= 300) return done({ status, json: null, error: null });
          try {
            done({ status, json: JSON.parse(body), error: null });
          } catch {
            done({ status, json: null, error: null });
          }
        });
      },
    );
    req.on("timeout", () => { timedOut = true; req.destroy(); });
    req.on("error", (e) => done({ status: null, json: null, error: timedOut ? "timeout" : (e?.code ?? "error") }));
    // `req.destroy()` 不保证 emit error(跨 Node 版本不一致),少这一条超时就可能永不 resolve。
    req.on("close", () => done({ status: null, json: null, error: timedOut ? "timeout" : "closed" }));
    req.end();
  });
}

/**
 * `localGet` 的 `error` 是不是「端口上压根没人在听」。
 *
 * 只有连接被明确拒绝才算。超时、连接被重置、未知错误一律**不算** —— 那些都是「问不出来」,
 * 而「问不出来」不等于「没有」(见 localGet 顶部那一段、以及 restart.mjs 的 impact)。
 */
export function isNotListening(error) {
  return error === "ECONNREFUSED" || error === "EADDRNOTAVAIL";
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
