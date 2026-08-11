import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { setTaskStage } from "./task-stage.js";
import { publishTaskUpdated } from "./task-store.js";

// 团队级验收联动：parentId 指向团队且不用独立 worktree 的共享执行者没有自己的分支，
// 团队验收成功时把它们的 stage 一起标成 accepted（从 task-accept.ts 拆出，纯行数拆分）。
export type SharedWorkerAcceptance = {
  total: number;
  updated: number;
  skipped: number;
};

export async function acceptSharedTeamWorkers(leadId: string): Promise<SharedWorkerAcceptance> {
  const sharedWorkers = (await db.select().from(tasks).where(eq(tasks.parentId, leadId)))
    .filter((worker) => !worker.useWorktree);
  let updated = 0;
  for (const worker of sharedWorkers) {
    if (worker.stage === "accepted") continue;
    await setTaskStage(worker.id, "accepted");
    await publishTaskUpdated(worker.id);
    updated += 1;
  }
  return { total: sharedWorkers.length, updated, skipped: sharedWorkers.length - updated };
}

export function sharedWorkerAcceptanceMessage(result: SharedWorkerAcceptance): string {
  if (result.total === 0) return "团队级验收联动：未发现共享执行者，无需同步阶段。";
  return `团队级验收联动：已将 ${result.updated} 个共享执行者的 stage 置为 accepted` +
    `${result.skipped ? `，另有 ${result.skipped} 个此前已是 accepted、已跳过` : ""}。`;
}
