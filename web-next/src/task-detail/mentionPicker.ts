import type { AgentExecutorProfile, AgentType } from "@harness/shared";
import type { ModelGroup } from "../lib/modelCatalog.ts";

/**
 * 对话框 @ 选择器的纯逻辑：智能体 / 供应商 / 模型各阶段的候选行怎么算、箭头
 * 怎么走。组件只管画，键盘只管调这里的函数——所以 textarea 驱动的第一阶段
 * 和浮层里后面几步能共用同一套上下键语义。
 */

/** 一次 @ 选择的最终结果：这一回合派谁、用哪个执行器、跑哪个模型、想多久。 */
export type MentionTarget = {
  agent: AgentType;
  executorId: string | null; // null = 按该类型的默认执行器解析
  model: string | null; // null = 跟随执行器自己的模型
  reasoningEffort: string | null; // null = 跟随执行器自己的思考强度
};

export type AgentRow = {
  key: string;
  agent: AgentType;
  detail: string;
};

export type ProviderRow = {
  key: string;
  groupKey: string;
  label: string;
  detail: string;
};

export type ModelRow = {
  key: string;
  executorId: string | null;
  model: string;
  label: string;
  detail: string;
};

export function agentRows(
  types: AgentType[],
  profiles: AgentExecutorProfile[],
  query: string,
): AgentRow[] {
  const keyword = query.trim().toLowerCase();
  return types
    .filter((type) => !keyword || type.toLowerCase().startsWith(keyword))
    .map((type) => {
      const owned = profiles.filter((profile) => profile.type === type);
      const fallback = owned.find((profile) => profile.isDefault) ?? owned[0];
      return {
        key: type,
        agent: type,
        detail: fallback
          ? `${fallback.name}${owned.length > 1 ? ` 等 ${owned.length} 个执行器` : ""}`
          : "未注册执行器",
      };
    });
}

/**
 * 第二步单列供应商：这一回合先决定账号/目录来源，再在下一步挑这家下面的模型。
 */
export function providerRows(groups: ModelGroup[], query: string): ProviderRow[] {
  const keyword = query.trim().toLowerCase();
  return groups
    .filter((group) => {
      if (!keyword) return true;
      return group.providerName.toLowerCase().includes(keyword)
        || group.executorName?.toLowerCase().includes(keyword)
        || group.note.toLowerCase().includes(keyword);
    })
    .map((group) => ({
      key: group.key,
      groupKey: group.key,
      label: group.providerName,
      detail: [group.executorName, group.note].filter(Boolean).join(" · "),
    }));
}

/**
 * 第三步只看选中的那一家供应商，避免「先看见模型、再意识到它其实属于别家」。
 *
 * 这里**不**再补「跟随执行器」那一行：它跟下面的模型是两种东西（一个是「不选」，
 * 一个是「选哪个」），混排在同一列表里会把真正要挑的模型往下挤。
 */
export function modelRows(group: ModelGroup | null, query: string): ModelRow[] {
  if (!group) return [];
  const keyword = query.trim().toLowerCase();
  return group.models
    .filter((model) => !keyword || model.toLowerCase().includes(keyword))
    .map((model) => ({
      key: `${group.key}:${model}`,
      executorId: group.executorId,
      model,
      label: model,
      detail: model === group.profileModel ? "执行器默认" : "",
    }));
}

/** 上下键：空列表返回 0，其余循环。 */
export function stepIndex(length: number, index: number, delta: number): number {
  if (length <= 0) return 0;
  return (index + delta + length) % length;
}

/** 越界的高亮下标夹回有效范围（候选随筛选词变短时用）。 */
export function clampIndex(length: number, index: number): number {
  return Math.min(index, Math.max(0, length - 1));
}
