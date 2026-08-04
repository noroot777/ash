// 「任务级 model / reasoningEffort 覆盖」是**针对某个特定执行器**的覆盖，不能脱离
// 执行器单独流动：换了执行器，原来那套模型名/思考强度在新 CLI 上多半根本不存在。
//
// 2026-07-28 事故：团队默认 workerModel 是给 codex 配的 "gpt-5.6-sol"，调度者
// dispatch 一个只改了 agentType:"claude" 的执行者时，model 被无条件继承，claude CLI
// 拿到 GPT 模型名启动即 exit 1。执行器解析早就有「换类型就不硬套默认 profile」的逻辑，
// 只有 model/effort 没跟着走同一条。
//
// 判定与取值统一走这里：server 的三条创建/编辑路径（team dispatch、批量建任务、
// PATCH /tasks/:id）与 web/mobile 的执行器选择器共用同一份口径。
import type { AgentType } from "./index.ts";

export type ExecutorRef = {
  executorId?: string | null;
  agentType?: AgentType | null;
};

// 两个选择是不是「同一个执行器」。粒度：解析后的 executorId 相同；两边都没有具体
// profile 时才退回比 agentType（都为空 = 都跟随该类型的当前默认执行器，算同一个）。
// 注意粒度不能放宽成「只比 agentType」：claude@官方 换成 claude@公司自建 是同类型
// 不同供应商，模型 id 那套是各认各的（见 server/CLAUDE.md 的供应商推论三）。
export function sameExecutor(a: ExecutorRef, b: ExecutorRef): boolean {
  const ea = a.executorId ?? null;
  const eb = b.executorId ?? null;
  if (ea || eb) return ea === eb;
  return (a.agentType ?? null) === (b.agentType ?? null);
}

export interface InheritExecutorOverridesInput {
  /** 默认值所属的执行器：团队的默认执行者 / 批次 defaults / 编辑前的任务。 */
  from: ExecutorRef;
  /** 这个任务最终解析到的执行器。 */
  to: ExecutorRef;
  /** 调用方**显式**给的覆盖；undefined = 没给（此时才谈继承）。 */
  model?: string | null;
  reasoningEffort?: string | null;
  /** from 那个执行器身上的默认覆盖。 */
  defaultModel?: string | null;
  defaultReasoningEffort?: string | null;
}

// 显式给的永远生效；没显式给时，只有执行器没换才继承默认值，换了就落 null
// （= 跟随新执行器自己的 profile）。空串一律归一成 null。
export function inheritExecutorOverrides(input: InheritExecutorOverridesInput): {
  model: string | null;
  reasoningEffort: string | null;
} {
  const same = sameExecutor(input.from, input.to);
  const pick = (explicit: string | null | undefined, fallback: string | null | undefined) =>
    (explicit !== undefined ? explicit : same ? fallback : null) || null;
  return {
    model: pick(input.model, input.defaultModel),
    reasoningEffort: pick(input.reasoningEffort, input.defaultReasoningEffort),
  };
}

export interface PickExecutorInput {
  /** 任务自己显式给的 executorId；undefined = 没给（这时才谈继承默认执行器）。 */
  executorId?: string | null;
  /** 任务自己显式给的 agentType；缺省 = 没给。 */
  agentType?: AgentType | null;
  /** 默认执行器：团队的默认执行者 / 批次 defaults。 */
  fallback: ExecutorRef;
  /** profile id → 类型（调用方从 agents 表拿）。 */
  typeOf: (executorId: string) => AgentType | undefined;
}

// 「这个任务到底用哪个执行器」的单点。规则：自带 executorId 就用它（类型由它决定）；
// 没带但自带了 agentType，那是**换类型**——默认执行器类型对不上就不硬套，落 null 走
// 该类型的当前默认执行器；两者都没带才整份继承默认执行器。
//
// 显式给出的 executorId + agentType 互相矛盾时由调用方自己报错（各家错误文案不同），
// 这里不做校验。
export function pickExecutor(input: PickExecutorInput): {
  executorId: string | null;
  agentType: AgentType | null;
} {
  const ownType = input.agentType ?? null;
  const fallbackType = input.fallback.agentType ?? null;
  if (input.executorId !== undefined) {
    const eid = input.executorId ?? null;
    const t = eid ? input.typeOf(eid) ?? null : null;
    return { executorId: eid, agentType: ownType ?? t ?? fallbackType };
  }
  const inherited = input.fallback.executorId ?? null;
  const inheritedType = inherited ? input.typeOf(inherited) ?? null : null;
  if (ownType) {
    return { executorId: inheritedType === ownType ? inherited : null, agentType: ownType };
  }
  return { executorId: inherited, agentType: inheritedType ?? fallbackType };
}
