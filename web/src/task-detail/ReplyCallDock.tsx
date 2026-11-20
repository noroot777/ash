import { X } from "@phosphor-icons/react";
import type { CreateReviewChoice } from "@navi/shared/review-on-create";
import { ReviewerChip } from "../free-workflow/ReviewerChip.tsx";
import type { ReviewerList } from "../free-workflow/useReviewerList.ts";
import { ReplyDockRow } from "./ReplyDock.tsx";
import { Select } from "../components/Select.tsx";
import { callChoices, type BaseOption, type CallAbility, type CallVerb, type DispatchBase, type ReplyCall } from "./replyCall.ts";

/**
 * `@` 了一个人之后，回复框顶上那一行：它来做什么（问一句 / 讨论 / 派出去）。跟「等你裁定」那一行同一副骨架、
 * 同一个位置；叫着人的时候框顶只有这一行，不叫了才换回裁定那一行（ReplyBox 里定谁让谁）。
 */
export function ReplyCallDock({ call, self, ability, onVerb, onCancel, baseError, onRetryBase }: {
  call: ReplyCall;
  self: boolean;
  ability: CallAbility;
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
      choices={callChoices(self, ability)}
      pressed={call.verb}
      onPick={onVerb}
      onEscape={onCancel}
      error={failed ? `没读到这个项目的分支，确认不了新任务从哪开工，先不派（${baseError}）` : null}
      errorAction={failed ? { label: "重试", onClick: onRetryBase } : null}
    />
  );
}

/** 派出去时胶囊最后那一段：新任务从哪开工。两种之间点一下就换；还能从远端分支开工时点开是一份清单。 */
export function DispatchBaseSegment({ options, value, disabled, onChange, remotes }: {
  options: BaseOption[];
  value: DispatchBase;
  disabled?: boolean;
  onChange: (base: DispatchBase) => void;
  /** 刷新远端分支（useDispatchBaseContext）：失败的原因写在下拉里。 */
  remotes?: { refresh: () => void; fetching: boolean; error: string | null };
}) {
  const index = Math.max(0, options.findIndex((option) => option.id === value));
  const current = options[index]!;
  if (options.some((option) => option.group)) {
    return (
      <Select size="compact" className="run-target-seg run-target-seg--tail" label="新任务从哪开工" value={current.id}
        options={options.map((option) => ({ value: option.id, label: option.label, group: option.group, mono: option.group === "远端" }))}
        display={current.label} disabled={disabled} filterable={options.length > 8} filterPlaceholder="筛选分支…" onChange={onChange}
        status={remotes?.error ? "failed" : undefined} note={remotes?.error ?? ""}
        footerAction={remotes && { label: remotes.fetching ? "正在刷新远端分支…" : "刷新远端分支", onClick: remotes.refresh, disabled: remotes.fetching }} />
    );
  }
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

/** 派出去时跟胶囊并排的「谁来审」：缺省是默认审查者，可换可关（free-workflow/ReviewerChip.tsx）。 */
export function CallReviewerChip({ call, list, disabled, onChange }: {
  call: ReplyCall;
  /** 由回复框读（它要拿同一份清单拦派出、定派给谁，ReplyBox.tsx）。 */
  list: ReviewerList;
  disabled?: boolean;
  onChange: (review: CreateReviewChoice) => void;
}) {
  return <ReviewerChip value={call.review ?? "default"} list={list} label="新任务" disabled={disabled} onChange={onChange} />;
}
