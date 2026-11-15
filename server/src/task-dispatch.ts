// 「派它的那条任务」（tasks.dispatched_by）：普通任务里派出去的独立任务收在谁名下。
//
// 这层关系原来只活在 creation_origin 那条审计记录里（`{kind:"agent", taskId}`），侧栏、详情页
// 一处都看不见。它跟 parentId 是两回事：parentId 是团队执行者 —— 不进顶层列表、共用调度台的
// 目录、跟团队一起验收；派出去的任务仍是完整独立的任务（自己的 worktree、审查、验收），只是
// 在界面上收在派它的那条下面。所以单开一列，parentId 的语义一处不碰。
//
// 判据（新建与存量回填同一份，回填的 SQL 在 db/migrate-dispatched-by.ts）：
//   · 显式给了 dispatchedBy（用户从回复框派出去、派活单）→ 以它为准；
//   · 否则看创建来源：智能体在某条任务的回合里建的，且那条任务是普通任务（不是团队调度台、
//     不是讨论）、新任务自己也是普通任务、不是团队执行者 → 记那条任务。
// 团队调度台用 MCP 另建的任务不收进来：团队行底下已经是它的执行者，再挂一层就改了团队在
// 侧栏的样子（这一轮团队、讨论两种模式不动）。
import { eq, inArray } from "drizzle-orm";
import { parseTaskCreationOrigin } from "@ash/shared/task-origin";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import type { Actor } from "./auth/context.js";
import { canSeeProject } from "./auth/visibility.js";

type DispatchCandidate = {
  id: string;
  parentId?: string | null;
  mode?: string | null;
  creationOrigin?: string | null;
  dispatchedBy?: string | null;
};

/** 来源记录里认得出的派活人（还没查它是不是普通任务）。 */
function originDispatcher(row: DispatchCandidate): string | null {
  if (row.parentId) return null;
  if ((row.mode ?? "single") !== "single") return null;
  const origin = parseTaskCreationOrigin(row.creationOrigin ?? null);
  if (origin?.kind !== "agent" || !origin.taskId || origin.taskId === row.id) return null;
  return origin.taskId;
}

/** 一批待建的行各自归在谁名下。显式给了的（含 null）原样留着。 */
export async function resolveDispatchedBy(rows: DispatchCandidate[]): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const pending = new Map<string, string>();
  for (const row of rows) {
    if (row.dispatchedBy !== undefined) result.set(row.id, row.dispatchedBy ?? null);
    else {
      const source = originDispatcher(row);
      if (source) pending.set(row.id, source);
      else result.set(row.id, null);
    }
  }
  const sourceIds = [...new Set(pending.values())];
  const sources = sourceIds.length
    ? await db.select({ id: tasks.id, mode: tasks.mode }).from(tasks).where(inArray(tasks.id, sourceIds))
    : [];
  const singles = new Set(sources.filter((source) => source.mode === "single").map((source) => source.id));
  for (const [rowId, source] of pending) result.set(rowId, singles.has(source) ? source : null);
  return result;
}

/**
 * `POST /tasks` 显式给的 dispatchedBy 能不能收。派活人可以在别的项目里（派到另一个仓库去
 * 干活），所以不走同项目判据，只要求看得见、是普通任务；团队执行者自有归属（parentId），
 * 不收第二层。「看不见」与「不存在」回同一句话，免得这里变成 id 探测器。
 */
export async function dispatcherRefusal(
  actor: Actor,
  body: { dispatchedBy?: string | null; parentId?: string | null; mode?: string | null },
): Promise<{ status: 400 | 404; body: Record<string, unknown> } | null> {
  if (!body.dispatchedBy) return null;
  const dispatcher = (await db.select({ projectId: tasks.projectId, mode: tasks.mode })
    .from(tasks).where(eq(tasks.id, body.dispatchedBy))).at(0);
  if (!dispatcher || !(await canSeeProject(actor, dispatcher.projectId))) {
    return { status: 404, body: { error: "task not found", dispatchedBy: body.dispatchedBy } };
  }
  if (dispatcher.mode !== "single" || body.parentId || (body.mode ?? "single") !== "single") {
    return { status: 400, body: { error: "只有普通任务能收派出去的普通任务", dispatchedBy: body.dispatchedBy } };
  }
  return null;
}
