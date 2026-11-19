// 标题后面那枚「计划」：这个任务开着 Codex 计划模式（只讨论方案、不动手）。以前是会话顶上一整条紫色
// 横幅，常驻占一行；现在收成标题行里一枚小标，指上去说清是哪个执行器，点叉就是发一句 /plan off。
// 不放进回复框：计划定稿后「实施此计划？」会占住回复框，模式标得一直看得到。
// 叉只在单一作用域时给：/plan off 要由那个执行器自己跑一回合，多个作用域没法一键退干净。
import { Lightbulb, X } from "@phosphor-icons/react";
import type { Task } from "@navi/shared";
import { HoverTip, useHoverTip } from "../components/HoverTip.tsx";
import "../components/proposed-plan.css";

export function PlanModeChip({ task, onOff }: {
  task: Task;
  onOff: (executorId: string | null) => void;
}) {
  const tip = useHoverTip();
  if (task.mode !== "single" || !task.codexPlanMode) return null;
  const scopes = task.codexPlanScopes ?? [];
  const labels = scopes.map((scope) => scope.executorLabel).join("、") || "Codex";
  const only = scopes.length === 1 ? scopes[0]! : null;
  return (
    <span className="plan-mode-chip" role="status" aria-label="Codex 计划模式" {...tip.anchorProps}>
      <Lightbulb size={13} aria-hidden="true" />
      计划
      <span className="task-visually-hidden">：{labels} 只讨论方案，发送 /plan off 退出</span>
      {only && <button type="button" aria-label="退出计划模式" disabled={task.status === "running" || task.status === "queued"} onClick={() => onOff(only.executorId)}>
        <X size={10} weight="bold" aria-hidden="true" />
      </button>}
      <HoverTip at={tip.at}>{labels} 只讨论方案、不动手</HoverTip>
    </span>
  );
}
