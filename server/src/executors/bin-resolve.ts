// 「裸命令名 → 真正能 spawn 的东西」的单点。检测(bin-probe)和执行(spawnAgent /
// spawnDetachedAgent)必须共用这里,否则就是「目录显示可用、派任务却 ENOENT」。
//
// POSIX 上这件事很短:扫 PATH,`access(X_OK)`,拿到路径直接 spawn。
// Windows 上同一件事有四个坑,每个都会让所有 CLI「全部找不到」:
//  ① PATH 的分隔符是 `;` 不是 `:`。按 `:` 拆会把 `C:\Users\…` 从盘符处切两半,
//     拆出来的每一段都是不存在的目录 —— 症状是「一个 CLI 都探测不到」。
//  ② 命令名没有扩展名。PATH 里躺的是 `claude.cmd` / `node.exe`,拿 `claude` 去
//     join 永远 stat 不到,得按 PATHEXT 逐个试。
//  ③ `accessSync(_, X_OK)` 在 Windows 上**恒为真**(ACL 不走这套),拿它当
//     「这是个可执行文件」用等于没判 —— 会把目录、txt 全认成命令。判据换成
//     「是个文件」+「扩展名在 PATHEXT 里」。
//  ④ 判「这是路径不是命令名」不能只看 `/`,Windows 的分隔符是 `\`。
//
// 还有第五件事不是坑而是设计选择:npm 装的 CLI 在 Windows 上是 `.cmd` 垫片,
// 而 Node 自 CVE-2024-27980 起拒绝直接 spawn 批处理。见 unwrapNpmShim。

import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { IS_WINDOWS, PATH_DELIMITER, boundaryKey, splitPathList, splitPathSegments } from "../platform.js";
import { cmdExeLaunch } from "./win-command.js";

// server 从 GUI / 预览启动(不是登录 shell)时,PATH 常常缺 CLI 所在的目录,
// 症状是 `spawn claude ENOENT`。补上各平台常见的安装位置。
function extraPaths(): string[] {
  const home = homedir();
  if (!IS_WINDOWS) {
    return [
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      `${home}/.local/bin`,
      `${home}/.bun/bin`,
      `${home}/.deno/bin`,
    ];
  }
  const { APPDATA, LOCALAPPDATA, ProgramFiles, ChocolateyInstall } = process.env;
  // `Program Files` 在 Windows 上不止一个:ARM64 机器上原生 ARM 程序在 `Program Files`、
  // x64 程序在 `Program Files (x86)`、32 位 ARM 在 `Program Files (Arm)`,而 `%ProgramFiles%`
  // 只指向**与当前进程架构相同**的那一个 —— 一个 x64 版 node 起的 harness,看不见装在
  // 原生 ARM 目录里的 node/CLI。三个都扫,不存在的目录 resolveBin 自会跳过。
  const programFiles = [ProgramFiles, process.env["ProgramFiles(x86)"], process.env["ProgramFiles(Arm)"]];
  return [
    APPDATA && join(APPDATA, "npm"), // npm -g 的垫片就装在这里
    LOCALAPPDATA && join(LOCALAPPDATA, "pnpm"),
    LOCALAPPDATA && join(LOCALAPPDATA, "Microsoft", "WindowsApps"),
    join(home, ".bun", "bin"),
    join(home, ".deno", "bin"),
    join(home, ".local", "bin"),
    join(home, "scoop", "shims"),
    ...programFiles.map((dir) => dir && join(dir, "nodejs")),
    ChocolateyInstall ? join(ChocolateyInstall, "bin") : "C:\\ProgramData\\chocolatey\\bin",
  ].filter((p): p is string => Boolean(p));
}

const PATH_SEP = PATH_DELIMITER;

/**
 * 把补充目录并进 PATH。
 *
 * Windows 上额外做一件事:**先删掉所有大小写变体的 PATH 键**。Windows 的环境变量名
 * 大小写不敏感,而 `process.env` 里的键通常是 `Path`;直接 `{...process.env, PATH: x}`
 * 会让子进程同时拿到 `Path` 和 `PATH` 两个键,谁生效由实现决定 —— 那等于 PATH 补丁
 * 时灵时不灵。
 */
export function augmentedEnv(): NodeJS.ProcessEnv {
  const cur = process.env.PATH ?? "";
  const have = new Set(splitPathList(cur).map(boundaryKey));
  const extra = extraPaths().filter((p) => !have.has(boundaryKey(p)));
  const merged = extra.length ? `${cur}${PATH_SEP}${extra.join(PATH_SEP)}` : cur;
  if (!IS_WINDOWS) return { ...process.env, PATH: merged };
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toLowerCase() !== "path") out[k] = v;
  }
  out.PATH = merged;
  return out;
}

// PATHEXT 的**顺序就是优先级**(cmd.exe 也按它挑),默认把 .EXE 排在 .CMD 前面 ——
// 正合我们意:原生 exe 能直接 spawn,批处理还得绕一圈。
function pathExts(): string[] {
  const raw = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
  return raw.split(";").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isExecutableFile(p: string): boolean {
  if (IS_WINDOWS) return isFile(p);
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function hasSeparator(bin: string): boolean {
  return bin.includes("/") || (IS_WINDOWS && bin.includes("\\"));
}

/** 把「带路径的命令」拆成目录 + 文件名。两种分隔符都认(Windows 上都合法)。 */
function splitDir(bin: string): { dir: string; base: string } {
  const idx = Math.max(bin.lastIndexOf("/"), IS_WINDOWS ? bin.lastIndexOf("\\") : -1);
  return idx < 0 ? { dir: ".", base: bin } : { dir: bin.slice(0, idx) || bin.slice(0, idx + 1), base: bin.slice(idx + 1) };
}

/** 一个目录下这个命令名的所有候选文件名,按优先级排。 */
function candidatesIn(dir: string, bin: string): string[] {
  if (!IS_WINDOWS) return [join(dir, bin)];
  const exts = pathExts();
  const own = extname(bin).toLowerCase();
  // 已经带了 PATHEXT 里的扩展名(`node.exe`)就只试它自己,不要再拼出 `node.exe.cmd`。
  if (own && exts.includes(own)) return [join(dir, bin)];
  return exts.map((ext) => join(dir, bin + ext));
}

/**
 * 命中的可执行文件绝对路径,找不到返回 null。
 * **只回答「在不在」**,不回答「怎么起」—— 批处理垫片能被这个函数找到,却不能直接
 * spawn。要起进程一律走 resolveLaunch。
 */
export function resolveBin(bin: string): string | null {
  if (hasSeparator(bin)) {
    if (isExecutableFile(bin)) return bin;
    // 带路径但没写扩展名(`C:\tools\claude`)在 Windows 上同样要试 PATHEXT。
    if (IS_WINDOWS) {
      const { dir, base } = splitDir(bin);
      for (const c of candidatesIn(dir, base)) {
        if (isFile(c)) return c;
      }
    }
    return null;
  }
  const dirs = [...splitPathList(process.env.PATH), ...extraPaths()];
  for (const d of dirs) {
    for (const c of candidatesIn(d, bin)) {
      if (isExecutableFile(c)) return c;
    }
  }
  return null;
}

// ── npm 垫片拆封 ───────────────────────────────────────────────────────────
// npm 在 Windows 上给每个 bin 生成一个 `.cmd`,最后一行长这样:
//   … & "%_prog%"  "%dp0%\node_modules\@anthropic-ai\claude-code\cli.js" %*
// 把那条脚本路径挖出来,就能 `node <script>` 直接跑,cmd.exe 全程不参与 ——
// 没有二次解析,也就没有转义风险。挖不出来才退到 cmd.exe(见 win-command.ts)。
//
// 用的是**本 harness 进程的 node**(process.execPath),不是垫片里那个 `%_prog%`。
// 绝大多数情况下两者是同一个(Node 官方安装器把 node.exe 和 npm 全局 bin 放在同
// 一个目录);不同的话,CLI 会跑在 harness 的 node 版本上 —— 记在这里,真出现
// 版本不兼容时先查这一条。
const SHIM_SCRIPT = /"%~?dp0%?\\{1,2}([^"]+\.(?:js|mjs|cjs))"/i;
const shimCache = new Map<string, string | null>();

function unwrapNpmShim(cmdPath: string): string | null {
  let mtime = 0;
  try {
    mtime = statSync(cmdPath).mtimeMs;
  } catch {
    return null;
  }
  const key = `${cmdPath}:${mtime}`;
  const cached = shimCache.get(key);
  if (cached !== undefined) return cached;
  let script: string | null = null;
  try {
    const m = SHIM_SCRIPT.exec(readFileSync(cmdPath, "utf8"));
    if (m) {
      // 垫片里写的是反斜杠路径,按两种分隔符一起切再重拼 —— 这样这段逻辑跟
      // 「宿主机的 path.sep 是什么」解耦,测试里能翻转平台验。
      const abs = join(splitDir(cmdPath).dir, ...splitPathSegments(m[1]!));
      if (isFile(abs)) script = abs;
    }
  } catch {
    /* 读不动就当拆不开 */
  }
  shimCache.set(key, script);
  return script;
}

export type LaunchPlan = {
  /** 磁盘上命中的那个文件,用于展示/日志(可能是垫片本身)。 */
  path: string;
  file: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
};

/**
 * 把「命令名 + 参数」变成 spawn 真正要用的三件套。找不到命令返回 null。
 * 抛错只有一种情况:Windows 上必须过 cmd.exe、而某个参数带换行(无法安全转义)。
 */
export function resolveLaunch(bin: string, args: string[]): LaunchPlan | null {
  const path = resolveBin(bin);
  if (!path) return null;
  if (!IS_WINDOWS) return { path, file: path, args };
  const ext = extname(path).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") return { path, file: path, args };
  const script = unwrapNpmShim(path);
  if (script) return { path, file: process.execPath, args: [script, ...args] };
  return { path, ...cmdExeLaunch(path, args) };
}
