import type { AgentExecutorProfile, AgentType } from "@harness/shared";
import type { ModelGroup } from "../lib/modelCatalog.ts";

/**
 * 对话框 @ 选择器的纯逻辑：两阶段（先智能体、再模型）各自的候选行怎么算、
 * 箭头怎么走。组件只管画，键盘只管调这里的函数——所以 textarea 驱动的第一阶段
 * 和浮层自带输入框的第二阶段能共用同一套候选与同一套上下键语义。
 */

/** 一次 @ 选择的最终结果：这一回合派谁、用哪个执行器、跑哪个模型。 */
export type MentionTarget = {
  agent: AgentType;
  executorId: string | null; // null = 按该类型的默认执行器解析
  model: string | null; // null = 跟随执行器自己的模型
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
  model: string | null; // null = 跟随执行器
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
 * 模型候选按供应商分块。每块开头补一条「跟随执行器」——用户只想换智能体、不想
 * 挑模型时，@ 之后连按两次回车就完事，这是「丝滑」的关键一步。
 *
 * 只有带代表 Profile 的块才有这条：没有 Profile 的供应商块选「跟随」会落回类型
 * 默认执行器（很可能是另一家供应商），那是骗人的，不如不给。
 */
export function modelSections(groups: ModelGroup[], query: string): ModelSection[] {
  const keyword = query.trim().toLowerCase();
  const sections: ModelSection[] = [];
  for (const group of groups) {
    const rows: ModelRow[] = [];
    const followLabel = "跟随执行器";
    if (group.executorId && (!keyword || followLabel.includes(keyword) || "follow".startsWith(keyword))) {
      rows.push({
        key: `${group.key}:__follow`,
        groupKey: group.key,
        executorId: group.executorId,
        model: null,
        label: followLabel,
        detail: group.profileModel ?? "由执行器自己决定",
      });
    }
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
