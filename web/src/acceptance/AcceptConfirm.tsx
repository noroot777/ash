import type { ReactNode, RefObject } from "react";
import type { AcceptanceSteps } from "@ash/shared/accept-message";
import { AcceptLayer } from "./AcceptLayer.tsx";
import { cleanText, type ConfirmGate, type ConfirmView } from "./confirmPlan.ts";

/**
 * 「这一按会做什么」：挂在主按钮下面的一层，一步一行。可以不做的那两步（运行、提交）前面带勾，
 * 取消了那一行自己写后果。事实来自 shared 的 acceptanceSteps —— 和飞书待验收卡那句话同源。
 */
export function AcceptConfirm({ anchorRef, steps, view, gate, commitChoosable, commitDefault, verification, source, family,
  waiting, canSetGate, onRun, onCommit, onAcknowledge, onRetryDefault, onRetryVerification, onSetGate, onConfirm, onClose }: {
  anchorRef: RefObject<HTMLElement | null>;
  steps: AcceptanceSteps;
  view: ConfirmView;
  gate: ConfirmGate | null;
  commitChoosable: boolean;
  commitDefault: { value: boolean | null; error: string | null };
  verification: { state: "none" | "loading" | "error" | "unacknowledged" | "acknowledged"; error: string | null };
  source: string;
  /** 一起验收的那几个任务（父任务在前）；只验一个时为空。 */
  family: string[];
  /** 依赖、门禁还在核对（或刚读不出来）：确认键先等着，层不收起来。 */
  waiting: boolean;
  canSetGate: boolean;
  onRun: (value: boolean) => void;
  onCommit: (value: boolean) => void;
  onAcknowledge: (value: boolean) => void;
  onRetryDefault: () => void;
  onRetryVerification: () => void;
  onSetGate: () => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const merge = steps.kind === "merge" ? steps : null;
  return (
    <AcceptLayer open anchorRef={anchorRef} onClose={onClose} label={steps.kind === "release" ? "确认放行" : "确认验收"} align="end" className="acc-layer-confirm">
      <ol className="acc-steps">
        {steps.kind === "release" && <Step verb="放行" what={steps.next ? <>下一站「{steps.next}」</> : "这一关"} />}
        {steps.kind === "mark" && <Step verb="标记" what="验收完成" />}
        {steps.kind !== "release" && gate && (
          <Step verb="运行" checked={view.runs} onToggle={onRun} label="运行前置命令" off={!view.runs && !gate.reusable}
            what={<><code>{gate.command}</code>
              {view.runs && gate.issue && <em className="is-red">{gate.issue}</em>}
              {gate.reusable && !view.runs && gate.passedAgo && <em>{gate.passedAgo}通过</em>}
              {!view.runs && !gate.reusable && gate.lastFailed && <em className="is-amber">上次未通过</em>}</>} />
        )}
        {merge && (merge.merge === "tag"
          ? <Step verb="打标签" what={<><code>ash-accepted</code><em><code>{merge.target}</code> 不动</em></>} />
          : <Step verb="合并" what={<>{family.length > 1 ? `${family.length} 个任务` : <code>{source}</code>} → <code>{merge.target}</code>
            {merge.merge === "squash" && <em>squash</em>}</>} />)}
        {merge && family.length > 1 && <li className="acc-step-family"><ul>{family.map((title) => <li key={title}>{title}</li>)}</ul></li>}
        {merge && commitChoosable && (commitDefault.value === null
          ? <Step verb="提交" what={commitDefault.error
            ? <><em className="is-red">项目默认读不出来</em><button type="button" className="acc-link" onClick={onRetryDefault}>重试</button></>
            : <em><i className="acc-spin is-ink" aria-hidden="true" />读取项目默认</em>} />
          : <Step verb="提交" checked={view.commit} onToggle={onCommit} label="合并后提交"
            what={view.batchNeedsCommit ? <em className="is-red">不提交时一次只能合一个任务</em>
              : !view.commit ? <em className="is-amber">改动留在 {merge.target} 工作区，这个仓库别的验收先被挡住</em> : null} />)}
        {merge && <Step verb="清理" what={cleanText(merge, view.commit)} />}
        {steps.kind !== "release" && steps.team && <Step verb="联动" what="共享执行者一起标为验收完成" />}
        {verification.state === "loading" && <Step verb="验证" what={<em><i className="acc-spin is-ink" aria-hidden="true" />核对独立验证</em>} />}
        {verification.state === "error" && <Step verb="验证" what={<><em className="is-red">验证记录读不出来</em>
          <button type="button" className="acc-link" onClick={onRetryVerification}>重试</button></>} />}
        {(verification.state === "unacknowledged" || verification.state === "acknowledged") && (
          <Step verb="知情" checked={verification.state === "acknowledged"} onToggle={onAcknowledge} label="我已知晓独立验证尚未执行，仍要验收"
            what={<em className="is-amber">独立验证尚未执行，仍要验收</em>} />
        )}
      </ol>
      <footer>
        {canSetGate && <button type="button" className="acc-link" onClick={onSetGate}>设一条前置命令</button>}
        <button type="button" className="acc-btn" onClick={onClose}>取消</button>
        <button type="button" className="acc-btn is-primary" autoFocus disabled={view.confirmDisabled || waiting} aria-busy={waiting || undefined}
          onClick={onConfirm}>
          {waiting && <i className="acc-spin" aria-hidden="true" />}{view.confirmLabel}
        </button>
      </footer>
    </AcceptLayer>
  );
}

function Step({ verb, what, checked, onToggle, label, off = false }: {
  verb: string;
  what: ReactNode;
  checked?: boolean;
  onToggle?: (value: boolean) => void;
  label?: string;
  off?: boolean;
}) {
  const body = <><span className="acc-step-verb">{verb}</span><span className="acc-step-what">{what}</span></>;
  return (
    <li className={off ? "is-off" : undefined}>
      {onToggle
        ? <label><input type="checkbox" checked={!!checked} aria-label={label} onChange={(event) => onToggle(event.target.checked)} />{body}</label>
        : <div><i aria-hidden="true" />{body}</div>}
    </li>
  );
}
