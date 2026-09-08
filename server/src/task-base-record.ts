import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks, taskBranchReceipts } from "./db/schema.js";
import { execFileText as exec } from "./exec.js";
import { baseRef } from "./task-branch-plan.js";
import { now } from "./util.js";

export async function recordCompletedBaseUpdate(repo: string, taskId: string, targetBranch: string,
  intent: { head: string; rebased: string; target: string }): Promise<void> {
  await exec("git", ["-C", repo, "update-ref", baseRef(taskId), intent.target]);
  await db.transaction(async tx => {
    await tx.insert(taskBranchReceipts).values({ id: `${taskId}:${intent.head}:${intent.rebased}`,
      taskId, sourceCommit: intent.head, mergeCommit: intent.rebased, targetBranch }).onConflictDoNothing();
    await tx.update(tasks).set({ worktreeStartCommit: intent.target, acceptedSourceCommit: null,
      baseUpdateIntent: null, stage: null, updatedAt: now() }).where(eq(tasks.id, taskId));
  });
}
