// 「建在谁上面」的下拉：候选和能不能选全听服务端（`GET /projects/:id/prerequisite-candidates`，判据在
// server/src/prerequisite-store.ts），这里只把它摆成下拉的样子。两个入口共用——新建面板（启动方式「创建并等前置」）
// 和右侧「信息」格（还没开工的任务加前置）。
//
// 排法照「排在某任务之后」那一份（lib/queueAfter.ts）：全部列出不过滤；能选的在上，右边灰字写它此刻到哪一步了；
// 不能选的置灰沉底，右边灰字写为什么。已经选进来的不再列。
import type { Group } from "@navi/shared";
import type { PrerequisiteCandidate } from "@navi/shared/prerequisites";
import { prerequisiteStepText } from "@navi/shared/prerequisites";
import type { DropdownOption } from "../components/Dropdown.tsx";

export function prerequisiteOptions(candidates: PrerequisiteCandidate[], groups: Group[], picked: string[] = []): DropdownOption[] {
  const groupName = (groupId: string | null) =>
    groupId == null ? "无分组" : groups.find((group) => group.id === groupId)?.name ?? "未知分组";
  const options = candidates.filter((item) => !picked.includes(item.taskId)).map((item): DropdownOption => ({
    value: item.taskId,
    label: item.title,
    group: groupName(item.groupId),
    detail: item.problem ?? candidateStepText(item),
    disabled: !!item.problem,
  }));
  return [...options.filter((option) => !option.disabled), ...options.filter((option) => option.disabled)];
}

/** 能选的那条此刻到哪一步了；服务端没给出（不该发生）就不写。 */
export function candidateStepText(item: Pick<PrerequisiteCandidate, "step" | "round">): string {
  return item.step ? prerequisiteStepText({ step: item.step, round: item.round, movedOn: false }) : "";
}
