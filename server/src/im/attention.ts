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
//   verify_failed  这一版成果的身份（task-result-version.ts：结束时刻；团队连同执行者和调度台自己的回合）
//   accept    这一版成果的身份 + 停在哪一道「等我点头」（task-human-gate.ts）：中途那几道放行不起新的一轮，
//             只认成果的话上一道关的旧卡能放行下一道、下一道关也发不出新卡（审查实测）。不在关口上只有成果身份，
//             和加关口身份之前发出去的卡同形
// failed / accept 的代次与验收、重试接口收的期望值是同一份身份，按钮带着它进去（acceptIdentityOf 拆回两样）。
import type { QuestionItem, Task } from "@ash/shared";
import { questionItems, questionKey } from "@ash/shared/questions";
import { humanTurnOf, type HumanTurnKind } from "@ash/shared/task-attention";
import { acceptanceMessage } from "@ash/shared/accept-message";
import { isFinalHumanGate } from "@ash/shared/workflow-policy";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { projects, tasks } from "../db/schema.js";
import { freeReviewRuns } from "../db/schema-free-workflow.js";
import { currentGateVersion } from "../duet/gate-version.js";
import { unresolvedDisputes } from "../free-review-dispute.js";
import { enrichTasks, toTaskListItem } from "../task-store.js";
import { humanGateOf, NO_GATE } from "../task-human-gate.js";
import { failureVersionOf, resultVersionOf } from "../task-result-version.js";
import { questionOccurrenceOf } from "../task-wait-ownership.js";

export type Turn =
  | { kind: "question"; generation: string; questionKey: string; items: QuestionItem[] }
  | { kind: "failed"; generation: string }
  | { kind: "dispute"; generation: string; runId: string; round: number; summary: string | null; hasDefer: boolean }
  | { kind: "duet_gate"; generation: string; version: number }
  | { kind: "verify_failed"; generation: string }
  /** release = 停在一道后面还有站的「等我点头」上，这一按只是放行；confirm = 确认框上那句「这一按会发生什么」。 */
  | { kind: "accept"; generation: string; reviewFailed: boolean; release: boolean; confirm: string };

export interface TaskView {
  task: Task;
  ownerUserId: string | null;
  projectName: string;
  /** 团队执行者：验收、结局都记在调度台身上。 */
  teamWorker: boolean;
  turn: Turn | null;
}

/** failed 的代次去掉种类前缀，就是重试接口认的那份身份。 */
export const versionOf = (generation: string) => generation.replace(/^[a-z]:/, "");

const acceptGeneration = (resultVersion: string, humanGate: string) =>
  humanGate === NO_GATE ? `a:${resultVersion}` : `a:${resultVersion}|${humanGate}`;

/** accept 的代次拆回验收接口认的两样：哪一版成果、哪一道关（没有关口那一截 = 不在关口上）。 */
export function acceptIdentityOf(generation: string): { resultVersion: string; humanGate: string } {
  const [resultVersion = "", humanGate = NO_GATE] = versionOf(generation).split("|");
  return { resultVersion, humanGate };
}

/** 卡片上带按钮的那几种（verify_failed 只是通知）。 */
export const DECISION_KINDS: ReadonlySet<HumanTurnKind> = new Set(["question", "failed", "dispute", "duet_gate", "accept"]);

/** 这张卡（种类 + 代次）管的那件事此刻还在：同一件事、同一代。 */
export function sameTurn(view: TaskView | null | undefined, kind: string, generation: string | null): view is TaskView & { turn: Turn } {
  return !!view?.turn && view.turn.kind === kind && view.turn.generation === generation;
}

/**
 * 卡上那件事此刻还等着人按：还是同一件事、同一代，而且没有一件已经开跑的事在替他办（验收前置命令在跑，卡上正显示
 * 着「在跑」）。点下去办成了不等于这件事了结了：中途那道关放行了、线却没能走过去（往下那一段没跑成、下一站验证轮数
 * 用尽、出错了），系统还停在同一道关上等人，卡上就还得有能点的按钮。按钮的收尾和对账都按它判（actions.ts settle、
 * reconcile.ts refresh / settleTask）；重启后的接管只看前半句（actions.ts recoverOne：那里卡上没有「在跑」要护着）。
 */
export function awaitsPress(view: TaskView | null | undefined, kind: string, generation: string | null): view is TaskView & { turn: Turn } {
  return sameTurn(view, kind, generation) && !view.task.acceptGateRunning;
}

/** 一个任务此刻的样子：undefined = 这一下没读清（同 viewsOf 的约定，调用方什么都别动），null = 任务没了。 */
export async function viewOf(taskId: string): Promise<TaskView | null | undefined> {
  const views = await viewsOf([taskId]).catch((error) => {
    console.warn(`[ash] 读不清任务现状（${taskId}）:`, (error as Error).message);
    return null;
  });
  return views?.has(taskId) ? views.get(taskId) ?? null : undefined;
}

/** 最近一条工作区审查没通过（自由工作流）。待验收卡上据此要求二次确认。 */
async function latestReviewFailed(taskId: string): Promise<boolean> {
  const run = (await db.select({ status: freeReviewRuns.status }).from(freeReviewRuns)
    .where(and(eq(freeReviewRuns.taskId, taskId), eq(freeReviewRuns.targetKind, "workspace")))
    .orderBy(desc(freeReviewRuns.createdAt)).limit(1)).at(0);
  return run?.status === "failed";
}

/**
 * 一批任务的现状。返回的 Map 里，查不到的任务（被删了）对应 null —— 删任务不发事件，
 * 对账要靠这一档把它名下的卡片收掉。**不在 Map 里** = 这一下看不清现状（讨论记录读不了，见 duet/gate-version.ts）：
 * 调用方什么都别动，不收卡、不发卡、不说「已删除」，下一次再看。
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
  const projectRows = new Map((await db.select({ id: projects.id, name: projects.name, acceptCommit: projects.acceptCommit }).from(projects)
    .where(inArray(projects.id, [...new Set(rows.map((row) => row.projectId))]))).map((p) => [p.id, p]));
  const rowById = new Map(rows.map((row) => [row.id, row]));

  for (const task of enriched) {
    const row = rowById.get(task.id)!;
    const crew = workers.filter((worker) => worker.parentId === task.id);
    let gateVersion: number | null = null;
    try {
      gateVersion = task.mode === "duet" && task.status === "awaiting_review" ? await currentGateVersion(task.id) : null;
    } catch (error) {
      console.warn(`[ash] 读不清讨论闸口现状，这一轮先不动它的卡 task=${task.id}:`, (error as Error).message);
      out.delete(task.id);
      continue;
    }
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
        turn = {
          kind, generation: acceptGeneration(await resultVersionOf(task), humanGateOf(row)), reviewFailed: await latestReviewFailed(task.id),
          release: !isFinalHumanGate(task.workflow, task.workflowAt),
          confirm: acceptanceMessage(toTaskListItem(task), projectRows.get(task.projectId)?.acceptCommit ?? true),
        };
        break;
    }
    out.set(task.id, {
      task,
      ownerUserId: row.ownerUserId ?? null,
      projectName: projectRows.get(task.projectId)?.name ?? "",
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
