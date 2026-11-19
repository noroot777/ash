// 线路图的纯逻辑：一条线走到哪儿了、每一站底下该写什么状态。
//
// 两条口径，都是产品承诺、都有单测（npm -w web run test:workflow-rail）：
//
// ① **每站底下那行字，就是任务列表里那一格的字**。所以这里绝不自己写文案，一律
//    `taskDisplayStatus(STEP_RUNTIME[kind])` 派生 —— 用户照着线路图预期「待验收」，
//    在列表里就得能按「待验收」找到它，差一个字这条线就白画了。
//
// ② **优先读任务身上那个真游标**（`tasks.workflow_at`，执行链第二期落的），反推只是
//    没有游标时的回落。这个先后顺序是有代价才换来的：反推表把 stage 当成站的代名词
//    （verifying → verify 站、awaiting_acceptance → human 站），而这两件事**并不等价**
//    —— agent 自己会按完成协议自报 stage，线上又允许把「等我点头」画在「自动验证」
//    前面，于是任务停在 human 站、stage 却是 verifying 时，反推会把游标指到后面那个
//    verify 站，前面的关口就被画成「✓ 已过」。用户看到的是「我压根没点头，它却说我
//    点过了」（2026-08-05 事故，见 docs/incidents.md「关口画在验证前面就被跳过」）。
//    反推留给老任务和还没走到任何锚点的任务：精度有限（preview/command 站在 status 上
//    跟 run 站长得一样，一律算作 run 之后的在途），但读的仍是真实状态，不是假进度条。
import type { Task, TaskStage } from "@navi/shared";
import { taskDisplayStatus } from "@navi/shared";
import type { StepKind, WorkflowDef, WorkflowStep } from "@navi/shared/workflow";
import { STEP_RUNTIME } from "@navi/shared/workflow";

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

/** 线路图读任务时只用得上这几个字段（`workflowAt` 是真游标，其余用于回落反推）。 */
export type CursorTask = Pick<Task, "status" | "stage" | "question" | "workflowAt">;

/**
 * 游标停在哪一站。返回 index = -1 表示还没开工；index >= steps.length 表示整条走完。
 * blocked = 停在这一站但没往下走（失败 / 暂停 / 等答复）。
 *
 * 先看任务身上的真游标，读不到才按 status/stage 反推（理由见文件头 ②）。
 */
export function resolveCursor(
  steps: WorkflowStep[],
  task: CursorTask | null,
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

  // 验收结论盖过游标：合并/验收是这条线的终点，而游标此刻多半还停在最后那道关口上
  // （放行之后才往下走完剩下的段）。
  if (task.stage === "accepted") return { index: steps.length, blocked: false };
  if (task.stage === "merged") return { index: pick(first("accept"), steps.length), blocked: false };

  // 真游标：任务此刻确实停在这一站，不用猜。
  const cursor = task.workflowAt ? steps.findIndex((s) => s.id === task.workflowAt) : -1;
  if (cursor >= 0) {
    return { index: cursor, blocked: stalled || waiting || task.stage === "verify_failed" };
  }

  const byStage: Partial<Record<TaskStage, () => { index: number; blocked: boolean }>> = {
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
  task: CursorTask | null,
): RailStop[] {
  const { index, blocked } = resolveCursor(def.steps, task);
  return def.steps.map((step, i) => ({
    step,
    state: i < index ? "done" : i > index ? "pending" : blocked ? "blocked" : "current",
    statusLabel: stepStatusLabel(step.kind),
    note: stepNote(step.kind),
  }));
}

/**
 * 游标此刻就停在这一站（`current` 和 `blocked` 都是「停在这儿」，区别只在动没动弹）。
 *
 * 用在人工关口那两个**真**按钮（验收通过 / 打回重修）上：判据必须是「线确实走到了这
 * 道关口」，不能只看 `stage === "awaiting_acceptance"` —— 那个 stage 可能是 agent 自报
 * 的，也可能属于线上**另一道**关口。
 */
export function isCursorStop(stop: RailStop): boolean {
  return stop.state === "current" || stop.state === "blocked";
}

/**
 * 游标此刻停着的那一站是不是「自动验证」；是就把线和站 id 一起给出来。
 *
 * 「验证站上那两个按钮」有两个表面（工作流页的线路图、验证页顶上那排动作），判据必须
 * 是同一条 —— 一边给按钮另一边不给，用户就得靠试才知道该去哪儿按。
 *
 * 跟画线路图那条口径的差别是**故意的**：这里只认 `workflowAt` 这个真游标，不吃 stage
 * 反推。画图时反推是「没有更好的信息，先按状态猜个位置」，猜偏了只是画得不准；这两颗
 * 按钮背后是后端一个会真合并的动作，而它的受理条件恰恰是「`workflowAt` 落在一个 verify
 * 站上」——按反推给按钮，用户按下去只会换回一句 409。没有游标的老任务本来也不需要它：
 * 线上没有后续的合并等着放行，验证没过时直接人工验收即可。
 *
 * 已验收/已合并的任务一律返回 null：那时这条线其实走完了（`resolveCursor` 里同一条
 * 口径），游标停在哪儿都不该再冒出一颗「强制通过」。
 */
export function verifyStationAtCursor(task: Task): { def: WorkflowDef; stationId: string } | null {
  const def = task.workflow;
  if (!def || !task.workflowAt) return null;
  if (task.stage === "accepted" || task.stage === "merged") return null;
  const step = def.steps.find((candidate) => candidate.id === task.workflowAt);
  return step && step.kind === "verify" ? { def, stationId: step.id } : null;
}
