import type { AgentExecutorProfile, AgentType } from "@harness/shared";
import type { ModelGroup } from "../lib/modelCatalog.ts";

/**
 * 对话框 @ 选择器的纯逻辑：智能体 / 模型 / 强度各阶段的候选行怎么算、箭头
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

export type ModelRow = {
  key: string;
  groupKey: string;
  executorId: string | null;
  model: string;
  label: string;
  detail: string;
};

export type ModelSection = { group: ModelGroup; rows: ModelRow[] };

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
 * 模型候选按供应商分块，块标题是供应商名、块里只列模型本身——供应商和模型是
 * **同一步**里的两件事：看着「哪家的」直接点「哪一个」，不必先选一次供应商再进
 * 下一屏（多一屏并没有多给出信息，同名模型靠块标题就分得清）。
 *
 * 这里**不**再补「跟随执行器」那一行：它跟下面的模型是两种东西（一个是「不选」，
 * 一个是「选哪个」），混排在同一列表里每块都顶着一条噪声，用户要挑的模型反而被
 * 挤下去。不挑模型的人本来就不会打开这个选择器。
 */
export function modelSections(groups: ModelGroup[], query: string): ModelSection[] {
  const keyword = query.trim().toLowerCase();
  const sections: ModelSection[] = [];
  for (const group of groups) {
    const rows: ModelRow[] = [];
    for (const model of group.models) {
      if (keyword && !model.toLowerCase().includes(keyword)) continue;
      rows.push({
        key: `${group.key}:${model}`,
        groupKey: group.key,
        executorId: group.executorId,
        model,
        label: model,
        detail: model === group.profileModel ? "执行器默认" : "",
      });
    }
    // 有筛选词时空块直接不画；没筛选词时保留，好让「正在读取 / 读取失败」看得见。
    if (!rows.length && keyword) continue;
    sections.push({ group, rows });
  }
  return sections;
}

/** 上下键走的是拉平后的行序，块标题不占位置。 */
export function flattenModelRows(sections: ModelSection[]): ModelRow[] {
  return sections.flatMap((section) => section.rows);
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
