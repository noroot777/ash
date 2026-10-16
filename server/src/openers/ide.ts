import { spawn } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { IS_WINDOWS, splitPathList } from "../platform.js";
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

/** 怎么把它拉起来。`app` 走 LaunchServices(只有 macOS 有),`exec` 直接起可执行文件。 */
type Found = { spec: IdeSpec; kind: "app" | "exec" | "winstart"; target: string };

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

/** PATH 上找一条命令。Windows 按 PATHEXT 补后缀(`code` 实际是 `code.cmd`)。 */
async function whichCommand(name: string): Promise<string | null> {
  const exts = IS_WINDOWS
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const dir of splitPathList(process.env.PATH)) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext);
      if (await isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

/** 把 `{LOCALAPPDATA}` 这类占位符换成真实目录;变量不存在就判定这条候选不可用。 */
function expandWindowsBase(template: string): string | null {
  const bases: Record<string, string | undefined> = {
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
    PROGRAMFILES: process.env.ProgramFiles ?? process.env.PROGRAMFILES,
    PROGRAMFILESX86: process.env["ProgramFiles(x86)"] ?? process.env["PROGRAMFILES(X86)"],
    USERPROFILE: process.env.USERPROFILE ?? homedir(),
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
      if (path && await isExecutableFile(path)) {
        // .cmd / .bat 不能直接 spawn(Node 18.20+ 起直接拒),统一交给 `cmd /c start`。
        return { spec, kind: "winstart", target: path };
      }
    }
  }
  if (process.platform === "linux") {
    for (const path of spec.linuxPaths ?? []) {
      if (await isExecutableFile(path)) return { spec, kind: "exec", target: path };
    }
  }
  for (const command of spec.commands ?? []) {
    const path = await whichCommand(command);
    if (path) return { spec, kind: IS_WINDOWS ? "winstart" : "exec", target: path };
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

/**
 * 起一个**活过这一轮请求**的进程。
 *
 * 不能用 execFile 等它退出:IDE 是 GUI 程序,拉起来就一直在,带 timeout 的 exec 会在
 * 15 秒后把用户刚打开的编辑器杀掉。`detached + stdio:"ignore"` 还顺带斩断了跟服务端的
 * 管道绑定 —— 否则重启 ash 会把它一起带走。
 *
 * 换来的代价是只认得出「没能起来」(ENOENT 一类),认不出「起来了但自己失败退出」。
 * 对这个用途够了:target 是刚 stat 过的真实路径。
 */
function launchDetached(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
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
export async function openInIde(ideId: string, absPath: string): Promise<{ name: string }> {
  const found = (await findInstalled(false)).find((item) => item.spec.id === ideId)
    // 缓存里没有可能只是它刚装上,重探一次再说没有。
    ?? (await findInstalled(true)).find((item) => item.spec.id === ideId);
  if (!found) {
    throw Object.assign(new Error("这个 IDE 不在本机已探测到的清单里"), { status: 400 });
  }
  if (found.kind === "app") await launchDetached("open", ["-a", found.target, absPath]);
  else if (found.kind === "winstart") await launchDetached("cmd", ["/c", "start", "", found.target, absPath]);
  else await launchDetached(found.target, [absPath]);
  return { name: found.spec.name };
}
