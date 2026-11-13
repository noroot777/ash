import type { Task } from "@ash/shared";

/** 验收的那枚章：空心是做完了等你验，实心是验过了；null 是不画。 */
export function sealState(task: Task): "open" | "done" | null {
  if (task.handoff?.direction === "out") return null;
  if (task.stage === "accepted") return "done";
  if (task.archived) return null;
  if (task.status === "running" || task.status === "queued") return null;
  // 验证结论会覆盖 accepted、答复会往一个已合并的 worktree 里续写：这两种时候后端 acceptanceGuard
  // 必然 409，章不画（改版前是一颗灰掉的「验证中」「等答复」）。
  if (task.verifyRound != null || task.question) return null;
  // 做完的团队执行者由团队整体验收（改版前那颗是灰掉的「已完成」）。
  if (task.parentId !== null && task.status === "done") return null;
  if (task.status === "done" || task.stage === "awaiting_acceptance" || task.stage === "verified") return "open";
  // 自由工作流的 failed / canceled 同样可验收（修复失败 / 手停后接受上一版直接合并，后端
  // acceptTask 已放行；时间线也承诺「由你决定验收」）。
  if (task.workflowMode === "free" && (task.status === "failed" || task.status === "canceled")) return "open";
  return null;
}
