import type { ReviewConclusion, TaskStage } from "@ash/shared";
import { STEP_LABELS } from "@ash/shared/workflow";
import { workflowPolicy } from "@ash/shared/workflow-policy";
import { eq } from "drizzle-orm";
import { bus } from "./bus.js";
import { db } from "./db/index.js";
import { projects, regressionEvidence, sessions, tasks } from "./db/schema.js";
import { appendFinalizationTimeline, commitFinalizationStep, finalizationStep, enqueueFinalizationRepair, checkpointFinalizationWorkflow } from "./regression-finalization.js";
import { readReport, writeConclusion } from "./review-evidence.js";
import { repairPrompt } from "./review-prompts.js";
import { detectReviewCoverage } from "./review-coverage.js";
import { MAX_AUTO_REVIEW_ROUNDS, reviewOutcomeAction, reviewPlan, type Settlement } from "./review-policy.js";
import { failureQuestionInput } from "./task-question.js";
import { advanceWorkflowFrom } from "./workflow-advance.js";
import { taskWorkflowDef } from "./workflows.js";
import { now } from "./util.js";
import { assertReviewAuthority, ReviewSuperseded, settlementAuthority, withReviewAuthority } from "./review-ownership.js";

type TaskRow = typeof tasks.$inferSelect;
const STUCK_AT_VERIFY = "线停在「自动验证」这一站等你：看过验证报告（有截图的话一并看）后，认可就点「人工强制通过」放行，想重跑就点「再验一轮」。";

export async function finalizePresetReview(state: typeof regressionEvidence.$inferSelect): Promise<boolean> {
  const plan = state.finalization!;
  const authority = settlementAuthority(state);
  const expiredQuestionNotice = authority.target ? "" : "原提问随本轮终止失效。";
  const { target, round, reviewTaskId, station, stationRound, outcome, conclusion, frozen, stageChanged } = JSON.parse(plan.payload) as {
    target: TaskRow; round: number; reviewTaskId: string | null; station: string | null; stationRound: number;
    outcome: Settlement; conclusion: ReviewConclusion; frozen: boolean; stageChanged: boolean;
  };
  const step = (name: string, action: () => Promise<unknown>) => finalizationStep(state.directory, state.generation, name, action);
  await step("publish", async () => {
    const current = (await db.select().from(tasks).where(eq(tasks.id, target.id)))[0];
    if (stageChanged && current) bus.publish({ type: "task.stage", taskId: target.id, stage: current.stage as TaskStage | null, updatedAt: current.updatedAt });
    bus.publish({ type: "task.review", taskId: target.id });
  });
  if (frozen) {
    await step("frozen", () => appendFinalizationTimeline(target.id,
      `第 ${round} 轮验证结束时任务已归档或验收，结论不再覆盖冻结阶段（这一轮${outcome === "done" ? "正常收尾" : "未正常收尾"}）。${expiredQuestionNotice}`, `${state.generation}:frozen`));
    return true;
  }
  try {
    if (plan.superseded) throw new ReviewSuperseded();
    await withReviewAuthority(authority, async () => {});
  }
  catch (error) {
    if (!(error instanceof ReviewSuperseded)) throw error;
    await step("unapplied", () => appendFinalizationTimeline(target.id,
      `第 ${round} 轮验证已终止并完成轮次记账；${plan.superseded ? "原轮次已被替换" : authority.target ? "原目标方向已变化" : "历史记录缺少原目标方向身份"}，本轮结论未应用，未推进工作流或投递修复。${expiredQuestionNotice}请重新派发验证。`,
      `${state.generation}:unapplied`));
    throw error;
  }
  await step("conclusion", async () => { if (outcome === "done") await writeConclusion(target.id, round, reviewTaskId, conclusion, true); });
  const parent = target.parentId && (await db.select().from(tasks).where(eq(tasks.id, target.parentId)))[0];
  const parentIsTeam = !!parent && parent.mode === "team";
  const workflow = taskWorkflowDef(target.workflow), policy = workflowPolicy(workflow, station);
  const action = reviewOutcomeAction({ reviewStatus: outcome, conclusion, reviewRequested: target.reviewRequested,
    round: stationRound, parentIsTeam, workflow, at: station });
  if (action === "verified") {
    if (plan.runningStep) {
      await step("interrupted-workflow", () => appendFinalizationTimeline(target.id,
        `审查已完成，但后续工作流「${plan.runningStep}」在执行中遇到服务中断，实际副作用未知；已保留待处理记录，不会自动重复执行，请手动检查后继续任务。`, `${state.generation}:interrupted-workflow`));
      return false;
    }
    await step("workflow", async () => {
      const saved = (await db.select().from(regressionEvidence).where(eq(regressionEvidence.directory, state.directory)))[0]!.finalization!;
      let dispatchError: unknown;
      await advanceWorkflowFrom(target, workflow, station, { skipStepIds: new Set(saved.steps),
        reviewAuthority: authority,
        onRepair: (text) => enqueueFinalizationRepair(state.directory, state.generation, target.id, text, authority.target!),
        onStepStart: (stepId) => checkpointFinalizationWorkflow(state.directory, state.generation, stepId, "started"),
        onStepFailure: (stepId) => checkpointFinalizationWorkflow(state.directory, state.generation, stepId, "failed"),
        onStepDone: (stepId) => checkpointFinalizationWorkflow(state.directory, state.generation, stepId),
        startVerifyRound: async (taskId) => {
          try { return await (await import("./review.js")).startVerifyRound(taskId, {}, { reviewAuthority: authority }); }
          catch (error) { dispatchError = error; throw error; }
        },
      });
      if (dispatchError) throw dispatchError;
    });
    return true;
  }
  const note = async (text: string) => {
    await step("timeline", () => appendFinalizationTimeline(target.id, text, `${state.generation}:timeline`));
    return true;
  };
  if (action === "failed") return note(`第 ${round} 轮验证以 ${outcome} 结束；${STUCK_AT_VERIFY}`);
  if (action === "invalid") return note(`第 ${round} 轮验证已结束，但没有把 verified / verify_failed 的结论写回来，线不会替你放行。${STUCK_AT_VERIFY}`);
  if (action === "stop") {
    if (policy?.verify && policy.onVerifyFail === "ask") {
      const input = failureQuestionInput(target.id, STEP_LABELS.verify, await readReport(target.id, round));
      const updatedAt = now();
      const changed = await commitFinalizationStep(state.directory, state.generation, "question", async (transaction) => {
        await assertReviewAuthority(transaction, authority);
        await transaction.update(tasks).set({ question: input.question, questionOptions: JSON.stringify(input.options),
          questionItems: null, updatedAt }).where(eq(tasks.id, target.id));
      });
      if (changed) bus.publish({ type: "task.question", taskId: target.id, question: input.question,
        questionOptions: input.options ?? null, questionItems: null, updatedAt });
      return note(`第 ${round} 轮验证未通过；这条线写的是「没过就问我一句」，已经把问题挂给你了。`);
    }
    return note(policy?.verify && policy.onVerifyFail !== "back"
      ? `第 ${round} 轮验证未通过；这条线写的是「没过就停下等人」，现停在 verify_failed。${STUCK_AT_VERIFY}`
      : `第 ${round} 轮验证仍未通过；自动复验上限为 ${policy?.verify ? policy.verifyRounds : MAX_AUTO_REVIEW_ROUNDS} 轮，现停在 verify_failed。${STUCK_AT_VERIFY}`);
  }
  const project = (await db.select().from(projects).where(eq(projects.id, target.projectId)))[0];
  const completed = (await db.select().from(sessions).where(eq(sessions.taskId, target.id)))
    .filter((session) => session.endedAt).sort((left, right) => right.endedAt!.localeCompare(left.endedAt!))[0];
  const coverage = project ? await detectReviewCoverage({ repoPath: project.repoPath, ref: completed?.branch,
    turnStartedAt: completed?.turnStartedAt ?? completed?.startedAt ?? target.startedAt,
    endedAt: completed?.endedAt ?? target.endedAt }) : null;
  const next = reviewPlan({ parentIsTeam, reviewRequested: target.reviewRequested, workflow, at: station });
  await enqueueFinalizationRepair(state.directory, state.generation, target.id,
    repairPrompt({ target, round, reviewTaskId, coverage, autoNext: next.auto && stationRound < next.maxRounds }),
    { turnToken: target.activeTurnToken, directionToken: target.activeDirectionToken, directionEpoch: target.directionEpoch });
  await note(`第 ${round} 轮验证未通过，已把报告和证据路径交回原任务续跑修复。`);
  return true;
}
