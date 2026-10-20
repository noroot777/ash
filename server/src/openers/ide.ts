import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { IS_WINDOWS } from "../platform.js";
import { IDE_CATALOG, type IdeSpec } from "./ide-catalog.js";

// 「用 IDE 打开这个文件夹」。清单在 ide-catalog.ts(为什么不能靠系统文件关联,见那里)。
//
// 探测只做三件事:macOS 看标准应用目录里有没有那个 .app、各平台看 PATH 上有没有那条
// 命令、Windows/Linux 再看几个固定安装位置。全是 stat,一轮下来几百次、十几毫秒,所以
// 缓存只是为了让连点几次不重复做功,不是性能必需 —— TTL 到了重探,装了新 IDE 最多等
// 半分钟就出现(界面上的「重新探测」能立刻作废)。

export interface IdeApp {
  /** 清单里的 id。启动时回传的就是它 —— 闭集,不接受调用方给路径。 */
  id: string;
  name: string;
  /** 在哪儿找到的:.app 路径或可执行文件路径。界面当副标题显示。 */
  detail: string;
}

export interface IdeProbe {
  platform: NodeJS.Platform;
  ides: IdeApp[];
  /** 一个都没找到时给用户的一句人话,找到了就是 null。 */
  note: string | null;
}

/**
 * 怎么把它拉起来。
 *
 * `app` 走 LaunchServices(只有 macOS 有),`exec` 直接起可执行文件,`winshell` 是 Windows
 * 上的 `.cmd`/`.bat` 包装器 —— **只有这一档**非过 cmd.exe 不可(Node 18.20 起直接 spawn
 * 批处理会被拒)。原生 `.exe` 不走 cmd:过一趟 cmd 就要面对它那套元字符和 `%VAR%` 展开,
 * 而 `C:\\review\\project&ver` 这种目录名是合法的。
 */
type Found = { spec: IdeSpec; kind: LaunchKind; target: string };

export type LaunchKind = "app" | "exec" | "winshell";

const MAC_APP_DIRS = [
  "/Applications",
  "/Applications/Utilities",
  "/System/Applications",
  join(homedir(), "Applications"),
];

const TTL_MS = 30_000;
let memo: { at: number; found: Found[] } | null = null;

async function isDirectory(path: string): Promise<boolean> {
  return await stat(path).then((info) => info.isDirectory(), () => false);
}

async function isExecutableFile(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return false;
  // Windows 没有执行位,能 stat 到就算数;其余平台要真的可执行,否则 PATH 上一个同名的
  // 文本文件会被当成 IDE 列出来,点下去才报错。
  if (IS_WINDOWS) return true;
  return await access(path, constants.X_OK).then(() => true, () => false);
}

type Env = Record<string, string | undefined>;

/**
 * PATH 上这条命令的候选文件名,按先后顺序。
 *
 * 跟实际的 stat 分开导出,是为了让 Windows 那半边能在**开发机上**测到:那边 `code` 实际
 * 落地成 `code.cmd`,PATHEXT 漏了或者分隔符写成冒号,症状都只是「我的 IDE 没出现」,
 * 在 macOS 上跑多少次都发现不了(跟 windows.ts 导出 registryScript 同一个理由)。
 */
export function commandCandidates(name: string, env: Env = process.env, windows = IS_WINDOWS): string[] {
  const exts = windows
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim()).filter(Boolean)
    : [""];
  // 分隔符和拼接**都**跟着 `windows` 参数走,一个都不能跟着宿主平台:`splitPathList` 和
  // `node:path.join` 认的是**当前**平台 —— 在 Windows 宿主上,非 Windows 那一档会把
  // `/usr/local/bin:/usr/bin` 当成一整个目录,再拼成 `\\usr\\local\\bin:...`。
  // 只参数化一半等于这个函数只在它自己的宿主上是对的,跨平台那一档永远验不到
  // (2026-10-20 第 2 轮审查 N2:这条断言在 Windows 真机上确实挂了)。
  const dirs = (env.PATH ?? "").split(windows ? ";" : ":").map((dir) => dir.trim()).filter(Boolean);
  const joinPath = windows ? win32.join : posix.join;
  return dirs.flatMap((dir) => exts.map((ext) => joinPath(dir, name + ext)));
}

/** PATH 上找一条命令。Windows 按 PATHEXT 补后缀(`code` 实际是 `code.cmd`)。 */
async function whichCommand(name: string): Promise<string | null> {
  for (const candidate of commandCandidates(name)) {
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * 把 `{LOCALAPPDATA}` 这类占位符换成真实目录;变量不存在就判定这条候选不可用
 * (返回 null,而不是拼出一条带 `{LOCALAPPDATA}` 字面量的假路径去 stat)。
 *
 * `env` 可注入,同样是为了能在非 Windows 机器上测 —— 这段拼接错了只会表现成「探不到」。
 */
export function expandWindowsBase(template: string, env: Env = process.env): string | null {
  const bases: Record<string, string | undefined> = {
    LOCALAPPDATA: env.LOCALAPPDATA,
    APPDATA: env.APPDATA,
    // Windows 真实的变量名是 `ProgramFiles`(驼峰),而 `process.env` 在非 Windows 上
    // 区分大小写,两种写法都认一下。
    PROGRAMFILES: env.ProgramFiles ?? env.PROGRAMFILES,
    PROGRAMFILESX86: env["ProgramFiles(x86)"] ?? env["PROGRAMFILES(X86)"],
    USERPROFILE: env.USERPROFILE ?? homedir(),
  };
  let missing = false;
  const expanded = template.replace(/\{([A-Z0-9]+)\}/g, (whole, name: string) => {
    const value = bases[name];
    if (!value) {
      missing = true;
      return whole;
    }
    return value;
  });
  // 清单里为了可读写的是正斜杠,Windows 的 API 大多也认,但拼出来的路径会在界面上原样
  // 显示给用户看——那边的人只认 `\`。
  return missing ? null : expanded.replace(/\//g, "\\");
}

async function findOne(spec: IdeSpec): Promise<Found | null> {
  if (process.platform === "darwin") {
    for (const app of spec.macApps ?? []) {
      for (const dir of MAC_APP_DIRS) {
        const path = join(dir, app);
        // .app 是个目录,不是文件 —— 这里用 isDirectory 而不是 isExecutableFile。
        if (await isDirectory(path)) return { spec, kind: "app", target: path };
      }
    }
  }
  if (process.platform === "win32") {
    for (const template of spec.windowsPaths ?? []) {
      const path = expandWindowsBase(template);
      if (path && await isExecutableFile(path)) return { spec, kind: windowsKind(path), target: path };
    }
  }
  if (process.platform === "linux") {
    for (const path of spec.linuxPaths ?? []) {
      if (await isExecutableFile(path)) return { spec, kind: "exec", target: path };
    }
  }
  for (const command of spec.commands ?? []) {
    const path = await whichCommand(command);
    if (path) return { spec, kind: IS_WINDOWS ? windowsKind(path) : "exec", target: path };
  }
  return null;
}

async function findInstalled(force: boolean): Promise<Found[]> {
  if (!force && memo && Date.now() - memo.at < TTL_MS) return memo.found;
  const results = await Promise.all(IDE_CATALOG.map((spec) => findOne(spec)));
  const found = results.filter((item): item is Found => item !== null);
  memo = { at: Date.now(), found };
  return found;
}

/** 本机装了清单里的哪些 IDE。`force` 跳过那半分钟的缓存重探一次。 */
export async function probeIdes(force = false): Promise<IdeProbe> {
  const found = await findInstalled(force);
  return {
    platform: process.platform,
    ides: found.map(({ spec, target }) => ({ id: spec.id, name: spec.name, detail: target })),
    note: found.length
      ? null
      : "没在本机找到认识的编程 IDE。装了但没列出来的话，把它的命令行工具装进 PATH（VS Code 系是「Shell Command: Install 'code' command」）就能被认出来",
  };
}

/** `.cmd` / `.bat` 只能过 cmd.exe;其余(主要是 `.exe`)直接起,不碰 shell。 */
function windowsKind(path: string): "exec" | "winshell" {
  return /\.(?:cmd|bat)$/i.test(path) ? "winshell" : "exec";
}

/**
 * Windows 批处理入口的命令行占位:路径**不拼进命令行**,只放进子进程的环境变量。
 *
 * cmd 对命令行先做元字符解析(`&` `|` `>` `^` `(` `)`)和 `%VAR%` 展开,而 Node/libuv 的
 * argv quoting 不是 cmd escaping —— 不含空格和引号的参数会原样落进命令串,于是
 * `C:\review\project&ver` 里的 `&ver` 就有机会变成第二条命令。
 *
 * 用变量绕开这两件事:`%VAR%` 的展开是**单遍**的(展开出来的内容不会再被当成变量语法
 * 重新扫描),所以路径里的 `%` 只是字面量;两侧的双引号让展开后的 `&` 之类留在参数里而
 * 不是变成命令分隔符。Windows 的文件名本来就不允许 `"`,所以没有闭合引号被撬开的路。
 * `/d` 跳过 AutoRun(用户注册表里挂的启动脚本不该混进来),`/s` 锁定「去掉首尾一对引号、
 * 中间原样」这条解析规则。
 *
 * 2026-10-20 在 Windows 真机上验过这两档:`amp&ver`、`amp&md INJECTED`、`pct%TEMP%pct`、
 * `caret^x`、`中文目录` 等目录名,经 `.cmd` 包装器和原生 `.exe` 各走一遍,启动器收到的都是
 * 原样完整路径,没有额外命令被执行。用例在 `server/scripts/test-open-in-ide.ts` 顶部有记。
 */
export const WIN_LAUNCHER_ENV = "ASH_IDE_LAUNCHER";
export const WIN_TARGET_ENV = "ASH_IDE_TARGET";

/**
 * 一次启动的结果。**「没看到失败」不等于「打开了」**,所以这里是三档不是两档:
 *  · 抛错     = 明确失败(启动器非零退出、被信号打死、进程根本没起来);
 *  · `opened` = 启动器自己以 0 退出,它说交代完了;
 *  · `launching` = 盯到窗口尽头它还活着 —— 多半就是那个编辑器进程,但**我们没有拿到
 *    任何确认**,调用方不许据此说「已打开」。
 *
 * 为什么不能把第三档当成功:直接起的可执行文件不一定是常驻 GUI,PATH 上捡到的 `code`
 * 之流是会退出的启动器,它完全可以在三秒后才失败;盯一秒半没动静就报「已用 X 打开」,
 * 用户看着一个没反应的屏幕,只会以为自己点漏了。
 */
export type LaunchStatus = "opened" | "launching";

/** 一次启动要跑的东西。跟真正 spawn 分开,是为了让 Windows 那两档在 macOS 上也测得到。 */
export interface LaunchPlan {
  file: string;
  args: string[];
  /** 额外环境变量。Windows 批处理档靠它把路径挡在命令行之外。 */
  env?: Record<string, string>;
  /** 整条命令行由我们自己写死,不让 Node 再加一层引号(只有 cmd 那档要)。 */
  verbatim: boolean;
  /**
   * 盯住它多久再下结论。**这是观察预算,不是对目标性质的断言** —— 到底是短命启动器
   * 还是常驻 GUI,由它在这段时间里退没退出来说明,不由这个字段替它回答。
   *
   * 明确是启动器的那两档(macOS 的 `open`、cmd 包装器)给足时间等退出码;直接起的进程
   * 只盯一小段「起来就夭折」的窗口,再久就是在等整个编辑器的生命周期了。
   */
  waitMs: number;
}

/** 短命启动器最多等这么久等它的退出码。到点**不杀**它。 */
const LAUNCHER_WAIT_MS = 15_000;
/** 直接起的进程只盯这一小段早夭窗口,过了就放它去跑(结论是 `launching`,不是成功)。 */
const EARLY_EXIT_WINDOW_MS = 1500;

export function launchPlan(kind: LaunchKind, target: string, absPath: string): LaunchPlan {
  if (kind === "app") {
    return { file: "open", args: ["-a", target, absPath], verbatim: false, waitMs: LAUNCHER_WAIT_MS };
  }
  if (kind === "winshell") {
    return {
      file: "cmd.exe",
      args: ["/d", "/s", "/c", `""%${WIN_LAUNCHER_ENV}%" "%${WIN_TARGET_ENV}%""`],
      env: { [WIN_LAUNCHER_ENV]: target, [WIN_TARGET_ENV]: absPath },
      verbatim: true,
      waitMs: LAUNCHER_WAIT_MS,
    };
  }
  // 原生可执行文件:路径作为一个 argv 元素交给 execvp / CreateProcess,中间没有 shell
  // 会再解释一遍,所以 `&`、`%`、空格、中文都只是文件名。
  return { file: target, args: [absPath], verbatim: false, waitMs: EARLY_EXIT_WINDOW_MS };
}

/**
 * 起一个**活过这一轮请求**的进程,并如实报出我们究竟观察到了什么。
 *
 * `spawn` 事件只证明**启动器**进程被创建了,证明不了它要做的事成功了:应用包损坏、
 * 探测之后被卸掉、权限不对、被安全软件当场打死,全都是启动器自己异常收场。
 * 三种收场各走各的出口(见 `LaunchStatus`):
 *  · 非零退出码 → 失败,带上退出码,用户才查得下去;
 *  · `code === null` → 它是**被信号打死**的,这同样是失败 —— 以前这一档跟「退出码 0」
 *    混在一个判断里,于是被 SIGTERM 终止的启动器会被报成「已打开」;
 *  · 等到窗口尽头还活着 → `launching`,**绝不 kill**:用户刚打开的编辑器不能被这条
 *    判据杀掉,但也不能冒充成功。
 *
 * `stdio:"ignore"` 保留着:管道会把它绑回服务端,重启 ash 就会连它一起带走。
 */
function launch(plan: LaunchPlan, name: string): Promise<LaunchStatus> {
  return new Promise((resolve, reject) => {
    const child = spawn(plan.file, plan.args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      ...(plan.verbatim ? { windowsVerbatimArguments: true } : {}),
      ...(plan.env ? { env: { ...process.env, ...plan.env } } : {}),
    });
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const done = (status: LaunchStatus) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.unref();
      resolve(status);
    };
    const timer = setTimeout(() => done("launching"), plan.waitMs);
    timer.unref();
    child.once("error", fail);
    child.once("exit", (code, signal) => {
      if (code === 0) return done("opened");
      const how = code === null ? `被信号 ${signal} 终止` : `以退出码 ${code} 退出`;
      fail(new Error(
        `${name} 没能打开：启动器${how}。`
        + "它可能已经被卸载、安装损坏，或者这台机器不允许它启动",
      ));
    });
  });
}

/**
 * 用指定 IDE 打开一个目录(给文件路径也行,IDE 自己会处理)。
 *
 * `ideId` 必须出现在探测结果里 —— 跟 openWithApp 同一个道理:这个端点等于「按名字启动
 * 本机程序」,不校验就是把任意可执行文件的启动入口开在了 HTTP 上。这里更严一档,因为
 * id 来自写死的清单,连「探到过的路径」都不接受。
 */
export async function openInIde(
  ideId: string,
  absPath: string,
): Promise<{ name: string; status: LaunchStatus }> {
  const found = (await findInstalled(false)).find((item) => item.spec.id === ideId)
    // 缓存里没有可能只是它刚装上,重探一次再说没有。
    ?? (await findInstalled(true)).find((item) => item.spec.id === ideId);
  if (!found) {
    throw Object.assign(new Error("这个 IDE 不在本机已探测到的清单里"), { status: 400 });
  }
  const status = await launch(launchPlan(found.kind, found.target, absPath), found.spec.name);
  return { name: found.spec.name, status };
}
