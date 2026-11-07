// 「等我点头」这一道关口的身份。
//
// 成果身份（task-result-version.ts）回答的是「还是不是你看过的那一版」，回答不了「还是不是你看到的那一道关」：
// 一条线上可以接连画好几道「等我点头」，中途那几道放行只挪游标、不起新的一轮，成果身份前后一模一样。只认它，
// 上一道关的旧卡就能放行后来那一道（审查实测：网页先放了第一道，再点飞书里第一道的旧卡，第二道也被放了）；
// 点过上一道关的卡之后，下一道关的代次和它一样、被那张已处理的卡占着，再也发不出能点的新卡。
//
// 所以线每走到一道「等我点头」，就在挪游标的同一条语句里领一个新身份（workflow-advance.ts setWorkflowAt），
// 游标和身份之间没有空档：读到新游标就读到新身份。此刻的关口身份 = 游标停在一道「等我点头」上时领到的那一个——放行
// 之后、走到下一站之前（中间可能跑着很久的命令站）游标还在这一道上，身份也还是这一道：那一段不该冒出一张新卡；
// 这一道已经放过，同一道关的卡再点一下也不放第二遍（staleAcceptance），往下走失败了要重放，在网页上点。
// 不在关口上（自由工作流、线走完了、跳过验证走到头）一律是 NO_GATE，那时这一按验的就是成果本身。
// 加列之前就停在关口上的老任务也是 NO_GATE：已经发出去的待验收卡照旧有效。
//
// 飞书的待验收卡把它拼进代次（im/attention.ts），按钮带着它进验收接口；接口在验收互斥里现核（staleAcceptance），
// 放行那一步再按「还是核过的那一道关」条件写（sameGate），核过之后才切的关也放不过去。
import { STEP_LABELS, type WorkflowDef } from "@ash/shared/workflow";
import { isFinalHumanGate, nextAnchor, type UnexecutedVerification } from "@ash/shared/workflow-policy";
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

type GateFacts = { workflow: string | null; workflowAt: string | null; stage: string | null; humanGateId: string | null };

const atHumanStep = (workflow: string | null, workflowAt: string | null): boolean =>
  taskWorkflowDef(workflow)?.steps.find((item) => item.id === workflowAt)?.kind === "human";

/** 此刻停着的那一道「等我点头」的身份；不在关口上是 NO_GATE。 */
export function humanGateOf(task: GateFacts): string {
  return atHumanStep(task.workflow, task.workflowAt) ? task.humanGateId ?? NO_GATE : NO_GATE;
}

/**
 * 不经 setWorkflowAt 就落下游标的那一处（接力导入，新来的和移回来的都是）：停在「等我点头」上就领一个新身份，
 * 否则不留。不沿用对端的、也不沿用本机离开前的——离开的这段时间里那道关可能已经放过、又走到了下一道，本机此前
 * 发出去的卡对的是哪一道已经说不清，换个身份让它们一律落空、重新发一张。
 */
export const importedHumanGate = (workflow: string | null, workflowAt: string | null): string | null =>
  atHumanStep(workflow, workflowAt) ? newHumanGate() : null;

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
  const gate = humanGateOf(task);
  if (gate !== expected.humanGate) {
    await appendTaskTimeline(task.id, "这一下没有执行：点的是另一道「等我点头」上的卡，这条线已经不停在那一道了。看过它现在停在哪一站再点。");
    return {
      accepted: false, httpStatus: 409, taskId: task.id, reason: "gate_changed", phase: "initial", status: task.status,
      error: "点的那一道「等我点头」已经不是这条线此刻停着的那一道，这一次没有执行：请看过它现在停在哪一站再点",
    };
  }
  // 中途那一道、同一道关、但已经放过了（放行之后、走到下一站之前身份不变）：再放一遍会把后面那一段（发布命令之类）
  // 并着再跑一遍。最后一道关点第二下不归这里管：已经验收过的走 task-accept.ts 的幂等快路，照实回「之前验收过了」。
  if (gate !== NO_GATE && task.stage !== "awaiting_acceptance" && !isFinalHumanGate(taskWorkflowDef(task.workflow), task.workflowAt)) {
    await appendTaskTimeline(task.id, "这一下没有执行：这一道「等我点头」已经放行过了，线正在往下走。");
    return {
      accepted: false, httpStatus: 409, taskId: task.id, reason: "gate_changed", phase: "initial", status: task.status,
      error: "这一道「等我点头」已经放行过了，这一次没有再放一遍：请看过它现在停在哪一站再点",
    };
  }
  return null;
}

/** 放行那一步的写入条件：游标、阶段、关口身份都还是核过的那一份。 */
function sameGate(task: Omit<GateFacts, "workflow">): SQL {
  return and(
    sql`${tasks.workflowAt} IS ${task.workflowAt}`,
    sql`${tasks.stage} IS ${task.stage}`,
    sql`${tasks.humanGateId} IS ${task.humanGateId}`,
  )!;
}

/**
 * 中途那道「等我点头」放行（后面还有站要走）：不合、不清、不落 accepted，只把阶段清回进行中（为什么见 task-accept.ts
 * 调用处；往下走那一步在锁外跑，task-accept-tail.ts releaseGate）。task 是核过身份的那一份：按它条件写，核过之后
 * 线才切到别的关，这一按就落空，不替他放后来那一道。
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
      error: "放行的同时这条线换了一道「等我点头」（或已经不停在这里了），这一次没有放行：请看过它现在停在哪一站再点",
    };
  }
  await publishTaskUpdated(task.id);
  return { accepted: true, taskId: task.id, status: task.status, stage: null, kind: "gate_released", ...(verification ? { verification } : {}) };
}
