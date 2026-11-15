import { X } from "@phosphor-icons/react";
import { ReplyDockRow } from "./ReplyDock.tsx";
import { callChoices, type BaseOption, type CallVerb, type DispatchBase, type ReplyCall } from "./replyCall.ts";

/**
 * `@` 了一个人之后，回复框顶上那一行：它来做什么（问一句 / 派出去）。跟「等你裁定」那一行同一副骨架、
 * 同一个位置；叫着人的时候框顶只有这一行，不叫了才换回裁定那一行（ReplyBox 里定谁让谁）。
 */
export function ReplyCallDock({ call, self, onVerb, onCancel, baseError, onRetryBase }: {
  call: ReplyCall;
  self: boolean;
  onVerb: (verb: CallVerb) => void;
  onCancel: () => void;
  /** 派出去时没读到从哪开工（null = 读到了或还在读）。 */
  baseError: string | null;
  onRetryBase: () => void;
}) {
  const failed = call.verb === "dispatch" && baseError !== null;
  return (
    <ReplyDockRow
      label={`叫 ${call.target.agent} 来做什么`}
      choices={callChoices(self, true)}
      pressed={call.verb}
      onPick={onVerb}
      onEscape={onCancel}
      error={failed ? `没读到这个项目的分支，确认不了新任务从哪开工，先不派（${baseError}）` : null}
      errorAction={failed ? { label: "重试", onClick: onRetryBase } : null}
    />
  );
}

/** 派出去时胶囊最后那一段：新任务从哪开工。两种之间点一下就换。 */
export function DispatchBaseSegment({ options, value, disabled, onChange }: {
  options: BaseOption[];
  value: DispatchBase;
  disabled?: boolean;
  onChange: (base: DispatchBase) => void;
}) {
  const index = Math.max(0, options.findIndex((option) => option.id === value));
  const current = options[index]!;
  const next = options[(index + 1) % options.length]!;
  return (
    <button
      type="button"
      className="run-target-seg run-target-seg--tail"
      disabled={disabled}
      aria-label={`新任务从哪开工：${current.label}；点击改成${next.label}`}
      onClick={() => onChange(next.id)}
    ><span>{current.label}</span></button>
  );
}

/** 胶囊旁那颗小叉：不叫人了，胶囊回到这条任务自己的执行器。 */
export function CallCancelKey({ agent, onCancel }: { agent: string; onCancel: () => void }) {
  return (
    <button type="button" className="task-reply-chip-reset" aria-label={`不叫 ${agent} 了`} onClick={onCancel}>
      <X size={10} weight="bold" />
    </button>
  );
}
