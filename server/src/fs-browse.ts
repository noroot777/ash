// 「在我的目录里挑一个位置」的只读浏览端点(§七 web 目录树选择器)。
//
// 为什么另开一条而不是复用 `POST /host/pick-directory`:那条把**服务端桌面**上的原生
// 目录窗口弹出来,选到的是整台机器的文件系统,而且只有本机浏览器用得上。多人模式下
// 它是实例管理员的工具(dir-picker.ts 已就地拦掉),普通用户需要的是一个能在浏览器里
// 走、且**只在自己目录内**走的目录树。
//
// 钳制不自己写:路径判据全部走 auth/path-scope.ts,与建项目、克隆、MCP 那三条入口
// 是同一份 —— 分头写一定会在某个入口上宽半格,而宽半格的那个入口就是护栏的缺口。
import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { Context, Hono } from "hono";
import { expandHome } from "./git.js";
import { actorOf } from "./auth/context.js";
import { isMultiUser, rootDirOf } from "./auth/mode.js";
import { pathScopeOf, projectPathRejection } from "./auth/path-scope.js";

export interface BrowseEntry {
  name: string;
  path: string;
  /** 里面还有没有子目录 —— 树控件据此决定要不要画展开箭头。 */
  hasChildren: boolean;
  /** 已经是个 git 仓库(可以直接登记成项目)。 */
  isRepo: boolean;
}

async function listDirs(dir: string): Promise<BrowseEntry[]> {
  const items = await readdir(dir, { withFileTypes: true });
  const out: BrowseEntry[] = [];
  for (const item of items) {
    if (!item.isDirectory()) continue;
    // 点开头的目录一律不列:`.git`、`.ash`、`node_modules` 这类既不是用户想选的
    // 位置,又会把树撑成几千行。
    if (item.name.startsWith(".") || item.name === "node_modules") continue;
    const full = join(dir, item.name);
    let hasChildren = false;
    let isRepo = false;
    try {
      const children = await readdir(full, { withFileTypes: true });
      hasChildren = children.some((child) => child.isDirectory() && !child.name.startsWith("."));
      isRepo = children.some((child) => child.name === ".git");
    } catch {
      /* 权限不足 / 目录刚被删:当作空目录,不让整棵树塌掉 */
    }
    out.push({ name: item.name, path: full, hasChildren, isRepo });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 这个人的浏览起点和边界。「谁受钳制、钳到哪」**不在这里判**,取 path-scope 那一份 ——
 * 这里曾经自己查一遍用户,于是同一个问题有了两份答案,而两份判据早晚宽窄不一。
 * 这里只额外决定「不受钳制的人从哪儿开始画」:根目录比整块文件系统好用。
 */
async function browseRootFor(c: Context): Promise<{ root: string; clamped: boolean }> {
  const scope = await pathScopeOf(actorOf(c));
  if (scope.clamp === "deny") throw Object.assign(new Error(scope.reason), { status: 401 });
  if (scope.clamp === "home") return { root: scope.home, clamped: true };
  if (!(await isMultiUser())) return { root: expandHome("~"), clamped: false };
  return { root: (await rootDirOf()) || expandHome("~"), clamped: false };
}

export function mountFsBrowseRoutes(api: Hono): void {
  // 起点:告诉前端从哪儿开始画,以及这个人的钳制边界在哪(界面上要写出来)。
  api.get("/fs/browse/root", async (c) => {
    try {
      const { root, clamped } = await browseRootFor(c);
      return c.json({
        root,
        name: basename(root) || root,
        // 不受钳制的人(自用模式、实例管理员 §七)不显示「你只能在这个目录内选择」。
        clamped,
        entries: await listDirs(root),
      });
    } catch (error) {
      const status = (error as { status?: number }).status ?? 500;
      return c.json({ error: (error as Error).message }, status as 400 | 401 | 500);
    }
  });

  // 展开一层。`path` 必须是绝对路径,且过一遍与建项目**完全相同**的那道钳制。
  api.get("/fs/browse", async (c) => {
    const raw = (c.req.query("path") ?? "").trim();
    if (!raw) return c.json({ error: "path required" }, 400);
    const target = resolve(expandHome(raw));
    if (await isMultiUser()) {
      const scope = await pathScopeOf(actorOf(c));
      if (scope.clamp === "deny") return c.json({ error: scope.reason }, 401);
      if (scope.clamp === "none") {
        // 管理员不受钳制,但仍要拒 UNC / 8.3 短名(与其它入口同一套原语)。
        const { windowsPathRejection } = await import("./platform.js");
        if (windowsPathRejection(target)) return c.json({ error: "不接受 UNC / 8.3 短名路径" }, 400);
      } else {
        // **注意这里用的不是 projectPathRejection**:那一条额外拒绝「目录根本身」,
        // 因为把用户目录根注册成项目会污染整片区域。而浏览目录根是完全正常的动作。
        const { realPathClampError } = await import("./auth/mode.js");
        const outside = resolve(scope.home) === target ? null : await realPathClampError(scope.home, target);
        if (outside) return c.json({ error: outside }, 403);
      }
    }
    try {
      const info = await stat(target);
      if (!info.isDirectory()) return c.json({ error: "这不是一个目录" }, 400);
      return c.json({ path: target, entries: await listDirs(target) });
    } catch {
      return c.json({ error: "目录不存在" }, 404);
    }
  });

  // 在自己的目录里新建一个子目录(建项目时常见的动作:先开一个空目录再 clone 进去)。
  api.post("/fs/browse/mkdir", async (c) => {
    const b = await c.req.json<{ path?: string }>().catch(() => ({}) as { path?: string });
    const raw = (b.path ?? "").trim();
    if (!raw) return c.json({ error: "path required" }, 400);
    const target = resolve(expandHome(raw));
    // 建目录**用完整那道钳制**:它建出来的位置紧接着就会被登记成项目,判据必须一致。
    const rejection = await projectPathRejection(actorOf(c), target);
    if (rejection) return c.json({ error: rejection }, 403);
    try {
      await mkdir(target, { recursive: true });
      return c.json({ path: target }, 201);
    } catch (error) {
      return c.json({ error: `建不出目录：${(error as Error).message}` }, 400);
    }
  });
}
