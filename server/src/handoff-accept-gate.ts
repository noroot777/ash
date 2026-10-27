import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { acceptGateRuns } from "./db/schema.js";
import { gateLogFileNames } from "./accept-gate-diagnosis.js";
import { acceptGateLogPath } from "./accept-gate-process.js";
import { hasOwnedGateProcess, reconcileGateProcesses } from "./accept-gate-ownership.js";
import { HandoffError, type HandoffManifest } from "./handoff-types.js";

type GateRow = typeof acceptGateRuns.$inferSelect;
export type HandoffGateRun = Pick<GateRow, "id" | "command" | "status" | "exitCode" | "failure" | "sourceCommit"
  | "targetBranch" | "targetCommit" | "fastForward" | "startedAt" | "finishedAt" | "handoffAt" | "handoffError">
  & { executionMode?: GateRow["executionMode"] };
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export function validateGatePayload(manifest: HandoffManifest): void {
  const mode = manifest.task.acceptedGateMode;
  if (mode != null && !["passed", "skipped", "unset"].includes(mode)) throw new HandoffError("acceptedGateMode 非法");
  if (manifest.task.acceptedGateRunId != null && !validId(manifest.task.acceptedGateRunId)) throw new HandoffError("acceptedGateRunId 非法");
  const runs = manifest.acceptGateRuns;
  if (runs == null) return;
  if (!Array.isArray(runs) || runs.length > 10_000) throw new HandoffError("acceptGateRuns 非法");
  const seen = new Set<string>();
  for (const run of runs) {
    if (!run || !validId(run.id) || seen.has(run.id) || !["passed", "failed", "interrupted", "canceled"].includes(run.status)
      || typeof run.command !== "string" || typeof run.startedAt !== "string"
      || ![null, "exit_code", "timeout", "spawn_failed", "server_restarted", "canceled", "source_changed", "process_unconfirmed", "ownership_waived"].includes(run.failure)
      || (run.exitCode != null && !Number.isInteger(run.exitCode))) throw new HandoffError("acceptGateRuns 记录非法");
    for (const field of ["sourceCommit", "targetBranch", "targetCommit", "finishedAt", "handoffAt", "handoffError"] as const) {
      if (run[field] != null && typeof run[field] !== "string") throw new HandoffError(`acceptGateRuns.${field} 非法`);
    }
    if (run.fastForward != null && typeof run.fastForward !== "boolean") throw new HandoffError("acceptGateRuns.fastForward 非法");
    if (run.executionMode != null && run.executionMode !== "macos-observed") throw new HandoffError("acceptGateRuns.executionMode 非法");
    seen.add(run.id);
  }
  const basis = runs.find(run => run.id === manifest.task.acceptedGateRunId);
  if (mode === "passed" && basis && basis.status !== "passed") throw new HandoffError("验收通过凭据指向了未通过的运行");
}

export async function collectGateRuns(taskId: string): Promise<HandoffGateRun[]> {
  await reconcileGateProcesses(taskId);
  const rows = await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.taskId, taskId));
  if (hasOwnedGateProcess(taskId) || rows.some(row => row.processPending || row.status === "running")) {
    throw new HandoffError("验收前置命令仍占用工作区；确认整次运行停止后才能接力", 409);
  }
  if (rows.length > 10_000) throw new HandoffError("验收前置命令历史超过接力容量；未丢弃凭据，请先整理历史", 409);
  return rows.map(row => ({ id: row.id, command: row.command, status: row.status, exitCode: row.exitCode,
    failure: row.failure, sourceCommit: row.sourceCommit, targetBranch: row.targetBranch, targetCommit: row.targetCommit,
    fastForward: row.fastForward, startedAt: row.startedAt, finishedAt: row.finishedAt,
    handoffAt: row.handoffAt, handoffError: row.handoffError, executionMode: row.executionMode }));
}

/**
 * 这一次接力把这份日志的文件带过来没有。
 *
 * 判据是**整组产物**而不是那个 `.log`（第 8 轮审查 F1）：现场和进度是单独的文件，只有
 * 它们到了也照样看得出「停在哪一条、静了多久」，这时候给路径挂上 `.not-transferred`
 * 等于把到手的证据判成没来，连带 `.notes`/`.scene` 的路径也一起拼歪。一个都没到才标。
 */
function transferredLogPath(manifest: HandoffManifest, runId: string): string {
  const path = acceptGateLogPath(manifest.task.id, runId);
  const names = new Set(gateLogFileNames(`accept-gate-${runId}.log`));
  const arrived = manifest.files.some(file => file.kind === "run-artifact" && names.has(file.rel));
  return arrived ? path : `${path}.not-transferred`;
}

export async function replaceGateRuns(store: Pick<typeof db, "select" | "delete" | "insert">,
  manifest: HandoffManifest): Promise<void> {
  const rows = manifest.acceptGateRuns ?? [];
  for (const row of rows) {
    const existing = (await store.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, row.id))).at(0);
    if (existing && existing.taskId !== manifest.task.id) throw new HandoffError("门禁运行身份与本机另一任务冲突", 409);
  }
  await store.delete(acceptGateRuns).where(eq(acceptGateRuns.taskId, manifest.task.id));
  if (rows.length) await store.insert(acceptGateRuns).values(rows.map(row => ({
    ...row, taskId: manifest.task.id, projectId: manifest.targetProjectId,
    cwd: "（跨机迁入的历史快照，当前机器不可重跑）", logPath: transferredLogPath(manifest, row.id),
    sourceFingerprint: null, pid: null, pidStartedAt: null, processPending: false, acceptOptions: null,
  })));
}
