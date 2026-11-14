import { useId, useState, type ReactNode } from "react";
import { CaretDown } from "@phosphor-icons/react";

/**
 * 前提列里一行的调子。红（block）拦验收，琥珀（warn）只提醒，live 是「有东西正在替你办」
 * （记号会动），其余几档只陈述：idle 还没发生、passed 通过、failed 没过、skipped 明确跳过、
 * stopped 被取消或打断（没有结论，所以不是红）。
 */
export type CheckTone = "block" | "warn" | "live" | "idle" | "passed" | "failed" | "skipped" | "stopped" | "running";

/**
 * 一件事一行：状态记号 + 一句事实 + 行尾至多一个它自己的出路。要细看的东西（日志、文件清单、
 * 原文）收进 `detail`，点这一行才展开。`check` 是这一行是哪件事的稳定名字（测试和样式都认它）。
 */
export function CheckRow({ check, tone, text, state, tools, detail, defaultOpen = false, className = "" }: {
  check: string;
  tone: CheckTone;
  text: ReactNode;
  state?: ReactNode;
  tools?: ReactNode;
  detail?: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const detailId = useId();
  const body = <>
    <i className={`acc-glyph is-${tone}`} aria-hidden="true" />
    <span className="acc-check-text">{text}</span>
    {state != null && state !== false && <span className="acc-check-state">{state}</span>}
  </>;
  return (
    <div className={`acc-check is-${tone} ${className}`} data-check={check} role="listitem">
      <div className="acc-check-line">
        {detail
          ? <button type="button" className="acc-check-main" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen((value) => !value)}>
            {body}<CaretDown size={11} weight="bold" className="acc-check-caret" aria-hidden="true" />
          </button>
          : <span className="acc-check-main">{body}</span>}
        {tools && <span className="acc-check-tools">{tools}</span>}
      </div>
      {detail && open && <div className="acc-check-detail" id={detailId}>{detail}</div>}
    </div>
  );
}

/** 行尾那一个出路。黑白：颜色只留给状态。 */
export function CheckAction({ children, onClick, disabled, busy, label }: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  label?: string;
}) {
  return (
    <button type="button" className="acc-btn is-sm" disabled={disabled || busy} aria-busy={busy || undefined} aria-label={label} onClick={onClick}>
      {busy && <i className="acc-spin" aria-hidden="true" />}{children}
    </button>
  );
}

/** 展开层里的文件清单（冲突文件、挡路文件、待提交文件）。 */
export function FileList({ files, limit = 40 }: { files: readonly string[]; limit?: number }) {
  return (
    <>
      <ul className="acc-files">{files.slice(0, limit).map((file) => <li key={file}><code>{file}</code></li>)}</ul>
      {files.length > limit && <p className="acc-check-more">共 {files.length} 个，只列前 {limit} 个</p>}
    </>
  );
}
