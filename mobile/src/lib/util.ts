// 分组展示标签 "<name> · 并行/串行" —— 移植自 web/src/util.ts,移动端各处(分组视图、
// 管理页、新建任务选组)统一用它显示分组,与 web 完全一致。
import type { Group } from "@harness/shared";

export function groupLabel(g: Pick<Group, "name" | "mode">): string {
  return `${g.name} · ${g.mode === "parallel" ? "并行" : "串行"}`;
}
