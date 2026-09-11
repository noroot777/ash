import { eq } from "drizzle-orm";
import type { UnexecutedVerification } from "@ash/shared/workflow-policy";
import { db } from "./db/index.js";
import { tasks, sessions } from "./db/schema.js";
import { taskWorkflowDef } from "./workflows.js";
import { completedInlineVerificationSteps } from "./review-execution.js";

export async function unexecutedVerification(task: typeof tasks.$inferSelect): Promise<UnexecutedVerification | null> {
  if (task.mode !== "team") return taskUnexecutedVerification(task);
  if (task.stage === "accepted") return null;
  // 调度台常驻且不执行自己的验证站；本次整体验收联动的是共享工作区执行者。
  const workers = (await db.select().from(tasks).where(eq(tasks.parentId, task.id)))
    .filter(worker => !worker.useWorktree);
  const unverifiedTasks: NonNullable<UnexecutedVerification["unverifiedTasks"]> = [];
  for (const worker of workers) {
    const missing = await taskUnexecutedVerification(worker);
    if (missing) unverifiedTasks.push({ taskId: worker.id, title: worker.title, stepIds: missing.stepIds });
  }
  if (!unverifiedTasks.length) return null;
  return {
    reason: "verify_not_run",
    message: `以下团队执行者的独立验证尚未执行：${unverifiedTasks.map(worker =>
      `「${worker.title}」（${worker.taskId}，未执行步骤：${worker.stepIds.join("、")}）`).join("；")}。`,
    stepIds: [],
    unverifiedTasks,
  };
}

async function taskUnexecutedVerification(task: typeof tasks.$inferSelect): Promise<UnexecutedVerification | null> {
  const steps = taskWorkflowDef(task.workflow)?.steps.filter(step => step.kind === "verify") ?? [];
  if (!steps.length || task.stage === "accepted") return null;
  const completed = completedInlineVerificationSteps(task);
  // 旧独立审查任务可能只创建了没开跑，只有真实会话记录才算执行过。
  const legacy = await db.select({ reviewStep: tasks.reviewStep }).from(sessions)
    .innerJoin(tasks, eq(sessions.taskId, tasks.id)).where(eq(tasks.reviewOf, task.id));
  for (const review of legacy) completed.add(review.reviewStep ?? steps[0]!.id);
  const stepIds = steps.filter(step => !completed.has(step.id)).map(step => step.id);
  if (!stepIds.length) return null;
  return {
    reason: "verify_not_run",
    message: `独立验证尚未执行：工作流中有 ${stepIds.length} 个自动验证步骤没有已执行的验证轮记录。`,
    stepIds,
  };
}
