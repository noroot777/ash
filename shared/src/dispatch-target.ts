// 派出去的活交给谁：智能体 · 模型 · 智能水平（同回复框那颗三段胶囊）。挂在回复框顶上的每一件
// （dispatch-suggestion.ts）、任务上「派出去的活交给谁」那一格（tasks.dispatch_target）、智能体绕过
// 回复框直接建任务时补的执行器（server task-dispatch.ts），都是这一个形状。
import type { AgentType } from "./index.ts";

export type DispatchRunTarget = {
  agentType: AgentType;
  executorId: string | null;
  /** null = 跟随执行器 */
  model: string | null;
  /** null = 跟随执行器 */
  reasoningEffort: string | null;
};

/**
 * 「派出去的活交给谁」此刻落在谁身上：设了就是设的那个，没设（同这里）就是这条任务自己的执行器。
 * 这条任务自己也没定执行器时给 null，由调用方按各自的默认口径接手。
 */
export function dispatchDefaultTarget(task: {
  dispatchTarget?: DispatchRunTarget | null;
  agentType?: AgentType | null;
  executorId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
}): DispatchRunTarget | null {
  if (task.dispatchTarget) return task.dispatchTarget;
  if (!task.agentType) return null;
  return {
    agentType: task.agentType,
    executorId: task.executorId ?? null,
    model: task.model ?? null,
    reasoningEffort: task.reasoningEffort ?? null,
  };
}

/** 存在任务上的那一份（JSON 列）读回来；形状不对当没有。 */
export function parseDispatchTarget(raw: string | null | undefined): DispatchRunTarget | null {
  if (!raw) return null;
  try {
    return targetOf(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** 一份「交给谁」按已知的几样重建（多出来的键不要）；形状不对给 null。 */
export function targetOf(value: unknown): DispatchRunTarget | null {
  const raw = value as Partial<DispatchRunTarget> | null;
  if (!raw || typeof raw !== "object" || typeof raw.agentType !== "string") return null;
  return {
    agentType: raw.agentType,
    executorId: typeof raw.executorId === "string" ? raw.executorId : null,
    model: typeof raw.model === "string" && raw.model ? raw.model : null,
    reasoningEffort: typeof raw.reasoningEffort === "string" && raw.reasoningEffort ? raw.reasoningEffort : null,
  };
}

export const sameDispatchTarget = (left: DispatchRunTarget | null, right: DispatchRunTarget | null): boolean =>
  !!left && !!right && left.agentType === right.agentType && (left.executorId ?? null) === (right.executorId ?? null)
  && (left.model ?? null) === (right.model ?? null) && (left.reasoningEffort ?? null) === (right.reasoningEffort ?? null);
