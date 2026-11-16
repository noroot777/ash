import type { ReactNode } from "react";
import type { ScheduledMessage, TaskListItem } from "@ash/shared";
import { ArrowUUpLeft, ChatsCircle, PaperPlaneRight, SpinnerGap, X } from "@phosphor-icons/react";
import { formatInstant } from "../task-detail/utils.ts";
import { HoverTip, useHoverTip } from "./HoverTip.tsx";
import { MonitorMark } from "./MonitorMark.tsx";
import {
  scheduledMessageExitCode, scheduledMessageSource, scheduledMessageSummary, scheduledMessageText, scheduledMessageWhen,
  type ScheduledMessageSource,
} from "./scheduledMessagePresentation.ts";

const SOURCE_LABELS: Record<ScheduledMessageSource, string> = { mine: "你", monitor: "哨兵", managed: "审查答复", system: "系统" };

export function scheduledMessageLabel(message: ScheduledMessage): string {
  return scheduledMessageSummary(message)
    || (message.attachments.length ? `[${message.attachments.length} 个附件]` : "[空消息]");
}

/**
 * 「引导会话」:出不出这颗键由服务端按引导的前置条件判(server/src/task-steer-gate.ts 的 `steerable`)——
 * 任务不在执行回合、不是最早一条自己的消息,点了都必然被拒,就不出现。收着那一行和点开的那一行共用它。
 */
export function SteerButton({ message, busy, steering, onSteer }: {
  message: ScheduledMessage;
  busy: boolean;
  steering: boolean;
  onSteer: (messageId: string) => void;
}) {
  const tip = useHoverTip();
  return <>
    <button type="button" className="scheduled-message-guide" disabled={busy}
      aria-label={`用最早的排队消息“${scheduledMessageText(message) || "附件"}”引导会话`}
      onClick={() => { tip.hide(); onSteer(message.id); }} {...tip.anchorProps}>
      {steering ? <SpinnerGap size={13} className="is-spinning" aria-hidden="true" /> : <ChatsCircle size={13} weight="duotone" aria-hidden="true" />}
      <span>{steering ? "引导中" : "引导会话"}</span>
    </button>
    <HoverTip at={tip.at}>不等这一轮结束，把这条直接接进正在进行的对话</HoverTip>
  </>;
}

/** 指到这一行才出的那颗图标键(撤回 / 取消这次唤醒 / 停掉哨兵);忙着的时候一直亮着,好让转圈看得见。 */
export function RevealButton({ label, tip: tipText, busy, spinning, onClick, className, children }: {
  label: string;
  tip: string;
  busy: boolean;
  spinning: boolean;
  onClick: () => void;
  className: string;
  children: ReactNode;
}) {
  const tip = useHoverTip();
  return <>
    <button type="button" className={`scheduled-message-reveal ${className}`} disabled={busy} aria-label={label}
      onClick={() => { tip.hide(); onClick(); }} {...tip.anchorProps}>
      {spinning ? <SpinnerGap size={12} className="is-spinning" aria-hidden="true" /> : children}
    </button>
    <HoverTip at={tip.at}>{tipText}</HoverTip>
  </>;
}

/** 撤回：取下这条，内容放回输入框。点开的那一行指到才出；收着那一行带着最早那条时常显。 */
export function WithdrawButton({ message, tasks, busy, spinning, onWithdraw, className = "" }: {
  message: ScheduledMessage;
  tasks?: TaskListItem[];
  busy: boolean;
  spinning: boolean;
  onWithdraw: (message: ScheduledMessage) => void;
  className?: string;
}) {
  const whenSpoken = message.mode === "queued" ? "排队中" : message.mode === "timed" ? formatInstant(message.sendAt) : scheduledMessageWhen(message, tasks).text;
  return <RevealButton className={`scheduled-message-withdraw ${className}`.trim()} busy={busy} spinning={spinning} tip="撤回，内容放回输入框"
    label={`撤回${whenSpoken}的待发送消息“${scheduledMessageText(message) || "附件"}”，内容放回输入框`} onClick={() => onWithdraw(message)}>
    <ArrowUUpLeft size={12} weight="bold" aria-hidden="true" />
  </RevealButton>;
}

export function ScheduledMessageRow({ message, busy, steering, open, bodyId, tasks, monitorEnded, onToggle, onSteer, onWithdraw, onCancel, onSendNow, onOpenTask }: {
  message: ScheduledMessage;
  /** 哨兵送来的这一条，它的哨兵已经不在盯了（托盘拿得到在盯的那几个时才知道；不知道就不画记号）。 */
  monitorEnded?: boolean;
  busy: boolean;
  steering: boolean;
  /** 全文是否在这一行下面摊开。 */
  open: boolean;
  bodyId: string;
  tasks?: TaskListItem[];
  onToggle: () => void;
  onSteer?: (messageId: string) => void;
  onWithdraw: (message: ScheduledMessage) => void;
  /** 哨兵那一行的叉:由托盘先弹确认框,这里只报「想取消哪条」。 */
  onCancel?: (messageId: string) => void;
  onSendNow?: (messageId: string) => void;
  /** 「某某名下已全部停下」那一格点得过去：到那一条里按接着跑。 */
  onOpenTask?: (taskId: string) => void;
}) {
  const displayText = scheduledMessageText(message);
  // 哨兵口径(「取消这次唤醒」、「不执行停止哨兵操作」)只许落在真哨兵上,判据与后端同源,见 scheduledMessageSource。
  const source = scheduledMessageSource(message);
  const exitCode = scheduledMessageExitCode(message);
  const attention = exitCode !== null && exitCode !== 0;
  const when = scheduledMessageWhen(message, tasks);
  const heldBy = message.mode === "queued" && message.wait?.kind === "dispatchHeld" ? message.wait.by : null;
  return <div className={`scheduled-message-item${busy ? " is-busy" : ""}`} data-message-id={message.id}>
    <div className="scheduled-message-row">
      <span className={`scheduled-message-source${attention ? " is-attention" : ""}`}>
        {source === "monitor" && monitorEnded && <MonitorMark state="ended" />}{SOURCE_LABELS[source]}
        {attention && <span className="scheduled-message-exit">exit {exitCode}</span>}
        {message.agent && <span className="scheduled-message-agent">@{message.agent}</span>}
      </span>
      <button type="button" className="scheduled-message-summary" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}>
        {scheduledMessageLabel(message)}
      </button>
      {/* 说不出在等什么也占着这一格:四格对成列,少一格后面的键就错到这一列上来。 */}
      {heldBy && onOpenTask
        ? <button type="button" className="scheduled-message-when is-link" aria-label={`${when.text}：打开「${heldBy.title || "未命名任务"}」`}
          onClick={() => onOpenTask(heldBy.id)}>{when.text}</button>
        : <span className={`scheduled-message-when${when.stuck ? " is-stuck" : ""}`}>{when.text}</span>}
      <span className="scheduled-message-actions">
        {source === "mine" && message.steerable === true && onSteer
          && <SteerButton message={message} busy={busy} steering={steering} onSteer={onSteer} />}
        {source === "mine" && when.stuck && onSendNow && <button type="button" className="scheduled-message-guide scheduled-message-send-now"
          disabled={busy} aria-label={`不再等前置任务，把“${displayText || "附件"}”直接发出`} onClick={() => onSendNow(message.id)}>
          <PaperPlaneRight size={12} aria-hidden="true" /><span>直接发送</span>
        </button>}
        {source === "mine" && <WithdrawButton message={message} tasks={tasks} busy={busy} spinning={busy && !steering} onWithdraw={onWithdraw} />}
        {source === "monitor" && onCancel && <RevealButton className="scheduled-message-cancel" busy={busy} spinning={busy} tip="取消这次唤醒"
          label={`取消哨兵事件“${displayText}”这一次唤醒（仅移除本条输入，不执行停止哨兵操作）`} onClick={() => onCancel(message.id)}>
          <X size={12} weight="bold" aria-hidden="true" />
        </RevealButton>}
      </span>
    </div>
    {open && <div id={bodyId} className="scheduled-message-full">
      <div className="scheduled-message-body">{displayText || "[无文字内容]"}</div>
      {message.attachments.length > 0 && <ul aria-label="消息附件">{message.attachments.map((path, index) => <li key={`${index}:${path}`}>{path}</li>)}</ul>}
    </div>}
  </div>;
}
