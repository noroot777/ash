import { Fragment, useId, useRef, useState, type ReactNode } from "react";
import type { TaskMode } from "@ash/shared";
import { ArrowRight, CaretDown, Check, GitBranch, Robot, X } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";

export type StudioPanel = "people" | "space" | "flow";
export type StudioSection = {
  id: StudioPanel;
  label: string;
  value: string;
  detail: string;
  content: ReactNode;
  disabled?: boolean;
};

export function ComposerExecution({ sections }: { sections: StudioSection[] }) {
  const [open, setOpen] = useState<StudioPanel | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const id = useId();
  const active = sections.find((section) => section.id === open && !section.disabled);
  useDismissable({
    enabled: !!active, containerRef, restoreFocusRef: triggerRef,
    closeOnOutside: false, onClose: () => setOpen(null),
  });
  const icons = { people: Robot, space: GitBranch, flow: Check };
  return (
    <div className="studio-execution" ref={containerRef}>
      <header><span>执行安排</span><small>默认已就绪，按需调整</small></header>
      <div className="studio-path">
        {sections.map((section, index) => {
          const Icon = icons[section.id];
          return (
            <Fragment key={section.id}>
              {index > 0 && <ArrowRight className="studio-path-arrow" size={16} aria-hidden="true" />}
              <button type="button" className="studio-step" aria-expanded={active?.id === section.id}
                aria-controls={`${id}-${section.id}`} disabled={section.disabled}
                onClick={(event) => { triggerRef.current = event.currentTarget; setOpen(active?.id === section.id ? null : section.id); }}>
                <span className={`studio-step-icon is-${section.id}`}><Icon size={16} /></span>
                <span className="studio-step-copy"><small>{section.label}</small><b>{section.value}</b><span>{section.detail}</span></span>
                {!section.disabled && <CaretDown size={10} className="studio-caret" />}
              </button>
            </Fragment>
          );
        })}
      </div>
      {sections.map((section) => (
        <section key={section.id} id={`${id}-${section.id}`} hidden={active?.id !== section.id}
          aria-label={section.label} className="studio-settings">
          {active?.id === section.id && <>
            <header><b>{section.label}</b><button type="button" className="studio-close" aria-label={`收起${section.label}`}
              onClick={() => { setOpen(null); triggerRef.current?.focus(); }}><X size={14} /></button></header>
            {section.content}
          </>}
        </section>
      ))}
    </div>
  );
}

const STARTERS = [
  { label: "解决一个问题", detail: "现象 → 原因 → 修复与验证", symbol: "⌁", mode: "single", body: "请帮我定位并修复这个问题。\n\n现象：\n复现步骤：\n期望结果：\n\n完成后，请运行相关检查并说明根因。" },
  { label: "做一个新功能", detail: "目标 → 边界 → 交付标准", symbol: "＋", mode: "single", body: "我想增加一个新功能。\n\n使用场景：\n需要实现：\n不在本次范围：\n\n验收标准：" },
  { label: "讨论一个方案", detail: "比较取舍，形成共同结论", symbol: "⇄", mode: "duet", body: "请比较下面的方案，并形成一个可执行的结论。\n\n背景：\n候选方案：\n主要顾虑：\n\n请说明各自的收益、成本和推荐理由。" },
] satisfies { label: string; detail: string; symbol: string; mode: TaskMode; body: string }[];

export function ComposerStarters({ onPick }: { onPick: (body: string, mode: TaskMode) => void }) {
  return <section className="studio-starters" aria-label="任务示例">
    <header><span>还没想好怎么写？</span><small>选一个起点，继续补充</small></header>
    <div>{STARTERS.map((starter) => <button key={starter.label} type="button" onClick={() => onPick(starter.body, starter.mode)}>
      <span className="studio-starter-icon">{starter.symbol}</span><span><b>{starter.label}</b><small>{starter.detail}</small></span><ArrowRight size={12} />
    </button>)}</div>
  </section>;
}
