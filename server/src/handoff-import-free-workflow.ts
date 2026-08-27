// 任务接力——导入侧把 manifest 里的自由工作流审查历史翻译成本机可落库的行。
//
// 只做「翻译」不做落库:插入/删除留在 handoff-import.ts 的两条路径里各自执行(全新
// 导入在 createTasks 的 afterInsert 里、移回在事务里),这样两边的补偿回滚和事务边界
// 都还是那边说了算。
//
// 机器本地的外键在这里重新解析,解析不到就置空并留一条注记:
//   - 审查者 profile:按**名字**在本机 reviewer_profiles 里找;找不到 = 只保留历史里
//     的 reviewerName 文本(展示够用),手动预约不落地(armed 强制为 false),否则会预约一
//     个本机根本不存在的审查者,到点起跑当场失败。**自动复审的续轮预约是例外**——它在
//     原 run 上续下一轮,配置冻结在 free_review_runs 行里,不查 profile,照常保留。
//   - 执行器 profile(executorId/reviewExecutorId):一律置空,由 agentType 走本机默认
//     执行器解析——和 sessions/scheduledMessages 的处理口径一致。
//   - repairTaskId:指向源机上另一个**没有随本次接力迁移**的任务,置空;它只是「已经
//     派过修复任务了」的幂等锁,置空最坏是对端能再派一个新的。
import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { freeReviewRounds, freeReviewRuns, freeWorkflowEvents, freeWorkflowStates, reviewerProfiles } from "./db/schema.js";
import type { HandoffFreeWorkflowPayload } from "./handoff-types.js";
import { id } from "./util.js";

export interface FreeWorkflowImportRows {
  state: typeof freeWorkflowStates.$inferInsert | null;
  runs: (typeof freeReviewRuns.$inferInsert)[];
  rounds: (typeof freeReviewRounds.$inferInsert)[];
  events: (typeof freeWorkflowEvents.$inferInsert)[];
}

export const EMPTY_FREE_WORKFLOW_ROWS: FreeWorkflowImportRows = { state: null, runs: [], rounds: [], events: [] };

export async function buildFreeWorkflowRows(
  taskId: string,
  payload: HandoffFreeWorkflowPayload | null | undefined,
  notes: string[],
): Promise<FreeWorkflowImportRows> {
  if (!payload) return EMPTY_FREE_WORKFLOW_ROWS;

  // 名字在 reviewer_profiles 里不是唯一的:重名时取最早建的那条,行为可预期。
  let reviewerId: string | null = null;
  const wantedName = payload.state?.selectedReviewerName ?? null;
  if (wantedName) {
    const candidates = (await db.select().from(reviewerProfiles).where(eq(reviewerProfiles.name, wantedName)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    reviewerId = candidates.at(0)?.id ?? null;
  }

  const runIds = new Set(payload.runs.map((r) => r.id));
  // 续轮预约指向的那条 run 必须真的在这次载荷里,否则是个悬空指针。
  const followUpRunId = payload.state?.reviewRunId && runIds.has(payload.state.reviewRunId)
    ? payload.state.reviewRunId
    : null;
  const state = payload.state
    ? {
        taskId,
        selectedReviewerId: reviewerId,
        // 审查者解析不到就不能 armed —— 预约一个本机不存在的审查者,到点起跑必然失败。
        // **但自动复审的续轮预约除外**:它在原 run 上续下一轮,执行器配置早就冻结在
        // free_review_runs 那一行里,根本不查 reviewer profile。把它一起撤掉 =
        // 「修完自动进第 N+1 轮」这条链在接力后静默断掉(第 1 轮审查实测)。
        reviewArmed: payload.state.reviewArmed && (!wantedName || !!reviewerId || !!followUpRunId),
        reviewCheckMode: payload.state.reviewCheckMode,
        reviewRetryLimit: payload.state.reviewRetryLimit,
        reviewNote: payload.state.reviewNote,
        reviewAgentType: payload.state.reviewAgentType,
        // 执行器 profile 是本机主键,按 agentType 走本机默认执行器重新解析。
        reviewExecutorId: null,
        reviewModel: payload.state.reviewModel,
        reviewReasoningEffort: payload.state.reviewReasoningEffort,
        reviewRunId: followUpRunId,
        updatedAt: payload.state.updatedAt,
      }
    : null;

  const runs = payload.runs.map((r) => ({
    id: r.id,
    taskId,
    reviewerId: r.reviewerName === wantedName ? reviewerId : null,
    reviewerName: r.reviewerName,
    agentType: r.agentType,
    executorId: null,
    model: r.model,
    reasoningEffort: r.reasoningEffort,
    checkMode: r.checkMode,
    note: r.note,
    targetKind: r.targetKind,
    targetBranch: r.targetBranch,
    targetBaseCommit: r.targetBaseCommit,
    targetCommit: r.targetCommit,
    repairTaskId: null,
    retryLimit: r.retryLimit,
    currentRound: r.currentRound,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    finishedAt: r.finishedAt,
  }));

  const rounds = payload.runs.flatMap((r) => r.rounds.map((round) => ({
    id: id(),
    runId: r.id,
    round: round.round,
    status: round.status,
    conclusion: round.conclusion,
    reviewedCommit: round.reviewedCommit,
    startedAt: round.startedAt,
    endedAt: round.endedAt,
  })));

  const events = payload.events.map((e) => ({
    id: id(),
    taskId,
    kind: e.kind,
    source: e.source,
    detail: e.detail,
    occurredAt: e.occurredAt,
  }));

  // 预约真的被撤掉时才提这一句(续轮预约不受审查者缺失影响,见上)。
  if (wantedName && !reviewerId && payload.state?.reviewArmed && !followUpRunId) {
    notes.push(`本机没有名为「${wantedName}」的审查者,已保留审查历史但取消了预约复审;需要的话在本机重新预约`);
  } else if (wantedName && !reviewerId) {
    notes.push(`本机没有名为「${wantedName}」的审查者,审查历史里只保留了名字;下次手动派审时重新选一位`);
  }
  if (runs.length) notes.push(`迁移自由工作流审查历史 ${runs.length} 轮次(共 ${rounds.length} 轮)`);
  return { state, runs, rounds, events };
}
