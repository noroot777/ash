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
