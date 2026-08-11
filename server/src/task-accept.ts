import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { acceptPlan, anchorAt, hasAcceptStation, isFinalHumanGate, nextAnchor, segmentAfter } from "@harness/shared/workflow-policy";
import type { AcceptBy } from "@harness/shared/workflow-policy";
import { ACCEPT_CLEAN_LABELS, ACCEPT_STRATEGY_LABELS, STEP_LABELS } from "@harness/shared/workflow";
import { STAGE_LABELS } from "@harness/shared";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { projects, tasks } from "./db/schema.js";
import { handOffConflict } from "./accept-conflict.js";
import { localBranchExists, resolveTaskMergeTarget } from "./git.js";
import { cleanupAcceptedTask, cleanupPlanFor, mergeTaskBranch } from "./git-accept.js";
import { hasActiveFreeReview } from "./free-workflow.js";
import { disarmFreeReviewReservation } from "./free-review-reservations.js";
import { releaseFreeWorkflowAction, tryAcquireFreeWorkflowAction } from "./free-workflow-lock.js";
import { taskWorkflowDef } from "./workflows.js";
import { taskBranchDiff } from "./git-diff.js";
import { publishTaskUpdated } from "./task-store.js";
import { stopPreviewAtAccept } from "./preview.js";
import { IS_PREVIEW_INSTANCE, previewRefusal } from "./preview-instance.js";
import { withRepoLock } from "./repo-lock.js";
import { setTaskStage, clearTaskStage } from "./task-stage.js";
import { acceptSharedTeamWorkers, sharedWorkerAcceptanceMessage, type SharedWorkerAcceptance } from "./task-accept-shared-workers.js";
import { acceptanceGuard, type AcceptFailure, type AcceptWarning } from "./task-accept-guard.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { now } from "./util.js";
import type { WorkflowAdvanceOptions } from "./workflow-advance.js";

type AcceptSuccess = {
  accepted: true;
  taskId: string;
  status: string;
  /** 中途关口放行不是验收，stage 会被清回「进行中」，所以这里可能是 null */
  stage: "accepted" | null;
  kind: "already_accepted" | "in_place" | "isolated_worktree" | "marked_only" | "gate_released";
  sharedWorkersAccepted?: number;
  targetBranch?: string;
  merge?: string;
  /** 「只打标签不合并」那一档打下的标签名 */
  tag?: string;
  worktreePath?: string;
  worktreeRemoved?: boolean;
  branch?: string;
  branchDeleted?: boolean;
  warnings?: AcceptWarning[];
  /**
   * 「点头之后」那一段（发布脚本之类）跑得怎么样。线上没写这一段就没有这个字段。
   *
   * 它**不影响 accepted**：合并和清理已经真的做完了，改回 accepted:false 等于谎报另一头。
   * 但也不能不说 —— 一个挂掉的发布脚本被吞成「验收成功」，用户下一次知道是在线上出事
   * 的时候。所以合并的结论和尾段的结论分开报，各说各的。
   */
  tail?: AcceptTail;
};

type AcceptTail = {
  ok: boolean;
  /** 卡在哪一站（用中文站名，直接能显示） */
  step?: string;
  reason?: string;
};


export type AcceptTaskResult = AcceptSuccess | AcceptFailure;

const mergeLabel: Record<string, string> = {
  already_merged: "任务分支此前已合并",
  fast_forward: "纯 fast-forward",
  merge_commit: "--no-ff 合并提交",
  squash: "squash 合并（压成一个提交）",
  tagged: "只打标签，未合并",
};

const acceptingTaskIds = new Set<string>();

/** 验收是否正在进行（归档路由用：验收中途归档会形成「已冻结却继续合并写入」）。 */
export function isAcceptingTask(taskId: string): boolean {
  return acceptingTaskIds.has(taskId);
}

async function finalizeAcceptance(
  task: typeof tasks.$inferSelect,
  message: string,
): Promise<SharedWorkerAcceptance | null> {
  await setTaskStage(task.id, "accepted");
  // 人工关口到此结束，这条线也走到终点了：线上写着「下一个人工关口结束时回收」和
  // 「任务结束时回收」的预览都在这儿收掉。「点头之后」那一段还没开跑，所以那一段
  // 特意编排的预览不会被这一下误伤。
  await stopPreviewAtAccept(task.id);
  // 自由工作流：验收即终局，挂着的复审预约一并注销 —— 否则它会在任务日后被唤醒的
  // 某个回合里突然触发一场语境全变的审查（幽灵预约）。
  if (task.workflowMode === "free" && await disarmFreeReviewReservation(task.id)) {
    await appendTaskTimeline(task.id, "验收已完成，未消费的复审预约已一并取消。");
  }
  const sharedWorkers = task.mode === "team" ? await acceptSharedTeamWorkers(task.id) : null;
  await appendTaskTimeline(
    task.id,
    `${message}${sharedWorkers ? ` ${sharedWorkerAcceptanceMessage(sharedWorkers)}` : ""}`,
  );
  await publishTaskUpdated(task.id);
  return sharedWorkers;
}


async function acceptWithoutCleanup(
  task: typeof tasks.$inferSelect,
  kind: AcceptSuccess["kind"],
  message: string,
): Promise<AcceptSuccess> {
  const sharedWorkers = await finalizeAcceptance(task, message);
  return {
    accepted: true,
    taskId: task.id,
    status: task.status,
    stage: "accepted",
    kind,
    ...(sharedWorkers ? { sharedWorkersAccepted: sharedWorkers.updated } : {}),
  };
}

async function acceptTaskUnlocked(taskId: string, by: AcceptBy): Promise<AcceptTaskResult> {
  const requestedTask = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!requestedTask) {
    return { accepted: false, httpStatus: 404, taskId, reason: "not_found", error: "not found", phase: "initial" };
  }
  // Archived = frozen/read-only（task-routes 的约定）：验收会合并、清理、改 stage，
  // 全是写操作，归档任务一律拒——run/reply/review/repair/preview 的门禁都这么做。
  if (requestedTask.archived) {
    return {
      accepted: false,
      httpStatus: 409,
      taskId,
      reason: "task_archived",
      error: "任务已归档（只读）；先取消归档再验收",
      status: requestedTask.status,
      phase: "initial",
    };
  }
  // 自由任务在任何**终态**都可验收：done 是正常路径；failed/canceled 是「修复失败/被
  // 手停后我接受上一版直接合并」——轮数用尽的时间线明确承诺过「由你决定验收」，只放行
  // done 会让那句话在修复失败分支变成假承诺（验收页按钮可见却 409）。
  if (
    requestedTask.workflowMode === "free"
    && requestedTask.stage !== "accepted"
    && requestedTask.stage !== "merged"
    && !["done", "failed", "canceled"].includes(requestedTask.status)
  ) {
    return {
      accepted: false,
      httpStatus: 409,
      taskId,
      reason: "free_workflow_not_ready_for_acceptance",
      error: "自由工作流尚未到可验收的状态；任务结束后再进入验收页处理",
      status: requestedTask.status,
      phase: "initial",
    };
  }
  if (
    requestedTask.workflowMode === "free"
    && requestedTask.stage !== "accepted"
    && await hasActiveFreeReview(taskId)
  ) {
    return {
      accepted: false,
      httpStatus: 409,
      taskId,
      reason: "free_review_in_progress",
      error: "自由工作流审查回合正在进行，结束后再验收",
      status: requestedTask.status,
      phase: "initial",
    };
  }
  const requestedParent = requestedTask.parentId
    ? (await db.select().from(tasks).where(eq(tasks.id, requestedTask.parentId))).at(0)
    : null;
  if (requestedTask.parentId && requestedParent?.mode === "team" && !requestedTask.useWorktree) {
    return {
      accepted: false,
      httpStatus: 409,
      taskId,
      reason: "shared_worker_acceptance_not_applicable",
      error: "执行者不需人工验收，请对团队整体验收",
      status: requestedTask.status,
      phase: "initial",
    };
  }

  const initial = await acceptanceGuard(taskId, "initial");
  if (initial.failure) return initial.failure;
  const task = initial.task!;
  if (task.stage === "accepted") {
    // 幂等快路也要补清预约：历史上可能形成 accepted + armed 的组合（旧版合并入口、
    // 或写 accepted 与清预约之间进程退出），不自愈的话 reopen 后会触发幽灵审查。
    if (task.workflowMode === "free" && await disarmFreeReviewReservation(task.id)) {
      await appendTaskTimeline(task.id, "任务已验收，检测到遗留的复审预约，已补清。");
    }
    const sharedWorkers = task.mode === "team" ? await acceptSharedTeamWorkers(task.id) : null;
    await appendTaskTimeline(
      taskId,
      `验收动作重复调用：该任务此前已验收完成，本次未重复执行 git 操作。` +
        `${sharedWorkers ? ` ${sharedWorkerAcceptanceMessage(sharedWorkers)}` : ""}`,
    );
    return {
      accepted: true,
      taskId,
      status: task.status,
      stage: "accepted",
      kind: "already_accepted",
      ...(sharedWorkers ? { sharedWorkersAccepted: sharedWorkers.updated } : {}),
    };
  }

  // 停在一道**后面还有站要走**的「等我点头」上时，这一按的意思是「这一关我放行」，不是
  // 「这份产物我认了，去合吧」—— 后面还画着别的站呢（最常见的就是关口画在「自动验证」
  // 前面），顺手把不可逆的合并做掉，等于拿用户没表达过的意思替他做主，还把他亲手画的
  // 那一站整站跳过。所以这一档不合、不清、也不落 accepted，只把阶段清回进行中，让这条
  // 线接着往下走（往下走那一步在锁外跑，见 acceptTask）。
  // 判定单点在 shared 的 isFinalHumanGate；前端确认框读同一个判定，措辞跟着变。
  const gateDef = taskWorkflowDef(task.workflow);
  if (!isFinalHumanGate(gateDef, task.workflowAt)) {
    const guard = await acceptanceGuard(taskId, "before_accept");
    if (guard.failure) return guard.failure;
    const next = nextAnchor(gateDef, task.workflowAt);
    const where = next ? `后面还写着「${STEP_LABELS[next.kind]}」` : "这条线上后面还写着别的站";
    await clearTaskStage(
      taskId,
      `你在这一道「等我点头」放行了：${where}，所以没有合并、也没有清理，接着往下走。`,
    );
    await publishTaskUpdated(taskId);
    return { accepted: true, taskId, status: task.status, stage: null, kind: "gate_released" };
  }

  // A task that deliberately ran in the project's existing checkout has no
  // harness/<id> branch or harness-owned worktree to merge/delete.
  if (!task.useWorktree) {
    const guard = await acceptanceGuard(taskId, "before_accept");
    if (guard.failure) return guard.failure;
    const subject = task.mode === "team" ? "团队调度台未启用共享独立 worktree" : "任务未使用独立 worktree";
    return acceptWithoutCleanup(
      task,
      "in_place",
      `验收通过：${subject}，代码已在原工作区中；无需执行分支合并或 worktree 清理，status 保持 ${task.status}。`,
    );
  }

  const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
  if (!project) {
    return {
      accepted: false,
      httpStatus: 409,
      taskId,
      reason: "project_not_found",
      error: `任务所属项目 ${task.projectId} 不存在`,
      status: task.status,
    };
  }

  // 「验收通过」这个动作 = 执行线上那一站「合并并清理」，所以怎么合、清到什么程度
  // 都读它的参数。线上没有这一站时看谁按的：人按的照老规矩合（手按是最高指令），
  // 线自己走到的才一动不动——判定单点在 shared 的 acceptPlan，那里写着为什么。
  const def = taskWorkflowDef(task.workflow);
  const plan = acceptPlan(def, by, task.workflowAt);
  // 只有自动路径落得到这里（`runAccept` 仅在线上真有这一站时才跑，所以实际到不了；
  // 留着是给以后新增的自动触发点兜底）。人按的那一下永远拿到老规矩。
  if (!plan.merge) {
    const guard = await acceptanceGuard(taskId, "before_accept");
    if (guard.failure) return guard.failure;
    return acceptWithoutCleanup(
      task,
      "marked_only",
      `验收通过：这条线上没有「合并并清理」这一站，所以只记下「我认可这份产物」，` +
        `没有动 git —— 任务分支和 worktree 都留着。要让这条线自己合，在编排里加上这一站即可。`,
    );
  }

  // 线上没画这一站、却是人亲手点的 → 照老规矩合，但必须说清「这不是线上写的，是你按的」，
  // 否则用户回头看时间线会以为编排里有一站他没印象加过。
  const offScript = by === "human" && !hasAcceptStation(def);
  await appendTaskTimeline(
    taskId,
    (offScript
      ? task.workflowMode === "free"
        ? `开始验收：自由工作流没有预设合并站，手动验收按默认规矩`
        : `开始验收：这条线上没画「合并并清理」，但你亲手点了验收通过 —— 手动验收按默认规矩`
      : `开始验收：按线上写的`) +
      `「${ACCEPT_STRATEGY_LABELS[plan.merge]}、${ACCEPT_CLEAN_LABELS[plan.clean]}」处理，` +
      `目标 ${task.worktreeBase?.trim() || "项目当前分支"}；冲突时只报告并回滚，不会强制合并。`,
  );
  const mergeGuard = await acceptanceGuard(taskId, "before_merge");
  if (mergeGuard.failure) {
    await appendTaskTimeline(taskId, `验收暂缓：${mergeGuard.failure.error}`);
    return mergeGuard.failure;
  }
  // 一次验收生命周期内目标分支必须冻结：合并成功、清理失败停在 merged 后重试时，
  // 用 worktreeBase=null 动态解析会跟着项目当前 checkout 漂移——把同一任务再合进
  // 另一条分支（审查实测复现）。重试一律回到首次记录的目标。
  const retrying = task.stage === "merged";
  const frozenTarget = retrying && task.acceptedTargetBranch ? task.acceptedTargetBranch : task.worktreeBase;
  const merge = await mergeTaskBranch(project.repoPath, taskId, frozenTarget, plan.merge);

  // Retry after a previous partial success: stage=merged plus an already-removed
  // source branch means `git branch -d` did its job; finish the stage transition.
  // 快路也要验证冻结目标**仍然存在**：mergeTaskBranchLocked 在检查目标之前就返回
  // source_branch_missing，目标被删/改名时这里若只看字符串非空就 finalize，会把任务
  // 盖成 accepted 而返回值宣称一个不存在的分支（审查实测复现）。
  if (!merge.ok && merge.reason === "source_branch_missing" && task.stage === "merged") {
    const targetBranch = merge.targetBranch ?? await resolveTaskMergeTarget(project.repoPath, task.worktreeBase);
    if (targetBranch && await localBranchExists(project.repoPath, targetBranch)) {
      const guard = await acceptanceGuard(taskId, "before_accept");
      if (guard.failure) return guard.failure;
      const sharedWorkers = await finalizeAcceptance(
        task,
        `任务分支已在先前清理中删除；沿用已记录的 merged 阶段，继续完成验收标记（目标 ${targetBranch}）。`,
      );
      return {
        accepted: true,
        taskId,
        status: task.status,
        stage: "accepted",
        kind: "isolated_worktree",
        targetBranch,
        merge: "already_merged",
        branch: merge.sourceBranch,
        branchDeleted: true,
        ...(sharedWorkers ? { sharedWorkersAccepted: sharedWorkers.updated } : {}),
      };
    }
  }

  if (!merge.ok) {
    const detail = merge.conflictFiles?.length
      ? `；冲突文件：${merge.conflictFiles.join("、")}`
      : merge.dirtyFiles?.length
        ? `；脏文件：${merge.dirtyFiles.join("、")}`
        : "";
    await appendTaskTimeline(taskId, `验收未完成：${merge.message}${detail}。未强制合并，任务 status 保持 ${task.status}。`);
    const conflictHandoff = await handOffConflict(task, merge);
    return {
      accepted: false,
      httpStatus: 409,
      taskId,
      reason: merge.reason,
      error: merge.message,
      status: task.status,
      sourceBranch: merge.sourceBranch,
      targetBranch: merge.targetBranch,
      conflictFiles: merge.conflictFiles,
      dirtyFiles: merge.dirtyFiles,
      targetPath: merge.targetPath,
      ...(conflictHandoff ? { conflictHandoff } : {}),
    };
  }

  const tagged = merge.method === "tagged";
  // stage=merged 与快照三列**同一条 UPDATE** 落库（SQLite 单语句原子）：分两次写的话，
  // 进程死在中间会留下「stage=merged、快照还是上一生命周期」的组合，重试便把第二版
  // 产物合回旧目标分支（审查实测复现）。
  // 快照按**一次验收生命周期**冻结：全新验收（stage 不是 merged）三列整体覆盖——
  // reopen 后的第二次验收是新生命周期，不能沿用上一版的 base；清理失败后的重试
  // （stage=merged）三列保持首次值——already_merged 的同值区间、重试期间目标分支被
  // 别人推进产生的新 tip，都不能污染首次真实的合并区间。
  const snapshot = retrying ? {
    acceptedTargetBranch: task.acceptedTargetBranch ?? merge.targetBranch,
    acceptedBaseCommit: task.acceptedBaseCommit ?? merge.beforeCommit ?? null,
    acceptedMergeCommit: task.acceptedMergeCommit ?? merge.afterCommit ?? null,
  } : {
    acceptedTargetBranch: merge.targetBranch,
    acceptedBaseCommit: merge.beforeCommit ?? null,
    acceptedMergeCommit: merge.afterCommit ?? null,
  };
  const mergedAt = now();
  await db.update(tasks).set({
    ...snapshot,
    ...(tagged ? {} : { stage: "merged" }),
    updatedAt: mergedAt,
  }).where(eq(tasks.id, taskId));
  if (!tagged) {
    bus.publish({ type: "task.stage", taskId, stage: "merged", updatedAt: mergedAt });
    await appendTaskTimeline(taskId, `验收阶段更新：${STAGE_LABELS.merged}（merged）`);
  }
  await appendTaskTimeline(
    taskId,
    tagged
      ? `已按线上写的「只打标签不合并」在 ${merge.sourceBranch} 上打下标签 ${merge.tag}；目标分支 ${merge.targetBranch} 一个字节都没动。`
      : `合并完成：${merge.sourceBranch} → ${merge.targetBranch}（${mergeLabel[merge.method] ?? merge.method}）。`,
  );
  for (const warning of merge.warnings ?? []) {
    await appendTaskTimeline(taskId, `合并清理警告：${warning.message}`);
  }
  const cleanupGuard = await acceptanceGuard(taskId, "before_cleanup");
  if (cleanupGuard.failure) {
    const error = `合并已完成，但相关任务在清理前进入 running/queued；为避免删除正在使用的 worktree，清理已暂缓。${cleanupGuard.failure.error}`;
    await appendTaskTimeline(taskId, `${error} 阶段停在 merged，稍后可重新验收继续清理。`);
    return {
      ...cleanupGuard.failure,
      error,
      sourceBranch: merge.sourceBranch,
      targetBranch: merge.targetBranch,
      warnings: merge.warnings,
    };
  }

  // squash 和「只打标签」之后，任务分支在 git 眼里**并没有**被合并（squash 是新造一个
  // 提交，标签压根没合），所以 `git branch -d` 一定会被拒。删分支这一项在这两档里直接
  // 不做并说清楚原因——绝不改用 `-D`：自动流程强删分支是不可逆的，那是用户自己按的活。
  const cleanPlan = cleanupPlanFor(plan.clean);
  const branchUnmergeable = merge.method === "squash" || tagged;
  const branchKeptReason = !cleanPlan.branch
    ? `线上写的是「${ACCEPT_CLEAN_LABELS[plan.clean]}」`
    : branchUnmergeable
      ? `${tagged ? "只打了标签没合并" : "squash 之后 git 不认为它已合并"}，按约定不强删`
      : null;
  if (branchUnmergeable) cleanPlan.branch = false;

  const cleanup = await cleanupAcceptedTask(project.repoPath, taskId, merge.targetBranch, cleanPlan);
  if (!cleanup.ok) {
    await appendTaskTimeline(
      taskId,
      `验收清理未完成：${cleanup.message}。合并结果已保留，阶段停在 merged，status 保持 ${task.status}。`,
    );
    return {
      accepted: false,
      httpStatus: 409,
      taskId,
      reason: cleanup.reason,
      error: cleanup.message,
      status: task.status,
      sourceBranch: cleanup.sourceBranch,
      targetBranch: cleanup.targetBranch,
      worktreePath: cleanup.worktreePath,
      dirtyFiles: cleanup.dirtyFiles,
      warnings: merge.warnings,
    };
  }

  await appendTaskTimeline(
    taskId,
    `清理完成：${
      !cleanPlan.worktree
        ? `按线上写的保留了 worktree ${cleanup.worktreePath}`
        : cleanup.worktreeRemoved ? `已删除 worktree ${cleanup.worktreePath}` : "任务 worktree 已不存在"
    }；${
      cleanup.branchDeleted
        ? `已用 git branch -d 删除 ${cleanup.sourceBranch}`
        : branchKeptReason
          ? `分支 ${cleanup.sourceBranch} 保留（${branchKeptReason}）`
          : `分支 ${cleanup.sourceBranch} 已不存在`
    }。`,
  );
  const sharedWorkers = await finalizeAcceptance(
    task,
    `验收完成：目标分支 ${merge.targetBranch}；任务 status 保持 ${task.status}。`,
  );
  return {
    accepted: true,
    taskId,
    status: task.status,
    stage: "accepted",
    kind: "isolated_worktree",
    targetBranch: merge.targetBranch,
    merge: merge.method,
    ...(merge.tag ? { tag: merge.tag } : {}),
    worktreePath: cleanup.worktreePath,
    worktreeRemoved: cleanup.worktreeRemoved,
    branch: cleanup.sourceBranch,
    branchDeleted: cleanup.branchDeleted,
    warnings: merge.warnings,
    ...(sharedWorkers ? { sharedWorkersAccepted: sharedWorkers.updated } : {}),
  };
}

// 验收要动的是仓库级共享状态(目标分支的 ref、项目工作区、worktree 注册表),
// 所以整段验收都在仓库锁里跑:并行点下的多个验收**排队依次合并**,而不是一起
// 冲进同一个 `.git`(见 repo-lock.ts 的三类事故)。整段而非只锁 merge 的原因是
// 守卫判断不能过期 —— acceptTaskUnlocked 拿到锁后才重新读任务与项目,所以排在
// 后面的验收看到的是前一个合并完成后的世界(目标分支已前进、stage 已更新)。
async function acceptanceContext(taskId: string): Promise<{
  repoPath: string | null;
  freeWorkflow: boolean;
  status?: string;
}> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  // 没有独立 worktree 的任务只改 stage,不碰 git,不必占用仓库锁。
  if (!task) return { repoPath: null, freeWorkflow: false };
  if (!task.useWorktree) {
    return { repoPath: null, freeWorkflow: task.workflowMode === "free", status: task.status };
  }
  const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
  return {
    repoPath: project?.repoPath ?? null,
    freeWorkflow: task.workflowMode === "free",
    status: task.status,
  };
}

// `by` 默认 human：这个函数的调用方绝大多数是「用户按了验收通过」（HTTP 路由、MCP
// accept_task），只有 workflow-steps 里那条「线自己走到这一站」要显式传 "workflow"。
export async function acceptTask(
  taskId: string,
  by: AcceptBy = "human",
  advanceOpts: WorkflowAdvanceOptions = {},
): Promise<AcceptTaskResult> {
  // 预览实例：库是主库的快照，任务行指的却是真分支、真 worktree。走结构化拒绝而不是抛
  // 异常，UI 才能把这句话原样显示在验收按钮旁边（见 preview-instance.ts）。
  if (IS_PREVIEW_INSTANCE) {
    return {
      accepted: false,
      httpStatus: 409,
      taskId,
      reason: "preview_instance",
      error: previewRefusal("验收通过"),
    };
  }
  if (acceptingTaskIds.has(taskId)) {
    return {
      accepted: false,
      httpStatus: 409,
      taskId,
      reason: "acceptance_in_progress",
      error: "该任务正在验收中，请等待当前验收动作结束后再试",
    };
  }
  acceptingTaskIds.add(taskId);
  let result: AcceptTaskResult;
  let freeWorkflowLocked = false;
  try {
    const context = await acceptanceContext(taskId);
    if (context.freeWorkflow && !tryAcquireFreeWorkflowAction(taskId)) {
      result = {
        accepted: false,
        httpStatus: 409,
        taskId,
        reason: "free_workflow_action_in_progress",
        error: "当前已有自由工作流操作正在进行，结束后再验收",
        status: context.status,
        phase: "initial",
      };
    } else {
      freeWorkflowLocked = context.freeWorkflow;
      result = await withRepoLock(context.repoPath, async (wait) => {
        if (wait.queued) {
          // 排队是刷新后仍看得见的事实,不只是"点了没反应"。
          await appendTaskTimeline(
            taskId,
            `验收排队：同一仓库有其它验收/worktree 操作正在执行，已等待 ${(wait.waitedMs / 1000).toFixed(1)}s 后开始本次验收。`,
          );
        }
        return acceptTaskUnlocked(taskId, by);
      });
    }
  } finally {
    if (freeWorkflowLocked) releaseFreeWorkflowAction(taskId);
    acceptingTaskIds.delete(taskId);
  }
  if (result.accepted) {
    // 两条尾巴，都在仓库锁**之外**跑（这些命令可能好几分钟，占着锁会让同仓库的其它
    // 验收干等）：中途关口放行 = 让这条线接着往下走；真正的验收 = 跑「点头之后」那一段。
    if (result.kind === "gate_released") await releaseGate(taskId, advanceOpts);
    else {
      const tail = await runAcceptedTail(taskId, by);
      if (tail) result = { ...result, tail };
    }
  }
  return result;
}

// 中途关口放行之后接着往下走：跑完这一段，再按下一个锚点是什么决定（又一站验证、
// 下一道关口、还是这条线走到头）。**不传 skipAccept** —— 这一按没有做任何合并，
// 线上真画了「合并并清理」就该由它自己走到那一站时执行。
async function releaseGate(taskId: string, opts: WorkflowAdvanceOptions): Promise<void> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return;
  const { advanceWorkflowFrom } = await import("./workflow-advance.js");
  await advanceWorkflowFrom(task, taskWorkflowDef(task.workflow), task.workflowAt, opts)
    .catch((error) => appendTaskTimeline(
      taskId,
      `放行之后想接着往下走，但出错了（${error instanceof Error ? error.message : String(error)}），请手动续跑。`,
    ));
}

// 点头之后线上还写着的那几站（跑一条发布命令、把预览再开起来之类）。
// 放在仓库锁**之外**跑：这些命令可能跑好几分钟，占着锁会让同仓库的其它验收干等。
// skipAccept 是因为「合并并清理」正是刚做完的这件事,不能再做一遍。
//
// 跑砸了**不会把验收改成失败**（合并确实做完了），但要如实带回去，并按这一站写的失败
// 策略收尾——线路图上给它挂了「问我一句」，就得真的问出来。
async function runAcceptedTail(taskId: string, by: AcceptBy): Promise<AcceptTail | null> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return null;
  const def = taskWorkflowDef(task.workflow);
  // 「点头之后」是**哪一道**点头之后：读游标（`tasks.workflow_at`），游标丢了回落到线上
  // 第一道关口——那正是只有一道关口时的老行为。
  const gate = anchorAt(def, task.workflowAt, "human")?.id ?? null;
  if (!segmentAfter(def, gate).some((step) => step.kind !== "accept")) return null;
  const { runSegment } = await import("./workflow-steps.js");
  const result = await runSegment(task, def, gate, { skipAccept: true });
  if (result.ok) return { ok: true };

  const step = result.failed!;
  const label = STEP_LABELS[step.kind];
  await appendTaskTimeline(
    taskId,
    `合并已经做完了，卡住的是「点头之后」那一段：「${label}」没跑过。产物已经合进去，这一段要不要补跑由你定。`,
  );
  // 「打回给 AI 重做」在这一段有个真做不到的情况：清理那一档刚把 worktree 和分支收掉，
  // 唤醒 agent 也没有地方可干活。这时不假装打回，改成把问题挂给用户并说明为什么。
  // 这里必须带上 `by`：人工验收在线上没画这一站时照样清了工作区，用默认口径会算成
  // 「工作区还在」，于是打回一个已经不存在的 worktree。
  const workspaceGone = task.useWorktree && acceptPlan(def, by, task.workflowAt).clean !== "none";
  if (step.fail?.mode === "back" && workspaceGone) {
    await appendTaskTimeline(taskId, `「${label}」写的是「打回给 AI 重做」，但工作区刚随验收清掉了，没法再打回；改成问你一句。`);
    const { askAboutFailure } = await import("./task-question.js");
    await askAboutFailure(taskId, label, result.reason);
  } else {
    const { applyFailPolicy } = await import("./workflow-steps.js");
    await applyFailPolicy(
      task,
      step,
      result.reason,
      (round) => `验收之后的「${label}」这一站没跑过（第 ${round} 次）：\n\n`
        + `${"```"}\n${result.reason ?? ""}\n${"```"}\n\n`
        + "产物已经合并，请把这一段修到能跑过，然后照常确认完成。",
    );
  }
  return { ok: false, step: label, reason: result.reason };
}

export function mountTaskAcceptanceRoutes(api: Hono): void {
  api.post("/tasks/:id/accept", async (c) => {
    const result = await acceptTask(c.req.param("id"));
    if (result.accepted) return c.json(result);
    const { httpStatus, ...body } = result;
    return httpStatus === 404 ? c.json(body, 404) : c.json(body, 409);
  });

  api.get("/tasks/:id/diff", async (c) => {
    const taskId = c.req.param("id");
    const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
    if (!task) return c.json({ error: "not found" }, 404);
    const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0);
    if (!project) return c.json({ error: "project not found", projectId: task.projectId }, 404);
    return c.json(await taskBranchDiff(project.repoPath, taskId, task.worktreeBase));
  });
}
