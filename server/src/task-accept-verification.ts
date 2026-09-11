import { eq } from "drizzle-orm";
import type { UnexecutedVerification } from "@ash/shared/workflow-policy";
import { db } from "./db/index.js";
import { tasks, sessions } from "./db/schema.js";
import { taskWorkflowDef } from "./workflows.js";

export async function unexecutedVerification(task: typeof tasks.$inferSelect): Promise<UnexecutedVerification | null> {
  const steps = taskWorkflowDef(task.workflow)?.steps.filter(step => step.kind === "verify") ?? [];
  if (!steps.length || task.stage === "accepted" || (task.verifyRounds ?? 0) > 0) return null;
  // verifyRound 是在飞标记，结算后清空；verifyRounds 才是已执行轮数。
  // 旧独立审查任务可能只创建了没开跑，只有真实会话记录才算执行过。
  const legacy = await db.select({ id: sessions.id }).from(sessions)
    .innerJoin(tasks, eq(sessions.taskId, tasks.id)).where(eq(tasks.reviewOf, task.id)).limit(1);
  if (legacy.length) return null;
  return {
    reason: "verify_not_run",
    message: "独立验证尚未执行：工作流包含自动验证步骤，但没有已执行的验证轮记录。",
    stepIds: steps.map(step => step.id),
  };
}
