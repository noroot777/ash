// 「等我点头」这一道关口的身份。
//
// 成果身份（task-result-version.ts）回答的是「还是不是你看过的那一版」，回答不了「还是不是你看到的那一道关」：
// 一条线上可以接连画好几道「等我点头」，中途那几道放行只挪游标、不起新的一轮，成果身份前后一模一样。只认它，
// 上一道关的旧卡就能放行后来那一道（审查实测：网页先放了第一道，再点飞书里第一道的旧卡，第二道也被放了）；
// 点过上一道关的卡之后，下一道关的代次和它一样、被那张已处理的卡占着，再也发不出能点的新卡。
//
// 所以线每**离开**一道「等我点头」，就在挪游标的同一个事务里领一个新身份（workflow-advance.ts setWorkflowAt）。
// 一个身份管的是两次离开关口之间那一段，不是某一道关本身：
//   · 走到关口之前（验证还在跑，待验收卡已经发了）和停在关口上是同一段：卡留着、原地换成「放行」的样子。到达时就换
//     的话，每条「先验证、再点头」的线都会多推一张，旧卡还写着假的「有了新的一轮」；放行进了下一站验证，代次又退回
//     没有关口那一截，把放行之前那张旧卡翻回来（第 1 轮审查后的对抗复核实测）；
//   · 放行之后、走到下一站之前（中间可能跑着很久的命令站）游标还在这一道上，也还是这一段：不冒新卡。这一段里再点
//     不会并着把后面那一段再跑一遍：验收互斥一直占到往下走那一步跑完（task-accept.ts acceptTask）。走完游标还停在
//     这一道上就是线没能走过去，再放一次就是重走：这件事还等着人按，飞书那张卡不收，换个新信封、照实写着停住了，
//     按钮还能点（im/attention.ts awaitsPress）；
//   · 离开这一道（去下一站验证、下一道关、或者线走完了）就是新的一段、新的卡；旧卡的身份再也对不上，不会被翻回来。
// 加列之前的任务、还没离开过关口的任务没有身份（NO_GATE），代次和以前同形：已经发出去的待验收卡照旧有效。
//
// 飞书的待验收卡把它拼进代次（im/attention.ts），按钮带着它进验收接口；接口在验收互斥里现核（staleAcceptance），
// 放行那一步再按「还是核过的那一段」条件写（sameGate），核过之后线才离开这一道也放不过去。
import { STEP_LABELS, type WorkflowDef } from "@ash/shared/workflow";
import { nextAnchor, type UnexecutedVerification } from "@ash/shared/workflow-policy";
import { and, sql, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { tasks } from "./db/schema.js";
import type { AcceptTaskResult } from "./task-accept.js";
import { acceptanceGuard, type AcceptFailure } from "./task-accept-guard.js";
import { resultVersionOf } from "./task-result-version.js";
import { clearTaskStage } from "./task-stage.js";
import { publishTaskUpdated } from "./task-store.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { taskWorkflowDef } from "./workflows.js";

export const NO_GATE = "-";

export const newHumanGate = (): string => nanoid(16);

type GateFacts = { workflowAt: string | null; stage: string | null; humanGateId: string | null };

const atHumanStep = (workflow: string | null, workflowAt: string | null): boolean =>
  taskWorkflowDef(workflow)?.steps.find((item) => item.id === workflowAt)?.kind === "human";

/** 此刻这一段的身份；还没离开过关口是 NO_GATE。 */
export const humanGateOf = (task: Pick<GateFacts, "humanGateId">): string => task.humanGateId ?? NO_GATE;

/** 游标从 from 挪到 to 是不是离开了一道「等我点头」：是就该领新身份（setWorkflowAt 在挪游标的同一个事务里写）。 */
export const leavesHumanGate = (workflow: string | null, from: string | null, to: string | null): boolean =>
  from !== to && atHumanStep(workflow, from);

/** 调用方看到的那一版成果、那一道关（飞书卡片带进来）。没传的那一样不核：网页、MCP 点的是眼前这一版。 */
export interface AcceptExpectation { resultVersion?: string; humanGate?: string }

type TaskRow = typeof tasks.$inferSelect;

/** 在验收互斥里现核：已经不是调用方看到的那一版成果、那一道关，就不验收。 */
export async function staleAcceptance(task: TaskRow, expected: AcceptExpectation): Promise<AcceptFailure | null> {
  if (expected.resultVersion !== undefined && await resultVersionOf(task) !== expected.resultVersion) {
    await appendTaskTimeline(task.id, "验收没有执行：点验收时看到的那一版之后，任务又跑出了新的结果。看过最新的再验收。");
    return {
      accepted: false, httpStatus: 409, taskId: task.id, reason: "result_changed", phase: "initial", status: task.status,
      error: "要验收的那一版之后任务又跑出了新结果，这一次没有验收：请看过最新的再验收",
    };
  }
  if (expected.humanGate === undefined) return null;
  if (humanGateOf(task) !== expected.humanGate) {
    await appendTaskTimeline(task.id, "这一下没有执行：点的是这条线上一段的卡，它已经离开了那一道「等我点头」。看过它现在停在哪一站再点。");
    return {
      accepted: false, httpStatus: 409, taskId: task.id, reason: "gate_changed", phase: "initial", status: task.status,
      error: "点的那张卡是这条线上一段的，它已经离开了那一道「等我点头」，这一次没有执行：请看过它现在停在哪一站再点",
    };
  }
  return null;
}

/** 放行那一步的写入条件：游标、阶段、这一段的身份都还是核过的那一份。 */
function sameGate(task: GateFacts): SQL {
  return and(
    sql`${tasks.workflowAt} IS ${task.workflowAt}`,
    sql`${tasks.stage} IS ${task.stage}`,
    sql`${tasks.humanGateId} IS ${task.humanGateId}`,
  )!;
}

/**
 * 中途那道「等我点头」放行（后面还有站要走）：不合、不清、不落 accepted，只把阶段清回进行中（为什么见 task-accept.ts
 * 调用处；往下走那一步在锁外跑，task-accept-tail.ts releaseGate）。task 是核过身份的那一份：按它条件写，核过之后
 * 线才离开这一道、换了一段，这一按就落空，不替他放后来那一道。
 */
export async function releaseHumanGate(
  task: TaskRow, def: WorkflowDef | null, verification: UnexecutedVerification | null,
): Promise<AcceptTaskResult> {
  const guard = await acceptanceGuard(task.id, "before_accept");
  if (guard.failure) return guard.failure;
  const next = nextAnchor(def, task.workflowAt);
  const where = next ? `后面还写着「${STEP_LABELS[next.kind]}」` : "这条线上后面还写着别的站";
  if (!await clearTaskStage(task.id, `你在这一道「等我点头」放行了：${where}，所以没有合并、也没有清理，接着往下走。`, sameGate(task))) {
    return {
      accepted: false, httpStatus: 409, taskId: task.id, reason: "gate_changed", phase: "before_accept", status: task.status,
      error: "放行的同时这条线离开了这一道「等我点头」（或已经放过了），这一次没有放行：请看过它现在停在哪一站再点",
    };
  }
  await publishTaskUpdated(task.id);
  return { accepted: true, taskId: task.id, status: task.status, stage: null, kind: "gate_released", ...(verification ? { verification } : {}) };
}
