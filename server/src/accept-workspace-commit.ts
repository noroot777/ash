import { readScmStatus } from "./git-status.js";
import { commitWorkspace, ScmOperationError } from "./git-workspace-ops.js";
import { claimWorkspaceWrite, resolveWorkspaceContext, workspaceReadOnlyReason } from "./workspace-write-gate.js";
import { appendTaskTimeline } from "./task-timeline.js";
import type { tasks } from "./db/schema.js";
import { acceptanceWorkspaceCommitBlock, assertAcceptanceWorkspaceCommit, SHARED_WORKSPACE_COMMIT_BLOCK } from "./accept-workspace-ownership.js";
import type { AcceptFailure } from "./task-accept-guard.js";

export async function autoCommitAcceptanceWorkspace(
  task: typeof tasks.$inferSelect,
  enabled: boolean,
): Promise<AcceptFailure | null> {
  if (!enabled || task.stage === "merged" || task.stage === "accepted") return null;
  try {
    const context = await resolveWorkspaceContext(task.id);
    if ("error" in context) throw new Error(context.error);
    if (!context.root.gitRepo) return null;
    const ownership = await acceptanceWorkspaceCommitBlock(context);
    if (ownership === SHARED_WORKSPACE_COMMIT_BLOCK) {
      await appendTaskTimeline(task.id, `验收前已跳过自动提交：${ownership}`, { eventKey: `accept-auto-commit-shared:${task.id}` });
      return null;
    }
    if (ownership) throw new Error(ownership);
    const status = await readScmStatus(context.root.path);
    const changes = [...status.staged, ...status.unstaged, ...status.untracked, ...status.merge];
    if (!changes.length) return null;
    const readOnly = await workspaceReadOnlyReason(context.task, context.root);
    if (readOnly) throw new Error(readOnly);
    if (status.truncated || status.operation || status.merge.length || changes.some(change => change.nested)) {
      throw new Error("存在冲突、未完成的 Git 操作、嵌套仓库或文件列表不完整，请先在源代码管理中处理");
    }
    const result = await commitWorkspace(context.root.path, context.root.repo, {
      message: `chore: ${task.title.replace(/[\r\n]+/g, " ")}`,
      stagePaths: [...new Set(changes.flatMap(change => change.origPath ? [change.path, change.origPath] : [change.path]))],
    }, async () => {
      await assertAcceptanceWorkspaceCommit(context);
      return claimWorkspaceWrite({
        taskId: task.id, context, forced: false,
        busyError: who => new ScmOperationError(`${who}，不能自动提交`, 409),
        archivedError: message => new ScmOperationError(message, 409),
        missingError: () => new ScmOperationError("任务不存在", 404),
      });
    });
    await appendTaskTimeline(task.id, `验收前已按项目设置自动提交任务改动：${result.sha?.slice(0, 8) ?? result.subject}。${result.warning ?? ""}`);
    return null;
  } catch (error) {
    return { accepted: false, httpStatus: 409, taskId: task.id, reason: "auto_commit_failed",
      error: `验收前自动提交未完成：${error instanceof Error ? error.message : String(error)}。未继续验收。` };
  }
}
