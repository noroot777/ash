import type { Hono } from "hono";
import { Readable } from "node:stream";
import {
  listDirectory,
  openRawStream,
  readFileContent,
  resolveTarget,
  taskFileRoot,
  type WorkspaceRoot,
} from "./file-browser.js";
import { openWithApp, probeOpeners, revealInFileManager } from "./openers/index.js";
import { listWorkspaceDir, searchWorkspaceFiles } from "./file-search.js";

// 任务文件浏览。全部是只读视角 + 三个「交给本机去做」的动作（在文件夹中显示、
// 用某个应用打开、拿原始字节预览），任何一个都不写工作区。

function statusOf(error: unknown): number {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : 500;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publicRoot(root: WorkspaceRoot) {
  return { path: root.path, branch: root.branch, gitRepo: root.gitRepo, source: root.source };
}

export function mountFileRoutes(api: Hono) {
  /** 解析任务根目录；解析不出来时由调用方把 404 交出去。 */
  const rootFor = async (taskId: string) => taskFileRoot(taskId);

  api.get("/tasks/:id/files", async (c) => {
    const root = await rootFor(c.req.param("id"));
    if (!root) return c.json({ error: "这个任务还没有可浏览的工作目录" }, 404);
    try {
      const listing = await listDirectory(root, c.req.query("path") ?? "");
      return c.json({ root: publicRoot(root), ...listing });
    } catch (error) {
      return c.json({ error: messageOf(error) }, statusOf(error) as 400);
    }
  });

  api.get("/tasks/:id/file", async (c) => {
    const root = await rootFor(c.req.param("id"));
    if (!root) return c.json({ error: "这个任务还没有可浏览的工作目录" }, 404);
    try {
      return c.json({ root: publicRoot(root), file: await readFileContent(root, c.req.query("path") ?? "") });
    } catch (error) {
      return c.json({ error: messageOf(error) }, statusOf(error) as 400);
    }
  });

  api.get("/tasks/:id/file/raw", async (c) => {
    const root = await rootFor(c.req.param("id"));
    if (!root) return c.json({ error: "这个任务还没有可浏览的工作目录" }, 404);
    try {
      const raw = await openRawStream(root, c.req.query("path") ?? "");
      return new Response(Readable.toWeb(raw.stream) as ReadableStream, {
        headers: {
          "content-type": raw.mime,
          "content-length": String(raw.size),
          // 一律 inline：这个端点只服务预览，不该触发下载。
          "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(raw.name)}`,
          "cache-control": "no-store",
        },
      });
    } catch (error) {
      return c.json({ error: messageOf(error) }, statusOf(error) as 400);
    }
  });

  api.get("/tasks/:id/file/openers", async (c) => {
    const root = await rootFor(c.req.param("id"));
    if (!root) return c.json({ error: "这个任务还没有可浏览的工作目录" }, 404);
    try {
      const target = await resolveTarget(root, c.req.query("path") ?? "");
      return c.json(await probeOpeners(target.absPath, c.req.query("refresh") === "1"));
    } catch (error) {
      return c.json({ error: messageOf(error) }, statusOf(error) as 400);
    }
  });

  // 对话框里敲 `@` 时的候选来源：只读、只回相对路径，不碰工作区。
  // 没有工作目录（任务还没跑过、项目也不是仓库）时回空表而不是 404 —— 输入框据此
  // 静默不弹菜单就好，弹一条红字说「没有工作目录」是在打断一次普通的打字。
  api.get("/tasks/:id/file-search", async (c) => {
    const root = await rootFor(c.req.param("id"));
    if (!root) return c.json({ root: null, mode: "dir", hits: [], truncated: false, more: false });
    try {
      // `dir` = 树里展开某一层；`q` = 全局搜。两条同源（共用枚举缓存），只是取法不同。
      const dir = c.req.query("dir");
      const found = dir === undefined
        ? await searchWorkspaceFiles(root.path, {
          gitRepo: root.gitRepo,
          query: c.req.query("q") ?? "",
          limit: Number(c.req.query("limit")) || undefined,
        })
        : await listWorkspaceDir(root.path, {
          gitRepo: root.gitRepo,
          dir,
          limit: Number(c.req.query("limit")) || undefined,
        });
      return c.json({ root: publicRoot(root), ...found });
    } catch (error) {
      return c.json({ error: messageOf(error) }, statusOf(error) as 400);
    }
  });

  api.post("/tasks/:id/file/reveal", async (c) => {
    const root = await rootFor(c.req.param("id"));
    if (!root) return c.json({ error: "这个任务还没有可浏览的工作目录" }, 404);
    try {
      const body = await c.req.json().catch(() => ({})) as { path?: string };
      const target = await resolveTarget(root, body.path ?? "");
      await revealInFileManager(target.absPath);
      return c.json({ ok: true, absPath: target.absPath });
    } catch (error) {
      return c.json({ error: messageOf(error) }, statusOf(error) as 400);
    }
  });

  api.post("/tasks/:id/file/open", async (c) => {
    const root = await rootFor(c.req.param("id"));
    if (!root) return c.json({ error: "这个任务还没有可浏览的工作目录" }, 404);
    try {
      const body = await c.req.json().catch(() => ({})) as { path?: string; appId?: string | null };
      const target = await resolveTarget(root, body.path ?? "");
      await openWithApp(target.absPath, body.appId?.trim() || null);
      return c.json({ ok: true, absPath: target.absPath });
    } catch (error) {
      return c.json({ error: messageOf(error) }, statusOf(error) as 400);
    }
  });
}
