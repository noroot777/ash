// 线路图的纯逻辑：一条线走到哪儿了、每一站底下该写什么状态。
//
// 两条口径，都是产品承诺、都有单测（npm -w web-next run test:workflow-rail）：
//
// ① **每站底下那行字，就是任务列表里那一格的字**。所以这里绝不自己写文案，一律
//    `taskDisplayStatus(STEP_RUNTIME[kind])` 派生 —— 用户照着线路图预期「待验收」，
//    在列表里就得能按「待验收」找到它，差一个字这条线就白画了。
//
// ② **游标是派生的，不是存的**。执行链接管（第二期）之前，任务身上没有「现在在第几
//    站」这个字段，所以这里从 status/stage 反推。反推表就是 STEP_RUNTIME 的逆向：
//    stage=verifying 说明在 verify 站，awaiting_acceptance 说明在 human 站。
//    精度有限（preview/command 站在 status 上跟 run 站长得一样，一律算作 run 之后的
//    在途），但**它读的是真实状态，不是假进度条** —— 第二期落了真游标就换掉这里。
import type { Task, TaskStage } from "@harness/shared";
import { taskDisplayStatus } from "@harness/shared";
import type { StepKind, WorkflowDef, WorkflowStep } from "@harness/shared/workflow";
import { STEP_RUNTIME } from "@harness/shared/workflow";

// 线路图上的短名。STEP_LABELS 那套（「让 AI 干活」）是编排时选站用的完整说法，
// 画在一排站台上太挤，这里另给一套两三个字的。
export const STEP_SHORT: Record<StepKind, string> = {
  run: "干活", verify: "验证", preview: "预览", human: "等我点头", command: "命令", accept: "合并",
};

/** 这一站跑起来时，任务列表里那一格写什么。 */
export function stepStatusLabel(kind: StepKind): string {
  const runtime = STEP_RUNTIME[kind];
  return taskDisplayStatus(runtime.status, runtime.stage, false).label;
}

export function stepNote(kind: StepKind): string | null {
  return STEP_RUNTIME[kind].note;
}

/** 折叠态的一句话：干活 → 验证 → 等我点头 → 合并 */
export function workflowSummary(def: WorkflowDef): string {
  return def.steps.map((s) => STEP_SHORT[s.kind]).join(" → ");
}

export type StepState = "done" | "current" | "blocked" | "pending";

export interface RailStop {
  step: WorkflowStep;
  state: StepState;
  /** 这一站跑起来时列表里显示的字（常驻，不随执行变化） */
  statusLabel: string;
  note: string | null;
}

/**
 * 游标停在哪一站。返回 index = -1 表示还没开工；index >= steps.length 表示整条走完。
 * blocked = 停在这一站但没往下走（失败 / 暂停 / 等答复）。
 */
export function resolveCursor(
  steps: WorkflowStep[],
  task: Pick<Task, "status" | "stage" | "question"> | null,
): { index: number; blocked: boolean } {
  if (!task || !steps.length) return { index: -1, blocked: false };
  const first = (kind: StepKind) => steps.findIndex((s) => s.kind === kind);
  // 「某一站之后的下一站」：那一站已经过了，任务正等着往下走
  const after = (kind: StepKind) => {
    const at = first(kind);
    return at < 0 ? -1 : at + 1;
  };
  // 按优先级取第一个**线里真有**的位置。注意不能写成 Math.max：用户把站排乱了
  // （比如「等我点头」拖到「干活」前面）时，取最大会指到线外去。
  const pick = (...candidates: number[]) => candidates.find((at) => at >= 0) ?? 0;
  const stalled = task.status === "failed" || task.status === "canceled" || task.status === "paused";
  const waiting = !!task.question;

  const byStage: Partial<Record<TaskStage, () => { index: number; blocked: boolean }>> = {
    accepted: () => ({ index: steps.length, blocked: false }),
    merged: () => ({ index: pick(first("accept"), steps.length), blocked: false }),
    awaiting_acceptance: () => ({ index: pick(first("human"), after("run")), blocked: false }),
    verifying: () => ({ index: pick(first("verify"), after("run")), blocked: false }),
    verify_failed: () => ({ index: pick(first("verify"), after("run")), blocked: true }),
    verified: () => ({ index: pick(after("verify"), after("run")), blocked: stalled }),
    implemented: () => ({ index: pick(after("run")), blocked: stalled }),
  };
  const staged = task.stage ? byStage[task.stage] : undefined;
  if (staged) {
    const at = staged();
    return { index: at.index, blocked: at.blocked || waiting };
  }

  // 没有 stage：只能按 status 判断，一律落在「干活」这一段上
  const run = pick(first("run"));
  if (task.status === "backlog" || task.status === "queued" || task.status === "idle") {
    return { index: -1, blocked: false };
  }
  if (task.status === "awaiting_review") {
    return { index: pick(first("human"), after("run")), blocked: false };
  }
  if (task.status === "done") return { index: pick(after("run")), blocked: false };
  return { index: run, blocked: stalled || waiting };
}

export function railStops(
  def: WorkflowDef,
  task: Pick<Task, "status" | "stage" | "question"> | null,
): RailStop[] {
  const { index, blocked } = resolveCursor(def.steps, task);
  return def.steps.map((step, i) => ({
    step,
    state: i < index ? "done" : i > index ? "pending" : blocked ? "blocked" : "current",
    statusLabel: stepStatusLabel(step.kind),
    note: stepNote(step.kind),
  }));
}
