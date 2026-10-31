import { readScmStatus } from "./git-status.js";
import { commitWorkspace, ScmOperationError } from "./git-workspace-ops.js";
import { claimWorkspaceWrite, resolveWorkspaceContext } from "./workspace-write-gate.js";
import { appendTaskTimeline } from "./task-timeline.js";
import type { tasks } from "./db/schema.js";
import { assertAcceptanceWorkspaceCommit } from "./accept-workspace-ownership.js";
import type { AcceptFailure } from "./task-accept-guard.js";
import type { AcceptanceAutoCommitOutcome } from "@ash/shared/accept-workspace";
import { acceptanceAutoCommitDecision } from "./accept-workspace-decision.js";

export async function autoCommitAcceptanceWorkspace(
  task: typeof tasks.$inferSelect,
  enabled: boolean,
  onOutcome?: (outcome: AcceptanceAutoCommitOutcome) => void,
): Promise<AcceptFailure | null> {
  if (!enabled || task.stage === "merged" || task.stage === "accepted") return null;
  const skip = async (reason: string) => {
    onOutcome?.({ status: "skipped", reason });
    await appendTaskTimeline(task.id, `验收前已跳过自动提交，继续按原流程验收：${reason}`);
    return null;
  };
  let commitRequired = false;
  try {
    const context = await resolveWorkspaceContext(task.id);
    if ("error" in context) return skip(context.error);
    if (!context.root.gitRepo) return skip("当前工作目录不是 Git 仓库");
    const status = await readScmStatus(context.root.path);
    const decision = await acceptanceAutoCommitDecision(context, status, enabled);
    if (decision.action !== "commit") return skip(decision.reason);
    commitRequired = true;
    const changes = [...status.staged, ...status.unstaged, ...status.untracked, ...status.merge];
    const result = await commitWorkspace(context.root.path, context.root.repo, {
      message: `chore: ${task.title.replace(/[\r\n]+/g, " ")}`,
      stagePaths: [...new Set(changes.flatMap(change => change.origPath ? [change.path, change.origPath] : [change.path]))],
    }, async () => {
      await assertAcceptanceWorkspaceCommit(context);
      const freshDecision = await acceptanceAutoCommitDecision(context, await readScmStatus(context.root.path), true, null);
      if (freshDecision.action !== "commit") throw new ScmOperationError(freshDecision.reason, 409);
      return claimWorkspaceWrite({
        taskId: task.id, context, forced: false,
        busyError: who => new ScmOperationError(`${who}，不能自动提交`, 409),
        archivedError: message => new ScmOperationError(message, 409),
        missingError: () => new ScmOperationError("任务不存在", 404),
      });
    });
    onOutcome?.({ status: "committed", reason: result.warning ?? "已自动提交任务改动", ...(result.sha ? { sha: result.sha } : {}) });
    await appendTaskTimeline(task.id, `验收前已按项目设置自动提交任务改动：${result.sha?.slice(0, 8) ?? result.subject}。${result.warning ?? ""}`);
    return null;
  } catch (error) {
    if (!commitRequired) return skip(error instanceof Error ? error.message : String(error));
    onOutcome?.({ status: "failed", reason: error instanceof Error ? error.message : String(error) });
    return { accepted: false, httpStatus: 409, taskId: task.id, reason: "auto_commit_failed",
      error: `验收前自动提交未完成：${error instanceof Error ? error.message : String(error)}。未继续验收。` };
  }
}
