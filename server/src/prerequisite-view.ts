// 任务快照上的 `prerequisites`：这条任务建在哪几条上面、各自到哪一步了、谁建在它上面、是不是在等齐就起。
//
// 它是**后台事实**：前置那边一变，下游的这一格就变了，而下游自己的行一个字都没动。所以下游重发快照前先
// 推一格后台水位（`task_background_revisions`），前端那套快照合并据此认新旧（web/src/lib/taskSnapshot.ts）。
// 判定本身只在 prerequisite-standing.ts 一处，这里只摆形状。
import { eq, inArray, sql } from "drizzle-orm";
import type { TaskPrerequisites } from "@ash/shared/prerequisites";
import { db } from "./db/index.js";
import { projects, taskBackgroundRevisions, taskPrerequisiteLaunches, tasks } from "./db/schema.js";
import { prerequisiteStanding, type PrerequisiteStanding } from "./prerequisite-standing.js";
import { edgesAround } from "./prerequisite-store.js";
import { expandHome, resolveWorktreeBranchName } from "./git.js";
import { commitAt, containsCommit } from "./task-branch-plan.js";

type TaskRow = typeof tasks.$inferSelect;

// 一阵事件里同一条前置会被问好几遍（它自己的快照、每个下游的快照）：短时间内只判一次。
const STANDING_TTL_MS = 1_500;
const standingCache = new Map<string, { key: string; at: number; value: Promise<PrerequisiteStanding> }>();

export function cachedStanding(task: TaskRow): Promise<PrerequisiteStanding> {
  const key = `${task.updatedAt}|${task.status}|${task.stage}|${task.archived}`;
  const hit = standingCache.get(task.id);
  if (hit && hit.key === key && Date.now() - hit.at < STANDING_TTL_MS) return hit.value;
  const value = prerequisiteStanding(task).catch((): PrerequisiteStanding => ({ step: "unreadable", round: null, commit: null }));
  standingCache.set(task.id, { key, at: Date.now(), value });
  if (standingCache.size > 2_000) standingCache.delete(standingCache.keys().next().value!);
  return value;
}

/** 审查状态变了（它不动任务行）时，下一次读别用缓存。 */
export function forgetStanding(taskId: string): void {
  standingCache.delete(taskId);
}

/** 下游开工之后，这条前置是不是又有了下游手里没有的提交。 */
async function movedOn(repo: string | undefined, prerequisite: TaskRow, inherited: string | null): Promise<boolean> {
  if (!repo || !inherited || !prerequisite.useWorktree) return false;
  const current = await commitAt(repo, await resolveWorktreeBranchName(repo, prerequisite.id));
  return !!current && current !== inherited && !await containsCommit(repo, current, inherited);
}

/** 给一批任务各算一格；跟前置关系无关的任务不在结果里（快照上省略这一格）。 */
export async function prerequisiteViews(rows: TaskRow[]): Promise<Map<string, TaskPrerequisites>> {
  const out = new Map<string, TaskPrerequisites>();
  const ids = rows.map((row) => row.id);
  const edges = await edgesAround(ids);
  if (!edges.length) return out;
  const related = [...new Set(edges.flatMap((edge) => [edge.taskId, edge.prerequisiteId]))];
  const byId = new Map((await db.select().from(tasks).where(inArray(tasks.id, related))).map((row) => [row.id, row] as const));
  const launches = new Map((await db.select().from(taskPrerequisiteLaunches)
    .where(inArray(taskPrerequisiteLaunches.taskId, ids))).map((row) => [row.taskId, row] as const));
  const projectIds = [...new Set(rows.map((row) => row.projectId))];
  const repoOf = new Map((await db.select({ id: projects.id, repoPath: projects.repoPath }).from(projects)
    .where(inArray(projects.id, projectIds))).map((row) => [row.id, expandHome(row.repoPath)] as const));
  await Promise.all(rows.map(async (row) => {
    const mine = edges.filter((edge) => edge.taskId === row.id);
    const theirs = edges.filter((edge) => edge.prerequisiteId === row.id);
    if (!mine.length && !theirs.length) return;
    const launch = launches.get(row.id);
    const prerequisites = await Promise.all(mine.flatMap((edge) => {
      const prerequisite = byId.get(edge.prerequisiteId);
      if (!prerequisite) return [];
      return [(async () => {
        const standing = await cachedStanding(prerequisite);
        return {
          taskId: prerequisite.id,
          title: prerequisite.title || prerequisite.id,
          step: standing.step,
          round: standing.round,
          movedOn: await movedOn(repoOf.get(row.projectId), prerequisite, edge.inheritedCommit).catch(() => false),
        };
      })()];
    }));
    out.set(row.id, {
      prerequisites,
      dependents: theirs.flatMap((edge) => {
        const dependent = byId.get(edge.taskId);
        return dependent ? [{ taskId: dependent.id, title: dependent.title || dependent.id }] : [];
      }),
      waiting: !!launch?.requestedAt && row.status === "backlog" && !row.archived,
      blocked: row.status === "backlog" ? launch?.blocked ?? null : null,
      launched: !!launch?.launchedAt,
    });
  }));
  return out;
}

/**
 * 下游的这一格变了（前置推进、等齐就起的记账变了）：推一格后台水位再重发快照。不推的话前端拿到的新快照
 * 跟手里那份 updatedAt 一样，会被当成旧的丢掉。
 */
export async function republishPrerequisiteView(taskIds: string[]): Promise<void> {
  const ids = [...new Set(taskIds)];
  if (!ids.length) return;
  for (const taskId of ids) {
    await db.insert(taskBackgroundRevisions).values({ taskId, revision: 1 })
      .onConflictDoUpdate({ target: taskBackgroundRevisions.taskId, set: { revision: sql`${taskBackgroundRevisions.revision} + 1` } });
  }
  const { publishTaskUpdated } = await import("./task-store.js");
  for (const taskId of ids) {
    const exists = (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, taskId))).length;
    if (!exists) continue;
    republishing.set(taskId, (republishing.get(taskId) ?? 0) + 1);
    try { await publishTaskUpdated(taskId); }
    finally {
      const left = (republishing.get(taskId) ?? 1) - 1;
      if (left) republishing.set(taskId, left); else republishing.delete(taskId);
    }
  }
}

// 这里自己重发的那几条快照不再往下游传：下游看的是前置本身的状态，不看前置这一格，
// 传下去只会让一次变化沿着整条链白跑一遍。
const republishing = new Map<string, number>();
export const isRepublishingView = (taskId: string): boolean => republishing.has(taskId);
