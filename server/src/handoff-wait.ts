import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { db } from "./db/index.js";
import type { tasks } from "./db/schema.js";
import type { TaskWaitOwnership, WaitOrigin } from "./db/schema-task-wait.js";
import { RUNS_DIR } from "./paths.js";
import { questionWaitMatches, questionWaitOrigin } from "./task-wait-ownership.js";
import { HandoffError } from "./handoff-types.js";

export type HandoffWaitOrigins = { question?: WaitOrigin["kind"]; checkpoint?: WaitOrigin["kind"] };

export function validateWaitOrigins(origins: HandoffWaitOrigins | undefined): void {
  if (origins === undefined) return;
  if (!origins || typeof origins !== "object" || Array.isArray(origins)
    || Object.entries(origins).some(([field, kind]) => !["question", "checkpoint"].includes(field)
      || !["ordinary", "review", "unknown"].includes(kind))) throw new HandoffError("waitOrigins 非法");
}

export async function exportWaitOrigins(task: typeof tasks.$inferSelect): Promise<HandoffWaitOrigins> {
  const fallback = await db.transaction((transaction) => questionWaitOrigin(transaction, { ...task, waitOwnership: null }),
    { behavior: "immediate" });
  return {
    ...(task.question ? { question: questionWaitMatches(task) ? task.waitOwnership!.question!.origin.kind : fallback.kind } : {}),
    ...(task.resumePrompt ? { checkpoint: task.waitOwnership?.checkpoint?.generation === task.resumePromptGeneration
      ? task.waitOwnership.checkpoint.origin.kind : fallback.kind } : {}),
  };
}

export function importWaitOwnership(task: { id: string; question: string | null; questionOptions: string | null;
  questionItems: string | null; resumePrompt: string | null; resumePromptGeneration: number },
  origins: HandoffWaitOrigins | undefined): TaskWaitOwnership | null {
  validateWaitOrigins(origins);
  if (!task.question && !task.resumePrompt) return null;
  const origin = (kind: WaitOrigin["kind"] | undefined): WaitOrigin => kind === "ordinary" ? { kind }
    : { kind: kind === "review" ? "review" : "unknown",
      directory: join(RUNS_DIR, task.id, "handoff-wait", randomUUID()), generation: null };
  return {
    ...(task.question ? { question: { occupancy: randomUUID(), origin: origin(origins?.question), text: task.question,
      options: task.questionOptions, items: task.questionItems } } : {}),
    ...(task.resumePrompt ? { checkpoint: { generation: task.resumePromptGeneration, origin: origin(origins?.checkpoint) } } : {}),
  };
}
