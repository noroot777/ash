import { execFile } from "node:child_process";
import { dirname, extname } from "node:path";
import { execFileText as exec } from "../exec.js";
import { linuxOpenCommand, linuxRevealCommand, probeLinuxOpeners } from "./linux.js";
import { macOpenCommand, macRevealCommand, probeMacOpeners } from "./macos.js";
import { probeWindowsOpeners, windowsOpenCommand } from "./windows.js";
import type { OpenerProbe } from "./types.js";

export type { AppOpener, OpenerProbe } from "./types.js";

interface Command {
  file: string;
  args: string[];
  fallback?: { file: string; args: string[] } | null;
}

/** 本机上哪些应用能打开这个文件。`force` 跳过应用清单缓存重扫一次。 */
export async function probeOpeners(absPath: string, force = false): Promise<OpenerProbe> {
  const ext = extname(absPath).replace(/^\./, "").toLowerCase();
  if (process.platform === "darwin") return probeMacOpeners(absPath, ext, force);
  if (process.platform === "linux") return probeLinuxOpeners(absPath);
  if (process.platform === "win32") return probeWindowsOpeners(ext, force);
  return {
    platform: process.platform,
    canReveal: false,
    apps: [],
    note: "这个平台还没做应用探测，只能用系统默认方式打开",
  };
}

async function run(command: Command): Promise<void> {
  try {
    await exec(command.file, command.args, { timeout: 15000 });
  } catch (error) {
    if (!command.fallback) throw error;
    await exec(command.fallback.file, command.fallback.args, { timeout: 15000 });
  }
}

/** 在系统文件管理器里定位这个文件（能选中就选中，不能就打开所在目录）。 */
export async function revealInFileManager(absPath: string): Promise<void> {
  if (process.platform === "darwin") return run(macRevealCommand(absPath));
  if (process.platform === "win32") {
    // explorer 定位成功时退出码也是 1，所以这条不看退出码。
    return void execFile("explorer.exe", [`/select,${absPath}`], { windowsHide: true }, () => {});
  }
  if (process.platform === "linux") return run(linuxRevealCommand(absPath, dirname(absPath)));
  throw new Error(`${process.platform} 上没有可用的「在文件夹中显示」`);
}

/**
 * 用指定应用打开文件；`appId` 为空走系统默认。
 *
 * appId 必须先在这个文件的探测结果里出现过 —— 这个端点等于「按名字启动本机
 * 程序」，不校验就是把任意可执行文件的启动入口开在了 HTTP 上。
 */
export async function openWithApp(absPath: string, appId: string | null): Promise<void> {
  if (appId) {
    const probe = await probeOpeners(absPath);
    if (!probe.apps.some((app) => app.id === appId)) {
      throw Object.assign(
        new Error("这个应用不在本机可打开该文件的清单里"),
        { status: 400 }, // 是请求不对，不是服务器出错
      );
    }
  }
  if (process.platform === "darwin") return run(macOpenCommand(absPath, appId));
  if (process.platform === "linux") return run(linuxOpenCommand(absPath, appId));
  if (process.platform === "win32") {
    return run(await windowsOpenCommand(absPath, extname(absPath).replace(/^\./, "").toLowerCase(), appId));
  }
  throw new Error(`${process.platform} 上没有可用的打开方式`);
}
