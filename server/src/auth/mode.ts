// 实例模式(自用 / 多人)的读取与转换,以及根目录 / 每人目录的路径原语。
//
// 模式读得非常频繁(每个请求的中间件都要问一次),所以在进程内缓存:它只会被
// `POST /api/auth/setup` 改一次,改完主动失效。**不做定时刷新** —— 一个装了两台
// server 共用一份库的场景本来就被 singleton.ts 挡死了。
import { mkdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { InstanceMode } from "@ash/shared";
import { userDirNameError } from "@ash/shared/multiuser";
import { getAppSettings, writeSystemSetting } from "../app-settings.js";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { expandHome } from "../git.js";
import { isInsidePath, windowsPathRejection } from "../platform.js";
import { setMultiUserFlag } from "./multi-flag.js";

let cached: { mode: InstanceMode | ""; rootDir: string } | null = null;
// 见 needsSetup:一旦见过能登录的人就不再查库(authGate 每个请求都要问一次)。
let sawLoginableUser = false;

export async function instanceConfig(): Promise<{ mode: InstanceMode | ""; rootDir: string }> {
  if (cached) return cached;
  const settings = await getAppSettings();
  cached = { mode: settings.instanceMode, rootDir: settings.rootDir };
  // spawn 那条同步路径靠这一位判断要不要清出站凭证(见 multi-flag.ts)。
  setMultiUserFlag(cached.mode === "multi");
  return cached;
}

export function invalidateInstanceConfig(): void {
  cached = null;
  sawLoginableUser = false;
}

/** 多人模式?这是所有闸的总开关。 */
export async function isMultiUser(): Promise<boolean> {
  return (await instanceConfig()).mode === "multi";
}

/**
 * 首启向导要不要出。两种情形:
 *  ① 模式还没定过 —— 真正的首启。
 *  ② 模式已经是 multi,却**一个能登录的人都没有** —— 转换中途崩了(建人失败、进程被
 *     杀、磁盘出问题)。这时实例是锁死的:`needsSetup:false` 会把向导藏起来,而唯一的
 *     管理员没有 key,谁也进不来,只能手改库。`middleware.ts` 的 authGate 早就写着
 *     「放行 setup 让它补完」,但判据一直只有 ① —— 那句注释在第 1 轮审查里被证明是空头
 *     支票(P0)。这里把它兑现。
 *
 * ② 的探测**只在没见过可登录用户时查库**:authGate 每个请求都要问一次,而这一位一旦
 * 为真就再也不会翻回去(登录不了的实例不可能自己长出用户)。见 `sawLoginableUser`。
 */
export async function needsSetup(): Promise<boolean> {
  const mode = (await instanceConfig()).mode;
  if (mode === "") return true;
  if (mode !== "multi" || sawLoginableUser) return false;
  const rows = await db.select({ keyHash: users.keyHash, status: users.status }).from(users);
  sawLoginableUser = rows.some((u) => u.keyHash && u.status !== "suspended");
  return !sawLoginableUser;
}

export async function rootDirOf(): Promise<string> {
  return (await instanceConfig()).rootDir;
}

/**
 * 写定模式。**只允许 `"" → single`、`"" → multi`、`single → multi`,外加
 * `multi → multi` 的幂等补做**;多人转回自用永不提供(多人数据无法合并回单人,§二)。
 *
 * 之所以要放行 multi→multi:转换中途崩掉的实例(模式已落、管理员没建出来)只能靠
 * 重走一遍向导救回来,而那一遍必然会再写一次同样的模式。根目录仍然锁死,所以这条
 * 补做路径改不了任何已定的东西。
 */
export async function setInstanceMode(mode: InstanceMode, rootDir: string): Promise<void> {
  const current = await instanceConfig();
  if (current.mode === "multi" && mode !== "multi") throw new Error("多人模式不能转回自用模式");
  if (mode === "multi") {
    if (current.rootDir && current.rootDir !== rootDir) {
      throw new Error("根目录设定后锁死，不能修改（一改所有已建项目路径失效）");
    }
    await writeSystemSetting("rootDir", rootDir);
  }
  await writeSystemSetting("instanceMode", mode);
  invalidateInstanceConfig();
  await instanceConfig(); // 立刻回填同步镜像,别等下一个请求
}

// ── 根目录与每人目录 ────────────────────────────────────────────────────────

/**
 * 根目录路径校验。它是**磁盘上一个真实目录**,而且会成为所有用户目录的父。
 * 不存在就建出来(转换向导里填一个还不存在的路径是很自然的动作)。
 */
export function prepareRootDir(input: string): string {
  const raw = (input ?? "").trim();
  if (!raw) throw Object.assign(new Error("根目录必填"), { status: 400 });
  const abs = resolve(expandHome(raw));
  if (windowsPathRejection(abs)) {
    throw Object.assign(new Error("根目录不能用 UNC / 8.3 短名路径"), { status: 400 });
  }
  if (existsSync(abs)) {
    if (!statSync(abs).isDirectory()) {
      throw Object.assign(new Error(`这个路径被一个文件占着：${abs}`), { status: 409 });
    }
  } else {
    try {
      mkdirSync(abs, { recursive: true });
    } catch (e) {
      throw Object.assign(new Error(`建不出根目录 ${abs}：${(e as Error).message}`), { status: 400 });
    }
  }
  return abs;
}

/** `rootDir/<dirName>`。目录名已在建用户时校验过,这里只拼。 */
export async function userHomeDir(dirName: string): Promise<string> {
  const root = await rootDirOf();
  if (!root) throw new Error("根目录还没设定");
  return join(root, dirName);
}

/**
 * 建用户目录,根目录显式给。首启向导需要这个版本:**目录要在落库之前就建出来**,
 * 而那一刻 rootDir 还没写进 app_settings(先落库再建目录的顺序会在磁盘出问题时
 * 留下一个进不去的实例 / 一个补不回的用户,见两处调用点的注释)。
 */
export function ensureHomeDirUnder(rootDir: string, dirName: string): string {
  const error = userDirNameError(dirName);
  if (error) throw Object.assign(new Error(error), { status: 400 });
  const dir = join(rootDir, dirName);
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory()) {
      throw Object.assign(new Error(`这个路径被一个文件占着：${dir}`), { status: 409 });
    }
    return dir;
  }
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw Object.assign(new Error(`建不出目录 ${dir}：${(e as Error).message}`), { status: 500 });
  }
  return dir;
}

/** 建用户时创建他的目录。已存在就复用(管理员可能先在磁盘上准备好了)。 */
export async function ensureUserHomeDir(dirName: string): Promise<string> {
  const root = await rootDirOf();
  if (!root) throw new Error("根目录还没设定");
  return ensureHomeDirUnder(root, dirName);
}

/**
 * 路径钳制:`candidate` 必须落在 `home` **之内**,且**不能是 home 本身**。
 *
 * 「不能是 home 本身」是 §七/§九 的硬要求:项目目录里会长出 `.ash`、worktree 这类
 * 东西,把用户目录根注册成项目会把整片区域污染成一个仓库,之后每建一个子项目都在
 * 它的工作区里。
 *
 * 比较一律走 platform.ts 的 isInsidePath(NTFS 大小写不敏感,裸 startsWith 既误拒
 * 又是绕过面),UNC / 8.3 短名单独由 windowsPathRejection 拒掉 —— 与 file-browser.ts
 * 的 resolveInRoot 是同一套原语,别另写一份。
 */
export function pathClampError(home: string, candidate: string): string | null {
  const homeAbs = resolve(home);
  const target = resolve(candidate);
  if (windowsPathRejection(target)) return "不接受 UNC / 8.3 短名路径";
  if (target === homeAbs) return "不能把你的目录根本身注册成项目，请用它下面的一个子目录";
  if (!isInsidePath(homeAbs, target, sep)) return `路径必须在你的目录内：${homeAbs}`;
  return null;
}

/**
 * 解析 realpath 之后再钳一次 —— 目录里一条指向外面的软链就是现成的越狱通道
 * (判据同 file-browser.ts)。目标还不存在时退而检查它的父目录。
 */
export async function realPathClampError(home: string, candidate: string): Promise<string | null> {
  const direct = pathClampError(home, candidate);
  if (direct) return direct;
  const { realpath } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  const homeAbs = resolve(home);
  const realHome = await realpath(homeAbs).catch(() => null);
  if (!realHome) return `你的目录还不在磁盘上：${homeAbs}`;
  const target = resolve(candidate);
  const realTarget = await realpath(target).catch(() => null);
  if (realTarget) {
    if (realTarget === realHome) return "不能把你的目录根本身注册成项目，请用它下面的一个子目录";
    return isInsidePath(realHome, realTarget, sep) ? null : `路径必须在你的目录内：${homeAbs}`;
  }
  const realParent = await realpath(dirname(target)).catch(() => null);
  if (!realParent) return `父目录不存在：${dirname(target)}`;
  // 父目录 === home 是允许的（在自己目录下新建一个子目录当项目）。
  if (realParent !== realHome && !isInsidePath(realHome, realParent, sep)) {
    return `路径必须在你的目录内：${homeAbs}`;
  }
  return null;
}
