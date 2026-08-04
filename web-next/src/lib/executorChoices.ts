import type { AgentType } from "@harness/shared";
import { REASONING_EFFORT_VALUES } from "@harness/shared/cli-presets";
import type { DropdownOption } from "../components/Dropdown.tsx";

/**
 * 「思考强度」的候选项。各处（新建面板、派生面板、任务信息面板、执行器设置、
 * 团队预设、对话框的 @ 选择器）都得列同一份，所以在这里生成一次。
 *
 * 第一项永远是「不覆盖」：档位是 CLI 自己的事，harness 只在用户明确挑了才传。
 */
export function effortOptions(type: AgentType, followLabel = "跟随执行器"): DropdownOption[] {
  return [
    { value: "", label: followLabel },
    ...REASONING_EFFORT_VALUES[type].map((effort) => ({ value: effort, label: effort })),
  ];
}
