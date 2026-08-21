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
import { delimiter, join } from "node:path";

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

/** `command -v` 的跨平台版本：在 PATH 里找可执行文件，找不到返回 null。 */
export function which(cmd) {
  if (cmd.includes("/") || cmd.includes("\\")) return executable(cmd) ? cmd : null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
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

/** 全进程表的 `{ pid, command }`。查不到返回空数组。 */
export function listProcesses() {
  const rows = [];
  if (IS_WINDOWS) {
    const out = powerShell(`$ErrorActionPreference='SilentlyContinue'
Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)\`t$($_.CommandLine)" }`);
    for (const line of out.split(/\r?\n/)) {
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const pid = Number(line.slice(0, tab));
      if (Number.isInteger(pid) && pid > 0) rows.push({ pid, command: line.slice(tab + 1).trim() });
    }
    return rows;
  }
  for (const line of capture("ps", ["-ww", "-axo", "pid=,command="]).split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), command: m[2] });
  }
  return rows;
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
export function localJson(port, path, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = request({ host: "127.0.0.1", port, path, timeout: timeoutMs }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (!res.statusCode || res.statusCode >= 300) return resolve(null);
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
