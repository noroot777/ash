import { execFileText as exec } from "./exec.js";

// ── 「删掉的东西去哪儿」 ─────────────────────────────────────────────────────
//
// 页面上的删除默认是**移到系统废纸篓**，不是 unlink：ash 不做自己的回收站（系统那个
// 用户本来就会用，也只有它能在访达/资源管理器里「放回原处」），但也不能假装删除可逆。
// 所以这里只回答两件事：这台机器上有没有可用的废纸篓、把某个绝对路径送进去。
//
// **探测只看工具在不在，不做试删**：真试一次就得在用户的废纸篓里留一个自检垃圾文件，
// 每个服务进程一份。所以能力是「乐观」的——真正送进去失败时由路由如实报错，前端据此
// 提供「永久删除」那一档（要抄名字），绝不把失败悄悄升级成不可逆的删除。
//
// win32 这一档**刻意留空**：回收站得走 PowerShell 的 `Microsoft.VisualBasic.FileIO`，
// 而根 `AGENTS.md` 写明碰 win32 分支必须上 192.168.1.187 真跑一遍再交付，本轮那台机器
// 不可达（`curl :4317` 无响应）。与其交一段「读着像对」的代码，不如明说没有——Windows
// 上删除照样能用，只是走永久删除那一档，对话框会要求抄名字。

export interface TrashCapability {
  available: boolean;
  /** 给用户看的去向名，例如「系统废纸篓」。不可用时是 null。 */
  label: string | null;
  /** 不可用的原因，直接进对话框。 */
  reason: string | null;
}

const UNAVAILABLE_WINDOWS: TrashCapability = {
  available: false,
  label: null,
  reason: "Windows 回收站通道还没在真机上验证过，这里只提供永久删除",
};

const CACHE_MS = 60_000;
let cached: { at: number; value: TrashCapability } | null = null;

async function onPath(command: string): Promise<boolean> {
  try {
    // `command -v` 是 POSIX 的，比 which 更可靠（有些发行版没装 which）。
    await exec("/bin/sh", ["-c", `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
}

async function probe(): Promise<TrashCapability> {
  if (process.platform === "darwin") {
    return { available: true, label: "系统废纸篓", reason: null };
  }
  if (process.platform === "win32") return UNAVAILABLE_WINDOWS;
  if (await onPath("gio")) return { available: true, label: "系统回收站", reason: null };
  if (await onPath("trash-put")) return { available: true, label: "系统回收站", reason: null };
  return {
    available: false,
    label: null,
    reason: "这台机器上没找到 gio 或 trash-put（trash-cli），没有可用的回收站",
  };
}

export async function trashCapability(): Promise<TrashCapability> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const value = await probe();
  cached = { at: Date.now(), value };
  return value;
}

/** 测试用：清掉探测缓存。 */
export function resetTrashCapability(): void {
  cached = null;
}

export class TrashUnavailableError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "TrashUnavailableError";
  }
}

/**
 * 把一个绝对路径送进系统废纸篓。失败一律抛 `TrashUnavailableError`——调用方**不许**
 * 因此改走永久删除：用户点的是「移到废纸篓」，悄悄换成不可逆的删除是另一件事。
 *
 * macOS 走访达（唯一能进废纸篓并带「放回原处」的通道）。路径经 `argv` 传给 AppleScript
 * 而不是拼进脚本文本：文件名里的引号、反斜杠在脚本里是注入面，在 argv 里只是字节。
 */
export async function moveToTrash(absPath: string): Promise<void> {
  const capability = await trashCapability();
  if (!capability.available) throw new TrashUnavailableError(capability.reason ?? "这台机器上没有可用的废纸篓");

  const fail = (error: unknown): never => {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new TrashUnavailableError(`移到${capability.label ?? "废纸篓"}失败：${detail}`);
  };

  if (process.platform === "darwin") {
    try {
      await exec("osascript", [
        "-e", "on run argv",
        "-e", 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)',
        "-e", "end run",
        absPath,
      ]);
    } catch (error) {
      return fail(error);
    }
    return;
  }

  try {
    if (await onPath("gio")) await exec("gio", ["trash", "--", absPath]);
    else await exec("trash-put", ["--", absPath]);
  } catch (error) {
    return fail(error);
  }
}
