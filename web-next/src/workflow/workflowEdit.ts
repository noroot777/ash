// 编排一条线时的所有改动，都是这里的纯函数：进去一份定义，出来一份新定义。
//
// 为什么不让组件直接改数组：**改一站会牵动别站**。删掉一站，指向它的「失败回拐」
// 就悬空了；把一站往前挪，原本合法的回拐可能变成往后跳。这些连带修复必须跟改动
// 本身待在同一个函数里，否则总有一条路径会漏掉（漏掉的结果是 checkWorkflow 拒收，
// 用户只看到「存不了」却不知道哪儿错）。
import type {
  FailMode, FailPolicy, StepKind, StepParams, WorkflowDef, WorkflowStep,
} from "@harness/shared/workflow";
import { MAX_FAIL_ROUNDS, MAX_WORKFLOW_STEPS, hasFailBranch, makeStep } from "@harness/shared/workflow";

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

/** 在第 at 个位置插一站（at = steps.length 就是插在末尾）。 */
export function insertStep(def: WorkflowDef, at: number, kind: StepKind): WorkflowDef {
  if (!canAddStep(def)) return def;
  const steps = def.steps.slice();
  const bounded = Math.min(Math.max(at, 0), steps.length);
  steps.splice(bounded, 0, makeStep(kind, nextStepId(def)));
  return repair({ ...def, steps });
}

export function removeStep(def: WorkflowDef, id: string): WorkflowDef {
  const steps = def.steps.filter((s) => s.id !== id);
  if (steps.length === def.steps.length) return def;
  return repair({ ...def, steps });
}

/** delta = -1 往前挪、+1 往后挪。挪到头就原样返回。 */
export function moveStep(def: WorkflowDef, id: string, delta: number): WorkflowDef {
  const from = def.steps.findIndex((s) => s.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= def.steps.length) return def;
  const steps = def.steps.slice();
  [steps[from], steps[to]] = [steps[to]!, steps[from]!];
  return repair({ ...def, steps });
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
    if (fail.mode !== "back") fail.backTo = null;
    fail.max = Math.min(Math.max(Math.round(fail.max), 1), MAX_FAIL_ROUNDS);
    return { ...s, fail } as WorkflowStep;
  });
  return repair({ ...def, steps });
}

/** 某一站的「回到某一步重做」能指向哪些站：只能是它前面的。 */
export function backTargets(def: WorkflowDef, id: string): WorkflowStep[] {
  const at = def.steps.findIndex((s) => s.id === id);
  return at <= 0 ? [] : def.steps.slice(0, at);
}

/**
 * 连带修复：删站/挪站之后，指向不存在或指向后面的回拐一律降级成「停下等人」。
 * 这跟 shared 的 normalizeWorkflowDef 是同一条规矩，只是那边收的是存盘数据、
 * 这边是编排过程中的每一次改动 —— 编排时就修掉，用户才不会点了保存才看见报错。
 */
function repair(def: WorkflowDef): WorkflowDef {
  const at = new Map(def.steps.map((s, i) => [s.id, i]));
  const steps = def.steps.map((s, i) => {
    if (!s.fail || s.fail.mode !== "back") return s;
    const target = s.fail.backTo ? at.get(s.fail.backTo) : undefined;
    if (target !== undefined && target < i) return s;
    return { ...s, fail: { mode: "stop" as FailMode, backTo: null, max: s.fail.max } } as WorkflowStep;
  });
  return { ...def, steps };
}

/** 「失败 → ?」那颗标签上的字。 */
export function failText(def: WorkflowDef, step: WorkflowStep): string | null {
  if (!step.fail || !hasFailBranch(step.kind)) return null;
  if (step.fail.mode === "stop") return "停下等人";
  if (step.fail.mode === "ask") return "问我一句再决定";
  const at = def.steps.findIndex((s) => s.id === step.fail!.backTo);
  if (at < 0) return "停下等人";
  return `拐回第 ${at + 1} 站 · 最多 ${step.fail.max} 轮`;
}
