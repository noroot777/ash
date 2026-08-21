import type { Hono } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { realpath } from "node:fs/promises";
import { resolve, dirname, sep } from "node:path";
import { db } from "./db/index.js";
import { projects } from "./db/schema.js";
import { expandHome } from "./git.js";
import { openWithApp } from "./openers/index.js";
import { isInsidePath, splitPathList, windowsPathRejection } from "./platform.js";

// 额外放行的目录。**默认空**:原来写死的两条(`/Users/fjh/code/daily-report/videos`、
// `/Users/fjh/code/ash/review`)都落在已注册项目的仓库路径底下,
// registeredProjectRoots() 本来就覆盖着它们 —— 写死在源码里只是让别人 clone 下来多两
// 条不存在的目录,外加一个人的用户名。要加别的目录走 ASH_LOCAL_OPEN_ROOTS。
//
// 分隔符走 splitPathList(PATH_DELIMITER),**不能写死 ":"** —— Windows 上那会把
// `C:\videos` 从盘符处切成 `C` 和 `\videos` 两条都不存在的路径。
const CONFIGURED_ROOTS = splitPathList(process.env.ASH_LOCAL_OPEN_ROOTS)
  .map((path) => resolve(expandHome(path)));

export function isTrustedLocalOpenRemote(address: string | undefined): boolean {
  const normalized = (address ?? "").replace(/^::ffff:/i, "");
  if (normalized === "127.0.0.1" || normalized === "::1") return true;
  if (normalized.toLowerCase().startsWith("fd7a:115c:a1e0:")) return true;
  const tailscaleV4 = /^100\.(\d+)\./.exec(normalized);
  return tailscaleV4 !== null && Number(tailscaleV4[1]) >= 64 && Number(tailscaleV4[1]) <= 127;
}

/**
 * Resolve symlinks on both sides so a link inside an allowed repo cannot escape it.
 *
 * 白名单比较交给 platform.ts 的 isInsidePath:Windows 上 `C:\Repo` 和 `c:\repo` 是
 * **同一个目录**,而 `startsWith` 只按字节比 —— 大小写一差,放行的目录当场变成越界,
 * 用户只会看到「打不开」。反过来同样致命:NTFS 不区分大小写意味着攻击者可以用
 * `C:\repo\..\Windows` 这种拼法试探,所以两侧都得先 realpath 再比。
 *
 * windowsPathRejection 拦的是 realpath 之后**仍然**危险的两类写法:UNC
 * (`\\server\share` —— 会让这个端点变成「打开任意网络位置」)和残留的 8.3 短名
 * (`PROGRA~1` —— 绕过前缀比较的经典手法)。放在 realpath 之后是因为大多数短名
 * 会被 realpath 展开成长名,剩下拦不住的才是真需要拒的。
 */
export async function resolveAllowedLocalPath(raw: string, roots: string[]): Promise<string | null> {
  if (!raw.trim()) return null;
  const target = await realpath(resolve(expandHome(raw))).catch(() => null);
  if (!target) return null;
  if (windowsPathRejection(target)) return null;
  for (const root of roots) {
    const allowed = await realpath(resolve(expandHome(root))).catch(() => null);
    if (allowed && isInsidePath(allowed, target, sep)) return target;
  }
  return null;
}

export async function registeredProjectRoots(): Promise<string[]> {
  const rows = await db.select({ repoPath: projects.repoPath }).from(projects);
  return rows
    .map(({ repoPath }) => expandHome(repoPath).trim())
    .filter(Boolean)
    .map((repoPath) => resolve(repoPath))
    // A registered filesystem root would make this opener unrestricted, so it is not an implicit project root.
    // 判据用 `dirname(p) === p` 而不是 `p !== sep`:Windows 上文件系统根是 `C:\`(还有
    // 每个盘一个),`\` 那个字面量在那边谁都不等于,等于这道闸整个失效。
    .filter((path) => dirname(path) !== path);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

export function mountLocalOpenRoutes(api: Hono): void {
  api.all("/open-local", async (c) => {
    if (!isTrustedLocalOpenRemote(getConnInfo(c).remote.address)) {
      return c.text("只允许本机或 Tailscale 网内设备调用 open-local", 403);
    }
    const target = await resolveAllowedLocalPath(
      c.req.query("path") ?? "",
      [...CONFIGURED_ROOTS, ...await registeredProjectRoots()],
    );
    if (!target) {
      return c.text("local path is missing, outside the allowlist, or does not exist", 400);
    }
    // 走 openers 的统一入口而不是写死 `open`:那个名字只有 macOS 有,Windows 要
    // `cmd /c start`、Linux 要 xdg-open。appId 传 null = 系统默认程序,不经过应用
    // 清单校验(这里本来也没让调用方指定用哪个应用)。
    try {
      await openWithApp(target, null);
    } catch (error) {
      return c.text(`打开失败:${error instanceof Error ? error.message : String(error)}`, 500);
    }
    return c.html(
      `<!doctype html><meta charset=utf-8><title>Opened</title>`
      + `<body style="font:14px -apple-system,system-ui,sans-serif;padding:20px">已打开：<code>${escapeHtml(target)}</code></body>`,
    );
  });
}
