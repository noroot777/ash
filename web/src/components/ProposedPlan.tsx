import { useEffect, useRef, useState } from "react";
import { ArrowsOutSimple, DownloadSimple, Lightbulb, X } from "@phosphor-icons/react";
import { createPortal } from "react-dom";
import type { AgentEvent } from "@navi/shared";
import { CopyButton } from "./CopyButton.tsx";
import { MarkdownBody } from "./MarkdownBody.tsx";
import { useDismissable } from "../lib/useDismissable.ts";
import "./proposed-plan.css";

export type ProposedPlanData = Extract<AgentEvent, { kind: "plan" }>;

export function ProposedPlan({ plan, running }: { plan: ProposedPlanData; running: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  useDismissable({ enabled: expanded, containerRef: dialogRef, restoreFocusRef: expandRef, onClose: () => setExpanded(false) });
  useEffect(() => { if (expanded) dialogRef.current?.focus(); }, [expanded]);
  const download = () => {
    const url = URL.createObjectURL(new Blob([plan.text], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "plan.md";
    link.click();
    URL.revokeObjectURL(url);
  };
  const content = <MarkdownBody text={plan.text} />;
  const writing = running && plan.status === "streaming";
  return (
    <section className={`proposed-plan${writing ? " is-writing" : ""}`} aria-label="计划书" aria-busy={writing}>
      <header className="proposed-plan-head">
        <span><Lightbulb size={17} />{writing ? "正在拟定计划" : plan.status === "complete" ? "计划" : "计划草稿"}</span>
        <div className="proposed-plan-actions" data-selection-chrome="">
          <button type="button" aria-label="下载计划" onClick={download} disabled={!plan.text}><DownloadSimple size={16} /></button>
          <CopyButton value={plan.text} icon ariaLabel="复制计划" />
          <button type="button" aria-label="展开计划" ref={expandRef} onClick={() => setExpanded(true)}><ArrowsOutSimple size={16} /></button>
        </div>
      </header>
      <div className="proposed-plan-body">{plan.text ? content : <span className="proposed-plan-pending">正在整理方案…</span>}</div>
      {expanded && createPortal(
        <div className="proposed-plan-backdrop">
          <div className="proposed-plan-dialog" role="dialog" aria-modal="true" aria-label="计划全文" ref={dialogRef} tabIndex={-1}>
            <header><strong>计划</strong><button type="button" aria-label="关闭计划全文" onClick={() => setExpanded(false)}><X size={20} /></button></header>
            <div className="proposed-plan-body">{content}</div>
          </div>
        </div>, document.body,
      )}
    </section>
  );
}
