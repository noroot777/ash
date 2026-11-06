// 「这个任务此刻要人做哪一件事」在 server 侧的完整答案：shared 的 humanTurnOf 判种类，
// 这里补上它算不出来的事实（闸口开没开、有没有待裁定的驳回、是不是团队执行者），再给每一
// 件事配一个**代次**（generation）。
//
// 代次 = 「同一种事里的第几回」。卡片上记着发卡那一刻的代次，按钮按下去时现算一遍，对不上
// 就是旧卡 —— 旧提问卡答不中新提问，上一轮的驳回卡裁不了这一轮。各种事的代次取自那件事
// 自己的身份，不靠时间猜：
//   question  提问占位（每次 ask 一个随机 id，task-wait-ownership.ts）；老数据退回到
//             「第几次提问 + 问题原文指纹」
//   failed    这一次失败的结束时刻（重试后再失败就换了）
//   dispute   那条驳回所在的审查链 + 轮次（就是裁定接口的 target）
//   duet_gate 闸口版本（duet/gate-version.ts）
//   verify_failed / accept  这一版成果的身份（task-result-version.ts：结束时刻；团队连同执行者和调度台
//             自己的回合）
// failed / accept 的代次与验收、重试接口收的期望值是同一份身份（task-result-version.ts），按钮带着它进去。
import type { QuestionItem, Task } from "@ash/shared";
import { questionItems, questionKey } from "@ash/shared/questions";
import { humanTurnOf, type HumanTurnKind } from "@ash/shared/task-attention";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { projects, tasks } from "../db/schema.js";
import { freeReviewRuns } from "../db/schema-free-workflow.js";
import { currentGateVersion } from "../duet/gate-version.js";
import { unresolvedDisputes } from "../free-review-dispute.js";
import { enrichTasks, toTaskListItem } from "../task-store.js";
import { failureVersionOf, resultVersionOf } from "../task-result-version.js";
import { questionOccurrenceOf } from "../task-wait-ownership.js";

export type Turn =
  | { kind: "question"; generation: string; questionKey: string; items: QuestionItem[] }
  | { kind: "failed"; generation: string }
  | { kind: "dispute"; generation: string; runId: string; round: number; summary: string | null; hasDefer: boolean }
  | { kind: "duet_gate"; generation: string; version: number }
  | { kind: "verify_failed"; generation: string }
  | { kind: "accept"; generation: string; reviewFailed: boolean };

export interface TaskView {
  task: Task;
  ownerUserId: string | null;
  projectName: string;
  /** 团队执行者：验收、结局都记在调度台身上。 */
  teamWorker: boolean;
  turn: Turn | null;
}

/** failed / accept 的代次去掉种类前缀，就是重试、验收接口认的那份身份。 */
export const versionOf = (generation: string) => generation.replace(/^[a-z]:/, "");

/** 卡片上带按钮的那几种（verify_failed 只是通知）。 */
export const DECISION_KINDS: ReadonlySet<HumanTurnKind> = new Set(["question", "failed", "dispute", "duet_gate", "accept"]);

/** 最近一条工作区审查没通过（自由工作流）。待验收卡上据此要求二次确认。 */
async function latestReviewFailed(taskId: string): Promise<boolean> {
  const run = (await db.select({ status: freeReviewRuns.status }).from(freeReviewRuns)
    .where(and(eq(freeReviewRuns.taskId, taskId), eq(freeReviewRuns.targetKind, "workspace")))
    .orderBy(desc(freeReviewRuns.createdAt)).limit(1)).at(0);
  return run?.status === "failed";
}

/**
 * 一批任务的现状。返回的 Map 里，查不到的任务（被删了）对应 null —— 删任务不发事件，
 * 对账要靠这一档把它名下的卡片收掉。
 */
export async function viewsOf(taskIds: string[]): Promise<Map<string, TaskView | null>> {
  const out = new Map<string, TaskView | null>(taskIds.map((taskId) => [taskId, null]));
  if (!taskIds.length) return out;
  const rows = await db.select().from(tasks).where(inArray(tasks.id, taskIds));
  if (!rows.length) return out;
  const leads = rows.filter((row) => row.mode === "team" && !row.parentId).map((row) => row.id);
  const workerRows = leads.length ? await db.select().from(tasks).where(inArray(tasks.parentId, leads)) : [];
  const parentIds = [...new Set(rows.flatMap((row) => row.parentId ? [row.parentId] : []))];
  const parents = parentIds.length
    ? new Map((await db.select({ id: tasks.id, mode: tasks.mode }).from(tasks).where(inArray(tasks.id, parentIds))).map((p) => [p.id, p.mode]))
    : new Map<string, string>();
  const [enriched, workers] = await Promise.all([enrichTasks(rows), enrichTasks(workerRows)]);
  const projectNames = new Map((await db.select({ id: projects.id, name: projects.name }).from(projects)
    .where(inArray(projects.id, [...new Set(rows.map((row) => row.projectId))]))).map((p) => [p.id, p.name]));
  const rowById = new Map(rows.map((row) => [row.id, row]));

  for (const task of enriched) {
    const row = rowById.get(task.id)!;
    const crew = workers.filter((worker) => worker.parentId === task.id);
    const gateVersion = task.mode === "duet" && task.status === "awaiting_review" ? await currentGateVersion(task.id) : null;
    const disputes = task.workflowMode === "free" && task.mode === "single" ? await unresolvedDisputes(task.id) : [];
    const teamWorker = !!task.parentId && parents.get(task.parentId) === "team";
    const kind = humanTurnOf(toTaskListItem(task), crew.map(toTaskListItem), {
      teamWorker,
      duetGateOpen: gateVersion !== null,
      disputeOpen: disputes.length > 0,
    });
    let turn: Turn | null = null;
    switch (kind) {
      case "question":
        turn = { kind, generation: questionOccurrenceOf(row), questionKey: questionKey(task), items: questionItems(task) };
        break;
      case "failed":
        turn = { kind, generation: `f:${failureVersionOf(task)}` };
        break;
      case "dispute": {
        // 好几条同时等裁定时一张卡只管一条：最近的那条。裁掉它，下一条再成一张新卡。
        const { run, round } = disputes[0]!;
        turn = {
          kind, generation: `d:${run.id}:${round.round}`, runId: run.id, round: round.round,
          summary: round.disputeSummary ?? null, hasDefer: !!round.disputeDeferReason,
        };
        break;
      }
      case "duet_gate":
        turn = { kind, generation: `g:${gateVersion}`, version: gateVersion! };
        break;
      case "verify_failed":
        turn = { kind, generation: `v:${await resultVersionOf(task)}` };
        break;
      case "accept":
        turn = { kind, generation: `a:${await resultVersionOf(task)}`, reviewFailed: await latestReviewFailed(task.id) };
        break;
    }
    out.set(task.id, {
      task,
      ownerUserId: row.ownerUserId ?? null,
      projectName: projectNames.get(task.projectId) ?? "",
      teamWorker,
      turn,
    });
  }
  return out;
}

/** 团队执行者的变化会改变调度台的「下一步」：对账时把调度台一起带上。 */
export async function withTeamLeads(taskIds: string[]): Promise<string[]> {
  if (!taskIds.length) return [];
  const parents = await db.select({ parentId: tasks.parentId }).from(tasks).where(inArray(tasks.id, taskIds));
  return [...new Set([...taskIds, ...parents.flatMap((row) => row.parentId ? [row.parentId] : [])])];
}
