import { and, eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { regressionEvidence, tasks } from "./db/schema.js";
import type { CheckedConclusion } from "./regression-evidence-lifecycle.js";
import { RegressionConclusionRejected } from "./regression-conclusion-errors.js";

export type ConclusionTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type ConclusionTask = typeof tasks.$inferSelect;

export async function assertConclusionTask(transaction: ConclusionTransaction, expected: ConclusionTask): Promise<void> {
  const current = (await transaction.select().from(tasks).where(eq(tasks.id, expected.id)))[0];
  const fields = ["status", "stage", "verifyRound", "reviewOf", "reviewRound", "workflowMode", "archived",
    "activeTurnToken", "activeDirectionToken", "activeDirectionVersion", "handoff"] as const;
  if (!current || fields.some((field) => current[field] !== expected[field])) {
    throw new RegressionConclusionRejected("当前回合、方向身份、审查轮次或结论已变化，本次上报未提交");
  }
}

export async function commitRegressionConclusion<Result>(checked: CheckedConclusion,
  write: (transaction: ConclusionTransaction) => Promise<Result>): Promise<Result> {
  return db.transaction(async (transaction) => {
    if (checked) {
      const state = (await transaction.select().from(regressionEvidence)
        .where(eq(regressionEvidence.directory, checked.directory)))[0];
      if (!state || state.taskId !== checked.taskId || state.generation !== checked.generation
        || (checked.stage === "verified" && state.revoked && !checked.basis)) {
        throw new RegressionConclusionRejected("审查证据代次或撤销状态已变化，结论与依据均未提交");
      }
      if (state.settlement && JSON.stringify(state.acceptedBasis) !== JSON.stringify(checked.basis)) {
        throw new RegressionConclusionRejected("本轮已进入结算，不能替换结论依据");
      }
    }
    const result = await write(transaction);
    if (checked) {
      const updated = await transaction.update(regressionEvidence).set({ acceptedBasis: checked.basis })
        .where(and(eq(regressionEvidence.directory, checked.directory), eq(regressionEvidence.generation, checked.generation)))
        .returning({ directory: regressionEvidence.directory });
      if (!updated.length) throw new RegressionConclusionRejected("审查证据代次已变化，结论与依据均未提交");
    }
    return result;
  }, { behavior: "immediate" });
}
