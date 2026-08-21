// 编排一条线时的所有改动，都是这里的纯函数：进去一份定义，出来一份新定义。
//
// 为什么不让组件直接改数组：**改一站会牵动别站**。「让 AI 干活」和「合并并清理」各只能
// 有一个（见 shared 的 SINGLETON_KINDS），插站时就得挡住，不能等用户点保存才由
// checkWorkflow 拒收——那时他只看到「存不了」，不知道哪儿错。这类连带判断必须跟改动
// 本身待在同一个函数里，否则总有一条路径会漏掉。
import type {
  FailPolicy, StepKind, StepParams, WorkflowDef, WorkflowStep,
} from "@ash/shared/workflow";
import {
  MAX_FAIL_ROUNDS, MAX_WORKFLOW_STEPS, hasFailBranch, isSingletonKind, makeStep,
} from "@ash/shared/workflow";

/** 线里没被占用的最小 sN。id 只在这条线内唯一即可。 */
export function nextStepId(def: WorkflowDef): string {
  const used = new Set(def.steps.map((s) => s.id));
  for (let n = 1; n <= MAX_WORKFLOW_STEPS + 1; n += 1) {
    const id = `s${n}`;
    if (!used.has(id)) return id;
  }
  return `s${Date.now()}`;
}

export function canAddStep(def: WorkflowDef): boolean {
  return def.steps.length < MAX_WORKFLOW_STEPS;
}

/** 这一类站现在还能不能再加一个（「加一站」菜单据此置灰）。 */
export function canAddKind(def: WorkflowDef, kind: StepKind): boolean {
  if (!canAddStep(def)) return false;
  return !isSingletonKind(kind) || !def.steps.some((s) => s.kind === kind);
}

/** 在第 at 个位置插一站（at = steps.length 就是插在末尾）。 */
export function insertStep(def: WorkflowDef, at: number, kind: StepKind): WorkflowDef {
  if (!canAddKind(def, kind)) return def;
  const steps = def.steps.slice();
  const bounded = Math.min(Math.max(at, 0), steps.length);
  steps.splice(bounded, 0, makeStep(kind, nextStepId(def)));
  return { ...def, steps };
}

export function removeStep(def: WorkflowDef, id: string): WorkflowDef {
  const steps = def.steps.filter((s) => s.id !== id);
  if (steps.length === def.steps.length) return def;
  return { ...def, steps };
}

/** delta = -1 往前挪、+1 往后挪。挪到头就原样返回。 */
export function moveStep(def: WorkflowDef, id: string, delta: number): WorkflowDef {
  const from = def.steps.findIndex((s) => s.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= def.steps.length) return def;
  const steps = def.steps.slice();
  [steps[from], steps[to]] = [steps[to]!, steps[from]!];
  return { ...def, steps };
}

export function patchParams<K extends StepKind>(
  def: WorkflowDef,
  id: string,
  patch: Partial<StepParams[K]>,
): WorkflowDef {
  const steps = def.steps.map((s) =>
    s.id === id ? ({ ...s, p: { ...s.p, ...patch } } as WorkflowStep) : s);
  return { ...def, steps };
}

export function patchFail(def: WorkflowDef, id: string, patch: Partial<FailPolicy>): WorkflowDef {
  const steps = def.steps.map((s) => {
    if (s.id !== id || !s.fail) return s;
    const fail: FailPolicy = { ...s.fail, ...patch };
    fail.max = Math.min(Math.max(Math.round(fail.max), 1), MAX_FAIL_ROUNDS);
    return { ...s, fail } as WorkflowStep;
  });
  return { ...def, steps };
}

/** 「失败 → ?」那颗标签上的字。 */
export function failText(step: WorkflowStep): string | null {
  if (!step.fail || !hasFailBranch(step.kind)) return null;
  if (step.fail.mode === "stop") return "停下等人";
  if (step.fail.mode === "ask") return "问我一句再决定";
  return `打回给 AI 重做 · 最多 ${step.fail.max} 轮`;
}
