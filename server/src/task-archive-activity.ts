import { and, eq, or } from "drizzle-orm";
import { db } from "./db/index.js";
import { acceptGateRuns, monitors } from "./db/schema.js";
import { isRunning } from "./runs.js";

export type ArchiveActivity = {
  liveProcess: boolean;
  monitorRunning: boolean;
  acceptGateRunning: boolean;
};

export async function readArchiveActivity(taskId: string): Promise<ArchiveActivity> {
  const [monitor, gate] = await Promise.all([
    db.select({ id: monitors.id }).from(monitors)
      .where(and(eq(monitors.taskId, taskId), eq(monitors.status, "running"))).limit(1),
    db.select({ id: acceptGateRuns.id }).from(acceptGateRuns)
      .where(and(eq(acceptGateRuns.taskId, taskId), or(eq(acceptGateRuns.status, "running"), eq(acceptGateRuns.processPending, true)))).limit(1),
  ]);
  return { liveProcess: isRunning(taskId), monitorRunning: monitor.length > 0, acceptGateRunning: gate.length > 0 };
}
