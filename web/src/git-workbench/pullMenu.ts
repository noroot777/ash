import type { Workbench } from "./useWorkbench.ts";
import type { MenuItem } from "./WorkbenchMenu.tsx";

// 拉取的三种方式。顶栏的「拉取」和推送被拒那条提示里的「先拉取」用同一份：
// 后者只是把同一个动作摆到出事的地方，不替用户挑方式、也不在拉完之后自动再推。
// 任务工作树不给变基（它的提交历史由验收流程管）。
export function pullMenuItems(w: Workbench, managed: boolean): MenuItem[] {
  return [
    {
      label: "仅快进 · 分叉时停止",
      onClick: () => void w.run({ kind: "pull", strategy: "ff-only" }),
    },
    {
      label: "拉取并合并",
      onClick: () => void w.run({ kind: "pull", strategy: "merge" }),
    },
    ...(!managed
      ? [
          {
            label: "拉取并变基",
            onClick: () => void w.run({ kind: "pull", strategy: "rebase" as const }),
          },
        ]
      : []),
  ];
}
