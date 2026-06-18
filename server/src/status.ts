import { eq } from "drizzle-orm";
import type { TaskStatus } from "@harness/shared";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { bus } from "./bus.js";
import { now } from "./util.js";

const TERMINAL: TaskStatus[] = ["done", "failed", "canceled"];

// Single source of truth for changing a task's status. Besides persisting the
// status it maintains the run-timing columns and broadcasts them, so every
// surface (single run, debate, scheduler, manual patch) keeps `startedAt` /
// `endedAt` consistent and the web can show start/end/duration live:
//   • → running  : stamp startedAt once (first run), clear endedAt.
//   • → terminal : stamp endedAt (run finished).
//   • otherwise  : leave the timestamps untouched.
export async function setTaskStatus(taskId: string, status: TaskStatus): Promise<void> {
  const cur = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  let startedAt = cur?.startedAt ?? null;
  let endedAt = cur?.endedAt ?? null;
  const patch: Record<string, unknown> = { status, updatedAt: now() };

  if (status === "running") {
    if (!startedAt) patch.startedAt = startedAt = now();
    patch.endedAt = endedAt = null;
  } else if (TERMINAL.includes(status)) {
    patch.endedAt = endedAt = now();
  }

  await db.update(tasks).set(patch).where(eq(tasks.id, taskId));
  bus.publish({ type: "task.status", taskId, status, startedAt, endedAt });
}
