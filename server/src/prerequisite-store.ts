// 前置关系的读写与校验。判定「站没站稳」在 prerequisite-standing.ts，起跑在 prerequisite-launch.ts。
//
// 一条边能不能成立，判据只在 `edgeProblem` 一处（建任务时逐条写的、建好之后加的都过它）：
//   · 两头都是同项目里的普通任务（团队调度台、团队执行者、审查任务都不算）；
//   · 下游还没开工：起点一旦按前置定下来，再加减前置就改不了它手里的代码了；
//   · 不成环；
//   · 两头都用 worktree 时，前置最终合入的分支要跟下游一致 —— 否则前置的代码进不了下游要合入的那条分支，
//     下游的验收永远等不到它。已经合入的前置不受这条限制：它的代码已经在目标分支上了。
//   · 已经钉在父任务分支上开工的（`worktreeBase` 填父任务分支、`baseTaskId` 非空）不再加前置：那是另一种
//     写法，两套依赖叠在一条任务上，验收时就说不清该等谁。
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { isAcceptedStage, type TaskStage } from "@ash/shared";
import { db } from "./db/index.js";
import { sessions, taskPrerequisiteLaunches, taskPrerequisites, tasks } from "./db/schema.js";
import { now } from "./util.js";

type TaskRow = typeof tasks.$inferSelect;
/** 校验只用到的那几列：新建的行（还没落库）也能直接拿来判。 */
export type EdgeTask = Pick<TaskRow, "id" | "projectId" | "title" | "mode" | "parentId" | "reviewOf" | "status"
  | "useWorktree" | "mergeTargetBranch" | "acceptedTargetBranch" | "baseTaskId" | "stage">;
export type PrerequisiteEdge = { taskId: string; prerequisiteId: string };

export class PrerequisiteError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) { super(message); }
}

const name = (task: { title: string | null; id: string }) => `「${task.title || task.id}」`;

export async function prerequisiteEdges(taskId: string) {
  return db.select().from(taskPrerequisites).where(eq(taskPrerequisites.taskId, taskId))
    .orderBy(asc(taskPrerequisites.createdAt), asc(taskPrerequisites.prerequisiteId));
}

export async function dependentEdges(prerequisiteId: string) {
  return db.select().from(taskPrerequisites).where(eq(taskPrerequisites.prerequisiteId, prerequisiteId));
}

export async function launchRecord(taskId: string) {
  return (await db.select().from(taskPrerequisiteLaunches).where(eq(taskPrerequisiteLaunches.taskId, taskId))).at(0) ?? null;
}

/** 一批任务各自的边（作为下游的、作为前置的），一次查完。 */
export async function edgesAround(ids: string[]) {
  if (!ids.length) return [];
  return db.select().from(taskPrerequisites)
    .where(or(inArray(taskPrerequisites.taskId, ids), inArray(taskPrerequisites.prerequisiteId, ids)))
    .orderBy(asc(taskPrerequisites.createdAt), asc(taskPrerequisites.prerequisiteId));
}

/** 团队调度台与团队执行者不参与前置：它们的「完成」和分支都不是普通任务那一套。 */
async function teamMember(task: EdgeTask, known: Map<string, EdgeTask>): Promise<boolean> {
  if (task.mode !== "single" || task.reviewOf) return true;
  if (!task.parentId) return false;
  const parent = known.get(task.parentId)
    ?? (await db.select().from(tasks).where(eq(tasks.id, task.parentId))).at(0);
  return parent?.mode === "team";
}

/** 下游开工了没有：起点按前置定下来过、跑过任何一回合、或者已经不在待办上。 */
export async function hasLaunched(taskId: string, status?: string): Promise<boolean> {
  if (status && status !== "backlog") return true;
  if ((await launchRecord(taskId))?.launchedAt) return true;
  return (await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.taskId, taskId)).limit(1)).length > 0;
}

/** 从 `from` 沿「建在…上面」往前走，走得到 `target` 就说明加上 target → from 这条边会成环。 */
function reaches(graph: Map<string, string[]>, from: string, target: string): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const at = stack.pop()!;
    if (at === target) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    stack.push(...(graph.get(at) ?? []));
  }
  return false;
}

async function graphWith(extra: PrerequisiteEdge[]): Promise<Map<string, string[]>> {
  const graph = new Map<string, string[]>();
  for (const edge of [...await db.select().from(taskPrerequisites), ...extra]) {
    graph.set(edge.taskId, [...(graph.get(edge.taskId) ?? []), edge.prerequisiteId]);
  }
  return graph;
}

// 成环是整张图的性质：A→B 与 B→A 同时加，各自读到的旧图里都没有环，两条都落下就成了环。所以「判一批边、
// 落这批边」在全局排成一条队（加边的入口只有建任务和建好之后加，两处都包在这里面）。只在真要加边时排，
// 没有前置的建任务不受影响；去掉边不会成环，不进这条队。
let graphChain: Promise<unknown> = Promise.resolve();
export function withPrerequisiteGraph<T>(work: () => Promise<T>): Promise<T> {
  const next = graphChain.catch(() => undefined).then(work);
  graphChain = next.catch(() => undefined);
  return next;
}

/**
 * 一批边能不能成立。`rows` 是这批里新建、还没落库的任务（建任务时逐条写前置走这里），其余的到库里取。
 * 不成立就抛 `PrerequisiteError`，一条都不落。
 */
export async function assertPrerequisiteEdges(edges: PrerequisiteEdge[], rows: EdgeTask[] = []): Promise<void> {
  if (!edges.length) return;
  const known = new Map<string, EdgeTask>(rows.map((row) => [row.id, row]));
  const missing = [...new Set(edges.flatMap((edge) => [edge.taskId, edge.prerequisiteId]))].filter((id) => !known.has(id));
  if (missing.length) for (const row of await db.select().from(tasks).where(inArray(tasks.id, missing))) known.set(row.id, row);
  const fresh = new Set(rows.map((row) => row.id));
  const accepted: PrerequisiteEdge[] = [];
  for (const edge of edges) {
    const task = known.get(edge.taskId);
    const prerequisite = known.get(edge.prerequisiteId);
    if (!task) throw new PrerequisiteError(`任务 ${edge.taskId} 不存在`, 404);
    if (!prerequisite) throw new PrerequisiteError(`前置任务 ${edge.prerequisiteId} 不存在`, 404);
    if (!fresh.has(task.id) && await hasLaunched(task.id, task.status)) throw launchedError(task);
    const problem = await edgeProblem(task, prerequisite, known);
    if (problem) throw new PrerequisiteError(problem);
    if (reaches(await graphWith(accepted), prerequisite.id, task.id)) {
      throw new PrerequisiteError(`${name(prerequisite)}已经直接或间接建在${name(task)}上面，再反过来就成环了`);
    }
    accepted.push(edge);
  }
}

const launchedError = (task: EdgeTask) => new PrerequisiteError(`${name(task)}已经开工，起点定下来之后不能再改前置`, 409);

async function edgeProblem(task: EdgeTask, prerequisite: EdgeTask, known: Map<string, EdgeTask>): Promise<string | null> {
  if (task.id === prerequisite.id) return "任务不能建在自己上面";
  if (task.projectId !== prerequisite.projectId) return `前置只能是同一项目里的任务，${name(prerequisite)}在别的项目里`;
  if (await teamMember(task, known)) return `${name(task)}不是普通任务（团队、团队执行者、审查任务不能有前置）`;
  if (await teamMember(prerequisite, known)) return `${name(prerequisite)}不是普通任务（团队、团队执行者、审查任务不能当前置）`;
  if (task.baseTaskId) return `${name(task)}已经钉在父任务的分支上开工，不能再加前置`;
  // 不用独立工作区的任务在项目目录里干活，拿不到还在前置分支上的代码（验收前它不在任何检出里）。
  if (!task.useWorktree && prerequisite.useWorktree && !isAcceptedStage(prerequisite.stage as TaskStage | null)) {
    return `${name(task)}不用独立工作区，拿不到${name(prerequisite)}分支上的代码；让它用独立工作区，或等${name(prerequisite)}合入后再开工`;
  }
  if (task.useWorktree && prerequisite.useWorktree && !isAcceptedStage(prerequisite.stage as TaskStage | null)) {
    const mine = task.mergeTargetBranch;
    const theirs = prerequisite.acceptedTargetBranch || prerequisite.mergeTargetBranch;
    if (!theirs) return `${name(prerequisite)}的最终合入分支还没定，没法判断它的代码能不能进${name(task)}要合入的分支`;
    if (mine && theirs !== mine) {
      return `${name(prerequisite)}最终合入 ${theirs}，${name(task)}合入 ${mine}，它又还没合入：它的代码进不了 ${mine}，这条任务的验收会一直等它`;
    }
  }
  return null;
}

/** 落边（调用方先过 `assertPrerequisiteEdges`，两步包在同一次 `withPrerequisiteGraph` 里）。重复的忽略。 */
export async function insertPrerequisiteEdges(edges: PrerequisiteEdge[]): Promise<void> {
  if (!edges.length) return;
  const at = now();
  await db.insert(taskPrerequisites)
    .values(edges.map((edge) => ({ ...edge, createdAt: at })))
    .onConflictDoNothing();
}

/** 去掉一条前置。下游已经开工的不能去：它手里的代码里已经有这条前置了。 */
export async function removePrerequisiteEdge(taskId: string, prerequisiteId: string): Promise<boolean> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) throw new PrerequisiteError("任务不存在", 404);
  if (await hasLaunched(taskId, task.status)) throw launchedError(task);
  const removed = await db.delete(taskPrerequisites)
    .where(and(eq(taskPrerequisites.taskId, taskId), eq(taskPrerequisites.prerequisiteId, prerequisiteId)))
    .returning({ id: taskPrerequisites.prerequisiteId });
  return removed.length > 0;
}

/**
 * 删任务时跟删行同一批执行的那几条：它作为下游的边、它作为前置的边、它的起跑记账，全部收掉。
 * 「谁建在它上面」要在删之前读出来（调用方删完据此通知下游），删了就再也查不到了。
 */
export function prerequisiteDeletes(taskId: string) {
  return [
    db.delete(taskPrerequisites).where(or(eq(taskPrerequisites.taskId, taskId), eq(taskPrerequisites.prerequisiteId, taskId))),
    db.delete(taskPrerequisiteLaunches).where(eq(taskPrerequisiteLaunches.taskId, taskId)),
  ] as const;
}
