import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Chats, Quotes } from "@phosphor-icons/react";
import { useDismissable } from "../lib/useDismissable.ts";
import { stageSideChatQuote } from "./sideChatQuote.ts";
import "./conversation-selection.css";

type Selected = { text: string; left: number; top: number };
const controls = "button, input, textarea, select, [contenteditable]:not([contenteditable=false])";
const elementOf = (node: Node) => node instanceof Element ? node : node.parentElement;

export function ConversationSelection({ taskId, onAsk, onAddToReply, children }: {
  taskId: string;
  onAsk: () => void;
  /** 不传 = 这个任务没有可用的对话框（比如已交接出去），浮条上就不出现「添加到对话」。 */
  onAddToReply?: (text: string) => void;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  // 浮条实际有多宽取决于按钮个数和文案，量出来再贴边，别拿常数猜（猜小了会被右边缘切掉）。
  const [left, setLeft] = useState(8);
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
          left: Math.max(8, last.left),
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

  // 量宽度要在浏览器画之前做完（useLayoutEffect），否则第一帧会先闪一下没贴边的位置。
  useLayoutEffect(() => {
    if (!selected) return;
    const width = toolbar.current?.offsetWidth ?? 0;
    setLeft(Math.max(8, Math.min(selected.left, innerWidth - width - 8)));
  }, [selected]);

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

  const take = (use: (text: string) => void) => () => {
    const text = selected?.text;
    setSelected(null);
    window.getSelection()?.removeAllRanges();
    if (text) use(text);
  };

  return <div className="conversation-selection-scope" ref={root}>
    {children}
    {selected && createPortal(<div className="conversation-selection-action" ref={toolbar} style={{ left, top: selected.top }}>
      {onAddToReply && <button type="button" onPointerDown={(event) => event.preventDefault()}
        onClick={take(onAddToReply)}><Quotes size={16} />添加到对话</button>}
      <button type="button" onPointerDown={(event) => event.preventDefault()} onClick={take((text) => {
        stageSideChatQuote(taskId, text);
        onAsk();
      })}><Chats size={16} />在侧聊中提问</button>
    </div>, document.body)}
  </div>;
}
