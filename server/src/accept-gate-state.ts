import { and, desc, eq, or } from "drizzle-orm";
import { normalizeAcceptGateCommand, type AcceptGateBasis, type AcceptGateBasisMode, type AcceptGateFailure, type AcceptGateState, type AcceptGateStatus, type AcceptGateView } from "@ash/shared/accept-gate";
import { db } from "./db/index.js";
import { acceptGateRuns, projects, tasks } from "./db/schema.js";
import { acceptGateLogTail } from "./accept-gate-process.js";
import { commitAt } from "./task-branch-plan.js";
import { existingTaskWorkspacePath, taskWorkspace } from "./task-workspace.js";

type GateRow = typeof acceptGateRuns.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;
type ProjectRow = typeof projects.$inferSelect;

export const gateView = (row: GateRow): AcceptGateView => ({
  id: row.id,
  taskId: row.taskId,
  command: row.command,
  cwd: row.cwd,
  status: row.status as AcceptGateStatus,
  exitCode: row.exitCode ?? null,
  failure: (row.failure as AcceptGateFailure | null) ?? null,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt ?? null,
  sourceCommit: row.sourceCommit ?? null,
  targetBranch: row.targetBranch ?? null,
  targetCommit: row.targetCommit ?? null,
  fastForward: row.fastForward ?? null,
  stale: false,
  logPath: row.logPath,
  logTail: acceptGateLogTail(row.logPath),
  handoff: row.handoffAt ? { at: row.handoffAt, error: row.handoffError ?? null } : null,
  processPending: row.processPending,
});

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

/**
 * 被测的那棵树：工作区当前 HEAD。
 *
 * 拿不到（非 git 项目）就是 null —— 那时**一次结果只作数一次**（没有能比对的身份，
 * 复用等于拿上一棵树的结论替这一棵背书）。
 */
export const headCommit = (cwd: string) => commitAt(cwd, "HEAD");

export async function gateHead(task: TaskRow, repoPath: string): Promise<string | null> {
  const cwd = await existingTaskWorkspacePath(task, repoPath);
  return cwd ? headCommit(cwd) : null;
}

export function acceptGateCommandOf(project: Pick<ProjectRow, "acceptGateCommand"> | null | undefined): string | null {
  return normalizeAcceptGateCommand(project?.acceptGateCommand);
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

/** 界面要的那一份：这个项目设没设、上一次跑成什么样、这次结果还作不作数、凭据是什么。 */
export async function acceptGateState(taskId: string): Promise<AcceptGateState> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return { command: null, running: null, latest: null, basis: null };
  const project = (await db.select().from(projects).where(eq(projects.id, task.projectId))).at(0) ?? null;
  const command = acceptGateCommandOf(project);
  const basis = await acceptBasis(task);
  const latestRow = await latestRun(taskId);
  if (!latestRow) return { command, running: null, latest: null, basis };
  const view = gateView(latestRow);
  const pending = (await db.select().from(acceptGateRuns).where(and(eq(acceptGateRuns.taskId, taskId),
    or(eq(acceptGateRuns.status, "running"), eq(acceptGateRuns.processPending, true))))
    .orderBy(desc(acceptGateRuns.startedAt)).limit(1)).at(0);
  if (pending) return { command, running: gateView(pending), latest: view, basis };
  // 新鲜度按**现在**这棵树算：前端据它决定说「已通过，可以直接验收」还是「要重跑」。
  // 判据与 acceptGateCheck 的复用判据必须是同一条（提交 + 命令），否则卡上说「不会重跑」、
  // 一点下去却真的重跑了。
  const frozen = task.archived || task.stage === "accepted" || task.stage === "merged";
  const head = frozen ? task.acceptedSourceCommit ?? basis?.run?.sourceCommit ?? null
    : project ? await gateHead(task, project.repoPath) : null;
  const stale = !head || head !== latestRow.sourceCommit || latestRow.command !== command;
  return { command, running: null, latest: { ...view, stale }, basis };
}
