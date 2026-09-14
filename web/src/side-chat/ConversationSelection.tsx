import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Chats } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";
import { stageSideChatQuote } from "./sideChatQuote.ts";
import "./conversation-selection.css";

type Selected = { text: string; left: number; top: number };
const controls = "button, input, textarea, select, [contenteditable]:not([contenteditable=false])";
const elementOf = (node: Node) => node instanceof Element ? node : node.parentElement;

export function ConversationSelection({ taskId, onAsk, children }: {
  taskId: string;
  onAsk: () => void;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  useDismissable({ enabled: !!selected, containerRef: toolbar, onClose: () => setSelected(null) });

  useEffect(() => {
    setSelected(null);
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (toolbar.current?.contains(document.activeElement)) return;
        if (document.activeElement?.matches("input, textarea, select, [contenteditable]:not([contenteditable=false])")) return setSelected(null);
        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return setSelected(null);
        const range = selection.getRangeAt(0);
        if (!root.current?.contains(range.startContainer) || !root.current.contains(range.endContainer)
          || elementOf(range.startContainer)?.closest(controls) || elementOf(range.endContainer)?.closest(controls)
          || range.cloneContents().querySelector("input, textarea, select, [contenteditable]:not([contenteditable=false])")) return setSelected(null);
        const text = selection.toString();
        const rect = range.getBoundingClientRect();
        if (!text.trim() || (!rect.width && !rect.height) || rect.bottom < 0 || rect.top > innerHeight) return setSelected(null);
        const last = Array.from(range.getClientRects()).filter((box) => box.width && box.height).at(-1) ?? rect;
        setSelected({
          text,
          left: Math.max(8, Math.min(last.left, innerWidth - 180)),
          top: Math.max(8, Math.min(last.bottom + 8, innerHeight - 48)),
        });
      });
    };
    const dismiss = () => { cancelAnimationFrame(frame); setSelected(null); };
    const afterPointer = (event: PointerEvent) => {
      if (event.target instanceof Node && root.current?.contains(event.target)) update();
    };
    document.addEventListener("selectionchange", update);
    document.addEventListener("pointerup", afterPointer);
    window.addEventListener("resize", dismiss);
    document.addEventListener("scroll", dismiss, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("pointerup", afterPointer);
      window.removeEventListener("resize", dismiss);
      document.removeEventListener("scroll", dismiss, true);
    };
  }, [taskId]);

  useEffect(() => {
    if (!selected) return;
    const focusAction = (event: KeyboardEvent) => {
      if (event.key === "Tab" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
        && !toolbar.current?.contains(document.activeElement)) {
        event.preventDefault();
        toolbar.current?.querySelector("button")?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", focusAction);
    return () => document.removeEventListener("keydown", focusAction);
  }, [selected]);

  return <div className="conversation-selection-scope" ref={root}>
    {children}
    {selected && createPortal(<div className="conversation-selection-action" ref={toolbar} style={{ left: selected.left, top: selected.top }}>
      <button type="button" onPointerDown={(event) => event.preventDefault()} onClick={() => {
        stageSideChatQuote(taskId, selected.text);
        setSelected(null);
        window.getSelection()?.removeAllRanges();
        onAsk();
      }}><Chats size={16} />在侧聊中提问</button>
    </div>, document.body)}
  </div>;
}
