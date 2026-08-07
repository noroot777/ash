// 执行链在一条线上**往前走一步**的唯一实现处。
//
// 一条线是这样跑起来的：几个「会停下来等」的锚点（干活等 agent、自动验证等这一轮验证跑完、
// 等我点头等人）把线切成几段，段里是当场做完的站（跑一条命令、打开预览、合并并清理）。
// 每次有事件落回来（这一轮结算了、某一轮审查有结论了、用户在某道关口点了头），调用方
// 只需要说一句「我是从**这一站**回来的」，剩下的——把这一段跑完、决定下一个锚点怎么办、
// 把游标挪过去——全在这里。
//
// 为什么要有游标（`tasks.workflow_at`）：早先段落是按**锚点类型**切的，一条线上第二个
// 「自动验证」站没有任何东西能把它跟第一个区分开，只会被静默跳过——所以那时 verify 和
// human 被列进 SINGLETON_KINDS，界面上灰着不让加第二个。改成按站 id 切之后，这两种站
// 才真的能在一条线上出现多次。
//
// 三条不变量：
//   ① 游标每挪一次都广播（`task.updated`）。前端的验收确认框要靠它区分「中途关口放行」
//      和「最后一关，点了就合」——拿着旧游标会把不可逆的合并说成放行。
//   ② 一段跑砸了就地停下，**不往下推**：别在一条卡住的线上开验证、也别送进人工关口。
//   ③ 验证站轮数用尽时是**停下**，不是跳过。绕过一个用户亲手画上去的验证站，比停下更坏。
import { eq } from "drizzle-orm";
import type { WorkflowDef, WorkflowStep } from "@harness/shared/workflow";
import { STEP_LABELS } from "@harness/shared/workflow";
import { firstAnchor, nextAnchor, prevAnchor } from "@harness/shared/workflow-policy";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { publishTaskUpdated } from "./task-store.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { verifyStationAction } from "./review-policy.js";
import { advanceSegment, type SegmentOptions } from "./workflow-steps.js";
import { now } from "./util.js";

type TaskRow = typeof tasks.$inferSelect;

export interface WorkflowAdvanceOptions extends SegmentOptions {
  /** 测试只验证游标时注入 no-op，避免为一条断言真的启动 Claude/Codex。 */
  startVerifyRound?: (taskId: string) => Promise<unknown>;
}

/** 把游标挪到某一站并广播。广播不能省，理由见文件头不变量①。 */
export async function setWorkflowAt(taskId: string, stepId: string | null): Promise<void> {
  await db.update(tasks).set({ workflowAt: stepId, updatedAt: now() }).where(eq(tasks.id, taskId));
  await publishTaskUpdated(taskId);
}

/**
 * 这一站已经验过几轮（按站数，不是这个任务被验过的总次数）。
 *
 * 两种载体都要数进来：历史那批独立审查任务（一行一轮，身上记着 review_step），以及
 * 现在的就地验证轮（没有独立任务行，按站的轮数记在被验任务的 verify_station_rounds
 * 上，换一站归零）。漏掉后者的话，一站验证会因为「一轮都没验过」被无限重派。
 *
 * 导出只为回归测试钉住「两种载体都数进来」（`npm -w server run test:review`）。
 */
export async function stationRounds(taskId: string, stepId: string): Promise<number> {
  const target = (await db
    .select({ reviewStep: tasks.reviewStep, verifyStationRounds: tasks.verifyStationRounds })
    .from(tasks)
    .where(eq(tasks.id, taskId))).at(0);
  const inline = target?.reviewStep === stepId ? target.verifyStationRounds ?? 0 : 0;
  const rows = await db
    .select({ id: tasks.id, reviewStep: tasks.reviewStep })
    .from(tasks)
    .where(eq(tasks.reviewOf, taskId));
  // 老审查任务身上没有 review_step（那时一条线只可能有一站验证）：把它们算进第一站。
  return rows.filter((row) => (row.reviewStep ?? stepId) === stepId).length + inline;
}

async function parentIsTeam(task: TaskRow): Promise<boolean> {
  if (!task.parentId) return false;
  const parent = (await db.select({ mode: tasks.mode }).from(tasks).where(eq(tasks.id, task.parentId))).at(0);
  return parent?.mode === "team";
}

async function atVerifyStation(
  task: TaskRow,
  def: WorkflowDef,
  station: WorkflowStep,
  opts: WorkflowAdvanceOptions,
): Promise<boolean> {
  const action = verifyStationAction({
    parentIsTeam: await parentIsTeam(task),
    reviewRequested: task.reviewRequested,
    mode: task.mode,
    workflow: def,
    at: station.id,
    stage: task.stage,
    rounds: await stationRounds(task.id, station.id),
  });
  if (action === "skip") return true; // 接着往下走
  if (action === "halt") {
    await appendTaskTimeline(
      task.id,
      `这条线停在「${STEP_LABELS.verify}」这一站：自动复审轮数已经用完，等你处理后再手动派一轮。`,
    );
    return false;
  }
  // 先挪游标再开验证：开那一步要读游标才知道该用哪一站写的执行器去验。
  await setWorkflowAt(task.id, station.id);
  const startVerifyRound = opts.startVerifyRound
    ?? (await import("./review.js")).startVerifyRound;
  await startVerifyRound(task.id).catch((error) => appendTaskTimeline(
    task.id,
    `想在「${STEP_LABELS.verify}」这一站开一轮验证，但没开起来（${error instanceof Error ? error.message : String(error)}）。`,
  ));
  return false;
}

/**
 * 从**某一站**接着往前走：先把紧跟它的那一段跑完，再按下一个锚点是什么决定怎么办。
 *
 * `fromStepId` 就是「我是从这一站回来的」：干活那一轮结算传 run 站、审查有结论传那一站
 * 验证、用户点头传那一道关口。传 null 或指到不存在的站（老任务、换过快照）时不动——
 * 调用方负责回落到 firstAnchor。
 */
export async function advanceWorkflowFrom(
  task: TaskRow,
  def: WorkflowDef | null,
  fromStepId: string | null | undefined,
  opts: WorkflowAdvanceOptions = {},
): Promise<void> {
  if (!def || !fromStepId) return;
  let from: string | null = fromStepId;
  // 循环而不是递归：跳过一站验证之后还要接着走下一段，可能连着跳好几站。
  while (from) {
    if (!(await advanceSegment(task, def, from, opts))) return; // 这一段卡住了，别再往下推
    const next: WorkflowStep | null = nextAnchor(def, from);
    if (!next) {
      // 走到头了。游标停在最后一站，前端据此知道这条线已经走完。
      await setWorkflowAt(task.id, from);
      return;
    }
    if (next.kind === "human") {
      await setWorkflowAt(task.id, next.id);
      const { enterHumanGate } = await import("./review.js");
      await enterHumanGate(task.id);
      return;
    }
    if (next.kind === "verify") {
      if (!(await atVerifyStation(task, def, next, opts))) return;
      // 跳过这一站：游标照样挪过去，免得下一次事件落回来又从头判一遍。
      await setWorkflowAt(task.id, next.id);
      from = next.id;
      continue;
    }
    // 「让 AI 干活」是这条线的起点，往前走时不会再撞见第二个（run 仍是 singleton）。
    // 真撞见了就停下：再唤醒一次 agent 不是这一层该做的决定。
    await setWorkflowAt(task.id, from);
    return;
  }
}

/**
 * 干活那一轮结算之后从哪一站接着走。
 *
 * 一般就是「让 AI 干活」那一站——线是从那儿起步的。唯一的例外是**游标停在某一站验证**
 * 上（那一站没过、打回给 AI 重做了）：这时候要退回它前面那个锚点，好让紧跟着的那一段
 * （典型：先跑构建再验）重跑一遍，然后**重新验那一站**，而不是把它当验过了往下走。
 */
export function settleFrom(def: WorkflowDef | null, at: string | null | undefined): string | null {
  const runId = firstAnchor(def, "run")?.id ?? null;
  if (!def || !at) return runId;
  const step = def.steps.find((s) => s.id === at);
  if (step?.kind !== "verify") return runId;
  return prevAnchor(def, step.id)?.id ?? runId;
}
