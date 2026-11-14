import { and, desc, eq, or } from "drizzle-orm";
import { gateConfinementUnavailable, gateExecutionNotice, gateScopeNotice } from "./accept-gate-confinement.js";
import { readGateLaunch } from "./accept-gate-launch.js";
import { normalizeAcceptGateBaseline, normalizeAcceptGateCommand, normalizeAcceptGateFailure, type AcceptGateBasis, type AcceptGateBasisMode, type AcceptGateState, type AcceptGateStatus, type AcceptGateView } from "@ash/shared/accept-gate";
import { db } from "./db/index.js";
import { acceptGateRuns, projects, tasks } from "./db/schema.js";
import { gateLogReadable } from "./accept-gate-diagnosis.js";
import { acceptGateLogTail } from "./accept-gate-process.js";
import { commitAt } from "./task-branch-plan.js";
import { treeOfCommit } from "./git-accept.js";
import { existingTaskWorkspacePath, taskWorkspace } from "./task-workspace.js";
import { gateDependencies, gateSnapshotPath, gateSourceMatches, readGateSource } from "./accept-gate-source.js";
import { gateBaselineMatches, resolveGateBaseline } from "./accept-gate-baseline.js";
import { decodePhysical, type GatePhysical } from "./accept-gate-physical.js";
import { decodeGateEntryProbe, gateEntryNote } from "./accept-gate-entry.js";
import { conflictHandedAt } from "./accept-gate-conflict-registry.js";

type GateRow = typeof acceptGateRuns.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

/**
 * 凭据那一次门禁测的是哪一份：任务分支的提交；合并预览档另有测过的那棵树（预演出的合并树，已含目标
 * 分支时就是任务分支那棵）和测的时候目标分支所在的提交。最终合并只认这几样（git-accept 的落地约束）。
 */
export async function gateMergeSource(repoPath: string, basis: Pick<TaskRow, "acceptedGateMode" | "acceptedGateRunId"> | null):
  Promise<{ sourceCommit?: string; expectedTree?: string; expectedTarget?: string; expectedPhysical?: GatePhysical | null }> {
  if (basis?.acceptedGateMode !== "passed" || !basis.acceptedGateRunId) return {};
  const row = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, basis.acceptedGateRunId))).at(0);
  const sourceCommit = row?.sourceCommit ?? undefined;
  if (!row?.previewBase) return { sourceCommit };
  const expectedTree = row.previewTree ?? (sourceCommit ? await treeOfCommit(repoPath, sourceCommit) ?? undefined : undefined);
  return { sourceCommit, expectedTree, expectedTarget: row.previewBase, expectedPhysical: decodePhysical(row.previewPhysical) };
}

/**
 * 一行记录投影成界面/交接/回执共用的那一份。**所有消费点都从这里拿。**
 *
 * `failure` 归一：撤掉的 `command_missing` 这类值本身就是旧判据的结论，认不出就报
 * 「未通过、没有具体分类」。入口那句话由落盘的起跑前事实现算，不另存一份结论。
 */
export function gateView(row: GateRow): AcceptGateView {
  return {
    // 执行方式只说真起过的那一次：没起跑（entry_missing）就没有「实际执行」可言。
    executionNotice: row.failure === "entry_missing" ? null
      : gateScopeNotice(row.executionMode ?? readGateLaunch(row.logPath)?.confinementId),
    id: row.id,
    taskId: row.taskId,
    command: row.command,
    prepareCommand: row.prepareCommand ?? null,
    cwd: row.cwd,
    status: row.status as AcceptGateStatus,
    exitCode: row.exitCode ?? null,
    failure: normalizeAcceptGateFailure(row.failure),
    entryNote: gateEntryNote(decodeGateEntryProbe(row.entryProbe), row.status),
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? null,
    sourceCommit: row.sourceCommit ?? null,
    targetBranch: row.targetBranch ?? null,
    targetCommit: row.targetCommit ?? null,
    fastForward: row.fastForward ?? null,
    previewBase: row.previewBase ?? null,
    stale: false,
    logPath: row.logPath,
    logAvailable: gateLogReadable(row.logPath),
    logTail: acceptGateLogTail(row.logPath),
    handoff: row.handoffAt ? { at: row.handoffAt, error: row.handoffError ?? null } : null,
    processPending: row.processPending,
  };
}


export async function latestRun(taskId: string): Promise<GateRow | null> {
  return (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.taskId, taskId))
    .orderBy(desc(acceptGateRuns.startedAt), desc(acceptGateRuns.id)).limit(1)).at(0) ?? null;
}

export async function runningRun(taskId: string): Promise<GateRow | null> {
  return (await db.select().from(acceptGateRuns)
    .where(and(eq(acceptGateRuns.taskId, taskId), eq(acceptGateRuns.status, "running")))
    .orderBy(desc(acceptGateRuns.startedAt)).limit(1)).at(0) ?? null;
}

/** 这个任务干活的那个目录。worktree 没了/不是 git 项目时回落到项目目录（同 workflow 的命令站）。 */
export async function prepareGateCwd(task: TaskRow, repoPath: string): Promise<string> {
  try { return (await taskWorkspace(task, repoPath)).path; }
  catch { return repoPath; }
}

export const headCommit = (cwd: string) => commitAt(cwd, "HEAD");

export async function gateHead(task: TaskRow, repoPath: string): Promise<string | null> {
  const cwd = await existingTaskWorkspacePath(task, repoPath);
  return cwd ? headCommit(cwd) : null;
}

export function acceptGateCommandOf(project: Pick<ProjectRow, "acceptGateCommand"> | null | undefined): string | null {
  return normalizeAcceptGateCommand(project?.acceptGateCommand);
}

/** 准备命令（快照里先装依赖）。null = 没配，依赖照旧借用工作区那一份。 */
export function acceptGatePrepareOf(project: Pick<ProjectRow, "acceptGatePrepare"> | null | undefined): string | null {
  return normalizeAcceptGateCommand(project?.acceptGatePrepare);
}

/**
 * 那一次跑的是不是现在这一套（准备命令 + 前置命令）。复用旧绿、批量预判、卡片新鲜度三处共用：
 * 准备命令换了，装进快照的依赖就可能是另一份，那次的绿不再替现在这一套作证。
 */
export function sameGateRecipe(row: Pick<GateRow, "command" | "prepareCommand">, command: string | null, prepare: string | null): boolean {
  return row.command === command && (row.prepareCommand ?? null) === prepare;
}

/**
 * 这一按**当初**拿什么放的行。没验收过 / 老数据没留 → null（如实的「不知道」）。
 *
 * `passed` 那一档要把真的跑绿的那一次原样捞出来（按 id，不是「最近一次」）；记录本身可能
 * 已经随归档清理没了，那时只留 mode —— 回执据此说「凭据的明细已经不在了」。
 */
async function acceptBasis(task: TaskRow): Promise<AcceptGateBasis | null> {
  const mode = task.acceptedGateMode as AcceptGateBasisMode | null;
  if (mode !== "passed" && mode !== "skipped" && mode !== "unset") return null;
  if (mode !== "passed" || !task.acceptedGateRunId) return { mode, run: null };
  const row = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, task.acceptedGateRunId))).at(0);
  return { mode, run: row && row.taskId === task.id ? gateView(row) : null };
}

/** 这个任务名下的某一次（给「看完整日志」按 run 取用，顺带挡住跨任务的 id）。 */
export async function acceptGateRunOf(taskId: string, runId: string): Promise<AcceptGateView | null> {
  const row = (await db.select().from(acceptGateRuns).where(eq(acceptGateRuns.id, runId))).at(0);
  return row && row.taskId === taskId ? gateView(row) : null;
}

/**
 * 按项目当前的门禁基准，这一按此刻会不会在门禁之前被拦（没含目标分支 / 预演冲突）。状态接口和
 * 「让任务解决」那条直达入口共用：两边判的必须是同一件事。
 *
 * 合并预览档要知道这次快照借哪几个依赖目录（与 acceptGateCheck 同一个入参）。这里只读登记
 * （gateDependencies：树与文件系统），**不**读完整源码身份 —— 后者要比对整个工作区；不是这一档时
 * 一行都不读。配了准备命令就一个都不借（accept-gate-source 的 GateSource.prepared）。
 */
export async function judgeGateBaseline(task: TaskRow, project: ProjectRow) {
  const baseline = normalizeAcceptGateBaseline(project.acceptGateBaseline);
  const prepared = !!acceptGatePrepareOf(project);
  const head = await gateHead(task, project.repoPath);
  const cwd = await existingTaskWorkspacePath(task, project.repoPath);
  let sourceError: string | null = null;
  const borrowed = !(baseline === "merge_preview" && cwd && head) ? undefined
    : prepared ? { cwd, dependencies: [] }
    : await gateDependencies(cwd, head).then(planned => ({ cwd, dependencies: planned.dependencies }),
      (error) => { sourceError = String(error); return undefined; });
  const judged = await resolveGateBaseline(task, project, head, borrowed);
  return { head, cwd, judged, sourceError };
}

/** 界面要的那一份：这个项目设没设、上一次跑成什么样、这次结果还作不作数、凭据是什么。 */
export async function acceptGateState(taskId: string): Promise<AcceptGateState> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return { command: null, running: null, latest: null, basis: null };
  const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0) ?? null;
  const command = acceptGateCommandOf(project);
  // 返回**保存着的**那一条，不随前置命令有没有设而投影成 null：卡片拿它当编辑初值、算差量，
  // 投影掉了，留空的那一格就清不掉真实配置（第 1 轮审查 #2）。用不用它由 command 决定。
  const prepare = acceptGatePrepareOf(project);
  const prepared = !!command && !!prepare;
  const unavailable = command ? gateConfinementUnavailable() : null;
  const executionNotice = command ? gateExecutionNotice() : null;
  const basis = await acceptBasis(task);
  const frozen = task.archived || task.stage === "accepted" || task.stage === "merged";
  const baseline = normalizeAcceptGateBaseline(project?.acceptGateBaseline);
  // 门禁基准此刻要对照的目标与它会不会拦下这一按。已验收的任务没有「下一按」，不去读 git。
  const { head, cwd, judged, sourceError: dependencyError } = frozen || !project || !command
    ? { head: null, cwd: !frozen && project ? await existingTaskWorkspacePath(task, project.repoPath) : null, judged: null, sourceError: null }
    : await judgeGateBaseline(task, project);
  let sourceError: string | null = dependencyError;
  const target = judged?.plan ?? judged?.block ?? null;
  const block = judged?.block ?? null;
  const baselineView = { baseline, baselineBlock: block?.error ?? null,
    baselineIssue: block ? { reason: block.reason, targetBranch: block.targetBranch, conflictFiles: block.conflictFiles ?? [],
      handedOffAt: block.reason === "merge_conflict" ? conflictHandedAt(task.id, head, block.targetCommit) : null } : null,
    baselineTarget: target?.targetBranch && target.targetCommit ? { branch: target.targetBranch, commit: target.targetCommit } : null };
  const latestRow = await latestRun(taskId);
  if (!latestRow) return { command, prepare, running: null, latest: null, basis, unavailable, sourceError, executionNotice, ...baselineView };
  const view = gateView(latestRow);
  const pending = (await db.select().from(acceptGateRuns).where(and(eq(acceptGateRuns.taskId, taskId),
    or(eq(acceptGateRuns.status, "running"), eq(acceptGateRuns.processPending, true))))
    .orderBy(desc(acceptGateRuns.startedAt)).limit(1)).at(0);
  if (pending) return { command, prepare, running: gateView(pending), latest: view, basis, sourceError, executionNotice, ...baselineView };
  // 新鲜度按**现在**这棵树算：前端据它决定说「已通过，可以直接验收」还是「要重跑」。
  const frozenHead = task.acceptedSourceCommit ?? basis?.run?.sourceCommit ?? null;
  const source = cwd && !unavailable ? await readGateSource(cwd, gateSnapshotPath(task.id, "identity", prepared), prepared)
    .catch(error => { sourceError = String(error); return null; }) : null;
  // 基准也算进新鲜度：合并预览那份绿只对当时的目标分支尖端作数（被拦下的那一档没有 plan，旧绿同样不作数）。
  const stale = !sameGateRecipe(latestRow, command, prepare) || (frozen ? !frozenHead || frozenHead !== latestRow.sourceCommit
    : !gateSourceMatches(latestRow, source) || !judged?.plan || !gateBaselineMatches(latestRow, judged.plan));
  return { command, prepare, running: null, latest: { ...view, stale }, basis, unavailable, sourceError, executionNotice, ...baselineView };
}
