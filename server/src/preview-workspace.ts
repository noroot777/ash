import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { MAX_PREVIEW_SCRIPT_LENGTH, parsePreviewConfig, type WorkspacePreviewInput, type WorkspacePreviewLaunch } from "@ash/shared/preview";
import { db } from "./db/index.js";
import { projects, tasks } from "./db/schema.js";
import { taskFileRoot } from "./file-browser.js";
import { isolatedWorkspaceOwner } from "./task-workspace.js";
import { annotationReviewStatus } from "./page-annotation-review.js";
import { handoffBlockReasonById } from "./handoff-guard.js";
import { detectPreviewCandidates } from "./preview-command.js";
import { taskWorkflowDef } from "./workflows.js";

export function workspacePreviewInput(body: unknown): WorkspacePreviewInput | undefined {
  if (!body || typeof body !== "object" || !("workspace" in body) || body.workspace !== true) return undefined;
  const value = body as Record<string, unknown>;
  if (value.command !== undefined && (typeof value.command !== "string" || !value.command.trim()
    || value.command.length > MAX_PREVIEW_SCRIPT_LENGTH || value.command.includes("\0"))) throw new Error("请填写有效的预览启动命令");
  if (value.stepId !== undefined && typeof value.stepId !== "string") throw new Error("预览步骤无效");
  const config = value.config === undefined ? undefined : parsePreviewConfig(value.config);
  if (value.config !== undefined && !config) throw new Error("预览配置无效");
  return { workspace: true, command: value.command as string | undefined, config: config ?? undefined, stepId: value.stepId as string | undefined };
}

async function workspaceContext(taskId: string) {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  const project = task && (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
  if (!task || !project) throw new Error("任务或项目不存在");
  const root = await taskFileRoot(taskId);
  const missing = !root || (root.source === "repo" && !!await isolatedWorkspaceOwner(task));
  const status = await annotationReviewStatus(taskId);
  const reason = missing ? "任务工作目录已不存在，可能已在验收后清理，无法启动页面预览。请改用截图批注。"
    : await handoffBlockReasonById(taskId) || status.reason
    || (task.stage === "accepted" || task.stage === "merged" ? "任务已验收，无法在此启动预览。请改用截图批注。" : "")
    || (task.status === "backlog" ? "任务尚未运行，完成实现后再打开预览。也可以先使用截图批注。" : "")
    || (task.workflowMode === "free" && (task.mode !== "single" || task.parentId || task.reviewOf) ? "当前任务不支持自由预览，请使用截图批注。" : "");
  return { task, project, directory: missing ? null : root!.path, reason };
}

export async function workspacePreviewDirectory(taskId: string): Promise<string> {
  const context = await workspaceContext(taskId);
  if (context.reason || !context.directory) throw new Error(context.reason);
  return context.directory;
}

export async function workspacePreviewLaunch(taskId: string): Promise<WorkspacePreviewLaunch> {
  const { task, project, directory, reason } = await workspaceContext(taskId);
  const config = parsePreviewConfig(project.previewConfig ?? null);
  const command = config?.mode === "services" ? config.services.filter((s) => s.enabled).map((s) => s.command).join("\n\n") : project.previewCommand?.trim();
  const found = directory ? detectPreviewCandidates(directory, undefined, 3) : [];
  const unique = [...new Map(found.map((s) => [s.command, s])).values()];
  return {
    kind: task.workflowMode === "free" ? "free" : "workflow", directory, reason,
    configured: command ? { command, config: config ?? undefined } : null,
    steps: (taskWorkflowDef(task.workflow)?.steps ?? []).filter((s) => s.kind === "preview").map((s) => ({ id: s.id, command: s.p.cmd })),
    candidates: unique.slice(0, 40).map((s) => ({ id: createHash("sha256").update(s.command).digest("hex").slice(0, 16),
      name: s.label, directory: s.directory, command: s.command, kind: s.kind, enabled: false, requiresSelection: s.requiresSelection })),
    truncated: unique.length > 40,
  };
}
