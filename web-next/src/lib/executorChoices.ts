import type { AgentType } from "@harness/shared";
import { reasoningEffortsFor } from "@harness/shared/cli-presets";
import type { DropdownOption } from "../components/Dropdown.tsx";

/**
 * 「思考强度」的候选项。各处（新建面板、派生面板、任务信息面板、执行器设置、
 * 团队预设、对话框的 @ 选择器）都得列同一份，所以在这里生成一次。
 *
 * 第一项永远是「不覆盖」：档位是 CLI 自己的事，harness 只在用户明确挑了才传。
 *
 * 知道当前模型就把它传进来：解析器会按 CLI / provider / 模型规则返回完整允许集合，
 * 未登记模型才退回 CLI 并集。
 */
export function effortOptions(
  type: AgentType,
  followLabel = "跟随执行器",
  model?: string | null,
): DropdownOption[] {
  return [
    { value: "", label: followLabel },
    ...reasoningEffortsFor(type, model).map((effort) => ({ value: effort, label: effort })),
  ];
}
