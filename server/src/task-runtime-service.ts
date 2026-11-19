import { eq } from "drizzle-orm";
import { MAX_PREVIEW_SCRIPT_LENGTH } from "@navi/shared/preview";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { taskFileRoot } from "./file-browser.js";
import { isolatedWorkspaceOwner } from "./task-workspace.js";
import { handoffBlockReasonById } from "./handoff-guard.js";
import { beginPreviewStart, endPreviewStart, startPreview, isPreviewStarting } from "./preview.js";
import { alive, lastPreview, readAnyPreview } from "./preview-store.js";
import { previewState } from "./preview-public.js";
import { canConnect } from "./preview-probe.js";

export function developmentService(taskId: string) {
  const record = readAnyPreview(taskId) ?? lastPreview(taskId);
  return record?.purpose === "development" ? previewState(taskId) : null;
}

export async function developmentDirectory(taskId: string): Promise<string> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task || task.archived || task.stage === "accepted" || task.stage === "merged") throw new Error("任务已归档、验收或不存在，无法启动服务");
  const handed = await handoffBlockReasonById(taskId);
  if (handed) throw new Error(handed);
  const root = await taskFileRoot(taskId);
  if (!root || (root.source === "repo" && await isolatedWorkspaceOwner(task))) throw new Error("任务工作区已不存在，不能改用主仓库启动服务");
  return root.path;
}

export async function startDevelopmentService(
  taskId: string, input: { command: string; name?: string }, beforeStart: () => Promise<void>,
) {
  if (typeof input.command !== "string" || !input.command.trim() || input.command.length > MAX_PREVIEW_SCRIPT_LENGTH || input.command.includes("\0")) {
    throw new Error("请提供有效的服务启动命令（优先使用 $PORT 或项目支持的动态端口）");
  }
  if (input.name !== undefined && (typeof input.name !== "string" || input.name.length > 80)) throw new Error("服务名称不能超过 80 字");
  await beforeStart();
  const command = input.command.trim();
  const existing = readAnyPreview(taskId);
  if (existing?.purpose === "development" && existing.cmd === command && existing.state === "ready" && alive(existing.pid)) {
    if (!existing.port || !await canConnect(existing.port)) throw new Error("已有服务进程仍在，但端口健康检查失败，请先停止后重新启动");
    await beforeStart();
    if (readAnyPreview(taskId)?.gen !== existing.gen) throw new Error("服务已被停止或替换，请重试");
    return { reused: true, service: previewState(taskId) };
  }
  if (isPreviewStarting(taskId)) throw new Error("服务正在启动，请查看状态或停止后重试");
  if (existing && existing.purpose !== "development") throw new Error("此任务已有另一项预览服务，请先明确停止它再启动新服务");
  const gen = beginPreviewStart(taskId, undefined, "development");
  try {
    const directory = await developmentDirectory(taskId);
    const result = await startPreview(taskId, {
      id: "development", kind: "preview", p: { cmd: command, mode: "command", life: "task", ready: "port" }, fail: null,
    }, directory, gen, {
      purpose: "development", proxy: true, beforeStart,
      services: [{ id: "main", name: input.name?.trim() || "Demo", command, enabled: true, kind: "web" }],
    });
    if (!result.ok) throw new Error(result.reason);
    return { reused: false, service: previewState(taskId) };
  } finally { endPreviewStart(taskId, gen); }
}
