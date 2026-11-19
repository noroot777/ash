// 「建在谁上面」那一格的候选：本项目的任务全部列出，能不能当前置、为什么不能，都问加边时的同一份判据
// （prerequisite-store.ts `edgeProblem` / `subjectProblem` / 成环），界面上不另拄一份。
//
// 两种问法：
//   · 已有的任务（`taskId`）：它还能不能加、能不能减，每条候选加上去成不成立；
//   · 还没建的任务（新建面板）：按面板上此刻的工作目录选择拼一行假想的下游来判。它的合入分支跟着已选的前置走
//     （`mergeTargetBranch`，面板建任务时照它写），所以「几条前置合入的分支不一样」在这里就判出来、置灰。
//     只有**自己就能选**的已选项才参与定合入分支：已归档、不能当前置、已经不可见的那条不能反过来把别的挤掉。
//     因为跟这个合入分支对不上才不能选的，标 `conflict`（单独拿出来是能选的）——面板恢复草稿时只去掉自己就不成立的。
import { desc, eq } from "drizzle-orm";
import type { PrerequisiteCandidates } from "@navi/shared/prerequisites";
import { db } from "./db/index.js";
import { projects, tasks } from "./db/schema.js";
import { projectHealthLight } from "./git.js";
import {
  cycleProblem, edgeProblem, graphWith, hasLaunched, launchedError, prerequisiteEdges, prerequisiteTarget, reaches, subjectProblem, type EdgeTask,
} from "./prerequisite-store.js";
import { cachedStanding } from "./prerequisite-view.js";

/** 新建面板那一行：还没有 id，判据只用得到这几列。 */
const DRAFT_ID = "__draft__";

export type CandidateQuery =
  | { kind: "task"; taskId: string }
  | { kind: "draft"; useWorktree: boolean; selected: string[] };

export async function prerequisiteCandidates(projectId: string, query: CandidateQuery, visible: (ids: string[]) => Promise<string[]>)
  : Promise<PrerequisiteCandidates | null> {
  const project = (await db.select().from(projects).where(eq(projects.id, projectId))).at(0);
  if (!project) return null;
  const rows = await db.select().from(tasks).where(eq(tasks.projectId, projectId)).orderBy(desc(tasks.updatedAt));
  const shown = new Set(await visible(rows.map((row) => row.id)));
  const known = new Map<string, EdgeTask>(rows.map((row) => [row.id, row]));

  let subject: EdgeTask;
  let locked: string | null = null;
  let removable = true;
  let taken = new Set<string>();
  let graph: Map<string, string[]> | null = null;
  let mergeTargetBranch: string | null = null;
  /** 新建面板那一行、还不带合入分支：判「它自己能不能选」用。已有的任务没有这一步。 */
  let standalone: EdgeTask | null = null;
  if (query.kind === "task") {
    const row = rows.find((item) => item.id === query.taskId);
    if (!row) return null;
    subject = row;
    removable = !await hasLaunched(row.id, row.status);
    locked = removable ? (await subjectProblem(row, known))?.message ?? null : launchedError(row).message;
    // 加不了的不必再逐条判：界面上不出「建在某任务上面」那一行。
    if (locked) return { locked, removable, mergeTargetBranch: row.mergeTargetBranch ?? null, candidates: [] };
    taken = new Set((await prerequisiteEdges(row.id)).map((edge) => edge.prerequisiteId));
    graph = await graphWith([]);
    mergeTargetBranch = row.mergeTargetBranch ?? null;
  } else {
    const useWorktree = query.useWorktree && projectHealthLight(project.repoPath).isRepo;
    const draft: EdgeTask = {
      id: DRAFT_ID, projectId, title: "新任务", mode: "single", parentId: null, reviewOf: null, status: "backlog", archived: false,
      useWorktree, mergeTargetBranch: null, acceptedTargetBranch: null, baseTaskId: null, stage: null,
    };
    standalone = draft;
    // 按选的先后，第一条自己就能选、又有限制的前置定下合入分支；之后的每一条（含已选的）都拿它来比。
    for (const id of query.selected) {
      const picked = rows.find((row) => row.id === id);
      if (!picked || !shown.has(id) || await ownProblem(draft, picked)) continue;
      const target = prerequisiteTarget(draft, picked);
      if (target) { mergeTargetBranch = target; break; }
    }
    subject = { ...draft, mergeTargetBranch };
  }

  async function ownProblem(task: EdgeTask, row: typeof rows[number]): Promise<string | null> {
    if (taken.has(row.id)) return "已经是前置";
    return (await edgeProblem(task, row, known))?.brief
      ?? (graph && reaches(graph, row.id, task.id) ? cycleProblem(task, row).brief : null);
  }

  const candidates = await Promise.all(rows.filter((row) => row.id !== subject.id && shown.has(row.id)).map(async (row) => {
    // 新建面板：先看它自己能不能选（不带合入分支），能选再拿已选定下的合入分支比。
    const own = await ownProblem(standalone ?? subject, row);
    const problem = own ?? (standalone ? await ownProblem(subject, row) : null);
    const standing = problem ? null : await cachedStanding(row);
    return {
      taskId: row.id, title: row.title || row.id, groupId: row.groupId ?? null,
      problem, conflict: !own && !!problem, step: standing?.step ?? null, round: standing?.round ?? null,
    };
  }));
  return { locked, removable, mergeTargetBranch, candidates };
}
