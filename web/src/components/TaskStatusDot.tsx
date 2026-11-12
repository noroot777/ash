import { CircleDashed } from "@phosphor-icons/react";
import { TASK_LOOK, type TaskStatusIndicator } from "../lib/taskLook.ts";

// 指上去那句话跟侧栏行首读的是同一列（lib/taskLook 的 TASK_LOOK），两处说法不会各写各的。
// surface="workspace" 画的是侧栏那套记号（类名是 TASK_LOOK 的 mark，侧栏不画的档位就空着）；
// 侧栏自己的行用 TaskTreeRows 的 RowMark，这里留给只想借那副长相的地方。
export function TaskStatusDot({
  indicator,
  surface,
  small = false,
}: {
  indicator: TaskStatusIndicator;
  surface: "workspace" | "team";
  small?: boolean;
}) {
  const base = surface === "workspace" ? "workspace-status-dot" : "team-status-dot";
  const { mark, say: label } = TASK_LOOK[indicator];
  const variant = surface === "workspace" ? mark : indicator;
  const hasIcon = surface === "team" && indicator === "pending";
  return (
    <i
      className={`${base}${variant ? ` ${base}--${variant}` : ""}${small ? ` ${base}--small` : ""}${hasIcon ? " task-status-dot--has-icon" : ""}`}
      title={label}
      aria-label={label}
    >
      {hasIcon && (
        <CircleDashed className="task-status-dot-icon" weight="regular" aria-hidden="true" />
      )}
    </i>
  );
}
