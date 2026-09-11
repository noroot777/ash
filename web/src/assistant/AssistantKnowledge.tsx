import { useEffect, useRef, useState } from "react";
import { BookOpen, X } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";

export function AssistantKnowledgeContent() {
  return <><dl><dt>ash 使用说明</dt><dd>内置功能指南：任务、团队、执行器、起手式与验收。</dd>
    <dt>任务与会话</dt><dd>按需检索你可见项目的本机任务及会话，包括归档任务。</dd>
    <dt>当前资源</dt><dd>可见项目、执行器、起手式示例和本对话草案的保存状态。</dd>
    <dt>回复风格 · 已启用</dt><dd>默认 1–3 句或最多 3 个要点，通常不超过 200 字；需要时再展开。</dd></dl>
    <p>暂未接入 Obsidian 等外部知识库，也不做联网检索。</p></>;
}

export function AssistantKnowledge() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useDismissable({ enabled: open, containerRef: panel, restoreFocusRef: trigger, onClose: () => setOpen(false) });
  useEffect(() => { if (open) close.current?.focus(); }, [open]);
  return <>
    <button ref={trigger} type="button" aria-label="知识与回复设置" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)}><BookOpen size={20} /></button>
    {open && <section className="assistant-knowledge-panel assistant-knowledge" ref={panel} role="dialog" aria-label="知识与回复设置">
      <header><strong>知识与回复设置</strong><button ref={close} type="button" aria-label="关闭知识与回复设置" onClick={() => { setOpen(false); trigger.current?.focus(); }}><X size={16} /></button></header>
      <AssistantKnowledgeContent />
    </section>}
  </>;
}
