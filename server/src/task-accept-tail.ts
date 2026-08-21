// 验收「点头之后」的尾段（发布命令等）与中途关口放行的续走（从 task-accept.ts 拆出，
// 纯行数拆分）。为什么在仓库锁外跑、为什么逐站落账，见各函数头注释。
import { eq } from "drizzle-orm";
import { anchorAt, acceptPlan, segmentAfter } from "@ash/shared/workflow-policy";
import type { AcceptBy } from "@ash/shared/workflow-policy";
import { STEP_LABELS } from "@ash/shared/workflow";
import { db } from "./db/index.js";
import { tasks } from "./db/schema.js";
import { taskWorkflowDef } from "./workflows.js";
import { appendTaskTimeline } from "./task-timeline.js";
import { now } from "./util.js";
import type { WorkflowAdvanceOptions } from "./workflow-advance.js";

export type AcceptTail = {
  ok: boolean;
  /** 卡在哪一站（用中文站名，直接能显示） */
  step?: string;
  reason?: string;
};

/** 线上「点头之后」是否真有要跑的站（发布/命令…）。尾段 durable 进度与补跑都用这一份判定。 */
export function hasAcceptedTail(task: typeof tasks.$inferSelect): boolean {
  const def = taskWorkflowDef(task.workflow);
  const gate = anchorAt(def, task.workflowAt, "human")?.id ?? null;
  return segmentAfter(def, gate).some((step) => step.kind !== "accept");
}


// 中途关口放行之后接着往下走：跑完这一段，再按下一个锚点是什么决定（又一站验证、
// 下一道关口、还是这条线走到头）。**不传 skipAccept** —— 这一按没有做任何合并，
// 线上真画了「合并并清理」就该由它自己走到那一站时执行。
export async function releaseGate(taskId: string, opts: WorkflowAdvanceOptions): Promise<void> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return;
  const { advanceWorkflowFrom } = await import("./workflow-advance.js");
  await advanceWorkflowFrom(task, taskWorkflowDef(task.workflow), task.workflowAt, opts)
    .catch((error) => appendTaskTimeline(
      taskId,
      `放行之后想接着往下走，但出错了（${error instanceof Error ? error.message : String(error)}），请手动续跑。`,
    ));
}

// 点头之后线上还写着的那几站（跑一条发布命令、把预览再开起来之类）。
// 放在仓库锁**之外**跑：这些命令可能跑好几分钟，占着锁会让同仓库的其它验收干等。
// skipAccept 是因为「合并并清理」正是刚做完的这件事,不能再做一遍。
//
// 跑砸了**不会把验收改成失败**（合并确实做完了），但要如实带回去，并按这一站写的失败
// 策略收尾——线路图上给它挂了「问我一句」，就得真的问出来。
export async function runAcceptedTail(taskId: string, by: AcceptBy): Promise<AcceptTail | null> {
  const task = (await db.select().from(tasks).where(eq(tasks.id, taskId))).at(0);
  if (!task) return null;
  const def = taskWorkflowDef(task.workflow);
  // 「点头之后」是**哪一道**点头之后：读游标（`tasks.workflow_at`），游标丢了回落到线上
  // 第一道关口——那正是只有一道关口时的老行为。
  const gate = anchorAt(def, task.workflowAt, "human")?.id ?? null;
  if (!segmentAfter(def, gate).some((step) => step.kind !== "accept")) return null;
  const { runSegment } = await import("./workflow-steps.js");
  // 逐站 durable：每站跑完立刻把 step id 落进清单，崩溃补跑只跑**没做过**的站——
  // 只有 pending 一个布尔位时，重试会把已执行的发布/部署命令再跑一遍（审查实测：
  // 文件已写入后 SIGKILL，重试 deployCount 变 2）。这是 at-most-once 化的最小账本；
  // 站内非原子（命令跑完、落账前崩溃）仍是 at-least-once，站本身要求幂等。
  const doneSteps = new Set<string>(((): string[] => {
    try { return JSON.parse(task.acceptedTailDone ?? "[]") as string[]; } catch { return []; }
  })());
  const recordStepDone = async (stepId: string) => {
    doneSteps.add(stepId);
    await db.update(tasks).set({ acceptedTailDone: JSON.stringify([...doneSteps]), updatedAt: now() })
      .where(eq(tasks.id, taskId));
  };
  const result = await runSegment(task, def, gate, {
    skipAccept: true, skipStepIds: doneSteps, onStepDone: recordStepDone,
  });
  if (result.ok) return { ok: true };

  const step = result.failed!;
  const label = STEP_LABELS[step.kind];
  await appendTaskTimeline(
    taskId,
    `合并已经做完了，卡住的是「点头之后」那一段：「${label}」没跑过。产物已经合进去，这一段要不要补跑由你定。`,
  );
  // 「打回给 AI 重做」在这一段有个真做不到的情况：清理那一档刚把 worktree 和分支收掉，
  // 唤醒 agent 也没有地方可干活。这时不假装打回，改成把问题挂给用户并说明为什么。
  // 这里必须带上 `by`：人工验收在线上没画这一站时照样清了工作区，用默认口径会算成
  // 「工作区还在」，于是打回一个已经不存在的 worktree。
  const workspaceGone = task.useWorktree && acceptPlan(def, by, task.workflowAt).clean !== "none";
  if (step.fail?.mode === "back" && workspaceGone) {
    await appendTaskTimeline(taskId, `「${label}」写的是「打回给 AI 重做」，但工作区刚随验收清掉了，没法再打回；改成问你一句。`);
    const { askAboutFailure } = await import("./task-question.js");
    await askAboutFailure(taskId, label, result.reason);
  } else {
    const { applyFailPolicy } = await import("./workflow-steps.js");
    await applyFailPolicy(
      task,
      step,
      result.reason,
      (round) => `验收之后的「${label}」这一站没跑过（第 ${round} 次）：\n\n`
        + `${"```"}\n${result.reason ?? ""}\n${"```"}\n\n`
        + "产物已经合并，请把这一段修到能跑过，然后照常确认完成。",
    );
  }
  return { ok: false, step: label, reason: result.reason };
}
