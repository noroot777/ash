import { eq } from "drizzle-orm";
import { db } from "./db/index.js";
import { acceptGateRuns } from "./db/schema.js";
import { acceptGateLogPath } from "./accept-gate-process.js";
import { hasOwnedGateProcess, reconcileGateProcesses } from "./accept-gate-ownership.js";
import { HandoffError, type HandoffManifest } from "./handoff-types.js";

type GateRow = typeof acceptGateRuns.$inferSelect;
export type HandoffGateRun = Pick<GateRow, "id" | "command" | "status" | "exitCode" | "failure" | "sourceCommit"
  | "targetBranch" | "targetCommit" | "fastForward" | "startedAt" | "finishedAt" | "handoffAt" | "handoffError">
  // diagnosis 可选：旧 manifest 没有这个字段，迁入后按 null 处理（没归类过）。不带上它的话
  // 迁入页面仍说「出路见下面那段结论」而下面什么都没有（第 1 轮审查 N2）。
  & { executionMode?: GateRow["executionMode"]; diagnosis?: GateRow["diagnosis"];
    entryProbe?: GateRow["entryProbe"]; missAttribution?: GateRow["missAttribution"];
    // 那段结论是哪一代判据生成的。**必须跟着搬**：不搬的话迁入后全变 null=旧代,一份当代
    // 的结论会在对端被当成失效历史;而对端版本比本机老时,它本机的闸照旧认不出我们的代号,
    // 两头都停在保守的那一边(第 2 轮审查 F1)。旧 manifest 没这个字段 → null → 按旧代待。
    diagnosisGeneration?: GateRow["diagnosisGeneration"] };
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
      // `command_missing` 这个类别已经撤掉了(第 10 轮审查 F1),但**旧机器导出的 payload 里
      // 可能还有**:读得进来、不许卡住导入;产生端再也不会写它。
      || ![null, "exit_code", "timeout", "spawn_failed", "server_restarted", "canceled", "source_changed", "process_unconfirmed", "ownership_waived", "command_missing"].includes(run.failure)
      || (run.exitCode != null && !Number.isInteger(run.exitCode))) throw new HandoffError("acceptGateRuns 记录非法");
    for (const field of ["sourceCommit", "targetBranch", "targetCommit", "finishedAt", "handoffAt", "handoffError", "diagnosis", "entryProbe", "missAttribution", "diagnosisGeneration"] as const) {
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
    handoffAt: row.handoffAt, handoffError: row.handoffError, executionMode: row.executionMode,
    diagnosis: row.diagnosis, entryProbe: row.entryProbe, missAttribution: row.missAttribution,
    diagnosisGeneration: row.diagnosisGeneration }));
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
    cwd: "（跨机迁入的历史快照，当前机器不可重跑）", logPath: acceptGateLogPath(manifest.task.id, row.id)
      + (manifest.files.some(file => file.kind === "run-artifact" && file.rel === `accept-gate-${row.id}.log`) ? "" : ".not-transferred"),
    diagnosis: row.diagnosis ?? null,
    entryProbe: row.entryProbe ?? null,
    missAttribution: row.missAttribution ?? null,
    diagnosisGeneration: row.diagnosisGeneration ?? null,
    sourceFingerprint: null, pid: null, pidStartedAt: null, processPending: false, acceptOptions: null,
  })));
}
