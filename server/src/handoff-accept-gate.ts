import { eq } from "drizzle-orm";
import { ACCEPT_GATE_FAILURE_LABELS } from "@ash/shared/accept-gate";
import { db } from "./db/index.js";
import { acceptGateRuns, type tasks } from "./db/schema.js";
import { gateLogFileNames } from "./accept-gate-diagnosis.js";
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
    diagnosisGeneration?: GateRow["diagnosisGeneration"];
    // 这一次先跑的准备命令。不搬的话迁入后那条「准备没过」读不出是哪条命令没过。旧 manifest 没有 → null。
    prepareCommand?: GateRow["prepareCommand"] };
/** 读得进来的失败类别：当前那一整套（跟着标签表走，加一类不会漏在这里）加上已经撤掉、旧 payload 里还可能有的。 */
const IMPORTABLE_FAILURES: readonly (string | null)[] = [null, ...Object.keys(ACCEPT_GATE_FAILURE_LABELS), "command_missing"];
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

const ACCEPTANCE_FACTS = ["acceptedSourceCommit", "acceptedTargetBranch", "acceptedBaseCommit", "acceptedMergeCommit",
  "acceptedMergeMethod", "acceptedGateRunId"] as const;

/**
 * 移入这一行的验收身份（db/schema.ts acceptanceId）。老对端的 manifest 不带这一项（undefined，不是 null）：
 * 牌子和合并事实跟本机这份一样 = 对端没再验收过，沿用本机的身份（整行覆盖成 null 的话，同一次验收在飞书上
 * 会被当成新的一次再推一遍）；不一样就是对端又验收了一次，按加列之前的验收处理（按合并事实认）。
 */
export function returningAcceptanceId(
  existing: typeof tasks.$inferSelect | undefined, task: HandoffManifest["task"],
): string | null {
  if (task.acceptanceId !== undefined) return task.acceptanceId;
  if (!existing || existing.stage !== task.stage) return null;
  return ACCEPTANCE_FACTS.every((column) => existing[column] === (task[column] ?? null)) ? existing.acceptanceId : null;
}

export function validateGatePayload(manifest: HandoffManifest): void {
  const mode = manifest.task.acceptedGateMode;
  if (mode != null && !["passed", "skipped", "unset"].includes(mode)) throw new HandoffError("acceptedGateMode 非法");
  if (manifest.task.acceptedGateRunId != null && !validId(manifest.task.acceptedGateRunId)) throw new HandoffError("acceptedGateRunId 非法");
  if (manifest.task.acceptanceId != null && !validId(manifest.task.acceptanceId)) throw new HandoffError("acceptanceId 非法");
  const runs = manifest.acceptGateRuns;
  if (runs == null) return;
  if (!Array.isArray(runs) || runs.length > 10_000) throw new HandoffError("acceptGateRuns 非法");
  const seen = new Set<string>();
  for (const run of runs) {
    if (!run || !validId(run.id) || seen.has(run.id) || !["passed", "failed", "interrupted", "canceled"].includes(run.status)
      || typeof run.command !== "string" || typeof run.startedAt !== "string"
      // `command_missing` 这个类别已经撤掉了(第 10 轮审查 F1),但**旧机器导出的 payload 里
      // 可能还有**:读得进来、不许卡住导入;产生端再也不会写它。
      || !IMPORTABLE_FAILURES.includes(run.failure)
      || (run.exitCode != null && !Number.isInteger(run.exitCode))) throw new HandoffError("acceptGateRuns 记录非法");
    for (const field of ["sourceCommit", "targetBranch", "targetCommit", "finishedAt", "handoffAt", "handoffError", "diagnosis", "entryProbe", "missAttribution", "diagnosisGeneration", "prepareCommand"] as const) {
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
  // 结论之后欠着的那一步（自动验收 / 交回修复）只在本机补办，记号不随接力搬走：带着它接力，
  // 这份责任就在两台机器之间丢了。办完（或在本机重启补完）再接力。
  if (rows.some(row => row.settlement)) {
    throw new HandoffError("验收前置命令的结论之后还有一步没办完（自动验收或交回修复）；办完后才能接力", 409);
  }
  if (rows.length > 10_000) throw new HandoffError("验收前置命令历史超过接力容量；未丢弃凭据，请先整理历史", 409);
  return rows.map(row => ({ id: row.id, command: row.command, status: row.status, exitCode: row.exitCode,
    failure: row.failure, sourceCommit: row.sourceCommit, targetBranch: row.targetBranch, targetCommit: row.targetCommit,
    fastForward: row.fastForward, startedAt: row.startedAt, finishedAt: row.finishedAt,
    handoffAt: row.handoffAt, handoffError: row.handoffError, executionMode: row.executionMode,
    diagnosis: row.diagnosis, entryProbe: row.entryProbe, missAttribution: row.missAttribution,
    diagnosisGeneration: row.diagnosisGeneration, prepareCommand: row.prepareCommand }));
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
    diagnosis: row.diagnosis ?? null,
    entryProbe: row.entryProbe ?? null,
    missAttribution: row.missAttribution ?? null,
    diagnosisGeneration: row.diagnosisGeneration ?? null,
    prepareCommand: row.prepareCommand ?? null,
    sourceFingerprint: null, pid: null, pidStartedAt: null, processPending: false, acceptOptions: null,
  })));
}
