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
import { deleteEntry, readEntryOverview, type DeleteMode } from "./file-delete.js";
import { trashCapability, TrashUnavailableError } from "./file-trash.js";
import { openWithApp, probeOpeners, revealInFileManager } from "./openers/index.js";
import { listWorkspaceDir, searchWorkspaceFiles } from "./file-search.js";
import { readFileGitStatus } from "./file-git-status.js";
import { IS_PREVIEW_INSTANCE, previewRefusal } from "./preview-instance.js";
import { withRepoLock } from "./repo-lock.js";
import {
  ARCHIVED_REFUSAL,
  claimWorkspaceWrite,
  resolveWorkspaceContext,
  workspaceBusyLabel,
  workspaceReadOnlyReason,
} from "./workspace-write-gate.js";

// 任务文件浏览。绝大部分是只读视角 + 三个「交给本机去做」的动作（在文件夹中显示、
// 用某个应用打开、拿原始字节预览），它们一个都不写工作区。
//
// **唯一写工作区的是删除**（`DELETE /tasks/:id/file`）。它把两套东西叠在一起：
//   • 「能不能动这个目录」的门禁与 scm 写操作完全同源——`workspace-write-gate.ts`
//     （归档冻结、回落主仓只读、目录上有任务在飞要 force、锁内原子占位），外加预览实例
//     一律拒；
//   • 「这个东西本身能不能删」的三条硬拒在 `file-delete.ts`（根目录、`.git`、越界）。
// 删除还要排进 `withRepoLock`：删文件不是 git 操作，但它改的是同一个工作区，跟正在跑的
// 验收合并、discard 撞上就是互相拆台。

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
      const path = c.req.query("path") ?? "";
      const [listing, git] = await Promise.all([
        listDirectory(root, path),
        path === "" && root.gitRepo ? readFileGitStatus(root.path) : null,
      ]);
      return c.json({ root: publicRoot(root), ...listing, git });
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

  /**
   * 「这是什么、有多大、git 怎么看它、现在能不能删」。
   *
   * 中间栏的文件夹详情页和删除确认框读的是同一份——确认框要说的话正是详情页要展示的
   * 东西，分两个接口必然对不上。只读，所以不带写门禁，但把门禁的**结论**（只读理由、
   * 目录上有没有任务在飞、这台机器有没有废纸篓）一起给出去：按钮是禁是亮、点下去会弹
   * 哪一档确认，页面得在点之前就知道。
   */
  api.get("/tasks/:id/file/overview", async (c) => {
    const context = await resolveWorkspaceContext(c.req.param("id"));
    if ("error" in context) return c.json({ error: context.error }, context.status);
    try {
      const [overview, readOnly, trash] = await Promise.all([
        readEntryOverview(context.root, c.req.query("path") ?? ""),
        workspaceReadOnlyReason(context.task, context.root),
        trashCapability(),
      ]);
      return c.json({
        root: publicRoot(context.root),
        ...overview,
        trash,
        readOnly: IS_PREVIEW_INSTANCE ? previewRefusal("改任务的工作区") : readOnly,
        busy: context.busy
          ? { running: true, reason: workspaceBusyLabel(context.task.id, context.busy) }
          : { running: false, reason: null },
      });
    } catch (error) {
      return c.json({ error: messageOf(error) }, statusOf(error) as 400);
    }
  });

  /**
   * 删一个文件 / 一整个文件夹。默认移到系统废纸篓，`mode: "permanent"` 才真删。
   *
   * 门禁顺序跟 scm 写操作一模一样：预览实例 → 只读（force 不解）→ 在飞（要 force）→
   * 仓库锁 → 锁内原子占位 → 动手。
   */
  api.delete("/tasks/:id/file", async (c) => {
    if (IS_PREVIEW_INSTANCE) return c.json({ error: previewRefusal("删任务工作区里的文件") }, 403);
    const taskId = c.req.param("id");
    const context = await resolveWorkspaceContext(taskId);
    if ("error" in context) return c.json({ error: context.error }, context.status);
    const body = await c.req.json().catch(() => ({})) as { path?: string; mode?: string; force?: boolean };
    const mode: DeleteMode = body.mode === "permanent" ? "permanent" : "trash";
    const forced = body.force === true;

    const readOnly = await workspaceReadOnlyReason(context.task, context.root);
    if (readOnly) return c.json({ error: readOnly, readOnly }, 409);
    if (context.busy && !forced) {
      return c.json({
        error: `${workspaceBusyLabel(taskId, context.busy)}，agent 此刻可能正在写这个工作目录；`
          + "删掉的可能是它刚写出来、还没提交的东西。确认要继续请带 force",
        needsForce: true,
      }, 409);
    }

    try {
      return c.json(await withRepoLock(context.root.repo, async () => {
        const release = await claimWorkspaceWrite({
          taskId,
          context,
          forced,
          busyError: (who) => Object.assign(new Error(`${who}，删除已取消`), { status: 409, needsForce: true }),
          archivedError: () => Object.assign(new Error(ARCHIVED_REFUSAL), { status: 409 }),
          missingError: () => Object.assign(new Error("这个任务已经不在了"), { status: 404 }),
        });
        try {
          return await deleteEntry(context.root, body.path ?? "", mode);
        } finally {
          release?.();
        }
      }));
    } catch (error) {
      // 废纸篓不可用是**要用户再决定一次**，不是失败：前端据此提供「永久删除」那一档。
      // 绝不在这里自动降级——用户点的是「移到废纸篓」。
      if (error instanceof TrashUnavailableError) {
        return c.json({ error: error.message, trashFailed: true }, 409);
      }
      const needsForce = (error as { needsForce?: unknown } | null)?.needsForce === true;
      return c.json({ error: messageOf(error), ...(needsForce ? { needsForce } : {}) }, statusOf(error) as 400);
    }
  });
}
