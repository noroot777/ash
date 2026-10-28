import { eq } from "drizzle-orm";
import type { AcceptanceAutoCommitDecision } from "@ash/shared/accept-workspace";
import { db } from "./db/index.js";
import { projects } from "./db/schema.js";
import type { ScmStatus } from "./git-status.js";
import { acceptanceWorkspaceCommitBlock } from "./accept-workspace-ownership.js";
import { workspaceBusyLabel, type WorkspaceWriteContext } from "./workspace-write-gate.js";

export async function acceptanceAutoCommitDecision(
  context: WorkspaceWriteContext,
  status: ScmStatus,
  enabled?: boolean,
  ownershipBlock?: string | null,
): Promise<AcceptanceAutoCommitDecision> {
  const skip = (reason: string): AcceptanceAutoCommitDecision => ({ action: "skip", reason });
  if (context.task.stage === "merged" || context.task.stage === "accepted") return skip("任务已合并或验收，不再自动提交工作区改动");
  if (!context.root.gitRepo) return skip("当前工作目录不是 Git 仓库");
  const changes = [...status.staged, ...status.unstaged, ...status.untracked, ...status.merge];
  if (!changes.length) return skip("工作目录没有待提交改动");
  const ownership = ownershipBlock === undefined ? await acceptanceWorkspaceCommitBlock(context) : ownershipBlock;
  if (ownership) return skip(ownership);
  if (enabled === undefined) {
    enabled = (await db.select({ enabled: projects.acceptAutoCommit }).from(projects)
      .where(eq(projects.id, context.task.projectId))).at(0)?.enabled === true;
  }
  if (!enabled) return { action: "disabled", reason: "项目未开启验收前自动提交；可手动提交，或到项目设置 → 验收开启。" };
  if (context.busy) return skip(`${workspaceBusyLabel(context.task.id, context.busy)}，不能自动提交`);
  if (status.merge.length) return skip("存在冲突，请先在源代码管理中处理");
  if (status.operation) return skip("存在未完成的 Git 操作，请先在源代码管理中处理");
  if (status.truncated) return skip("文件列表不完整，请先在源代码管理中核对");
  if (changes.some(change => change.nested)) return skip("包含嵌套 Git 仓库，请先分别处理，避免遗漏改动");
  return { action: "commit", reason: "项目已开启验收前自动提交；当前预检通过，验收时将尝试提交这些改动，执行前会再次核对。" };
}
