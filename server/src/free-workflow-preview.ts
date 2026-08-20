// 自由工作流的预览段（从 free-workflow.ts 拆出，纯行数拆分）：命令推导、启动、路由。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { projects, tasks } from "./db/schema.js";
import { assertBeforeAcceptance } from "./free-workflow.js";
import { recordFreePreviewEvent } from "./free-workflow-events.js";
import { releaseFreeWorkflowAction, tryAcquireFreeWorkflowAction } from "./free-workflow-lock.js";
import { handoffBlockReasonById } from "./handoff-guard.js";
import { isTurnClaimed } from "./runs.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { taskWorkspace } from "./task-workspace.js";
import { startPreview, stopPreview, type PreviewStep } from "./preview.js";

function previewCommand(cwd: string): string {
  const packageJson = join(cwd, "package.json");
  if (!existsSync(packageJson)) throw new Error("工作区没有 package.json，无法自动判断预览命令");
  let scripts: Record<string, unknown> = {};
  try { scripts = JSON.parse(readFileSync(packageJson, "utf8")).scripts ?? {}; }
  catch { throw new Error("package.json 无法读取，无法自动判断预览命令"); }
  const script = typeof scripts.dev === "string" ? "dev" : typeof scripts.start === "string" ? "start" : null;
  if (!script) throw new Error("package.json 没有 dev 或 start 脚本，请先在项目中补充预览命令");
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return `pnpm run ${script}`;
  if (existsSync(join(cwd, "yarn.lock"))) return `yarn ${script}`;
  return `npm run ${script}`;
}

async function startFreePreview(taskId: string) {
  if (!tryAcquireFreeWorkflowAction(taskId)) throw new Error("当前已有自由工作流操作正在进行");
  try {
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task || task.workflowMode !== "free" || task.mode !== "single" || task.parentId || task.reviewOf) {
      throw new Error("当前任务不支持自由预览");
    }
    if (task.archived) throw new Error("归档任务不能打开预览");
    if (task.status === "backlog") throw new Error("任务尚未运行，完成实现后再打开预览");
    if (task.status === "running" || task.status === "queued") throw new Error("任务正在修改代码，结束后再打开预览");
    if (isTurnClaimed(taskId)) throw new Error("任务回合正在进行（状态尚未落库），结束后再打开预览");
    assertBeforeAcceptance(task);
    const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
    if (!project) throw new Error("项目不存在");
    const workspace = await taskWorkspace(task, project.repoPath);
    const command = previewCommand(workspace.path);
    const step: PreviewStep = {
      id: "free-preview", kind: "preview",
      p: { cmd: command, mode: "frontend", ready: "port+log", life: "task" },
      fail: null,
    };
    const result = await startPreview(taskId, step, workspace.path);
    if (!result.ok) throw new Error(result.reason);
    await recordFreePreviewEvent(taskId, {
      kind: "preview_opened",
      source: "user",
      detail: result.record.url ?? result.record.cmd,
      occurredAt: result.record.startedAt,
    });
    await appendTaskTimeline(taskId, `自由工作流预览已打开：${result.record.url ?? command}`);
    bus.publish({ type: "task.review", taskId });
    return result.record;
  } finally {
    releaseFreeWorkflowAction(taskId);
  }
}

export function mountFreePreviewRoutes(api: Hono): void {
  api.post("/tasks/:id/free-workflow/preview", async (c) => {
    // 打开预览会在任务工作区里跑启动命令——接力出去的「历史存档」不给开(关闭不拦)。
    const handedOff = await handoffBlockReasonById(c.req.param("id"));
    if (handedOff) return c.json({ error: handedOff, handoff: true }, 409);
    try {
      const record = await startFreePreview(c.req.param("id"));
      return c.json({ running: true, url: record.url, port: record.port, command: record.cmd, startedAt: record.startedAt });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });

  // 关闭预览是**控制类**动作：不设 waiting（提问/续跑）门禁——预览进程占着端口，
  // 任务无论停在哪一步，用户都必须能把它收掉。
  api.delete("/tasks/:id/free-workflow/preview", async (c) => {
    const taskId = c.req.param("id");
    const task = (await db.select({
      workflowMode: tasks.workflowMode, mode: tasks.mode, parentId: tasks.parentId, reviewOf: tasks.reviewOf,
    }).from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task || task.workflowMode !== "free" || task.mode !== "single" || task.parentId || task.reviewOf) {
      return c.json({ error: "当前任务不支持自由预览" }, 409);
    }
    if (!tryAcquireFreeWorkflowAction(taskId)) return c.json({ error: "当前已有自由工作流操作正在进行" }, 409);
    try {
      const stopped = await stopPreview(taskId, "用户关闭了自由工作流预览", "user");
      bus.publish({ type: "task.review", taskId });
      return c.json({ stopped });
    } finally {
      releaseFreeWorkflowAction(taskId);
    }
  });
}
