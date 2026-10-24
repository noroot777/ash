import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { freeReviewRounds, freeReviewRuns, regressionEvidence, tasks } from "../src/db/schema.js";
import { freeReviewEvidenceDir } from "../src/free-review-files.js";
import { reviewTargetIdentity } from "../src/review-ownership.js";
import { setTaskQuestion } from "../src/task-question.js";

export async function seedScheduledReviewQuestion(taskId: string, question: string, at: string): Promise<void> {
  const runId = `scheduled-review-${taskId}`;
  await db.update(tasks).set({ workflowMode: "free" }).where(eq(tasks.id, taskId));
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
  await db.insert(freeReviewRuns).values({ id: runId, taskId, reviewerName: "reviewer", agentType: "claude",
    checkMode: "logic", status: "reviewing", retryLimit: 0, currentRound: 1, createdAt: at, updatedAt: at });
  await db.insert(freeReviewRounds).values({ id: `${runId}-1`, runId, round: 1, status: "reviewing", startedAt: at });
  await db.insert(regressionEvidence).values({ directory: freeReviewEvidenceDir(taskId, runId, 1), taskId,
    generation: `${runId}-generation`, excludedMonitors: [], targetIdentity: reviewTargetIdentity(task) });
  await setTaskQuestion({ taskId, question });
}
