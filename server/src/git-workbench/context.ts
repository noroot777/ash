import { eq } from "drizzle-orm";
import type { GitAction, GitWorkbenchState } from "@ash/shared/git-workbench";
import type { Actor } from "../auth/context.js";
import {
  requireProjectAccess,
  requireProjectAdmin,
} from "../auth/visibility.js";
import { db } from "../db/index.js";
import { projects, tasks } from "../db/schema.js";
import { repoKey, worktreeBranchName, worktreePathFor } from "../git.js";
import { taskFileRoot } from "../file-browser.js";
import {
  isolatedWorkspaceOwner,
  workspaceParticipants,
} from "../task-workspace.js";
import { claimWorkspaceTurn, isTurnClaimed } from "../runs.js";
import { fail, selectRoot } from "./core.js";
import { readScmStatus } from "../git-status.js";
import { IS_PREVIEW_INSTANCE, previewRefusal } from "../preview-instance.js";

export async function requestContext(
  actor: Actor,
  projectId: string,
  requested?: string,
  taskId?: string,
) {
  await requireProjectAccess(actor, projectId);
  const project = (
    await db.select().from(projects).where(eq(projects.id, projectId))
  ).at(0);
  if (!project?.repoPath) fail("项目没有可用的 Git 仓库", 404);
  if (taskId && !requested) {
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(
      0,
    );
    if (!task || task.projectId !== projectId) fail("任务不属于这个项目", 404);
    const workspace = await taskFileRoot(taskId);
    if (
      !workspace ||
      (workspace.source === "repo" && (await isolatedWorkspaceOwner(task!)))
    )
      fail(
        "这个任务的独立工作区尚未创建，请先启动任务，或从项目分支胶囊打开主仓",
        409,
      );
    requested = workspace!.path;
  }
  return { ...(await selectRoot(project!.repoPath!, requested)), projectId };
}

async function projectTasks(projectId: string) {
  return db.select().from(tasks).where(eq(tasks.projectId, projectId));
}
export async function decorateState(
  state: GitWorkbenchState,
  actor: Actor,
  projectId: string,
): Promise<GitWorkbenchState> {
  const rows = await projectTasks(projectId);
  for (const worktree of state.worktrees) {
    const owner = rows.find(
      (task) =>
        repoKey(worktreePathFor(state.repo, task.id)) ===
          repoKey(worktree.path) ||
        (task.useWorktree && worktreeBranchName(task.id) === worktree.branch),
    );
    worktree.taskId = owner?.id || null;
    worktree.taskTitle = owner?.title || null;
    worktree.managed = !!owner;
  }
  const owner = state.worktrees.find(
    (w) => repoKey(w.path) === repoKey(state.root),
  )?.taskId;
  if (owner && rows.find((t) => t.id === owner)?.archived)
    state.readOnly = "任务已归档，工作区只读。请先取消归档。";
  if (IS_PREVIEW_INSTANCE) state.readOnly = previewRefusal("Git 工作台写操作");
  try {
    await requireProjectAdmin(actor, projectId);
  } catch {
    state.readOnly = "只有项目管理员或实例管理员可以修改项目 Git 仓库。";
  }
  return state;
}

export async function claimWorkbench(
  repo: string,
  root: string,
  projectId: string,
  action: GitAction,
): Promise<() => void> {
  const rows = await projectTasks(projectId);
  const status = await readScmStatus(root);
  const owner = rows.find(
    (t) =>
      repoKey(worktreePathFor(repo, t.id)) === repoKey(root) ||
      (t.useWorktree && worktreeBranchName(t.id) === status.branch.head),
  );
  if (owner?.archived) fail("任务已归档，工作区只读，请先取消归档");
  if (owner && action.kind === "pull" && action.strategy === "rebase")
    fail(
      "任务工作树的基线由 ash 管理，请使用快进或合并拉取，或从任务入口更新基线",
    );
  if (
    (action.kind === "branch-delete" || action.kind === "branch-rename") &&
    rows.some(
      (t) =>
        worktreeBranchName(t.id) === action.name ||
        t.worktreeBase === action.name ||
        t.mergeTargetBranch === action.name,
    )
  ) {
    fail(
      "这条分支被 ash 任务或任务基线引用，请从任务的验收／工作区清理入口处理",
    );
  }
  if (
    ["worktree-remove", "worktree-lock", "worktree-unlock"].includes(
      action.kind,
    ) &&
    "path" in action
  ) {
    if (
      rows.some(
        (t) => repoKey(worktreePathFor(repo, t.id)) === repoKey(action.path),
      )
    )
      fail("这是任务管理的工作树，请通过该任务的验收／释放工作区入口处理");
  }
  if (
    owner &&
    [
      "checkout",
      "branch-create",
      "reset",
      "rebase",
      "rebase-plan",
      "undo",
    ].includes(action.kind)
  ) {
    if (action.kind !== "branch-create" || action.checkout)
      fail(
        "任务工作树的分支与基线由 ash 管理，请在手动工作树中重写历史或切分支",
      );
  }
  const anchor = {
    id: "__git_workbench__",
    projectId,
    parentId: null,
    useWorktree: false,
    worktreeBase: null,
    reviewOf: null,
    mode: "single" as const,
  };
  const roots = [
    root,
    ...(action.kind === "worktree-remove" ? [action.path] : []),
  ];
  const collect = async () =>
    (
      await Promise.all(
        roots.map((path) => workspaceParticipants(anchor, path)),
      )
    )
      .flat()
      .filter((p) => p.id !== anchor.id);
  const peers = await collect();
  const busy = peers.find(
    (p) =>
      isTurnClaimed(p.id) || p.status === "running" || p.status === "queued",
  );
  if (busy)
    fail(
      `「${busy.title || busy.id}」正在使用这个工作区，请停止或等待该任务后再操作`,
    );
  const claimed = new Set(peers.map((p) => p.id));
  const release = claimWorkspaceTurn([...claimed]);
  if (!release) fail("有任务刚开始使用这个工作区，请稍后再试");
  try {
    const fresh = await collect();
    if (
      fresh.some(
        (p) =>
          p.status === "running" ||
          p.status === "queued" ||
          (!claimed.has(p.id) && isTurnClaimed(p.id)),
      )
    )
      fail("有任务刚开始使用这个工作区，请稍后再试");
    if (
      owner &&
      (await projectTasks(projectId)).find((t) => t.id === owner.id)?.archived
    )
      fail("任务刚刚被归档，工作区只读");
    return release!;
  } catch (error) {
    release!();
    throw error;
  }
}
