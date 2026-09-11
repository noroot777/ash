import { firstAnchor } from "@ash/shared/workflow-policy";
import type { tasks } from "./db/schema.js";
import { taskWorkflowDef } from "./workflows.js";

/** 就地验证执行记录。旧版只保留最后一站的轮数，不能用总轮数推断其它站。 */
export function completedInlineVerificationSteps(task: typeof tasks.$inferSelect): Set<string> {
  let stored: unknown;
  try { stored = JSON.parse(task.verifyCompletedSteps); } catch { stored = []; }
  const completed = new Set<string>(Array.isArray(stored) ? stored.filter(id => typeof id === "string") : []);
  if (task.reviewStep) {
    if ((task.verifyStationRounds ?? 0) > 0) completed.add(task.reviewStep);
  } else if ((task.verifyRounds ?? 0) > 0) {
    // 未记站号的旧轮只属于第一站，不能替后来加上的验证站作证。
    const first = firstAnchor(taskWorkflowDef(task.workflow), "verify");
    if (first) completed.add(first.id);
  }
  return completed;
}

export function verificationStepsAfterRound(task: typeof tasks.$inferSelect): string {
  const completed = completedInlineVerificationSteps(task);
  const station = task.reviewStep ?? firstAnchor(taskWorkflowDef(task.workflow), "verify")?.id;
  if (station) completed.add(station);
  return JSON.stringify([...completed]);
}
